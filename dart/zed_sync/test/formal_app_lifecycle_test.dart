// Exact refinement replay for formal/app_lifecycle.qnt. Rust and JavaScript
// consume this same trace corpus so platform lifecycle reducers cannot drift.

import 'dart:convert';
import 'dart:io';

import 'package:test/test.dart';
import 'package:zed_sync/zed_sync.dart';

Map<String, dynamic> _loadFixture() {
  var dir = Directory.current;
  for (var i = 0; i < 6; i++) {
    final file = File('${dir.path}/protocol/formal-app-lifecycle.json');
    if (file.existsSync()) {
      return jsonDecode(file.readAsStringSync()) as Map<String, dynamic>;
    }
    dir = dir.parent;
  }
  fail('could not locate protocol/formal-app-lifecycle.json');
}

LifecycleEvent _event(Map<String, dynamic> event) {
  final token = event['token'] as int?;
  return switch (event['type']) {
    'start_requested' => const StartRequested(),
    'start_succeeded' => StartSucceeded(token!),
    'start_failed' => StartFailed(token!),
    'connectivity_changed' =>
      ConnectivityChanged(token!, event['online'] as bool),
    'runtime_failed' => RuntimeFailed(token!),
    'stop_requested' => const StopRequested(),
    'stop_succeeded' => StopSucceeded(token!),
    'stop_failed' => StopFailed(token!),
    'reconcile_requested' => const ReconcileRequested(),
    final other => throw StateError('unknown fixture event $other'),
  };
}

void main() {
  final fixture = _loadFixture();

  test('Dart replays every formal app-lifecycle trace', () {
    expect(fixture['schema_version'], 1);
    expect(fixture['model'], 'app-lifecycle-v1');
    final cases = (fixture['cases'] as List).cast<Map<String, dynamic>>();
    expect(cases.length, greaterThanOrEqualTo(6));
    final covered = <String>{};
    final outcomes = <String>{};

    for (final c in cases) {
      final machine = AppLifecycleMachine();
      for (final rawStep in c['steps'] as List) {
        final step = rawStep as Map<String, dynamic>;
        final event = step['event'] as Map<String, dynamic>;
        covered.add(event['type'] as String);
        final outcome = machine.dispatch(_event(event));
        outcomes.add(outcome.name);
        expect(outcome.name, step['outcome'], reason: c['name'] as String);
        expect(machine.snapshot.toJson(), step['state'],
            reason: c['name'] as String);
        expect(machine.snapshot.validate, returnsNormally,
            reason: c['name'] as String);
      }
    }

    expect(
        covered,
        containsAll([
          'start_requested',
          'start_succeeded',
          'start_failed',
          'connectivity_changed',
          'runtime_failed',
          'stop_requested',
          'stop_succeeded',
          'stop_failed',
          'reconcile_requested',
        ]));
    expect(
        outcomes, containsAll(['applied', 'stuttered', 'stale', 'rejected']));
  });

  test('stale completion cannot resurrect a stopping mobile session', () {
    final machine = AppLifecycleMachine();
    machine.dispatch(const StartRequested());
    final startToken = machine.snapshot.activeToken!;
    final starting = machine.snapshot;
    expect(
        machine.dispatch(const StartSucceeded(0)), TransitionOutcome.rejected);
    expect(identical(machine.snapshot, starting), isTrue);
    expect(machine.dispatch(StartSucceeded(startToken + 1)),
        TransitionOutcome.rejected);
    expect(identical(machine.snapshot, starting), isTrue);

    machine.dispatch(const StopRequested());
    final stopping = machine.snapshot;
    expect(
        machine.dispatch(StartSucceeded(startToken)), TransitionOutcome.stale);
    expect(identical(machine.snapshot, stopping), isTrue);
  });

  test('malformed foreign snapshots have no capabilities', () {
    const malformed = AppLifecycleSnapshot(
      phase: AppPhase.online,
      generation: 1,
      online: true,
    );

    expect(malformed.validate, throwsStateError);
    final capabilities = malformed.capabilities;
    expect(capabilities.canStart, isFalse);
    expect(capabilities.canStop, isFalse);
    expect(capabilities.canWrite, isFalse);
    expect(capabilities.canReceiveChanges, isFalse);
    expect(capabilities.canFlush, isFalse);
    expect(capabilities.canReconcile, isFalse);
    expect(capabilities.busy, isFalse);
    expect(capabilities.running, isFalse);
  });
}
