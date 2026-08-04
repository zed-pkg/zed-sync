// Write-mode, error-policy, and conflict-resolution enums — the Dart mirror of
// protocol/write-policy.schema.json (and src/policy.rs, sdk/src/policy.mjs).
// Enums, not booleans: each write names its exact optimism level and error
// surface. `wire` is the canonical cross-language string.

enum WriteMode {
  localOnly('local_only'),
  optimisticQueue('optimistic_queue'),
  optimisticAwaitAck('optimistic_await_ack'),
  serverFirst('server_first'),
  serverOnly('server_only');

  final String wire;
  const WriteMode(this.wire);

  static WriteMode fromWire(String w) =>
      WriteMode.values.firstWhere((m) => m.wire == w,
          orElse: () => throw ArgumentError('unknown write mode "$w"'));
}

enum ErrorPolicy {
  throwOnly('throw_only'),
  emitOnly('emit_only'),
  throwAndEmit('throw_and_emit'),
  silent('silent');

  final String wire;
  const ErrorPolicy(this.wire);

  bool get shouldThrow =>
      this == ErrorPolicy.throwOnly || this == ErrorPolicy.throwAndEmit;
  bool get shouldEmit =>
      this == ErrorPolicy.emitOnly || this == ErrorPolicy.throwAndEmit;

  static ErrorPolicy fromWire(String w) =>
      ErrorPolicy.values.firstWhere((p) => p.wire == w,
          orElse: () => throw ArgumentError('unknown error policy "$w"'));
}

enum ConflictResolution {
  serverWins('server_wins'),
  lastWriteWins('last_write_wins');

  final String wire;
  const ConflictResolution(this.wire);

  static ConflictResolution fromWire(String w) =>
      ConflictResolution.values.firstWhere((c) => c.wire == w,
          orElse: () =>
              throw ArgumentError('unknown conflict resolution "$w"'));
}
