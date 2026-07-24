//! wasm-bindgen ABI: JSON string in / JSON string out, so the browser SDK's
//! `core.mjs` can wrap it as object-in/object-out JS while running the exact
//! same tested Rust reconcile core. Built with
//! `wasm-pack build --target web --out-dir sdk/pkg -- --features wasm`.

use wasm_bindgen::prelude::*;

use crate::{ChangeEvent, LocalRow, QueuedWrite, WriteAck};

fn err(context: &str, e: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&format!("zed-sync-core: {context}: {e}"))
}

/// `reconcile(local?: LocalRow, incoming: ChangeEvent) -> Reconcile`
#[wasm_bindgen]
pub fn reconcile(local: Option<String>, incoming: String) -> Result<String, JsValue> {
    let local: Option<LocalRow> = match local {
        Some(s) => Some(serde_json::from_str(&s).map_err(|e| err("local", e))?),
        None => None,
    };
    let incoming: ChangeEvent = serde_json::from_str(&incoming).map_err(|e| err("incoming", e))?;
    let out = crate::reconcile(local, &incoming);
    serde_json::to_string(&out).map_err(|e| err("encode", e))
}

/// `on_ack(local: LocalRow, ack: WriteAck) -> AckOutcome`
#[wasm_bindgen]
pub fn on_ack(local: String, ack: String) -> Result<String, JsValue> {
    let local: LocalRow = serde_json::from_str(&local).map_err(|e| err("local", e))?;
    let ack: WriteAck = serde_json::from_str(&ack).map_err(|e| err("ack", e))?;
    serde_json::to_string(&crate::on_ack(&local, &ack)).map_err(|e| err("encode", e))
}

/// `is_own_echo(queued: QueuedWrite, incoming: ChangeEvent) -> bool`
#[wasm_bindgen]
pub fn is_own_echo(queued: String, incoming: String) -> Result<bool, JsValue> {
    let queued: QueuedWrite = serde_json::from_str(&queued).map_err(|e| err("queued", e))?;
    let incoming: ChangeEvent = serde_json::from_str(&incoming).map_err(|e| err("incoming", e))?;
    Ok(queued.is_echo_of(&incoming))
}
