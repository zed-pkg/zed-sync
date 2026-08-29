// Finite application/session lifecycle for mobile, desktop, and browser apps.
//
// The runtime reducers use unbounded monotonic operation generations. This
// model bounds the counter to four generations, which is sufficient to explore
// start/stop replacement, stale async completion, failure, and explicit
// reconciliation while keeping TLC's state space finite and exhaustive.
module app_lifecycle {
  type Phase = Stopped | Starting | Online | Offline | Stopping | Failed
  type Operation = NoOperation | StartOperation | StopOperation | ReconcileOperation
  type Failure = NoFailure | StartFailure | RuntimeFailure | StopFailure

  type State = {
    phase: Phase,
    operation: Operation,
    generation: int,
    active_token: int,
    desired_running: bool,
    online: bool,
    failure: Failure,
    saw_stale_completion: bool,
    saw_invalid_completion: bool,
    saw_rejected_transition: bool,
    saw_failure_reconciliation: bool,
  }

  var s: State

  action init = {
    s' = {
      phase: Stopped,
      operation: NoOperation,
      generation: 0,
      active_token: 0,
      desired_running: false,
      online: false,
      failure: NoFailure,
      saw_stale_completion: false,
      saw_invalid_completion: false,
      saw_rejected_transition: false,
      saw_failure_reconciliation: false,
    }
  }

  action request_start = all {
    s.phase == Stopped,
    s.generation < 4,
    s' = {
      ...s,
      phase: Starting,
      operation: StartOperation,
      generation: s.generation + 1,
      active_token: s.generation + 1,
      desired_running: true,
      online: false,
      failure: NoFailure,
    },
  }

  // Transport callbacks may race with hydration while startup is still in
  // progress. They can update connectivity, but cannot skip Starting.
  action connectivity_online = all {
    or {
      s.phase == Starting,
      s.phase == Online,
      s.phase == Offline,
    },
    s' = {
      ...s,
      phase: if (s.phase == Starting) Starting else Online,
      online: true,
    },
  }

  action connectivity_offline = all {
    or {
      s.phase == Starting,
      s.phase == Online,
      s.phase == Offline,
    },
    s' = {
      ...s,
      phase: if (s.phase == Starting) Starting else Offline,
      online: false,
    },
  }

  action start_succeeded = all {
    s.phase == Starting,
    s.operation == StartOperation,
    s.active_token == s.generation,
    s' = {
      ...s,
      phase: if (s.online) Online else Offline,
      operation: NoOperation,
    },
  }

  // This event revokes logical authority. The adapter also cleans any partial
  // platform effects; Failed blocks restart until reconciliation confirms it.
  action start_failed = all {
    s.phase == Starting,
    s' = {
      ...s,
      phase: Failed,
      operation: NoOperation,
      active_token: 0,
      desired_running: false,
      online: false,
      failure: StartFailure,
    },
  }

  action request_stop = all {
    or {
      s.phase == Starting,
      s.phase == Online,
      s.phase == Offline,
    },
    s.generation < 4,
    s' = {
      ...s,
      phase: Stopping,
      operation: StopOperation,
      generation: s.generation + 1,
      active_token: s.generation + 1,
      desired_running: false,
      online: false,
      failure: NoFailure,
    },
  }

  // Runtime authority is revoked immediately; platform cleanup follows under
  // closed capabilities and is reconciled explicitly before any restart.
  action runtime_failed = all {
    or {
      s.phase == Starting,
      s.phase == Online,
      s.phase == Offline,
    },
    s' = {
      ...s,
      phase: Failed,
      operation: NoOperation,
      active_token: 0,
      desired_running: false,
      online: false,
      failure: RuntimeFailure,
    },
  }

  action stop_succeeded = all {
    s.phase == Stopping,
    s' = {
      ...s,
      phase: Stopped,
      operation: NoOperation,
      active_token: 0,
      desired_running: false,
      online: false,
      failure: NoFailure,
      saw_failure_reconciliation:
        s.saw_failure_reconciliation or s.operation == ReconcileOperation,
    },
  }

  action stop_failed_closed = all {
    s.phase == Stopping,
    s' = {
      ...s,
      phase: Failed,
      operation: NoOperation,
      active_token: 0,
      desired_running: false,
      online: false,
      failure: StopFailure,
    },
  }

  // Failed is intentionally not directly restartable. An app must first run
  // explicit platform reconciliation/cleanup back to Stopped.
  action request_failure_reconciliation = all {
    s.phase == Failed,
    s.generation < 4,
    s' = {
      ...s,
      phase: Stopping,
      operation: ReconcileOperation,
      generation: s.generation + 1,
      active_token: s.generation + 1,
      desired_running: false,
      online: false,
      failure: NoFailure,
    },
  }

  // Abstract a completion carrying previously allocated but revoked authority.
  // With an active generation this requires an older positive token; without
  // one, the just-revoked generation is stale as well.
  action stale_completion = all {
    s.generation >= 1,
    or {
      s.active_token == 0,
      s.generation >= 2,
    },
    s' = { ...s, saw_stale_completion: true },
  }

  // Token zero and tokens beyond the allocated generation are impossible
  // authority, not benign stale completions. They are rejected without
  // changing operational state.
  action invalid_completion = {
    s' = {
      ...s,
      saw_invalid_completion: true,
      saw_rejected_transition: true,
    }
  }

  // Every invalid current-generation event is rejected without state change.
  action rejected_transition = {
    s' = { ...s, saw_rejected_transition: true }
  }

  action idle = s' = s

  action step = any {
    request_start,
    connectivity_online,
    connectivity_offline,
    start_succeeded,
    start_failed,
    request_stop,
    runtime_failed,
    stop_succeeded,
    stop_failed_closed,
    request_failure_reconciliation,
    stale_completion,
    invalid_completion,
    rejected_transition,
    idle,
  }

  val generation_is_bounded = and {
    s.generation >= 0,
    s.generation <= 4,
    s.active_token >= 0,
    s.active_token <= s.generation,
  }

  val stopped_is_quiescent = s.phase != Stopped or and {
    s.operation == NoOperation,
    s.active_token == 0,
    not(s.desired_running),
    not(s.online),
    s.failure == NoFailure,
  }

  val starting_owns_start_intent = s.phase != Starting or and {
    s.operation == StartOperation,
    s.active_token == s.generation,
    s.active_token > 0,
    s.desired_running,
    s.failure == NoFailure,
  }

  val online_is_active = s.phase != Online or and {
    s.operation == NoOperation,
    s.active_token == s.generation,
    s.active_token > 0,
    s.desired_running,
    s.online,
    s.failure == NoFailure,
  }

  val offline_is_active = s.phase != Offline or and {
    s.operation == NoOperation,
    s.active_token == s.generation,
    s.active_token > 0,
    s.desired_running,
    not(s.online),
    s.failure == NoFailure,
  }

  val stopping_revokes_capabilities = s.phase != Stopping or and {
    or {
      s.operation == StopOperation,
      s.operation == ReconcileOperation,
    },
    s.active_token == s.generation,
    s.active_token > 0,
    not(s.desired_running),
    not(s.online),
    s.failure == NoFailure,
  }

  val failed_is_closed = s.phase != Failed or and {
    s.operation == NoOperation,
    s.active_token == 0,
    not(s.desired_running),
    not(s.online),
    s.failure != NoFailure,
  }

  // Runtime capabilities are pure phase projections, so every phase that can
  // receive or mutate data must still own current generation authority. A
  // foreign snapshot outside these predicates is closed by each refinement
  // before capabilities are derived.
  val derived_capabilities_are_authorized = and {
    not(or {
      s.phase == Starting,
      s.phase == Online,
      s.phase == Offline,
    }) or and {
      s.active_token == s.generation,
      s.active_token > 0,
      s.desired_running,
      s.failure == NoFailure,
    },
    not(or {
      s.phase == Online,
      s.phase == Offline,
    }) or and {
      s.operation == NoOperation,
      s.active_token == s.generation,
      s.active_token > 0,
      s.desired_running,
    },
    s.phase != Online or s.online,
    s.phase != Failed or failed_is_closed,
  }

  val app_lifecycle_safety = and {
    generation_is_bounded,
    stopped_is_quiescent,
    starting_owns_start_intent,
    online_is_active,
    offline_is_active,
    stopping_revokes_capabilities,
    failed_is_closed,
    derived_capabilities_are_authorized,
  }

  val online_reached = s.phase == Online
  val offline_reached = s.phase == Offline
  val failed_reached = s.phase == Failed
  val stale_completion_reached = s.saw_stale_completion
  val invalid_completion_rejected = s.saw_invalid_completion
  val rejected_transition_reached = s.saw_rejected_transition
  val failure_reconciliation_reached = s.saw_failure_reconciliation
}
