// Refinement replay for formal/write_lifecycle.qnt. Rust and JavaScript consume
// this exact concrete HLC/write-key corpus as well.

import 'dart:convert';
import 'dart:io';

import 'package:test/test.dart';
import 'package:zed_sync/zed_sync.dart';

Map<String, dynamic> _loadFixture() {
  var dir = Directory.current;
  for (var i = 0; i < 6; i++) {
    final file = File('${dir.path}/protocol/formal-write-lifecycle.json');
    if (file.existsSync()) {
      return jsonDecode(file.readAsStringSync()) as Map<String, dynamic>;
    }
    dir = dir.parent;
  }
  fail('could not locate protocol/formal-write-lifecycle.json');
}

void main() {
  final fixture = _loadFixture();

  test('Dart replays every formal write-lifecycle case', () {
    expect(fixture['schema_version'], 1);
    expect(fixture['model'], 'optimistic-write-lifecycle-v1');
    final cases = (fixture['cases'] as List).cast<Map<String, dynamic>>();
    expect(cases.length, greaterThanOrEqualTo(4));

    final covered = <String>{};
    for (final c in cases) {
      covered.addAll((c['actions'] as List).cast<String>());
      final current = c['current'] as Map<String, dynamic>;
      final local = LocalRow.fromJson(current['local'] as Map<String, dynamic>);
      final queued = current['queued'] as Map<String, dynamic>;
      final settling = c['settling'] as Map<String, dynamic>;
      final ack = settling['ack'] as Map<String, dynamic>;
      final expected = c['expected'] as Map<String, dynamic>;
      final got = settleQueuedAck(
        local: local,
        currentId: queued['id'] as String,
        currentKey: queued['key'] as String,
        settlingKey: settling['write_key'] as String,
        baseVersion:
            Hlc.fromJson(settling['base_version'] as Map<String, dynamic>),
        ackId: ack['id'] as String,
        committedVersion:
            Hlc.fromJson(ack['committed_version'] as Map<String, dynamic>),
      );
      final finalVersion = got.adopt ?? local.version;
      final finalDirty = got.adopt == null ? local.dirty : false;
      final finalQueuedKey =
          got.retireCurrentSlot ? null : queued['key'] as String;
      final name = c['name'] as String;

      expect(got.adopt == null ? 'Preserve' : 'Adopt', expected['settlement'],
          reason: name);
      expect(got.retireCurrentSlot, expected['retire_current_slot'],
          reason: name);
      expect(finalDirty, expected['final_dirty'], reason: name);
      expect(finalQueuedKey, expected['final_queued_key'], reason: name);
      expect(finalVersion.toJson(), expected['final_version'], reason: name);
    }

    for (final action in [
      'local_write',
      'send',
      'disconnect',
      'reconnect',
      'acknowledge',
      'duplicate_ack',
    ]) {
      expect(covered, contains(action),
          reason: 'formal refinement corpus covers $action');
    }
  });
}
