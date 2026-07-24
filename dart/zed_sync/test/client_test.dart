// SyncClient IO behavior over the shipped in-memory storage: the MemoryStorage
// adapter, the delete() convenience, and the equal-version "refreshed" reconcile
// path — the Dart mirror of sdk/test/client.test.mjs (kept separate from the
// shared-fixture conformance suite in conformance_test.dart).

import 'package:test/test.dart';
import 'package:zed_sync/zed_sync.dart';

SyncClient _client(MemoryStorage store, List<ChangeEvent> sent) => SyncClient(
      storage: store,
      actor: 'dev-1',
      send: (c) async {
        sent.add(c);
        // Server commits at a higher HLC than the client's base.
        return Hlc(c.version.wallMs + 1000, 0, 'srv');
      },
    );

void main() {
  test('MemoryStorage keeps rows and an ordered queue retired by write key', () async {
    final store = MemoryStorage();
    expect(await store.getRow('products', 'p1'), isNull);

    await store.putRow('products', 'p1',
        const StoredRow(row: {'id': 'p1', 'n': 1}, version: Hlc(100, 0, 'srv'), dirty: false));
    final got = await store.getRow('products', 'p1');
    expect(got, isNotNull);
    expect(got!.row!['n'], 1);

    await store.enqueue(const QueuedWrite('products', 'p1', Op.upsert, null, Hlc(100, 0, 'dev'), 'k1'));
    await store.enqueue(const QueuedWrite('products', 'p2', Op.upsert, null, Hlc(101, 0, 'dev'), 'k2'));
    final pending = await store.pending();
    expect(pending.map((w) => w.key), ['k1', 'k2'], reason: 'insertion order preserved');

    await store.retire(const QueuedWrite('products', 'p1', Op.upsert, null, Hlc(100, 0, 'dev'), 'k1'));
    final after = await store.pending();
    expect(after.single.key, 'k2', reason: 'retired by key');
  });

  test('delete() optimistically writes a null-row tombstone through the queue', () async {
    final store = MemoryStorage();
    final sent = <ChangeEvent>[];
    final client = _client(store, sent);

    await client.write('products', 'p1', {'id': 'p1', 'n': 1});
    final res = await client.delete('products', 'p1');

    expect(res.status, WriteStatus.acked);
    expect(sent.last.op, Op.delete);
    expect(sent.last.row, isNull, reason: 'delete sends a null payload');
    final row = await store.getRow('products', 'p1');
    expect(row, isNotNull);
    expect(row!.row, isNull, reason: 'delete stores a null-row tombstone');
    expect(row.dirty, isFalse, reason: 'adopted clean after ack');
    expect((await store.pending()).isEmpty, isTrue, reason: 'queue drained');
  });

  test('applyChange refreshes an equal-version clean row', () async {
    final store = MemoryStorage();
    final client = SyncClient(storage: store, actor: 'dev-1');
    const version = Hlc(100, 0, 'srv');

    await client.applyChange(ChangeEvent(
        table: 'products', op: Op.upsert, id: 'p1', version: version, atMs: 100, row: {'id': 'p1', 'n': 1}));
    // Same version, server-normalized payload -> refreshed (not ignored).
    final outcome = await client.applyChange(ChangeEvent(
        table: 'products',
        op: Op.upsert,
        id: 'p1',
        version: version,
        atMs: 100,
        row: {'id': 'p1', 'n': 1, 'normalized': true}));

    expect(outcome, 'refreshed');
    final row = await store.getRow('products', 'p1');
    expect(row!.row!['normalized'], true, reason: 'stored payload refreshed at equal version');
  });

  test('applyChange does not refresh a dirty equal-version row', () async {
    final store = MemoryStorage();
    final client = SyncClient(
      storage: store,
      actor: 'dev-1',
      send: (_) async {
        throw StateError('offline');
      },
    );

    final res = await client.write('products', 'p1', {'id': 'p1', 'n': 1});
    expect(res.status, WriteStatus.queued);
    final local = await store.getRow('products', 'p1');

    final outcome = await client.applyChange(ChangeEvent(
        table: 'products', op: Op.upsert, id: 'p1', version: local!.version, atMs: 1, row: {'id': 'p1', 'server': true}));

    expect(outcome, 'ignored', reason: 'dirty local is never silently refreshed');
    final after = await store.getRow('products', 'p1');
    expect(after!.row!['server'], isNull, reason: 'dirty payload preserved');
    expect(after.dirty, isTrue);
  });
}
