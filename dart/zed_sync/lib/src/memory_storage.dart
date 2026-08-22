// An in-memory [SyncStorage] — the Dart mirror of the JS MemoryStore
// (sdk/src/store.mjs). Rows live in a keyed map; the durable optimistic
// write-queue is an ordered list retired by write key. Ships as the zero-config
// default so the package runs and is testable out of the box — swap in a
// Drift/Hive/Isar (or atomic-JSON-file) adapter for real persistence.

import 'client.dart';
import 'core.dart';
import 'hlc.dart';

String _rowKey(String table, String id) => '$table $id';

/// In-memory [SyncStorage] — used by the Dart test suite and as a fallback.
class MemoryStorage implements SyncStorage {
  final Map<String, StoredRow> _rows = {};
  final List<QueuedWrite> _queue = [];

  @override
  Future<StoredRow?> getRow(String table, String id) async =>
      _rows[_rowKey(table, id)];

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

  @override
  Future<StoredAckSettlement> settleAck(
      QueuedWrite write, Hlc committedVersion) async {
    final index = _queue.indexWhere((w) =>
        w.table == write.table && w.id == write.id && w.key == write.key);
    final current = _rows[_rowKey(write.table, write.id)];
    if (index < 0 || current == null) {
      return const StoredAckSettlement(retired: false, adopted: false);
    }

    final currentQueued =
        _queue.lastWhere((w) => w.table == write.table && w.id == write.id);
    final settlement = settleQueuedAck(
      local: LocalRow(current.version, dirty: current.dirty),
      currentId: currentQueued.id,
      currentKey: currentQueued.key,
      settlingKey: write.key,
      baseVersion: write.baseVersion,
      ackId: write.id,
      committedVersion: committedVersion,
    );
    if (!settlement.retireCurrentSlot) {
      // Dart keeps independent queue entries instead of coalescing them. A
      // superseded historical request can be retired by its own key while the
      // newest slot for the row remains dirty and retryable.
      if (currentQueued.key != write.key) {
        _queue.removeAt(index);
        return const StoredAckSettlement(retired: true, adopted: false);
      }
      return const StoredAckSettlement(retired: false, adopted: false);
    }

    _queue.removeAt(index);
    final adopted = settlement.adopt;
    if (adopted != null) {
      _rows[_rowKey(write.table, write.id)] = StoredRow(
        row: current.row,
        version: adopted,
        dirty: false,
        syncedAtMs: DateTime.now().millisecondsSinceEpoch,
      );
    }
    return StoredAckSettlement(retired: true, adopted: adopted != null);
  }
}
