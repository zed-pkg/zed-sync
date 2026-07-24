// An in-memory [SyncStorage] — the Dart mirror of the JS MemoryStore
// (sdk/src/store.mjs). Rows live in a keyed map; the durable optimistic
// write-queue is an ordered list retired by write key. Ships as the zero-config
// default so the package runs and is testable out of the box — swap in a
// Drift/Hive/Isar (or atomic-JSON-file) adapter for real persistence.

import 'client.dart';

String _rowKey(String table, String id) => '$table $id';

/// In-memory [SyncStorage] — used by the Dart test suite and as a fallback.
class MemoryStorage implements SyncStorage {
  final Map<String, StoredRow> _rows = {};
  final List<QueuedWrite> _queue = [];

  @override
  Future<StoredRow?> getRow(String table, String id) async => _rows[_rowKey(table, id)];

  @override
  Future<void> putRow(String table, String id, StoredRow row) async {
    _rows[_rowKey(table, id)] = row;
  }

  @override
  Future<void> enqueue(QueuedWrite write) async {
    _queue.add(write);
  }

  @override
  Future<List<QueuedWrite>> pending() async => List.of(_queue);

  @override
  Future<void> retire(QueuedWrite write) async {
    _queue.removeWhere((w) => w.key == write.key);
  }
}
