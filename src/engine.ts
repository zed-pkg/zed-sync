import type { LocalDb } from "./outbox.js";
import type { SyncTransport } from "./transport.js";
import type { ChangeRecord, SyncEvents, SyncStatus } from "./types.js";

/** Pure last-write-wins decision: does the remote change beat the local one? */
export function remoteWins(local: ChangeRecord, remote: ChangeRecord): boolean {
  if (remote.updated_at === local.updated_at) {
    // Deterministic tiebreak so every replica converges.
    return remote.client_id > local.client_id;
  }
  return remote.updated_at > local.updated_at;
}

/** Pure exponential backoff with a cap: 500ms, 1s, 2s, ... max 60s. */
export function backoffMs(attempt: number, baseMs = 500, maxMs = 60_000): number {
  const exp = baseMs * 2 ** Math.max(0, attempt);
  return Math.min(exp, maxMs);
}

/**
 * Drains the outbox to the transport (with backoff on failure), pulls remote
 * changes, and merges them last-write-wins into local state. Writes stay
 * optimistic: the UI reads LocalDb immediately; the engine reconciles in the
 * background.
 */
export class SyncEngine {
  private timer: ReturnType<typeof setInterval> | null = null;
  private attempt = 0;
  private nextAllowedFlush = 0;
  private status: SyncStatus = "idle";

  constructor(
    private readonly db: LocalDb,
    private readonly transport: SyncTransport,
    private readonly clientId: string,
    private readonly events: SyncEvents = {},
  ) {}

  start(intervalMs = 2_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private setStatus(status: SyncStatus): void {
    this.status = status;
    this.events.status?.(status);
  }

  async tick(now: number = Date.now()): Promise<void> {
    if (now < this.nextAllowedFlush) return;
    try {
      await this.flush();
      await this.pull();
      this.attempt = 0;
      this.setStatus("idle");
    } catch (error) {
      this.attempt += 1;
      this.nextAllowedFlush = now + backoffMs(this.attempt);
      this.setStatus("error");
      this.events.error?.(error);
    }
  }

  /** Push every pending outbox change; ack what the server accepted. */
  async flush(): Promise<number> {
    this.setStatus("flushing");
    const pending = await this.db.pending();
    if (pending.length === 0) return 0;
    const { acked } = await this.transport.push(pending);
    await this.db.ack(acked);
    return acked.length;
  }

  /** Pull remote changes since the cursor and merge last-write-wins. */
  async pull(): Promise<number> {
    this.setStatus("pulling");
    const cursor = await this.db.getCursor();
    const { changes, cursor: nextCursor } = await this.transport.pull(cursor, this.clientId);
    const pending = await this.db.pending();
    for (const remote of changes) {
      const local = pending.find(
        (candidate) => candidate.table === remote.table && candidate.pk === remote.pk,
      );
      if (local && !remoteWins(local, remote)) {
        this.events.conflict?.(local, remote);
        continue; // our unflushed local write is newer; keep it
      }
      if (local) this.events.conflict?.(local, remote);
      await this.db.applyRemote(remote);
      this.events.applied?.(remote);
    }
    await this.db.setCursor(nextCursor);
    return changes.length;
  }

  currentStatus(): SyncStatus {
    return this.status;
  }
}
