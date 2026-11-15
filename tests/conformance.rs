//! The native Rust core runs the shared `protocol/conformance.json` — the same
//! fixture the JS and Dart ports run — so every language agrees on reconcile,
//! echo, and ack behavior.

use serde::Deserialize;
use zed_sync_core::hlc::MAX_DRIFT_MS;
use zed_sync_core::{
    on_ack, reconcile, AckOutcome, ChangeEvent, Hlc, LocalRow, QueuedWrite, Reconcile, WriteAck,
};

#[derive(Deserialize)]
struct Fixture {
    protocol_version: u32,
    reconcile: Vec<ReconcileCase>,
    echoes: Vec<EchoCase>,
    acks: Vec<AckCase>,
    clock: ClockSection,
    hlc_keys: HlcKeys,
}

#[derive(Deserialize)]
struct HlcKeys {
    valid: Vec<HlcKeyCase>,
    invalid: Vec<String>,
}

#[derive(Deserialize)]
struct HlcKeyCase {
    name: String,
    key: String,
    wall_ms: u64,
    counter: u32,
}

#[derive(Deserialize)]
struct ClockSection {
    #[serde(rename = "maxDriftMs")]
    max_drift_ms: u64,
    cases: Vec<ClockCase>,
}

#[derive(Deserialize)]
struct ClockCase {
    name: String,
    actor: String,
    ops: Vec<ClockOp>,
}

#[derive(Deserialize)]
struct ClockOp {
    tick: Option<u64>,
    observe: Option<Hlc>,
    now: Option<u64>,
    expect: Hlc,
}

#[derive(Deserialize)]
struct ReconcileCase {
    name: String,
    local: Option<LocalRow>,
    incoming: ChangeEvent,
    expected: Reconcile,
}

#[derive(Deserialize)]
struct EchoCase {
    name: String,
    queued: QueuedWrite,
    incoming: ChangeEvent,
    expected: bool,
}

#[derive(Deserialize)]
struct AckCase {
    name: String,
    local: LocalRow,
    ack: WriteAck,
    expected: AckOutcome,
}

fn fixture() -> Fixture {
    serde_json::from_str(include_str!("../protocol/conformance.json"))
        .expect("shared protocol fixture must be valid")
}

#[test]
fn rust_core_conforms_to_the_shared_protocol_fixture() {
    let fixture = fixture();
    assert_eq!(fixture.protocol_version, 1);

    for case in &fixture.hlc_keys.valid {
        let parsed = Hlc::decode(&case.key, "replica")
            .unwrap_or_else(|| panic!("valid key rejected: {}", case.name));
        assert_eq!(parsed.wall_ms, case.wall_ms, "{}", case.name);
        assert_eq!(parsed.counter, case.counter, "{}", case.name);
        assert_eq!(parsed.actor, "replica");
        assert_eq!(parsed.encode(), case.key, "{}", case.name);
    }
    for key in &fixture.hlc_keys.invalid {
        assert!(Hlc::decode(key, "replica").is_none(), "bad key admitted: {key:?}");
    }

    for case in fixture.reconcile {
        assert_eq!(
            reconcile(case.local, &case.incoming),
            case.expected,
            "reconcile fixture failed: {}",
            case.name
        );
    }
    for case in fixture.echoes {
        assert_eq!(
            case.queued.is_echo_of(&case.incoming),
            case.expected,
            "echo fixture failed: {}",
            case.name
        );
    }
    for case in fixture.acks {
        assert_eq!(
            on_ack(&case.local, &case.ack),
            case.expected,
            "ack fixture failed: {}",
            case.name
        );
    }

    assert_eq!(
        fixture.clock.max_drift_ms, MAX_DRIFT_MS,
        "drift bound must agree with the fixture"
    );
    for case in fixture.clock.cases {
        let mut hlc = Hlc::new(0, 0, &case.actor);
        for op in case.ops {
            match (op.tick, op.observe) {
                (Some(now), None) => hlc.tick(now),
                (None, Some(remote)) => {
                    hlc.observe(&remote, op.now.expect("observe op needs `now`"))
                }
                _ => panic!(
                    "clock op must be exactly one of tick/observe: {}",
                    case.name
                ),
            }
            assert_eq!(hlc, op.expect, "clock fixture failed: {}", case.name);
        }
    }
}
