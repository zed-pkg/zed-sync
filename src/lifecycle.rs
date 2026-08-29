//! Total, deterministic application/session lifecycle shared by every app runtime.
//!
//! The reducer owns operational intent. Callers execute platform effects only
//! after an `Applied` transition and attach every asynchronous completion to
//! the returned `active_token`. A completion from an older generation is
//! classified as `Stale` and cannot resurrect a stopped or replaced session.

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AppPhase {
    Stopped,
    Starting,
    Online,
    Offline,
    Stopping,
    Failed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LifecycleOperation {
    None,
    Start,
    Stop,
    Reconcile,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LifecycleFailure {
    Start,
    Runtime,
    Stop,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TransitionOutcome {
    Applied,
    Stuttered,
    Stale,
    Rejected,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LifecycleEvent {
    StartRequested,
    StartSucceeded { token: u64 },
    StartFailed { token: u64 },
    ConnectivityChanged { token: u64, online: bool },
    RuntimeFailed { token: u64 },
    StopRequested,
    StopSucceeded { token: u64 },
    StopFailed { token: u64 },
    ReconcileRequested,
}

/// Authority relation between a callback token and the lifecycle generation.
///
/// Only a previously allocated, now-revoked token is stale. Zero and tokens
/// from an unallocated future generation are invalid and must be rejected.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TokenRelation {
    Current,
    Stale,
    Invalid,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AppLifecycleSnapshot {
    pub phase: AppPhase,
    pub operation: LifecycleOperation,
    pub generation: u64,
    pub active_token: Option<u64>,
    pub desired_running: bool,
    pub online: bool,
    pub failure: Option<LifecycleFailure>,
}

impl Default for AppLifecycleSnapshot {
    fn default() -> Self {
        Self {
            phase: AppPhase::Stopped,
            operation: LifecycleOperation::None,
            generation: 0,
            active_token: None,
            desired_running: false,
            online: false,
            failure: None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AppCapabilities {
    pub can_start: bool,
    pub can_stop: bool,
    pub can_write: bool,
    pub can_receive_changes: bool,
    pub can_flush: bool,
    pub can_reconcile: bool,
    pub busy: bool,
    pub running: bool,
}

impl AppCapabilities {
    pub const CLOSED: Self = Self {
        can_start: false,
        can_stop: false,
        can_write: false,
        can_receive_changes: false,
        can_flush: false,
        can_reconcile: false,
        busy: false,
        running: false,
    };
}

impl AppLifecycleSnapshot {
    pub fn capabilities(&self) -> AppCapabilities {
        if self.validate().is_err() {
            return AppCapabilities::CLOSED;
        }

        let mut capabilities = AppCapabilities::CLOSED;
        match self.phase {
            AppPhase::Stopped => capabilities.can_start = true,
            AppPhase::Starting => {
                capabilities.can_stop = true;
                capabilities.can_receive_changes = true;
                capabilities.busy = true;
            }
            AppPhase::Online => {
                capabilities.can_stop = true;
                capabilities.can_write = true;
                capabilities.can_receive_changes = true;
                capabilities.can_flush = true;
                capabilities.running = true;
            }
            AppPhase::Offline => {
                capabilities.can_stop = true;
                capabilities.can_write = true;
                capabilities.can_receive_changes = true;
                capabilities.running = true;
            }
            AppPhase::Stopping => capabilities.busy = true,
            AppPhase::Failed => capabilities.can_reconcile = true,
        }
        capabilities
    }

    /// Check the phase/operation/token/failure coherence proved by the finite
    /// Quint model. This remains public so embedding apps can fail closed when
    /// decoding a persisted or foreign snapshot.
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.generation > AppLifecycleMachine::MAX_SAFE_GENERATION {
            return Err("generation exceeds the shared exact-integer range");
        }
        if let Some(token) = self.active_token {
            if token == 0 || token > self.generation {
                return Err("active token must identify an allocated generation");
            }
        }
        let coherent = match self.phase {
            AppPhase::Stopped => {
                self.operation == LifecycleOperation::None
                    && self.active_token.is_none()
                    && !self.desired_running
                    && !self.online
                    && self.failure.is_none()
            }
            AppPhase::Starting => {
                self.operation == LifecycleOperation::Start
                    && self.active_token == Some(self.generation)
                    && self.desired_running
                    && self.failure.is_none()
            }
            AppPhase::Online => {
                self.operation == LifecycleOperation::None
                    && self.active_token == Some(self.generation)
                    && self.desired_running
                    && self.online
                    && self.failure.is_none()
            }
            AppPhase::Offline => {
                self.operation == LifecycleOperation::None
                    && self.active_token == Some(self.generation)
                    && self.desired_running
                    && !self.online
                    && self.failure.is_none()
            }
            AppPhase::Stopping => {
                matches!(
                    self.operation,
                    LifecycleOperation::Stop | LifecycleOperation::Reconcile
                ) && self.active_token == Some(self.generation)
                    && !self.desired_running
                    && !self.online
                    && self.failure.is_none()
            }
            AppPhase::Failed => {
                self.operation == LifecycleOperation::None
                    && self.active_token.is_none()
                    && !self.desired_running
                    && !self.online
                    && self.failure.is_some()
            }
        };
        if coherent {
            Ok(())
        } else {
            Err("phase, operation, token, intent, connectivity, and failure disagree")
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct AppLifecycleMachine {
    snapshot: AppLifecycleSnapshot,
}

impl AppLifecycleMachine {
    /// Largest generation represented exactly by every Rust, JavaScript, and
    /// Dart refinement of this state machine.
    pub const MAX_SAFE_GENERATION: u64 = 9_007_199_254_740_991;

    pub fn new() -> Self {
        Self::default()
    }

    pub fn snapshot(&self) -> AppLifecycleSnapshot {
        self.snapshot
    }

    pub fn dispatch(&mut self, event: LifecycleEvent) -> TransitionOutcome {
        use AppPhase::*;
        use LifecycleEvent::*;

        let outcome = match event {
            StartRequested => {
                if self.snapshot.phase != Stopped {
                    TransitionOutcome::Rejected
                } else if self.snapshot.generation < Self::MAX_SAFE_GENERATION {
                    let token = self.snapshot.generation + 1;
                    self.snapshot = AppLifecycleSnapshot {
                        phase: Starting,
                        operation: LifecycleOperation::Start,
                        generation: token,
                        active_token: Some(token),
                        desired_running: true,
                        online: false,
                        failure: None,
                    };
                    TransitionOutcome::Applied
                } else {
                    TransitionOutcome::Rejected
                }
            }
            StartSucceeded { token } => match self.token_relation(token) {
                TokenRelation::Stale => TransitionOutcome::Stale,
                TokenRelation::Invalid => TransitionOutcome::Rejected,
                TokenRelation::Current if self.snapshot.phase != Starting => {
                    TransitionOutcome::Rejected
                }
                TokenRelation::Current => {
                    self.snapshot.phase = if self.snapshot.online {
                        Online
                    } else {
                        Offline
                    };
                    self.snapshot.operation = LifecycleOperation::None;
                    TransitionOutcome::Applied
                }
            },
            StartFailed { token } => match self.token_relation(token) {
                TokenRelation::Stale => TransitionOutcome::Stale,
                TokenRelation::Invalid => TransitionOutcome::Rejected,
                TokenRelation::Current if self.snapshot.phase != Starting => {
                    TransitionOutcome::Rejected
                }
                TokenRelation::Current => {
                    self.fail(LifecycleFailure::Start);
                    TransitionOutcome::Applied
                }
            },
            ConnectivityChanged { token, online } => match self.token_relation(token) {
                TokenRelation::Stale => TransitionOutcome::Stale,
                TokenRelation::Invalid => TransitionOutcome::Rejected,
                TokenRelation::Current
                    if !matches!(self.snapshot.phase, Starting | Online | Offline) =>
                {
                    TransitionOutcome::Rejected
                }
                TokenRelation::Current => {
                    let target = if self.snapshot.phase == Starting {
                        Starting
                    } else if online {
                        Online
                    } else {
                        Offline
                    };
                    if self.snapshot.online == online && self.snapshot.phase == target {
                        TransitionOutcome::Stuttered
                    } else {
                        self.snapshot.online = online;
                        self.snapshot.phase = target;
                        TransitionOutcome::Applied
                    }
                }
            },
            RuntimeFailed { token } => match self.token_relation(token) {
                TokenRelation::Stale => TransitionOutcome::Stale,
                TokenRelation::Invalid => TransitionOutcome::Rejected,
                TokenRelation::Current
                    if !matches!(self.snapshot.phase, Starting | Online | Offline) =>
                {
                    TransitionOutcome::Rejected
                }
                TokenRelation::Current => {
                    self.fail(LifecycleFailure::Runtime);
                    TransitionOutcome::Applied
                }
            },
            StopRequested => match self.snapshot.phase {
                Stopped | Stopping => TransitionOutcome::Stuttered,
                Failed => TransitionOutcome::Rejected,
                Starting | Online | Offline => self.begin_stop(LifecycleOperation::Stop),
            },
            StopSucceeded { token } => match self.token_relation(token) {
                TokenRelation::Stale => TransitionOutcome::Stale,
                TokenRelation::Invalid => TransitionOutcome::Rejected,
                TokenRelation::Current if self.snapshot.phase != Stopping => {
                    TransitionOutcome::Rejected
                }
                TokenRelation::Current => {
                    self.snapshot = AppLifecycleSnapshot {
                        generation: self.snapshot.generation,
                        ..AppLifecycleSnapshot::default()
                    };
                    TransitionOutcome::Applied
                }
            },
            StopFailed { token } => match self.token_relation(token) {
                TokenRelation::Stale => TransitionOutcome::Stale,
                TokenRelation::Invalid => TransitionOutcome::Rejected,
                TokenRelation::Current if self.snapshot.phase != Stopping => {
                    TransitionOutcome::Rejected
                }
                TokenRelation::Current => {
                    self.fail(LifecycleFailure::Stop);
                    TransitionOutcome::Applied
                }
            },
            ReconcileRequested => {
                if self.snapshot.phase == Failed {
                    self.begin_stop(LifecycleOperation::Reconcile)
                } else {
                    TransitionOutcome::Rejected
                }
            }
        };

        debug_assert!(self.snapshot.validate().is_ok());
        outcome
    }

    fn token_relation(&self, token: u64) -> TokenRelation {
        match (token, self.snapshot.active_token) {
            (0, _) => TokenRelation::Invalid,
            (candidate, Some(active)) if candidate == active => TokenRelation::Current,
            (candidate, _) if candidate <= self.snapshot.generation => TokenRelation::Stale,
            _ => TokenRelation::Invalid,
        }
    }

    fn begin_stop(&mut self, operation: LifecycleOperation) -> TransitionOutcome {
        if self.snapshot.generation >= Self::MAX_SAFE_GENERATION {
            return TransitionOutcome::Rejected;
        }
        let token = self.snapshot.generation + 1;
        self.snapshot = AppLifecycleSnapshot {
            phase: AppPhase::Stopping,
            operation,
            generation: token,
            active_token: Some(token),
            desired_running: false,
            online: false,
            failure: None,
        };
        TransitionOutcome::Applied
    }

    fn fail(&mut self, failure: LifecycleFailure) {
        self.snapshot = AppLifecycleSnapshot {
            phase: AppPhase::Failed,
            operation: LifecycleOperation::None,
            generation: self.snapshot.generation,
            active_token: None,
            desired_running: false,
            online: false,
            failure: Some(failure),
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{HashSet, VecDeque};

    #[test]
    fn stale_start_completion_cannot_resurrect_a_stopping_session() {
        let mut machine = AppLifecycleMachine::new();
        assert_eq!(
            machine.dispatch(LifecycleEvent::StartRequested),
            TransitionOutcome::Applied
        );
        let start_token = machine.snapshot().active_token.unwrap();
        assert_eq!(
            machine.dispatch(LifecycleEvent::StopRequested),
            TransitionOutcome::Applied
        );
        assert_eq!(
            machine.dispatch(LifecycleEvent::StartSucceeded { token: start_token }),
            TransitionOutcome::Stale
        );
        assert_eq!(machine.snapshot().phase, AppPhase::Stopping);
    }

    #[test]
    fn only_previously_allocated_tokens_are_stale() {
        let mut machine = AppLifecycleMachine::new();
        assert_eq!(
            machine.dispatch(LifecycleEvent::StartRequested),
            TransitionOutcome::Applied
        );
        let snapshot = machine.snapshot();

        assert_eq!(
            machine.dispatch(LifecycleEvent::StartSucceeded { token: 0 }),
            TransitionOutcome::Rejected
        );
        assert_eq!(machine.snapshot(), snapshot);
        assert_eq!(
            machine.dispatch(LifecycleEvent::StartSucceeded { token: 2 }),
            TransitionOutcome::Rejected
        );
        assert_eq!(machine.snapshot(), snapshot);

        assert_eq!(
            machine.dispatch(LifecycleEvent::StopRequested),
            TransitionOutcome::Applied
        );
        let stopping = machine.snapshot();
        assert_eq!(
            machine.dispatch(LifecycleEvent::StartSucceeded { token: 1 }),
            TransitionOutcome::Stale
        );
        assert_eq!(machine.snapshot(), stopping);
    }

    #[test]
    fn malformed_foreign_snapshot_has_no_capabilities() {
        let malformed = AppLifecycleSnapshot {
            phase: AppPhase::Online,
            ..AppLifecycleSnapshot::default()
        };

        assert!(malformed.validate().is_err());
        assert_eq!(malformed.capabilities(), AppCapabilities::CLOSED);
    }

    #[test]
    fn generation_is_bounded_by_the_cross_runtime_exact_integer_range() {
        let at_limit = AppLifecycleSnapshot {
            generation: AppLifecycleMachine::MAX_SAFE_GENERATION,
            ..AppLifecycleSnapshot::default()
        };
        assert!(at_limit.validate().is_ok());
        let mut machine = AppLifecycleMachine { snapshot: at_limit };
        assert_eq!(
            machine.dispatch(LifecycleEvent::StartRequested),
            TransitionOutcome::Rejected
        );

        let beyond_limit = AppLifecycleSnapshot {
            generation: AppLifecycleMachine::MAX_SAFE_GENERATION + 1,
            ..AppLifecycleSnapshot::default()
        };
        assert!(beyond_limit.validate().is_err());
        assert_eq!(beyond_limit.capabilities(), AppCapabilities::CLOSED);
    }

    #[test]
    fn failure_requires_explicit_reconciliation_before_restart() {
        let mut machine = AppLifecycleMachine::new();
        machine.dispatch(LifecycleEvent::StartRequested);
        let token = machine.snapshot().active_token.unwrap();
        machine.dispatch(LifecycleEvent::StartFailed { token });
        assert_eq!(machine.snapshot().phase, AppPhase::Failed);
        assert_eq!(
            machine.dispatch(LifecycleEvent::StartRequested),
            TransitionOutcome::Rejected
        );
        assert_eq!(
            machine.dispatch(LifecycleEvent::ReconcileRequested),
            TransitionOutcome::Applied
        );
        let reconcile_token = machine.snapshot().active_token.unwrap();
        machine.dispatch(LifecycleEvent::StopSucceeded {
            token: reconcile_token,
        });
        assert_eq!(machine.snapshot().phase, AppPhase::Stopped);
    }

    #[test]
    fn bounded_event_graph_is_total_deterministic_and_invariant_safe() {
        let mut queue = VecDeque::from([AppLifecycleMachine::new()]);
        let mut seen = HashSet::new();
        let mut seen_phases = HashSet::new();

        while let Some(machine) = queue.pop_front() {
            let snapshot = machine.snapshot();
            let key = format!("{snapshot:?}");
            if !seen.insert(key) {
                continue;
            }
            seen_phases.insert(format!("{:?}", snapshot.phase));
            snapshot
                .validate()
                .expect("all reachable snapshots are coherent");
            if snapshot.generation >= 4 {
                continue;
            }
            let current = snapshot.active_token.unwrap_or(snapshot.generation);
            let stale = current.saturating_sub(1);
            let events = [
                LifecycleEvent::StartRequested,
                LifecycleEvent::StartSucceeded { token: current },
                LifecycleEvent::StartSucceeded { token: stale },
                LifecycleEvent::StartFailed { token: current },
                LifecycleEvent::ConnectivityChanged {
                    token: current,
                    online: true,
                },
                LifecycleEvent::ConnectivityChanged {
                    token: current,
                    online: false,
                },
                LifecycleEvent::RuntimeFailed { token: current },
                LifecycleEvent::StopRequested,
                LifecycleEvent::StopSucceeded { token: current },
                LifecycleEvent::StopFailed { token: current },
                LifecycleEvent::ReconcileRequested,
            ];
            for event in events {
                let mut next = machine.clone();
                let first = next.dispatch(event);
                let next_snapshot = next.snapshot();
                let mut replay = machine.clone();
                let second = replay.dispatch(event);
                assert_eq!(first, second, "outcome must be deterministic for {event:?}");
                assert_eq!(
                    next_snapshot,
                    replay.snapshot(),
                    "next state must be deterministic for {event:?}"
                );
                queue.push_back(next);
            }
        }

        for phase in [
            "Stopped", "Starting", "Online", "Offline", "Stopping", "Failed",
        ] {
            assert!(
                seen_phases.contains(phase),
                "bounded graph must reach {phase}"
            );
        }
    }
}
