// Finite transition system for one coalesced optimistic-write queue slot.
//
// The JavaScript store deliberately reuses a queue sequence number when a
// second write targets the same (table, id). A response to the first request
// may therefore arrive after the slot contains the second write. Retirement is
// safe only when the settling request's immutable write key still matches the
// current slot. Rust, JavaScript, and Dart replay the corresponding refinement
// cases in protocol/formal-write-lifecycle.json.
module write_lifecycle {
  type WriteKey = NoKey | FirstKey | SecondKey

  type State = {
    queued_key: WriteKey,
    in_flight_key: WriteKey,
    local_generation: int,
    in_flight_generation: int,
    dirty: bool,
    connected: bool,
    needs_retry: bool,
    last_settled_key: WriteKey,
    last_retired_key: WriteKey,
    saw_late_ack: bool,
    saw_retry_after_disconnect: bool,
    saw_server_conflict: bool,
    saw_duplicate_ack: bool,
  }

  var s: State

  action init = {
    s' = {
      queued_key: NoKey,
      in_flight_key: NoKey,
      local_generation: 0,
      in_flight_generation: 0,
      dirty: false,
      connected: true,
      needs_retry: false,
      last_settled_key: NoKey,
      last_retired_key: NoKey,
      saw_late_ack: false,
      saw_retry_after_disconnect: false,
      saw_server_conflict: false,
      saw_duplicate_ack: false,
    }
  }

  // A repeated write to the same row replaces the queue slot's key and payload
  // while its storage sequence remains stable.
  action local_write = all {
    s.local_generation < 2,
    s' = {
      ...s,
      queued_key: if (s.local_generation == 0) FirstKey else SecondKey,
      local_generation: s.local_generation + 1,
      dirty: true,
    },
  }

  action send = all {
    s.connected,
    s.queued_key != NoKey,
    s.in_flight_key == NoKey,
    s' = {
      ...s,
      in_flight_key: s.queued_key,
      in_flight_generation: s.local_generation,
      needs_retry: false,
      saw_retry_after_disconnect:
        s.saw_retry_after_disconnect or s.needs_retry,
    },
  }

  // The request may be ambiguous after disconnect, but the durable queue slot
  // remains available for a retry under its original current key.
  action disconnect = all {
    s.connected,
    s' = {
      ...s,
      connected: false,
      needs_retry: s.needs_retry or s.in_flight_key != NoKey,
      in_flight_key: NoKey,
      in_flight_generation: 0,
    },
  }

  action reconnect = all {
    not(s.connected),
    s' = { ...s, connected: true },
  }

  action send_failure = all {
    s.in_flight_key != NoKey,
    s' = {
      ...s,
      in_flight_key: NoKey,
      in_flight_generation: 0,
      needs_retry: true,
    },
  }

  // Exact-key retirement is the central refinement rule. A late acknowledgement
  // for FirstKey may settle its request, but it must leave a coalesced SecondKey
  // queued and dirty.
  action acknowledge = all {
    s.in_flight_key != NoKey,
    s' = {
      ...s,
      queued_key:
        if (s.queued_key == s.in_flight_key) NoKey else s.queued_key,
      dirty:
        if (s.queued_key == s.in_flight_key) false else s.dirty,
      in_flight_key: NoKey,
      in_flight_generation: 0,
      last_settled_key: s.in_flight_key,
      last_retired_key:
        if (s.queued_key == s.in_flight_key) s.in_flight_key else NoKey,
      saw_late_ack:
        s.saw_late_ack or s.local_generation > s.in_flight_generation,
    },
  }

  // A duplicate response is observationally idempotent after the first
  // settlement; it cannot retire another queue slot.
  action duplicate_ack = all {
    s.last_settled_key != NoKey,
    s' = { ...s, saw_duplicate_ack: true },
  }

  // The configured server-wins policy intentionally adopts the incoming state
  // and drops this row's queued write. This is a distinct, explicit transition,
  // not an accidental acknowledgement retirement.
  action server_wins_conflict = all {
    s.queued_key != NoKey,
    s' = {
      ...s,
      queued_key: NoKey,
      in_flight_key: NoKey,
      local_generation: s.local_generation,
      in_flight_generation: 0,
      dirty: false,
      needs_retry: false,
      last_settled_key: NoKey,
      last_retired_key: NoKey,
      saw_server_conflict: true,
    },
  }

  action idle = s' = s

  action step = any {
    local_write,
    send,
    disconnect,
    reconnect,
    send_failure,
    acknowledge,
    duplicate_ack,
    server_wins_conflict,
    idle,
  }

  val generation_is_bounded = and {
    s.local_generation >= 0,
    s.local_generation <= 2,
    s.in_flight_generation >= 0,
    s.in_flight_generation <= s.local_generation,
  }

  val queue_matches_dirty =
    (s.queued_key == NoKey) == not(s.dirty)

  val queue_key_matches_generation = and {
    s.queued_key != FirstKey or s.local_generation == 1,
    s.queued_key != SecondKey or s.local_generation == 2,
  }

  val flight_is_well_formed = or {
    and {
      s.in_flight_key == NoKey,
      s.in_flight_generation == 0,
    },
    and {
      s.in_flight_key == FirstKey,
      s.in_flight_generation == 1,
    },
    and {
      s.in_flight_key == SecondKey,
      s.in_flight_generation == 2,
    },
  }

  val retry_preserves_a_queue =
    not(s.needs_retry) or and {
      s.queued_key != NoKey,
      s.in_flight_key == NoKey,
    }

  val retirement_requires_exact_key = or {
    s.last_retired_key == NoKey,
    s.last_retired_key == s.last_settled_key,
  }

  val write_lifecycle_safety = and {
    generation_is_bounded,
    queue_matches_dirty,
    queue_key_matches_generation,
    flight_is_well_formed,
    retry_preserves_a_queue,
    retirement_requires_exact_key,
  }

  val late_ack_preserves_newest_write = and {
    s.saw_late_ack,
    s.queued_key == SecondKey,
    s.dirty,
    s.last_settled_key == FirstKey,
    s.last_retired_key == NoKey,
  }

  val retry_after_disconnect_reached = s.saw_retry_after_disconnect
  val server_wins_conflict_reached = s.saw_server_conflict
  val duplicate_ack_reached = s.saw_duplicate_ack
}
