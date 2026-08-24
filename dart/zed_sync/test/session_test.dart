import 'dart:async';

import 'package:test/test.dart';
import 'package:zed_sync/zed_sync.dart';

SyncClient _client() => SyncClient(
      storage: MemoryStorage(),
      actor: 'mobile-1',
      send: (_) async => throw StateError('offline'),
    );

void main() {
  test('mobile session gates a retained client before start and after stop',
      () async {
    var deactivations = 0;
    final session = SyncSession(
      client: _client(),
      activate: () async => false,
      deactivate: () async {
        deactivations++;
      },
    );

    await expectLater(
      session.client.write('notes', 'n0', {'id': 'n0'}),
      throwsStateError,
    );
    await session.start();
    expect(session.snapshot.phase, AppPhase.offline);
    expect(session.capabilities.canWrite, isTrue);
    final result = await session.client.write('notes', 'n1', {'id': 'n1'});
    expect(result.status, WriteStatus.queued);

    await session.stop();
    expect(session.snapshot.phase, AppPhase.stopped);
    expect(deactivations, 1);
    await expectLater(
      session.client.write('notes', 'n2', {'id': 'n2'}),
      throwsStateError,
    );
  });

  test('stop during startup wins over the stale mobile completion', () async {
    final activated = Completer<bool>();
    var deactivations = 0;
    final session = SyncSession(
      client: _client(),
      activate: () => activated.future,
      deactivate: () async {
        deactivations++;
      },
    );

    final starting = session.start();
    expect(session.snapshot.phase, AppPhase.starting);
    await session.stop();
    expect(session.snapshot.phase, AppPhase.stopped);

    activated.complete(true);
    await expectLater(starting, throwsStateError);
    expect(session.snapshot.phase, AppPhase.stopped,
        reason: 'the old startup token cannot resurrect the session');
    expect(deactivations, 2,
        reason: 'late-created effects receive an idempotent cleanup pass');
  });

  test('runtime failure closes capabilities until stop reconciles', () async {
    var deactivations = 0;
    final session = SyncSession(
      client: _client(),
      activate: () async => true,
      deactivate: () async {
        deactivations++;
      },
    );
    await session.start();
    expect(session.snapshot.phase, AppPhase.online);

    await session.failRuntime();
    expect(session.snapshot.phase, AppPhase.failed);
    expect(session.capabilities.canWrite, isFalse);
    expect(session.capabilities.canReconcile, isTrue);

    await session.stop();
    expect(session.snapshot.phase, AppPhase.stopped);
    expect(deactivations, 2);
  });
}
