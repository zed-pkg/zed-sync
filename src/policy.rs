//! Per-write optimism levels and error surfaces — ENUMS, not booleans, so a
//! write names its exact behavior and new levels can be added without breaking
//! call sites. Canonical wire values live in
//! `protocol/write-policy.schema.json`; the JS (`sdk/src/policy.mjs`) and Dart
//! (`dart/zed_sync/lib/src/policy.dart`) ports mirror these, and
//! `zed-interfaces` re-exports them as `SyncWriteMode` / `SyncErrorPolicy`.

use serde::{Deserialize, Serialize};

/// How optimistically a single write is applied. Every level commits to the
/// durable local store first (except the server-first/only levels); they
/// differ in when the call settles and what happens to the local write on
/// server rejection.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WriteMode {
    /// Apply locally + enqueue durably; no network attempt until the next
    /// flush/reconnect.
    LocalOnly,
    /// Apply locally, enqueue, send; a send failure leaves the write queued
    /// for retry. The classic offline-capable optimistic write (default).
    OptimisticQueue,
    /// Like `OptimisticQueue`, but a send failure is surfaced per the error
    /// policy (the write still stays queued and durable).
    OptimisticAwaitAck,
    /// Send first; apply locally only after the ack (no dirty window; nothing
    /// queued on failure).
    ServerFirst,
    /// Send only; local state updates when the change feed delivers the
    /// committed row.
    ServerOnly,
}

impl Default for WriteMode {
    fn default() -> Self {
        Self::OptimisticQueue
    }
}

/// How write/flush errors are surfaced to the caller.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorPolicy {
    /// Reject/throw to the caller.
    ThrowOnly,
    /// Report through the telemetry/onError channel, settle normally (default
    /// for writes).
    EmitOnly,
    /// Both.
    ThrowAndEmit,
    /// Neither — the outcome is only visible in the returned result.
    Silent,
}

impl Default for ErrorPolicy {
    fn default() -> Self {
        Self::EmitOnly
    }
}

impl ErrorPolicy {
    pub fn should_throw(self) -> bool {
        matches!(self, Self::ThrowOnly | Self::ThrowAndEmit)
    }
    pub fn should_emit(self) -> bool {
        matches!(self, Self::EmitOnly | Self::ThrowAndEmit)
    }
}

/// How a dirty-vs-newer-remote conflict is resolved.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConflictResolution {
    /// Adopt the server row, drop the queued local write (default; safe).
    ServerWins,
    /// Keep whichever change has the higher HLC — deterministic across
    /// replicas, so leaderless multi-master still converges.
    LastWriteWins,
}

impl Default for ConflictResolution {
    fn default() -> Self {
        Self::ServerWins
    }
}
