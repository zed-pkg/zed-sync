// Hybrid Logical Clock — the Dart mirror of src/hlc.rs and sdk/src/hlc.mjs.
// Same total order (wallMs, counter, actor) and same sortable encoding.

class Hlc {
  final int wallMs;
  final int counter;
  final String actor;

  const Hlc(this.wallMs, this.counter, this.actor);

  factory Hlc.fromJson(Map<String, dynamic> json) => Hlc(
        (json['wall_ms'] as num).toInt(),
        (json['counter'] as num?)?.toInt() ?? 0,
        (json['actor'] ?? 'srv').toString(),
      );

  Map<String, dynamic> toJson() => {'wall_ms': wallMs, 'counter': counter, 'actor': actor};

  /// Total order: wallMs, then counter, then actor.
  int compareTo(Hlc other) {
    if (wallMs != other.wallMs) return wallMs < other.wallMs ? -1 : 1;
    if (counter != other.counter) return counter < other.counter ? -1 : 1;
    return actor.compareTo(other.actor);
  }

  /// Sortable canonical string, e.g. "0197f3b2c4d1-0003".
  String encode() {
    final wall = (wallMs % 0x1000000000000).toRadixString(16).padLeft(12, '0');
    final ctr = (counter % 0x10000).toRadixString(16).padLeft(4, '0');
    return '$wall-$ctr';
  }
}

/// Reject a remote stamp whose wall clock runs more than this far ahead of ours
/// (5 minutes). Mirrors MAX_DRIFT_MS in src/hlc.rs and sdk/src/hlc.mjs. Without
/// the bound one attacker-controlled far-future wallMs would permanently poison
/// the clock and win every last_write_wins conflict.
const int maxDriftMs = 300000;

/// A device-local clock producing strictly monotonic stamps even when the wall
/// clock jumps backwards.
class Clock {
  final String actor;
  int _wallMs = 0;
  int _counter = 0;

  Clock(this.actor);

  Hlc tick([int? nowMs]) {
    final now = nowMs ?? DateTime.now().millisecondsSinceEpoch;
    if (now > _wallMs) {
      _wallMs = now;
      _counter = 0;
    } else {
      _counter += 1;
    }
    return Hlc(_wallMs, _counter, actor);
  }

  Hlc observe(Hlc remote, [int? nowMs]) {
    final now = nowMs ?? DateTime.now().millisecondsSinceEpoch;
    // Clock-drift clamp: an over-drift remote wall is IGNORED (not folded in), so
    // the local clock never advances past now + maxDriftMs. In range, behavior is
    // identical to the classic HLC update (matches src/hlc.rs, sdk/src/hlc.mjs).
    final remoteOk = remote.wallMs <= now + maxDriftMs;
    final remoteWall = remoteOk ? remote.wallMs : 0;
    final maxWall = [now, _wallMs, remoteWall].reduce((a, b) => a > b ? a : b);
    if (remoteOk && maxWall == _wallMs && maxWall == remote.wallMs) {
      _counter = (_counter > remote.counter ? _counter : remote.counter) + 1;
    } else if (maxWall == _wallMs) {
      _counter += 1;
    } else if (remoteOk && maxWall == remote.wallMs) {
      _counter = remote.counter + 1;
    } else {
      _counter = 0;
    }
    _wallMs = maxWall;
    return Hlc(_wallMs, _counter, actor);
  }
}
