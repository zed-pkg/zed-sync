/// Total, deterministic application/session lifecycle for Flutter apps.
///
/// Platform effects run only after an [applied] transition. Every asynchronous
/// completion carries the operation token allocated by its request; an older
/// completion is [stale] and cannot resurrect a stopped session.
library;

enum AppPhase { stopped, starting, online, offline, stopping, failed }

enum LifecycleOperation { none, start, stop, reconcile }

enum LifecycleFailure { start, runtime, stop }

enum TransitionOutcome { applied, stuttered, stale, rejected }

enum _TokenRelation { current, stale, invalid }

sealed class LifecycleEvent {
  const LifecycleEvent();
}

final class StartRequested extends LifecycleEvent {
  const StartRequested();
}

final class StartSucceeded extends LifecycleEvent {
  final int token;
  const StartSucceeded(this.token);
}

final class StartFailed extends LifecycleEvent {
  final int token;
  const StartFailed(this.token);
}

final class ConnectivityChanged extends LifecycleEvent {
  final int token;
  final bool online;
  const ConnectivityChanged(this.token, this.online);
}

final class RuntimeFailed extends LifecycleEvent {
  final int token;
  const RuntimeFailed(this.token);
}

final class StopRequested extends LifecycleEvent {
  const StopRequested();
}

final class StopSucceeded extends LifecycleEvent {
  final int token;
  const StopSucceeded(this.token);
}

final class StopFailed extends LifecycleEvent {
  final int token;
  const StopFailed(this.token);
}

final class ReconcileRequested extends LifecycleEvent {
  const ReconcileRequested();
}

class AppLifecycleSnapshot {
  final AppPhase phase;
  final LifecycleOperation operation;
  final int generation;
  final int? activeToken;
  final bool desiredRunning;
  final bool online;
  final LifecycleFailure? failure;

  const AppLifecycleSnapshot({
    this.phase = AppPhase.stopped,
    this.operation = LifecycleOperation.none,
    this.generation = 0,
    this.activeToken,
    this.desiredRunning = false,
    this.online = false,
    this.failure,
  });

  AppCapabilities get capabilities => AppCapabilities._(this);

  Map<String, dynamic> toJson() => {
        'phase': phase.name,
        'operation': operation.name,
        'generation': generation,
        'active_token': activeToken,
        'desired_running': desiredRunning,
        'online': online,
        'failure': failure?.name,
      };

  /// Check the phase/operation/token/failure coherence proved by Quint.
  void validate() {
    final tokenValid =
        activeToken == null || (activeToken! > 0 && activeToken! <= generation);
    if (generation < 0 ||
        generation > AppLifecycleMachine.maxSafeGeneration ||
        !tokenValid) {
      throw StateError(
          'zed-sync lifecycle: invalid generation or active token');
    }

    final coherent = switch (phase) {
      AppPhase.stopped => operation == LifecycleOperation.none &&
          activeToken == null &&
          !desiredRunning &&
          !online &&
          failure == null,
      AppPhase.starting => operation == LifecycleOperation.start &&
          activeToken == generation &&
          desiredRunning &&
          failure == null,
      AppPhase.online => operation == LifecycleOperation.none &&
          activeToken == generation &&
          desiredRunning &&
          online &&
          failure == null,
      AppPhase.offline => operation == LifecycleOperation.none &&
          activeToken == generation &&
          desiredRunning &&
          !online &&
          failure == null,
      AppPhase.stopping => (operation == LifecycleOperation.stop ||
              operation == LifecycleOperation.reconcile) &&
          activeToken == generation &&
          !desiredRunning &&
          !online &&
          failure == null,
      AppPhase.failed => operation == LifecycleOperation.none &&
          activeToken == null &&
          !desiredRunning &&
          !online &&
          failure != null,
    };
    if (!coherent) {
      throw StateError(
          'zed-sync lifecycle: phase, operation, token, intent, connectivity, and failure disagree');
    }
  }
}

class AppCapabilities {
  final bool canStart;
  final bool canStop;
  final bool canWrite;
  final bool canReceiveChanges;
  final bool canFlush;
  final bool canReconcile;
  final bool busy;
  final bool running;

  AppCapabilities._(AppLifecycleSnapshot snapshot)
      : this._fromPhase(_validatedPhase(snapshot));

  AppCapabilities._fromPhase(AppPhase? phase)
      : canStart = phase == AppPhase.stopped,
        canStop = const {AppPhase.starting, AppPhase.online, AppPhase.offline}
            .contains(phase),
        canWrite = const {AppPhase.online, AppPhase.offline}.contains(phase),
        canReceiveChanges = const {
          AppPhase.starting,
          AppPhase.online,
          AppPhase.offline
        }.contains(phase),
        canFlush = phase == AppPhase.online,
        canReconcile = phase == AppPhase.failed,
        busy = const {AppPhase.starting, AppPhase.stopping}.contains(phase),
        running = const {AppPhase.online, AppPhase.offline}.contains(phase);

  static AppPhase? _validatedPhase(AppLifecycleSnapshot snapshot) {
    try {
      snapshot.validate();
      return snapshot.phase;
    } catch (_) {
      return null;
    }
  }
}

typedef LifecycleListener = void Function(
    AppLifecycleSnapshot snapshot, LifecycleEvent event);

class AppLifecycleMachine {
  static const maxSafeGeneration = 9007199254740991;

  AppLifecycleSnapshot _snapshot = const AppLifecycleSnapshot();
  final List<LifecycleListener> _listeners = [];

  AppLifecycleSnapshot get snapshot => _snapshot;
  AppCapabilities get capabilities => _snapshot.capabilities;

  /// Subscribe to applied transitions. The returned callback unsubscribes
  /// idempotently; observer exceptions never control state.
  void Function() subscribe(LifecycleListener listener) {
    _listeners.add(listener);
    var subscribed = true;
    return () {
      if (!subscribed) return;
      subscribed = false;
      _listeners.remove(listener);
    };
  }

  TransitionOutcome dispatch(LifecycleEvent event) {
    final before = _snapshot;
    AppLifecycleSnapshot? next;
    var outcome = TransitionOutcome.rejected;

    if (event is StartRequested) {
      if (before.phase == AppPhase.stopped &&
          before.generation < maxSafeGeneration) {
        final token = before.generation + 1;
        next = AppLifecycleSnapshot(
          phase: AppPhase.starting,
          operation: LifecycleOperation.start,
          generation: token,
          activeToken: token,
          desiredRunning: true,
        );
        outcome = TransitionOutcome.applied;
      }
    } else if (event is StartSucceeded) {
      switch (_tokenRelation(event.token)) {
        case _TokenRelation.stale:
          return TransitionOutcome.stale;
        case _TokenRelation.invalid:
          return TransitionOutcome.rejected;
        case _TokenRelation.current:
          break;
      }
      if (before.phase == AppPhase.starting) {
        next = _copy(
          before,
          phase: before.online ? AppPhase.online : AppPhase.offline,
          operation: LifecycleOperation.none,
        );
        outcome = TransitionOutcome.applied;
      }
    } else if (event is StartFailed) {
      switch (_tokenRelation(event.token)) {
        case _TokenRelation.stale:
          return TransitionOutcome.stale;
        case _TokenRelation.invalid:
          return TransitionOutcome.rejected;
        case _TokenRelation.current:
          break;
      }
      if (before.phase == AppPhase.starting) {
        next = _failed(LifecycleFailure.start);
        outcome = TransitionOutcome.applied;
      }
    } else if (event is ConnectivityChanged) {
      switch (_tokenRelation(event.token)) {
        case _TokenRelation.stale:
          return TransitionOutcome.stale;
        case _TokenRelation.invalid:
          return TransitionOutcome.rejected;
        case _TokenRelation.current:
          break;
      }
      if (const {AppPhase.starting, AppPhase.online, AppPhase.offline}
          .contains(before.phase)) {
        final phase = before.phase == AppPhase.starting
            ? AppPhase.starting
            : event.online
                ? AppPhase.online
                : AppPhase.offline;
        if (before.online == event.online && before.phase == phase) {
          outcome = TransitionOutcome.stuttered;
        } else {
          next = _copy(before, phase: phase, online: event.online);
          outcome = TransitionOutcome.applied;
        }
      }
    } else if (event is RuntimeFailed) {
      switch (_tokenRelation(event.token)) {
        case _TokenRelation.stale:
          return TransitionOutcome.stale;
        case _TokenRelation.invalid:
          return TransitionOutcome.rejected;
        case _TokenRelation.current:
          break;
      }
      if (const {AppPhase.starting, AppPhase.online, AppPhase.offline}
          .contains(before.phase)) {
        next = _failed(LifecycleFailure.runtime);
        outcome = TransitionOutcome.applied;
      }
    } else if (event is StopRequested) {
      if (const {AppPhase.stopped, AppPhase.stopping}.contains(before.phase)) {
        outcome = TransitionOutcome.stuttered;
      } else if (const {AppPhase.starting, AppPhase.online, AppPhase.offline}
          .contains(before.phase)) {
        next = _beginStop(LifecycleOperation.stop);
        outcome = next == null
            ? TransitionOutcome.rejected
            : TransitionOutcome.applied;
      }
    } else if (event is StopSucceeded) {
      switch (_tokenRelation(event.token)) {
        case _TokenRelation.stale:
          return TransitionOutcome.stale;
        case _TokenRelation.invalid:
          return TransitionOutcome.rejected;
        case _TokenRelation.current:
          break;
      }
      if (before.phase == AppPhase.stopping) {
        next = AppLifecycleSnapshot(generation: before.generation);
        outcome = TransitionOutcome.applied;
      }
    } else if (event is StopFailed) {
      switch (_tokenRelation(event.token)) {
        case _TokenRelation.stale:
          return TransitionOutcome.stale;
        case _TokenRelation.invalid:
          return TransitionOutcome.rejected;
        case _TokenRelation.current:
          break;
      }
      if (before.phase == AppPhase.stopping) {
        next = _failed(LifecycleFailure.stop);
        outcome = TransitionOutcome.applied;
      }
    } else if (event is ReconcileRequested) {
      if (before.phase == AppPhase.failed) {
        next = _beginStop(LifecycleOperation.reconcile);
        outcome = next == null
            ? TransitionOutcome.rejected
            : TransitionOutcome.applied;
      }
    }

    if (outcome == TransitionOutcome.applied) _commit(next!, event);
    return outcome;
  }

  _TokenRelation _tokenRelation(int token) => switch (token) {
        <= 0 => _TokenRelation.invalid,
        final candidate when _snapshot.activeToken == candidate =>
          _TokenRelation.current,
        final candidate when candidate <= _snapshot.generation =>
          _TokenRelation.stale,
        _ => _TokenRelation.invalid,
      };

  AppLifecycleSnapshot? _beginStop(LifecycleOperation operation) {
    if (_snapshot.generation >= maxSafeGeneration) return null;
    final token = _snapshot.generation + 1;
    return AppLifecycleSnapshot(
      phase: AppPhase.stopping,
      operation: operation,
      generation: token,
      activeToken: token,
    );
  }

  AppLifecycleSnapshot _failed(LifecycleFailure failure) =>
      AppLifecycleSnapshot(
        phase: AppPhase.failed,
        generation: _snapshot.generation,
        failure: failure,
      );

  AppLifecycleSnapshot _copy(
    AppLifecycleSnapshot source, {
    AppPhase? phase,
    LifecycleOperation? operation,
    bool? online,
  }) =>
      AppLifecycleSnapshot(
        phase: phase ?? source.phase,
        operation: operation ?? source.operation,
        generation: source.generation,
        activeToken: source.activeToken,
        desiredRunning: source.desiredRunning,
        online: online ?? source.online,
        failure: source.failure,
      );

  void _commit(AppLifecycleSnapshot next, LifecycleEvent event) {
    next.validate();
    _snapshot = next;
    for (final listener in List<LifecycleListener>.of(_listeners)) {
      try {
        listener(next, event);
      } catch (_) {
        // Observation must never control a lifecycle transition.
      }
    }
  }
}
