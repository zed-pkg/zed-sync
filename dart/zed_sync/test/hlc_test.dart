// HLC parity with the Rust core (src/hlc.rs tests) and JS (sdk/test/hlc.test.mjs):
// monotonic tick, observe-sorts-after-remote, the drift clamp, sortable encoding,
// and the actor tiebreak. These pin that the Dart clock behaves identically to
// the other runtimes — a divergence here breaks cross-device convergence.

import 'package:test/test.dart';
import 'package:zed_sync/zed_sync.dart';

void main() {
  test('tick is monotonic even when the wall clock steps backwards', () {
    final c = Clock('a');
    expect(c.tick(2000), _hlc(2000, 0, 'a'));
    expect(c.tick(1500), _hlc(2000, 1, 'a'),
        reason: 'backwards clock -> counter bump, no regress');
    expect(c.tick(2000), _hlc(2000, 2, 'a'), reason: 'same ms -> counter bump');
    expect(c.tick(2001), _hlc(2001, 0, 'a'),
        reason: 'new ms -> counter resets');
  });

  test('observe folds an in-range remote and sorts strictly after it', () {
    final c = Clock('a');
    c.tick(1000); // local at (1000,0,a)
    final observed = c.observe(const Hlc(3000, 2, 'b'), 1200);
    expect(observed.wallMs, 3000);
    expect(observed.compareTo(const Hlc(3000, 2, 'b')) > 0, isTrue,
        reason: 'local now sorts after remote');
  });

  test(
      'observe folds a slightly-ahead in-range remote like the classic HLC update',
      () {
    final c = Clock('a');
    // Seed local to (1000,5,a): tick to 1000 then bump the counter to 5.
    c.tick(1000);
    for (var i = 0; i < 5; i++) {
      c.tick(1000);
    }
    final r = c.observe(const Hlc(1050, 2, 'b'), 1000);
    expect(r.wallMs, 1050);
    expect(r.counter, 3, reason: 'remote.counter + 1');
  });

  test('observe clamps a far-future (poison) remote wall to now + maxDriftMs',
      () {
    final c = Clock('a');
    c.tick(1000);
    const now = 2000;
    // An hour past the drift bound — an attacker-controlled stamp.
    final poison = Hlc(now + maxDriftMs + 3600000, 0, 'attacker');
    final observed = c.observe(poison, now);
    expect(observed.wallMs <= now + maxDriftMs, isTrue,
        reason: 'never advances past the drift bound');
    expect(observed.wallMs, now,
        reason: 'advanced to now, not the poisoned wall');
    // A subsequent local tick still sorts BEFORE the rejected poison stamp,
    // so the attacker cannot win a last_write_wins conflict.
    expect(c.tick(now).compareTo(poison) < 0, isTrue);
  });

  test('encoding is fixed-width and sorts lexicographically by causal order',
      () {
    final a = const Hlc(1, 0, 'z').encode();
    final b = const Hlc(1, 1, 'a').encode();
    final cc = const Hlc(2, 0, 'a').encode();
    expect(a.compareTo(b) < 0 && b.compareTo(cc) < 0, isTrue);
    expect(const Hlc(0x0197f3b2c4d1, 3, 'x').encode(), '0197f3b2c4d1-0003');
  });

  test('actor breaks an equal (wall, counter) tie deterministically', () {
    expect(
        const Hlc(5, 5, 'aaa').compareTo(const Hlc(5, 5, 'bbb')) < 0, isTrue);
    expect(
        const Hlc(5, 5, 'bbb').compareTo(const Hlc(5, 5, 'aaa')) > 0, isTrue);
    expect(const Hlc(5, 5, 'x').compareTo(const Hlc(5, 5, 'x')), 0);
  });
}

Matcher _hlc(int wall, int counter, String actor) => predicate<Hlc>(
      (h) => h.wallMs == wall && h.counter == counter && h.actor == actor,
      '(wall=$wall, counter=$counter, actor=$actor)',
    );
