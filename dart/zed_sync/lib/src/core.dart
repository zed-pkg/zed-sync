// The reconciliation core, in Dart — a faithful mirror of src/lib.rs and
// sdk/src/core.mjs, validated against the SAME protocol/conformance.json.

import 'hlc.dart';

enum Op { upsert, delete }

Op opFromWire(String s) => s == 'delete' ? Op.delete : Op.upsert;

class ChangeEvent {
  final String table;
  final Op op;
  final String id;
  final Hlc version;
  final Map<String, dynamic>? row;
  final int atMs;
  final String? writeKey;
  final int? syncSequence;

  const ChangeEvent({
    required this.table,
    required this.op,
    required this.id,
    required this.version,
    required this.atMs,
    this.row,
    this.writeKey,
    this.syncSequence,
  });

  factory ChangeEvent.fromJson(Map<String, dynamic> j) => ChangeEvent(
        table: j['table'] as String,
        op: opFromWire(j['op'] as String),
        id: j['id'] as String,
        version: Hlc.fromJson(j['version'] as Map<String, dynamic>),
        row: j['row'] as Map<String, dynamic>?,
        atMs: (j['at_ms'] as num).toInt(),
        writeKey: j['write_key'] as String?,
        syncSequence: (j['sync_sequence'] as num?)?.toInt(),
      );
}

class LocalRow {
  final Hlc version;
  final bool dirty;
  const LocalRow(this.version, {this.dirty = false});

  factory LocalRow.fromJson(Map<String, dynamic> j) =>
      LocalRow(Hlc.fromJson(j['version'] as Map<String, dynamic>),
          dirty: j['dirty'] as bool? ?? false);
}

/// The reconcile decision, encoded to match the shared fixture:
/// "Apply" | {"Ignore": "Stale"|"AlreadyApplied"} | "Conflict".
sealed class Reconcile {
  const Reconcile();
  dynamic toFixture();
}

class Apply extends Reconcile {
  const Apply();
  @override
  dynamic toFixture() => 'Apply';
}

class Conflict extends Reconcile {
  const Conflict();
  @override
  dynamic toFixture() => 'Conflict';
}

class Ignore extends Reconcile {
  final String reason; // "Stale" | "AlreadyApplied"
  const Ignore(this.reason);
  @override
  dynamic toFixture() => {'Ignore': reason};
}

/// Pure reconciliation — depends only on (local.version, local.dirty,
/// incoming.version, incoming.op).
Reconcile reconcile(LocalRow? local, ChangeEvent incoming) {
  if (local == null) {
    return incoming.op == Op.upsert
        ? const Apply()
        : const Ignore('AlreadyApplied');
  }
  final cmp = incoming.version.compareTo(local.version);
  if (cmp < 0) return const Ignore('Stale');
  if (cmp == 0) return const Ignore('AlreadyApplied');
  return local.dirty ? const Conflict() : const Apply();
}

/// Settle an HTTP ack: adopt unless local already advanced past it.
/// Returns the adopted [Hlc], or null for "Superseded".
Hlc? onAck(LocalRow local, Hlc committedVersion) =>
    local.version.compareTo(committedVersion) > 0 ? null : committedVersion;

/// Queue-aware ack settlement shared with the Rust and JavaScript cores.
///
/// [retireCurrentSlot] is true only when the immutable key and local base
/// version still identify the settling request. [adopt] carries the committed
/// version for that same safe transition.
class QueuedAckSettlement {
  final Hlc? adopt;
  final bool retireCurrentSlot;
  const QueuedAckSettlement(this.adopt, this.retireCurrentSlot);
}

QueuedAckSettlement settleQueuedAck({
  required LocalRow local,
  required String currentId,
  required String currentKey,
  required String settlingKey,
  required Hlc baseVersion,
  required String ackId,
  required Hlc committedVersion,
}) {
  final exactSlot = currentId == ackId && currentKey == settlingKey;
  if (!exactSlot || local.version.compareTo(baseVersion) != 0) {
    return const QueuedAckSettlement(null, false);
  }
  final adopted = onAck(local, committedVersion);
  return QueuedAckSettlement(adopted, adopted != null);
}

/// True when [incoming] is the realtime echo of this queued write.
bool isOwnEcho(
        {required String table,
        required String id,
        required Op op,
        required String key,
        required ChangeEvent incoming}) =>
    incoming.table == table &&
    incoming.id == id &&
    incoming.op == op &&
    incoming.writeKey == key;
