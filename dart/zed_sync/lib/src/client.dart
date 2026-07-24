// SyncClient — the mobile optimistic-write + reconcile surface. Mirrors the JS
// SyncClient. Persistence is injected via [SyncStorage] so the same client runs
// over Drift, Hive, Isar, or an atomic JSON file (see docs/); the core logic
// (core.dart) stays IO-free.

import 'core.dart';
import 'hlc.dart';
import 'policy.dart';

/// Locally stored row + its sync metadata.
class StoredRow {
  final Map<String, dynamic>? row;
  final Hlc version;
  final bool dirty;

  /// Local wall-clock ms when this device last adopted server state; null until
  /// it has. A dirty write preserves the previous value.
  final int? syncedAtMs;

  const StoredRow({required this.row, required this.version, required this.dirty, this.syncedAtMs});
}

/// A durable queued optimistic write awaiting acknowledgement.
class QueuedWrite {
  final String table;
  final String id;
  final Op op;
  final Map<String, dynamic>? payload;
  final Hlc baseVersion;
  final String key;
  const QueuedWrite(this.table, this.id, this.op, this.payload, this.baseVersion, this.key);
}

/// Persistence boundary. Implement over Drift/Hive/Isar or a JSON file.
abstract class SyncStorage {
  Future<StoredRow?> getRow(String table, String id);
  Future<void> putRow(String table, String id, StoredRow row);
  Future<void> enqueue(QueuedWrite write);
  Future<List<QueuedWrite>> pending();
  Future<void> retire(QueuedWrite write);
}

/// The outcome of a write, mirroring the JS WriteResult.status.
enum WriteStatus { acked, queued, local, failed }

class WriteResult {
  final WriteStatus status;
  final Hlc version;
  const WriteResult(this.status, this.version);
}

typedef SendChange = Future<Hlc> Function(ChangeEvent change);

class SyncClient {
  final SyncStorage storage;
  final String actor;
  final SendChange? send;
  final WriteMode writeMode;
  final ErrorPolicy errorPolicy;
  final ConflictResolution conflictResolution;
  final void Function(String event, Map<String, dynamic> attrs)? telemetry;
  final Clock _clock;
  int _keySeq = 0;

  SyncClient({
    required this.storage,
    required this.actor,
    this.send,
    this.writeMode = WriteMode.optimisticQueue,
    this.errorPolicy = ErrorPolicy.emitOnly,
    this.conflictResolution = ConflictResolution.serverWins,
    this.telemetry,
  }) : _clock = Clock(actor);

  String _nextKey() => '$actor-${DateTime.now().millisecondsSinceEpoch}-${_keySeq++}';

  void _emit(String event, [Map<String, dynamic> attrs = const {}]) => telemetry?.call(event, attrs);

  /// Apply an incoming change (from either transport) through reconcile.
  /// Returns "applied" | "ignored" | "conflict-resolved" | "refreshed".
  Future<String> applyChange(ChangeEvent incoming) async {
    _clock.observe(incoming.version);
    final existing = await storage.getRow(incoming.table, incoming.id);
    final local = existing == null ? null : LocalRow(existing.version, dirty: existing.dirty);
    final decision = reconcile(local, incoming);

    if (decision is Apply) {
      await _adopt(incoming);
      _emit('sync.change', {'table': incoming.table, 'id': incoming.id, 'outcome': 'applied'});
      return 'applied';
    }
    if (decision is Conflict) {
      final adopt = conflictResolution == ConflictResolution.serverWins ||
          incoming.version.compareTo(local!.version) > 0;
      if (adopt) {
        await _adopt(incoming);
        for (final w in await storage.pending()) {
          if (w.table == incoming.table && w.id == incoming.id) await storage.retire(w);
        }
        _emit('sync.change', {'table': incoming.table, 'id': incoming.id, 'outcome': 'conflict-resolved'});
        return 'conflict-resolved';
      }
    }
    // Ignore. Refresh the stored payload for an equal-version clean row so a
    // server-normalized echo cannot be hidden by a racing ack.
    if (existing != null && !existing.dirty && decision is Ignore && decision.reason == 'AlreadyApplied') {
      await _adopt(incoming);
      _emit('sync.change', {'table': incoming.table, 'id': incoming.id, 'outcome': 'refreshed'});
      return 'refreshed';
    }
    _emit('sync.change', {'table': incoming.table, 'id': incoming.id, 'outcome': 'ignored'});
    return 'ignored';
  }

  Future<void> _adopt(ChangeEvent incoming) => storage.putRow(
        incoming.table,
        incoming.id,
        StoredRow(
          row: incoming.op == Op.delete ? null : incoming.row,
          version: incoming.version,
          dirty: false,
          syncedAtMs: DateTime.now().millisecondsSinceEpoch,
        ),
      );

  /// Optimistically write a row. [mode]/[policy] override the client defaults.
  Future<WriteResult> write(
    String table,
    String id,
    Map<String, dynamic>? row, {
    Op op = Op.upsert,
    WriteMode? mode,
    ErrorPolicy? policy,
  }) async {
    final m = mode ?? writeMode;
    final p = policy ?? errorPolicy;
    final version = _clock.tick();
    final key = _nextKey();
    _emit('sync.write.start', {'table': table, 'id': id, 'op': op.name, 'mode': m.wire});

    if (m == WriteMode.serverFirst || m == WriteMode.serverOnly) {
      try {
        final committed = await _doSend(ChangeEvent(table: table, op: op, id: id, version: version, atMs: version.wallMs, row: row, writeKey: key));
        if (m == WriteMode.serverFirst) {
          await storage.putRow(table, id, StoredRow(row: row, version: committed, dirty: false, syncedAtMs: DateTime.now().millisecondsSinceEpoch));
        }
        _emit('sync.write.acked', {'table': table, 'id': id, 'via': 'server'});
        return WriteResult(WriteStatus.acked, committed);
      } catch (err) {
        _surface(err, {'table': table, 'id': id}, p);
        return WriteResult(WriteStatus.failed, version);
      }
    }

    final existing = await storage.getRow(table, id);
    await storage.putRow(table, id, StoredRow(row: row, version: version, dirty: true, syncedAtMs: existing?.syncedAtMs));
    final queued = QueuedWrite(table, id, op, row, version, key);
    await storage.enqueue(queued);
    _emit('sync.write.local', {'table': table, 'id': id});

    if (m == WriteMode.localOnly) return WriteResult(WriteStatus.local, version);

    try {
      final committed = await _doSend(ChangeEvent(table: table, op: op, id: id, version: version, atMs: version.wallMs, row: row, writeKey: key));
      final current = await storage.getRow(table, id);
      if (current != null && onAck(LocalRow(current.version), committed) != null) {
        await storage.putRow(table, id, StoredRow(row: current.row, version: committed, dirty: false, syncedAtMs: DateTime.now().millisecondsSinceEpoch));
      }
      await storage.retire(queued);
      _emit('sync.write.acked', {'table': table, 'id': id});
      return WriteResult(WriteStatus.acked, committed);
    } catch (err) {
      _emit('sync.write.queued', {'table': table, 'id': id});
      if (m == WriteMode.optimisticAwaitAck) _surface(err, {'table': table, 'id': id}, p);
      return WriteResult(WriteStatus.queued, version);
    }
  }

  /// Delete convenience — an optimistic delete (null payload) through the same
  /// queue path as [write]. Mirrors the JS client's delete().
  Future<WriteResult> delete(
    String table,
    String id, {
    WriteMode? mode,
    ErrorPolicy? policy,
  }) =>
      write(table, id, null, op: Op.delete, mode: mode, policy: policy);

  Future<Hlc> _doSend(ChangeEvent change) {
    final s = send;
    if (s == null) throw StateError('no send transport configured');
    return s(change);
  }

  void _surface(Object err, Map<String, dynamic> ctx, ErrorPolicy policy) {
    if (policy.shouldEmit) _emit('sync.write.failed', {...ctx, 'error': err.toString()});
    if (policy.shouldThrow) throw err;
  }

  /// Re-send everything still queued (on reconnect) under the original keys.
  Future<int> flushQueue() async {
    _emit('sync.flush.start');
    var sent = 0;
    for (final w in await storage.pending()) {
      try {
        final committed = await _doSend(ChangeEvent(table: w.table, op: w.op, id: w.id, version: w.baseVersion, atMs: w.baseVersion.wallMs, row: w.payload, writeKey: w.key));
        final current = await storage.getRow(w.table, w.id);
        if (current != null && onAck(LocalRow(current.version), committed) != null) {
          await storage.putRow(w.table, w.id, StoredRow(row: current.row, version: committed, dirty: false, syncedAtMs: DateTime.now().millisecondsSinceEpoch));
        }
        await storage.retire(w);
        sent++;
      } catch (_) {
        break; // retried next reconnect
      }
    }
    _emit('sync.flush.done', {'sent': sent});
    return sent;
  }
}
