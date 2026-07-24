// The Dart core runs the SAME protocol/conformance.json the Rust and JS cores
// run, so the mobile port is proven to agree on reconcile, echo, and ack.

import 'dart:convert';
import 'dart:io';

import 'package:test/test.dart';
import 'package:zed_sync/zed_sync.dart';

Map<String, dynamic> _loadFixture() {
  // Walk up to the repo's protocol/ directory from the package root.
  var dir = Directory.current;
  for (var i = 0; i < 6; i++) {
    final f = File('${dir.path}/protocol/conformance.json');
    if (f.existsSync()) return jsonDecode(f.readAsStringSync()) as Map<String, dynamic>;
    dir = dir.parent;
  }
  fail('could not locate protocol/conformance.json');
}

void main() {
  final fixture = _loadFixture();

  test('protocol version is 1', () {
    expect(fixture['protocol_version'], 1);
  });

  test('reconcile matches every shared fixture case', () {
    for (final c in fixture['reconcile'] as List) {
      final local = c['local'] == null ? null : LocalRow.fromJson(c['local'] as Map<String, dynamic>);
      final incoming = ChangeEvent.fromJson(c['incoming'] as Map<String, dynamic>);
      expect(reconcile(local, incoming).toFixture(), c['expected'], reason: c['name'] as String);
    }
  });

  test('echo detection matches every shared fixture case', () {
    for (final c in fixture['echoes'] as List) {
      final q = c['queued'] as Map<String, dynamic>;
      final incoming = ChangeEvent.fromJson(c['incoming'] as Map<String, dynamic>);
      final got = isOwnEcho(
        table: q['table'] as String,
        id: q['id'] as String,
        op: opFromWire(q['op'] as String),
        key: q['key'] as String,
        incoming: incoming,
      );
      expect(got, c['expected'], reason: c['name'] as String);
    }
  });

  test('ack settlement matches every shared fixture case', () {
    for (final c in fixture['acks'] as List) {
      final local = LocalRow.fromJson(c['local'] as Map<String, dynamic>);
      final committed = Hlc.fromJson((c['ack'] as Map<String, dynamic>)['committed_version'] as Map<String, dynamic>);
      final adopted = onAck(local, committed);
      final expected = c['expected'];
      if (expected == 'Superseded') {
        expect(adopted, isNull, reason: c['name'] as String);
      } else {
        expect(adopted!.toJson(), (expected as Map)['Adopt'], reason: c['name'] as String);
      }
    }
  });

  test('HLC encoding is sortable and matches the shared format', () {
    expect(const Hlc(0x0197f3b2c4d1, 3, 'x').encode(), '0197f3b2c4d1-0003');
    final clock = Clock('dev');
    final a = clock.tick(1000);
    final b = clock.tick(500); // clock went backwards
    expect(b.compareTo(a), 1);
  });

  test('write modes are enums with canonical wire values', () {
    expect(WriteMode.optimisticQueue.wire, 'optimistic_queue');
    expect(WriteMode.values.length, 5);
    expect(ErrorPolicy.values.length, 4);
    expect(() => WriteMode.fromWire('nope'), throwsArgumentError);
  });
}
