export type Op = "upsert" | "delete";

/** One optimistic mutation, journaled locally and shipped to the server. */
export interface ChangeRecord {
  /** Client-generated id (uuid). */
  id: string;
  table: string;
  /** Primary key of the affected row. */
  pk: string;
  op: Op;
  /** Row payload for upserts; ignored for deletes. */
  payload: Record<string, unknown> | null;
  /** Stable per-device id; lets the server skip echoing our own changes. */
  client_id: string;
  /** Monotonic per-client sequence (assigned by the outbox). */
  seq: number;
  /** RFC 3339; last-write-wins tiebreaker. */
  updated_at: string;
}

export interface PushResult {
  /** Change ids the server durably accepted. */
  acked: string[];
}

export interface PullResult {
  changes: ChangeRecord[];
  /** Opaque cursor to resume from. */
  cursor: string;
}

export type SyncStatus = "idle" | "flushing" | "pulling" | "error";

export interface SyncEvents {
  status?: (status: SyncStatus) => void;
  conflict?: (local: ChangeRecord, remote: ChangeRecord) => void;
  error?: (error: unknown) => void;
  applied?: (change: ChangeRecord) => void;
}
