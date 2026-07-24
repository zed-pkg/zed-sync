//! Hybrid Logical Clock (Kulkarni et al. — the scheme CockroachDB uses for
//! transaction timestamps). Wall clocks lie: NTP steps them, VMs resume into
//! the past, users edit them. An HLC keeps a monotonic, causally-ordered
//! stamp anyway, so leaderless replicas (CouchDB-style) converge without a
//! central sequencer.
//!
//! Canonical encoding is a fixed-width, lexicographically-sortable string:
//! `"0197f3b2c4d1-0003"` = 12 hex digits of Unix-milliseconds, a dash, then 4
//! hex digits of the logical counter. Lexicographic order equals causal order
//! in every language port, and it stays clear of JavaScript's 2^53 integer
//! limit. `actor` breaks ties so equal `(wall_ms, counter)` still totally
//! orders — the deterministic tiebreak that makes every replica agree.

use std::cmp::Ordering;

use serde::{Deserialize, Serialize};

/// A hybrid logical clock stamp. Total order: `wall_ms`, then `counter`, then
/// `actor` (lexicographic).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Hlc {
    pub wall_ms: u64,
    pub counter: u32,
    pub actor: String,
}

/// Reject a remote stamp whose wall clock runs more than this far ahead of ours
/// (5 minutes). Without the bound one attacker-controlled far-future `wall_ms`
/// would permanently poison the clock and win every LAST_WRITE_WINS conflict.
pub const MAX_DRIFT_MS: u64 = 300_000;

impl Hlc {
    pub fn new(wall_ms: u64, counter: u32, actor: impl Into<String>) -> Self {
        Self {
            wall_ms,
            counter,
            actor: actor.into(),
        }
    }

    /// Sortable canonical string, e.g. `"0197f3b2c4d1-0003"` (actor omitted;
    /// it is metadata for tiebreaking, not part of the time key).
    pub fn encode(&self) -> String {
        format!(
            "{:012x}-{:04x}",
            self.wall_ms & 0xffff_ffff_ffff,
            self.counter
        )
    }

    /// Advance for a *local* event against the device wall clock. Strictly
    /// monotonic even if `physical_now_ms` jumps backwards.
    pub fn tick(&mut self, physical_now_ms: u64) {
        if physical_now_ms > self.wall_ms {
            self.wall_ms = physical_now_ms;
            self.counter = 0;
        } else {
            self.counter = self.counter.saturating_add(1);
        }
    }

    /// Fold in an observed remote stamp plus the local wall clock, so local
    /// stamps always sort after the last change we have seen (CockroachDB's
    /// `HLC.Update`).
    pub fn observe(&mut self, remote: &Hlc, physical_now_ms: u64) {
        // Clock-drift clamp: an over-drift remote wall is IGNORED (not folded in),
        // so the local clock never advances past `physical_now_ms + MAX_DRIFT_MS`.
        // In range, behavior is identical to the classic HLC update.
        let remote_ok = remote.wall_ms <= physical_now_ms.saturating_add(MAX_DRIFT_MS);
        let remote_wall = if remote_ok { remote.wall_ms } else { 0 };
        let max_wall = physical_now_ms.max(self.wall_ms).max(remote_wall);
        let counter = if remote_ok && max_wall == self.wall_ms && max_wall == remote.wall_ms {
            self.counter.max(remote.counter).saturating_add(1)
        } else if max_wall == self.wall_ms {
            self.counter.saturating_add(1)
        } else if remote_ok && max_wall == remote.wall_ms {
            remote.counter.saturating_add(1)
        } else {
            0
        };
        self.wall_ms = max_wall;
        self.counter = counter;
    }
}

impl PartialOrd for Hlc {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for Hlc {
    fn cmp(&self, other: &Self) -> Ordering {
        self.wall_ms
            .cmp(&other.wall_ms)
            .then(self.counter.cmp(&other.counter))
            .then_with(|| self.actor.cmp(&other.actor))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tick_is_monotonic_even_when_the_clock_goes_back() {
        let mut hlc = Hlc::new(1000, 0, "a");
        hlc.tick(2000);
        assert_eq!((hlc.wall_ms, hlc.counter), (2000, 0));
        hlc.tick(1500); // clock stepped backwards
        assert_eq!((hlc.wall_ms, hlc.counter), (2000, 1));
        hlc.tick(2000); // same ms
        assert_eq!((hlc.wall_ms, hlc.counter), (2000, 2));
    }

    #[test]
    fn observe_sorts_after_the_remote() {
        let mut local = Hlc::new(1000, 5, "a");
        let remote = Hlc::new(3000, 2, "b");
        local.observe(&remote, 1200);
        assert!(local > remote);
    }

    #[test]
    fn encoding_sorts_lexicographically_by_causal_order() {
        let a = Hlc::new(1, 0, "z").encode();
        let b = Hlc::new(1, 1, "a").encode();
        let c = Hlc::new(2, 0, "a").encode();
        assert!(a < b && b < c);
    }

    #[test]
    fn actor_breaks_ties_deterministically() {
        let a = Hlc::new(5, 5, "aaa");
        let b = Hlc::new(5, 5, "bbb");
        assert!(a < b);
    }
}
