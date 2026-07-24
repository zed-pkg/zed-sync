//! zed-sync-core — the zero-IO reconciliation core.
//!
//! Every correctness-critical decision (which change wins, whether an incoming
//! change is our own echo, how an HTTP ack settles) is a **pure function** of
//! its inputs, with no clock reads and no IO. The same crate builds:
//!
//! - **native** — verified by `cargo test` and reused server-side so the Rust
//!   services and the browser agree on one protocol; and
//! - **wasm** (`--features wasm`) — the browser core wrapped by the JS SDK.
//!
//! Reconciliation orders changes by a [`Hlc`] version, so two transports
//! (Supabase realtime + backend catch-up) can deliver the same change in any
//! order, any number of times, and every replica converges. See
//! `docs/protocol.md`.

pub mod hlc;
pub mod policy;
#[cfg(feature = "wasm")]
mod wasm;

pub use hlc::Hlc;
pub use policy::{ConflictResolution, ErrorPolicy, WriteMode};

use serde::{Deserialize, Serialize};

/// Operation carried by a change.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Op {
    Upsert,
    Delete,
}

/// The wire envelope both transports decode to. `protocol/change-event.schema.json`
/// is the language-neutral validation shape.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ChangeEvent {
    pub table: String,
    pub op: Op,
    pub id: String,
    /// The per-row HLC version: the ONLY reconciliation / compare-and-swap key.
    pub version: Hlc,
    /// Row payload for upserts; `null` for deletes.
    #[serde(default)]
    pub row: Option<serde_json::Value>,
    /// Server commit wall-clock (epoch ms) — surfaced to UIs, never used for
    /// ordering.
    pub at_ms: u64,
    /// Echo of a client's durable per-write identity, if the backend set it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub write_key: Option<String>,
    /// Plane-wide commit-ordered catch-up cursor. Present on catch-up rows,
    /// optional on live frames; NEVER feeds reconciliation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sync_sequence: Option<u64>,
}

/// The minimal local view reconciliation needs: the stored version and whether
/// there is an un-flushed local edit on top of it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct LocalRow {
    pub version: Hlc,
    #[serde(default)]
    pub dirty: bool,
}

/// Why an incoming change is ignored.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum IgnoreReason {
    /// Older than what we already hold.
    Stale,
    /// Same version, or a first-ever delete — nothing to do.
    AlreadyApplied,
}

/// The decision reconcile returns.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum Reconcile {
    /// Adopt the incoming change as authoritative.
    Apply,
    /// Drop it.
    Ignore(IgnoreReason),
    /// Incoming is newer but a dirty local write exists; the caller resolves
    /// per its [`ConflictResolution`].
    Conflict,
}

/// Pure reconciliation. Depends ONLY on `(local.version, local.dirty,
/// incoming.version, incoming.op)` — no clocks, no IO — so it is idempotent and
/// order-independent (see the table in `docs/protocol.md`).
pub fn reconcile(local: Option<LocalRow>, incoming: &ChangeEvent) -> Reconcile {
    let Some(local) = local else {
        return match incoming.op {
            Op::Upsert => Reconcile::Apply,
            // A delete for a row we never had is already the desired state.
            Op::Delete => Reconcile::Ignore(IgnoreReason::AlreadyApplied),
        };
    };
    match incoming.version.cmp(&local.version) {
        std::cmp::Ordering::Less => Reconcile::Ignore(IgnoreReason::Stale),
        std::cmp::Ordering::Equal => Reconcile::Ignore(IgnoreReason::AlreadyApplied),
        std::cmp::Ordering::Greater => {
            if local.dirty {
                Reconcile::Conflict
            } else {
                Reconcile::Apply
            }
        }
    }
}

/// Resolve a [`Reconcile::Conflict`] deterministically. `ServerWins` always
/// adopts the incoming change; `LastWriteWins` keeps the higher HLC (so
/// leaderless replicas still converge on the same winner).
pub fn resolve_conflict(
    resolution: ConflictResolution,
    local: &LocalRow,
    incoming: &ChangeEvent,
) -> bool {
    match resolution {
        ConflictResolution::ServerWins => true,
        ConflictResolution::LastWriteWins => incoming.version > local.version,
    }
}

/// A durable queued optimistic write awaiting server acknowledgement.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct QueuedWrite {
    pub table: String,
    pub id: String,
    pub op: Op,
    pub base_version: Hlc,
    /// The per-write idempotency key; the backend echoes it as `write_key`.
    pub key: String,
}

impl QueuedWrite {
    /// True when `incoming` is the realtime echo of THIS queued write. Matched
    /// by exact `write_key` (plus table/id/op): a keyed match is ours even if
    /// the committed version drifted; a missing/different key is never ours,
    /// so a third party cannot impersonate our write.
    pub fn is_echo_of(&self, incoming: &ChangeEvent) -> bool {
        incoming.table == self.table
            && incoming.id == self.id
            && incoming.op == self.op
            && incoming.write_key.as_deref() == Some(self.key.as_str())
    }
}

/// The HTTP ack for a queued write: the version the backend committed it at.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct WriteAck {
    pub id: String,
    pub committed_version: Hlc,
}

/// Outcome of settling an ack against current local state.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum AckOutcome {
    /// Adopt the committed version as clean/synced.
    Adopt(Hlc),
    /// Local already advanced past the committed version (e.g. a newer edit);
    /// the ack is stale.
    Superseded,
}

/// Settle an HTTP ack: adopt `committed_version` unless local already advanced
/// past it. Pure.
pub fn on_ack(local: &LocalRow, ack: &WriteAck) -> AckOutcome {
    if local.version > ack.committed_version {
        AckOutcome::Superseded
    } else {
        AckOutcome::Adopt(ack.committed_version.clone())
    }
}

/// The three timestamps, and who owns each (see `docs/timestamps.md`).
/// `created_at`/`updated_at` are server-set (inside the row); `synced_at` is a
/// client-local replica fact. This struct is the client-side metadata record.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RowMeta {
    pub version: Hlc,
    pub dirty: bool,
    /// Local wall-clock ms when this device last adopted server-authoritative
    /// state for the row; `None` until it has. A dirty write preserves the
    /// previous value (editing on synced state does not un-sync it).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub synced_at_ms: Option<u64>,
}
