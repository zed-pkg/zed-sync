//! Refinement replay for the finite optimistic-write lifecycle model.
//!
//! JavaScript and Dart consume this exact JSON corpus as well. These cases bind
//! the abstract write generations in `formal/write_lifecycle.qnt` to concrete
//! HLC values and immutable queue keys in the production Rust core.

use std::collections::BTreeSet;

use serde::Deserialize;
use zed_sync_core::{
    settle_queued_ack, Hlc, LocalRow, Op, QueuedAckSettlement, QueuedWrite, WriteAck,
};

#[derive(Deserialize)]
struct Fixture {
    schema_version: u32,
    model: String,
    cases: Vec<SettlementCase>,
}

#[derive(Deserialize)]
struct SettlementCase {
    name: String,
    actions: Vec<String>,
    current: Current,
    settling: Settling,
    expected: Expected,
}

#[derive(Deserialize)]
struct Current {
    local: LocalRow,
    queued: QueuedRef,
}

#[derive(Deserialize)]
struct QueuedRef {
    table: String,
    id: String,
    op: Op,
    key: String,
}

#[derive(Deserialize)]
struct Settling {
    write_key: String,
    base_version: Hlc,
    ack: WriteAck,
}

#[derive(Deserialize)]
struct Expected {
    settlement: String,
    retire_current_slot: bool,
    final_dirty: bool,
    final_queued_key: Option<String>,
    final_version: Hlc,
}

fn fixture() -> Fixture {
    serde_json::from_str(include_str!("../protocol/formal-write-lifecycle.json"))
        .expect("formal refinement fixture must be valid JSON")
}

fn outcome_name(settlement: &QueuedAckSettlement) -> &'static str {
    if settlement.adopt.is_some() {
        "Adopt"
    } else {
        "Preserve"
    }
}

#[test]
fn rust_replays_every_formal_write_lifecycle_case() {
    let fixture = fixture();
    assert_eq!(fixture.schema_version, 1);
    assert_eq!(fixture.model, "optimistic-write-lifecycle-v1");
    assert!(fixture.cases.len() >= 4);

    let mut covered_actions = BTreeSet::new();
    for case in fixture.cases {
        covered_actions.extend(case.actions.iter().cloned());
        let queued = QueuedWrite {
            table: case.current.queued.table,
            id: case.current.queued.id,
            op: case.current.queued.op,
            base_version: case.current.local.version.clone(),
            key: case.current.queued.key.clone(),
        };
        let got = settle_queued_ack(
            &case.current.local,
            &queued,
            &case.settling.write_key,
            &case.settling.base_version,
            &case.settling.ack,
        );

        assert_eq!(
            outcome_name(&got),
            case.expected.settlement,
            "{}",
            case.name
        );
        assert_eq!(
            got.retire_current_slot, case.expected.retire_current_slot,
            "{}",
            case.name
        );

        let final_version = got
            .adopt
            .clone()
            .unwrap_or_else(|| case.current.local.version.clone());
        let final_dirty = if got.adopt.is_some() {
            false
        } else {
            case.current.local.dirty
        };
        let final_queued_key = if got.retire_current_slot {
            None
        } else {
            Some(case.current.queued.key)
        };
        assert_eq!(final_version, case.expected.final_version, "{}", case.name);
        assert_eq!(final_dirty, case.expected.final_dirty, "{}", case.name);
        assert_eq!(
            final_queued_key, case.expected.final_queued_key,
            "{}",
            case.name
        );
    }

    for required in [
        "local_write",
        "send",
        "disconnect",
        "reconnect",
        "acknowledge",
        "duplicate_ack",
    ] {
        assert!(
            covered_actions.contains(required),
            "formal refinement corpus must cover {required}"
        );
    }
}
