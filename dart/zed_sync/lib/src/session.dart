import 'dart:async';

import 'client.dart';
import 'lifecycle.dart';

typedef StartSyncEffects = Future<bool> Function();
typedef StopSyncEffects = Future<void> Function();

/// Mobile application lifecycle owner around [SyncClient].
///
/// [activate] starts platform transports/storage and returns their initial
/// connectivity. [deactivate] must be idempotent: it is called again when a
/// late startup completes after stop was already requested. The wrapped client
/// is capability-gated, so writes and incoming changes fail closed outside an
/// active online/offline session even if a caller retains the client handle.
class SyncSession {
  final SyncClient client;
  final StartSyncEffects activate;
  final StopSyncEffects deactivate;
  final AppLifecycleMachine _lifecycle = AppLifecycleMachine();
  Future<void>? _stopFuture;

  SyncSession({
    required this.client,
    required this.activate,
    required this.deactivate,
  }) {
    client.attachLifecycle(_lifecycle);
  }

  AppLifecycleSnapshot get snapshot => _lifecycle.snapshot;
  AppCapabilities get capabilities => _lifecycle.capabilities;

  void Function() subscribe(LifecycleListener listener) =>
      _lifecycle.subscribe(listener);

  Future<void> start() async {
    final outcome = _lifecycle.dispatch(const StartRequested());
    if (outcome != TransitionOutcome.applied) {
      throw StateError(
          'zed-sync lifecycle: start rejected while ${snapshot.phase.name}');
    }
    final token = snapshot.activeToken!;
    try {
      final online = await activate();
      _lifecycle.dispatch(ConnectivityChanged(token, online));
      final completion = _lifecycle.dispatch(StartSucceeded(token));
      if (completion == TransitionOutcome.stale) {
        throw StateError('zed-sync lifecycle: startup was superseded');
      }
      if (completion != TransitionOutcome.applied) {
        throw StateError('zed-sync lifecycle: startup completion rejected');
      }
    } catch (_) {
      try {
        await deactivate();
      } finally {
        _lifecycle.dispatch(StartFailed(token));
      }
      rethrow;
    }
  }

  /// Publish transport connectivity for the current session generation.
  TransitionOutcome setOnline(bool online) {
    final token = snapshot.activeToken;
    if (token == null) return TransitionOutcome.rejected;
    return _lifecycle.dispatch(ConnectivityChanged(token, online));
  }

  /// Revoke logical authority immediately, then clean platform effects. A
  /// subsequent [stop] performs explicit reconciliation back to Stopped.
  Future<void> failRuntime() async {
    final token = snapshot.activeToken;
    if (token == null) {
      throw StateError(
          'zed-sync lifecycle: runtime failure rejected while ${snapshot.phase.name}');
    }
    final outcome = _lifecycle.dispatch(RuntimeFailed(token));
    if (outcome != TransitionOutcome.applied) {
      throw StateError('zed-sync lifecycle: runtime failure was not applied');
    }
    await deactivate();
  }

  Future<void> stop() {
    final pending = _stopFuture;
    if (pending != null) return pending;
    final event = snapshot.phase == AppPhase.failed
        ? const ReconcileRequested()
        : const StopRequested();
    final outcome = _lifecycle.dispatch(event);
    if (outcome == TransitionOutcome.stuttered &&
        snapshot.phase == AppPhase.stopped) {
      return Future.value();
    }
    if (outcome != TransitionOutcome.applied) {
      return Future.error(StateError(
          'zed-sync lifecycle: stop rejected while ${snapshot.phase.name}'));
    }
    final token = snapshot.activeToken!;
    late final Future<void> operation;
    operation = _performStop(token).whenComplete(() {
      if (identical(_stopFuture, operation)) _stopFuture = null;
    });
    _stopFuture = operation;
    return operation;
  }

  Future<void> _performStop(int token) async {
    try {
      await deactivate();
      _lifecycle.dispatch(StopSucceeded(token));
    } catch (_) {
      _lifecycle.dispatch(StopFailed(token));
      rethrow;
    }
  }
}
