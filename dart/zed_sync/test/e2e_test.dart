// E2E for the Dart runtime: the SyncClient's optimistic-write lifecycle and
// reconcile path driven against a small in-memory sync server, mirroring the JS
// e2e suites (sdk/test/e2e_*). Covers every WriteMode + ErrorPolicy surface,
// conflict resolution, offline queue -> flush, two-device convergence, delete
// tombstones, and the synced_at / HLC stamping contract. Dart ships no transport
// layer (send is injected), so "the server" is this fixture; the CLIENT under
// test is the production client.dart / core.dart / hlc.dart.

import 'package:test/test.dart';
import 'package:zed_sync/zed_sync.dart';

/// In-memory mirror of the sync server: monotonic per-row updated_at, a
/// server-authored HLC ("pg"), write_key idempotency, and a delete tombstone one
/// tick past the row's last version. Enough to exercise the client end to end.
class SimServer {
  final Map<String, ({Map<String, dynamic> row, Hlc version, int updatedAt})>
      _rows = {};
  final Map<String, Hlc> _byKey = {};
  int _wall = 0;

  int _now() {
    final t = DateTime.now().millisecondsSinceEpoch;
    _wall = t > _wall ? t : _wall + 1;
    return _wall;
  }

  /// Commit a client write and return (committed version, feedable ChangeEvent).
  ({Hlc version, ChangeEvent change}) commit(ChangeEvent c) {
    if (c.writeKey != null && _byKey.containsKey(c.writeKey)) {
      final v = _byKey[c.writeKey]!;
      return (
        version: v,
        change: _feed(c.table, c.op, c.id, v, c.op == Op.delete ? null : c.row,
            c.writeKey)
      );
    }
    final k = '${c.table} ${c.id}';
    final prev = _rows[k];
    final updated =
        _now() > (prev?.updatedAt ?? 0) ? _now() : (prev?.updatedAt ?? 0) + 1;
    Hlc version;
    Map<String, dynamic>? payload;
    if (c.op == Op.delete) {
      final base = prev?.version ?? Hlc(updated, 0, 'pg');
      version = Hlc(base.wallMs, base.counter + 1, 'pg');
      _rows.remove(k);
      payload = null;
    } else {
      final wall = prev != null && prev.version.wallMs > updated
          ? prev.version.wallMs
          : updated;
      final counter = prev != null && prev.version.wallMs == wall
          ? prev.version.counter + 1
          : 0;
      version = Hlc(wall, counter, 'pg');
      payload = {...?c.row, 'id': c.id, 'sync_version': version.toJson()};
      _rows[k] = (row: payload, version: version, updatedAt: updated);
    }
    if (c.writeKey != null) _byKey[c.writeKey!] = version;
    return (
      version: version,
      change: _feed(c.table, c.op, c.id, version, payload, c.writeKey)
    );
  }

  ChangeEvent _feed(String table, Op op, String id, Hlc v,
          Map<String, dynamic>? row, String? key) =>
      ChangeEvent(
          table: table,
          op: op,
          id: id,
          version: v,
          atMs: v.wallMs,
          row: row,
          writeKey: key);

  Map<String, dynamic>? currentRow(String table, String id) =>
      _rows['$table $id']?.row;
}

/// Wire a client's `send` to a server so writes commit and (optionally) feed the
/// committed change back to a list of peers' applyChange.
SyncClient connect(
  SimServer server, {
  required String actor,
  WriteMode writeMode = WriteMode.optimisticQueue,
  ErrorPolicy errorPolicy = ErrorPolicy.emitOnly,
  ConflictResolution conflictResolution = ConflictResolution.serverWins,
  List<SyncClient> Function()? peers,
  bool Function()? online,
  void Function(String, Map<String, dynamic>)? telemetry,
}) {
  late final SyncClient client;
  client = SyncClient(
    storage: MemoryStorage(),
    actor: actor,
    writeMode: writeMode,
    errorPolicy: errorPolicy,
    conflictResolution: conflictResolution,
    telemetry: telemetry,
    send: (change) async {
      if (online != null && !online()) throw StateError('offline');
      final res = server.commit(change);
      // Live-feed the committed change to every peer AND back to the writer.
      for (final p in [client, ...?peers?.call()]) {
        if (!identical(p, client)) await p.applyChange(res.change);
      }
      return res.version;
    },
  );
  return client;
}

/// Domain projection of a stored row (server-managed columns stripped).
Map<String, dynamic>? domain(StoredRow? r) {
  if (r == null || r.row == null) return null;
  return {
    for (final e in r.row!.entries)
      if (e.key != 'sync_version') e.key: e.value
  };
}

void main() {
  group('WriteMode', () {
    test('optimisticQueue applies locally, sends, and adopts the server HLC',
        () async {
      final s = SimServer();
      final c = connect(s, actor: 'dev-1');
      final res = await c.write('products', 'p1', {'id': 'p1', 'name': 'Ball'});
      expect(res.status, WriteStatus.acked);
      expect(res.version.actor, 'pg',
          reason: 'adopted the server-committed HLC');
      final row = await c.storage.getRow('products', 'p1');
      expect(row!.dirty, isFalse);
      expect((await c.storage.pending()).isEmpty, isTrue,
          reason: 'queue drained on ack');
    });

    test('localOnly applies + enqueues but never sends', () async {
      final s = SimServer();
      final sent = <ChangeEvent>[];
      final c = SyncClient(
          storage: MemoryStorage(),
          actor: 'dev-1',
          send: (ch) async {
            sent.add(ch);
            return s.commit(ch).version;
          });
      final res = await c.write('products', 'p1', {'id': 'p1'},
          mode: WriteMode.localOnly);
      expect(res.status, WriteStatus.local);
      expect(sent, isEmpty);
      expect((await c.storage.pending()).length, 1);
      expect((await c.storage.getRow('products', 'p1'))!.dirty, isTrue);
    });

    test(
        'serverFirst commits before storing, and stores clean at the committed version',
        () async {
      final s = SimServer();
      final c = connect(s, actor: 'dev-1', writeMode: WriteMode.serverFirst);
      final res = await c.write('products', 'p1', {'id': 'p1', 'name': 'sf'});
      expect(res.status, WriteStatus.acked);
      expect(res.version.actor, 'pg');
      final row = await c.storage.getRow('products', 'p1');
      expect(row!.dirty, isFalse);
      expect((await c.storage.pending()).isEmpty, isTrue);
    });

    test('serverOnly never stores locally on the write path', () async {
      final s = SimServer();
      final c = connect(s, actor: 'dev-1', writeMode: WriteMode.serverOnly);
      final res = await c.write('products', 'p1', {'id': 'p1'});
      expect(res.status, WriteStatus.acked);
      expect(await c.storage.getRow('products', 'p1'), isNull);
      expect((await c.storage.pending()).isEmpty, isTrue);
    });
  });

  group('ErrorPolicy on an offline send', () {
    Future<SyncClient> offline(ErrorPolicy p,
        {WriteMode mode = WriteMode.optimisticAwaitAck,
        List<String>? emitted}) async {
      return SyncClient(
        storage: MemoryStorage(),
        actor: 'dev-1',
        writeMode: mode,
        errorPolicy: p,
        telemetry: (e, a) {
          if (e == 'sync.write.failed') emitted?.add(e);
        },
        send: (_) async => throw StateError('offline'),
      );
    }

    test('throwOnly rejects the write', () async {
      final c = await offline(ErrorPolicy.throwOnly);
      await expectLater(
          c.write('t', 'i', {'id': 'i'}), throwsA(isA<StateError>()));
      expect((await c.storage.pending()).length, 1,
          reason: 'still durably queued');
    });

    test('emitOnly reports via telemetry and resolves as queued', () async {
      final emitted = <String>[];
      final c = await offline(ErrorPolicy.emitOnly, emitted: emitted);
      final res = await c.write('t', 'i', {'id': 'i'});
      expect(res.status, WriteStatus.queued);
      expect(emitted, contains('sync.write.failed'));
    });

    test('silent neither throws nor emits', () async {
      final emitted = <String>[];
      final c = await offline(ErrorPolicy.silent, emitted: emitted);
      final res = await c.write('t', 'i', {'id': 'i'});
      expect(res.status, WriteStatus.queued);
      expect(emitted, isEmpty);
    });

    test(
        'optimisticQueue swallows the send error and keeps it queued regardless of policy',
        () async {
      final c =
          await offline(ErrorPolicy.throwOnly, mode: WriteMode.optimisticQueue);
      final res = await c
          .write('t', 'i', {'id': 'i'}); // must NOT throw under optimisticQueue
      expect(res.status, WriteStatus.queued);
    });
  });

  group('conflict resolution', () {
    // Incoming versions are constructed explicitly relative to the dirty local
    // version so the outcome is deterministic (no wall-clock race).
    test(
        'serverWins: a strictly-newer server change overrides a dirty local edit and drops its queued write',
        () async {
      final s = SimServer();
      final b = connect(s,
          actor: 'dev-B', conflictResolution: ConflictResolution.serverWins);
      // Clean baseline via the feed.
      await b.applyChange(ChangeEvent(
          table: 'docs',
          op: Op.upsert,
          id: 'd1',
          version: const Hlc(1000, 0, 'pg'),
          atMs: 1000,
          row: {'id': 'd1', 'title': 'orig'}));
      // B edits locally offline -> dirty, queued.
      await b.write('docs', 'd1', {'id': 'd1', 'title': 'B draft'},
          mode: WriteMode.localOnly);
      final dirty = (await b.storage.getRow('docs', 'd1'))!.version;
      expect((await b.storage.pending()).length, 1);
      // A strictly-newer server change arrives.
      final incoming = Hlc(dirty.wallMs + 1000, 0, 'pg');
      final outcome = await b.applyChange(ChangeEvent(
          table: 'docs',
          op: Op.upsert,
          id: 'd1',
          version: incoming,
          atMs: incoming.wallMs,
          row: {'id': 'd1', 'title': 'A wins'}));
      expect(outcome, 'conflict-resolved');
      expect(domain(await b.storage.getRow('docs', 'd1')),
          {'id': 'd1', 'title': 'A wins'});
      expect((await b.storage.pending()).isEmpty, isTrue,
          reason: 'conflicting queued write dropped');
    });

    test(
        'a newer local dirty edit survives a stale server echo (stale-ignore, not clobber)',
        () async {
      final s = SimServer();
      final a = connect(s, actor: 'dev-A');
      await a.write('docs', 'd1', {'id': 'd1', 'v': 1}); // acked, clean
      await a.write('docs', 'd1', {'id': 'd1', 'v': 2},
          mode: WriteMode.localOnly); // dirty, newer
      final dirty = (await a.storage.getRow('docs', 'd1'))!.version;
      // A stale (older) server echo arrives.
      final stale = Hlc(dirty.wallMs - 1000, 0, 'pg');
      final outcome = await a.applyChange(ChangeEvent(
          table: 'docs',
          op: Op.upsert,
          id: 'd1',
          version: stale,
          atMs: stale.wallMs,
          row: {'id': 'd1', 'v': 0}));
      expect(outcome, 'ignored');
      expect(domain(await a.storage.getRow('docs', 'd1')), {'id': 'd1', 'v': 2},
          reason: 'newer local edit preserved');
      expect((await a.storage.pending()).length, 1,
          reason: 'the edit is still queued to send');
    });
  });

  group('offline + convergence', () {
    test(
        'offline writes queue, then flushQueue drains them and a peer converges',
        () async {
      final s = SimServer();
      var up = false;
      final b = connect(s, actor: 'dev-B');
      final a = connect(s, actor: 'dev-A', online: () => up, peers: () => [b]);

      final r1 = await a.write('notes', 'n1', {'id': 'n1', 't': 'first'});
      final r2 = await a.write('notes', 'n2', {'id': 'n2', 't': 'second'});
      expect(r1.status, WriteStatus.queued);
      expect(r2.status, WriteStatus.queued);
      expect((await a.storage.pending()).length, 2);

      up = true;
      final sent = await a.flushQueue();
      expect(sent, 2);
      expect((await a.storage.pending()).isEmpty, isTrue);
      expect(domain(await b.storage.getRow('notes', 'n1')),
          {'id': 'n1', 't': 'first'});
      expect(domain(await b.storage.getRow('notes', 'n2')),
          {'id': 'n2', 't': 'second'});
    });

    test(
        'two devices converge on the same row and version; delete tombstone wins',
        () async {
      final s = SimServer();
      final b = connect(s, actor: 'dev-B');
      final a = connect(s, actor: 'dev-A', peers: () => [b]);

      await a.write('items', 'k1', {'id': 'k1', 'n': 1});
      expect(
          domain(await b.storage.getRow('items', 'k1')), {'id': 'k1', 'n': 1});
      final av = (await a.storage.getRow('items', 'k1'))!.version;
      final bv = (await b.storage.getRow('items', 'k1'))!.version;
      expect(av.compareTo(bv), 0,
          reason: 'both devices hold the identical committed HLC');

      await a.delete('items', 'k1');
      expect((await a.storage.getRow('items', 'k1'))!.row, isNull);
      expect((await b.storage.getRow('items', 'k1'))!.row, isNull,
          reason: 'delete tombstone propagated');
    });
  });

  group('timestamps', () {
    test('synced_at is stamped on adopt and preserved across a dirty edit',
        () async {
      final s = SimServer();
      final c = connect(s, actor: 'dev-1');
      await c.write('e', 'e1', {'id': 'e1', 'n': 1});
      final synced = await c.storage.getRow('e', 'e1');
      expect(synced!.dirty, isFalse);
      expect(synced.syncedAtMs, isNotNull);
      final first = synced.syncedAtMs;

      await c.write('e', 'e1', {'id': 'e1', 'n': 2}, mode: WriteMode.localOnly);
      final dirty = await c.storage.getRow('e', 'e1');
      expect(dirty!.dirty, isTrue);
      expect(dirty.syncedAtMs, first,
          reason: 'a dirty edit preserves the prior synced_at');
    });
  });
}
