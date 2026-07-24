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
    final maxWall = [now, _wallMs, remote.wallMs].reduce((a, b) => a > b ? a : b);
    if (maxWall == _wallMs && maxWall == remote.wallMs) {
      _counter = (_counter > remote.counter ? _counter : remote.counter) + 1;
    } else if (maxWall == _wallMs) {
      _counter += 1;
    } else if (maxWall == remote.wallMs) {
      _counter = remote.counter + 1;
    } else {
      _counter = 0;
    }
    _wallMs = maxWall;
    return Hlc(_wallMs, _counter, actor);
  }
}
