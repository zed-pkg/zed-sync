/// zed_sync — offline-first sync for Flutter/Dart (iOS, Android).
///
/// The reconciliation core (HLC versioning, reconcile/ack/echo) and the write
/// policies are a faithful mirror of the Rust core (`src/lib.rs`) and the JS
/// SDK (`sdk/`), validated against the shared `protocol/conformance.json`.
/// Persistence adapters (Drift/Hive/Isar, or an atomic JSON file) plug in
/// behind the [SyncStorage] boundary — the core stays IO-free and testable.
library zed_sync;

export 'src/hlc.dart';
export 'src/lifecycle.dart';
export 'src/policy.dart';
export 'src/core.dart';
export 'src/client.dart';
export 'src/memory_storage.dart';
export 'src/session.dart';
