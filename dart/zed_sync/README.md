# zed_sync (Dart / Flutter)

The mobile port of [zed-sync](https://github.com/zed-pkg/zed-sync) for iOS and
Android. The reconciliation core (HLC versioning, `reconcile`/`onAck`/echo) and
the write policies mirror the Rust core and the JS SDK, and run the shared
`protocol/conformance.json`, so all three ports provably agree.

## Layout

- `lib/src/hlc.dart` — Hybrid Logical Clock (same encoding as Rust/JS).
- `lib/src/policy.dart` — `WriteMode` / `ErrorPolicy` / `ConflictResolution`
  enums with canonical wire values.
- `lib/src/core.dart` — pure `reconcile` / `onAck` / `isOwnEcho` + envelopes.
- `lib/src/client.dart` — `SyncClient` with optimistic writes, the same
  WriteMode behavior, and a `SyncStorage` boundary.

## Storage adapters

`SyncStorage` is the persistence boundary — implement it over Drift, Hive, Isar,
or an atomic app-private JSON file. The core logic stays IO-free and unit-tested.

## Test

```sh
dart pub get
dart test        # runs the shared conformance fixture
```
