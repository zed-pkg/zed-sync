//! Cross-runtime refinement replay for `formal/app_lifecycle.qnt`.

use std::collections::BTreeSet;

use serde::Deserialize;
use zed_sync_core::{
    AppLifecycleMachine, AppLifecycleSnapshot, AppPhase, LifecycleEvent, TransitionOutcome,
};

#[derive(Deserialize)]
struct Fixture {
    schema_version: u32,
    model: String,
    cases: Vec<Case>,
}

#[derive(Deserialize)]
struct Case {
    name: String,
    steps: Vec<Step>,
}

#[derive(Deserialize)]
struct Step {
    event: FixtureEvent,
    outcome: TransitionOutcome,
    state: AppLifecycleSnapshot,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum FixtureEvent {
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

impl FixtureEvent {
    fn name(&self) -> &'static str {
        match self {
            Self::StartRequested => "start_requested",
            Self::StartSucceeded { .. } => "start_succeeded",
            Self::StartFailed { .. } => "start_failed",
            Self::ConnectivityChanged { .. } => "connectivity_changed",
            Self::RuntimeFailed { .. } => "runtime_failed",
            Self::StopRequested => "stop_requested",
            Self::StopSucceeded { .. } => "stop_succeeded",
            Self::StopFailed { .. } => "stop_failed",
            Self::ReconcileRequested => "reconcile_requested",
        }
    }

    fn into_runtime(self) -> LifecycleEvent {
        match self {
            Self::StartRequested => LifecycleEvent::StartRequested,
            Self::StartSucceeded { token } => LifecycleEvent::StartSucceeded { token },
            Self::StartFailed { token } => LifecycleEvent::StartFailed { token },
            Self::ConnectivityChanged { token, online } => {
                LifecycleEvent::ConnectivityChanged { token, online }
            }
            Self::RuntimeFailed { token } => LifecycleEvent::RuntimeFailed { token },
            Self::StopRequested => LifecycleEvent::StopRequested,
            Self::StopSucceeded { token } => LifecycleEvent::StopSucceeded { token },
            Self::StopFailed { token } => LifecycleEvent::StopFailed { token },
            Self::ReconcileRequested => LifecycleEvent::ReconcileRequested,
        }
    }
}

#[test]
fn rust_replays_every_formal_app_lifecycle_trace() {
    let fixture: Fixture =
        serde_json::from_str(include_str!("../protocol/formal-app-lifecycle.json"))
            .expect("formal app lifecycle fixture must be valid JSON");
    assert_eq!(fixture.schema_version, 1);
    assert_eq!(fixture.model, "app-lifecycle-v1");
    assert!(fixture.cases.len() >= 6);

    let mut covered = BTreeSet::new();
    let mut outcomes = BTreeSet::new();
    for case in fixture.cases {
        let mut machine = AppLifecycleMachine::new();
        for step in case.steps {
            covered.insert(step.event.name());
            let got = machine.dispatch(step.event.into_runtime());
            outcomes.insert(format!("{got:?}"));
            assert_eq!(got, step.outcome, "{}", case.name);
            assert_eq!(machine.snapshot(), step.state, "{}", case.name);
            machine
                .snapshot()
                .validate()
                .unwrap_or_else(|why| panic!("{}: {why}", case.name));
        }
    }

    for event in [
        "start_requested",
        "start_succeeded",
        "start_failed",
        "connectivity_changed",
        "runtime_failed",
        "stop_requested",
        "stop_succeeded",
        "stop_failed",
        "reconcile_requested",
    ] {
        assert!(covered.contains(event), "fixture must cover {event}");
    }
    for outcome in ["Applied", "Stuttered", "Stale", "Rejected"] {
        assert!(outcomes.contains(outcome), "fixture must cover {outcome}");
    }
}

#[test]
fn failed_capabilities_are_fail_closed() {
    let mut machine = AppLifecycleMachine::new();
    machine.dispatch(LifecycleEvent::StartRequested);
    let token = machine.snapshot().active_token.unwrap();
    machine.dispatch(LifecycleEvent::RuntimeFailed { token });
    assert_eq!(machine.snapshot().phase, AppPhase::Failed);
    let capabilities = machine.snapshot().capabilities();
    assert!(!capabilities.can_start);
    assert!(!capabilities.can_stop);
    assert!(!capabilities.can_write);
    assert!(!capabilities.can_receive_changes);
    assert!(!capabilities.can_flush);
    assert!(capabilities.can_reconcile);
}
