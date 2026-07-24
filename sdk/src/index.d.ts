// Strict typings for @zed-pkg/sync. The runtime is build-free ESM (src/*.mjs);
// these declarations give consumers full types without a build step.

export type Hlc = { wall_ms: number; counter: number; actor: string };
export type Op = "upsert" | "delete";

export interface ChangeEvent {
  table: string;
  op: Op;
  id: string;
  version: Hlc;
  row?: Record<string, unknown> | null;
  at_ms: number;
  write_key?: string;
  sync_sequence?: number;
}

export interface LocalRow {
  version: Hlc;
  dirty?: boolean;
}

export interface RowMeta {
  version: Hlc;
  dirty: boolean;
  synced_at_ms: number | null;
}

export type Reconcile = "Apply" | { Ignore: "Stale" | "AlreadyApplied" } | "Conflict";
export type AckOutcome = { Adopt: Hlc } | "Superseded";

export const WriteMode: {
  readonly LOCAL_ONLY: "local_only";
  readonly OPTIMISTIC_QUEUE: "optimistic_queue";
  readonly OPTIMISTIC_AWAIT_ACK: "optimistic_await_ack";
  readonly SERVER_FIRST: "server_first";
  readonly SERVER_ONLY: "server_only";
};
export type WriteModeValue = (typeof WriteMode)[keyof typeof WriteMode];

export const ErrorPolicy: {
  readonly THROW_ONLY: "throw_only";
  readonly EMIT_ONLY: "emit_only";
  readonly THROW_AND_EMIT: "throw_and_emit";
  readonly SILENT: "silent";
};
export type ErrorPolicyValue = (typeof ErrorPolicy)[keyof typeof ErrorPolicy];

export const ConflictResolution: {
  readonly SERVER_WINS: "server_wins";
  readonly LAST_WRITE_WINS: "last_write_wins";
};
export type ConflictResolutionValue = (typeof ConflictResolution)[keyof typeof ConflictResolution];

export function assertWriteMode(mode: string): WriteModeValue;
export function assertErrorPolicy(policy: string): ErrorPolicyValue;
export function assertConflictResolution(resolution: string): ConflictResolutionValue;

export function compareHlc(a: Hlc, b: Hlc): -1 | 0 | 1;
export function encodeHlc(h: Hlc): string;
/** Reject a remote stamp whose wall clock runs more than this far ahead (ms). */
export const MAX_DRIFT_MS: number;
export class Clock {
  constructor(actor: string);
  actor: string;
  tick(nowMs?: number): Hlc;
  observe(remote: Hlc, nowMs?: number): Hlc;
}

export function reconcile(local: LocalRow | null | undefined, incoming: ChangeEvent): Reconcile;
export function onAck(local: LocalRow, ack: { id: string; committed_version: Hlc }): AckOutcome;
export function isOwnEcho(queued: { table: string; id: string; op: string; key: string }, incoming: ChangeEvent): boolean;
export function resolveConflict(resolution: ConflictResolutionValue, local: LocalRow, incoming: ChangeEvent): boolean;
export function loadWasmCore(): Promise<{
  reconcile(local: LocalRow | null, incoming: ChangeEvent): Reconcile;
  onAck(local: LocalRow, ack: object): AckOutcome;
  isOwnEcho(queued: object, incoming: ChangeEvent): boolean;
}>;

export function deepMerge(base: unknown, patch: unknown): unknown;

export interface Telemetry {
  event(name: string, attributes?: Record<string, unknown>): void;
}
export const noopTelemetry: Telemetry;
export function makeConsoleTelemetry(prefix?: string): Telemetry;
export function combineTelemetry(...sinks: Array<Telemetry | null | undefined>): Telemetry;
export function makeOtelTelemetry(deps?: { tracer?: unknown; meter?: unknown; logger?: unknown }): Telemetry;

export interface Store {
  getRow(table: string, id: string): Promise<{ row: unknown; meta: RowMeta } | null>;
  putRow(table: string, id: string, row: unknown, meta: RowMeta): Promise<void>;
  removeRow(table: string, id: string, meta: RowMeta): Promise<void>;
  enqueue(write: object): Promise<number>;
  pending(): Promise<Array<Record<string, unknown> & { seq: number }>>;
  retire(seq: number): Promise<void>;
  getCursor(scope: string): Promise<{ cursor: string; lastSyncedAtMs: number } | null>;
  setCursor(scope: string, cursor: string, at?: number): Promise<void>;
}
/** Default upper bound on the durable write-queue length. */
export const DEFAULT_MAX_QUEUE_LENGTH: number;
export class MemoryStore implements Store {
  constructor(opts?: { maxQueueLength?: number });
  maxQueueLength: number;
  onOverflow: ((dropped: Record<string, unknown>) => void) | null;
  getRow(table: string, id: string): Promise<{ row: unknown; meta: RowMeta } | null>;
  putRow(table: string, id: string, row: unknown, meta: RowMeta): Promise<void>;
  removeRow(table: string, id: string, meta: RowMeta): Promise<void>;
  enqueue(write: object): Promise<number>;
  pending(): Promise<Array<Record<string, unknown> & { seq: number }>>;
  retire(seq: number): Promise<void>;
  getCursor(scope: string): Promise<{ cursor: string; lastSyncedAtMs: number } | null>;
  setCursor(scope: string, cursor: string, at?: number): Promise<void>;
}
export class IndexedDbStore implements Store {
  static open(dbName?: string, idb?: IDBFactory, opts?: { maxQueueLength?: number }): Promise<IndexedDbStore>;
  maxQueueLength: number;
  onOverflow: ((dropped: Record<string, unknown>) => void) | null;
  getRow(table: string, id: string): Promise<{ row: unknown; meta: RowMeta } | null>;
  putRow(table: string, id: string, row: unknown, meta: RowMeta): Promise<void>;
  removeRow(table: string, id: string, meta: RowMeta): Promise<void>;
  enqueue(write: object): Promise<number>;
  pending(): Promise<Array<Record<string, unknown> & { seq: number }>>;
  retire(seq: number): Promise<void>;
  getCursor(scope: string): Promise<{ cursor: string; lastSyncedAtMs: number } | null>;
  setCursor(scope: string, cursor: string, at?: number): Promise<void>;
}

export interface WriteOptions {
  op?: Op;
  merge?: boolean;
  mode?: WriteModeValue;
  errorPolicy?: ErrorPolicyValue;
}
export interface WriteResult {
  status: "acked" | "queued" | "local" | "failed";
  version: Hlc;
}

export class SyncClient {
  constructor(deps: {
    store: Store;
    actor: string;
    send?: (change: ChangeEvent) => Promise<{ committed_version: Hlc }>;
    telemetry?: Telemetry;
    writeMode?: WriteModeValue;
    errorPolicy?: ErrorPolicyValue;
    conflictResolution?: ConflictResolutionValue;
    tables?: string[];
    onError?: (err: unknown, ctx: Record<string, unknown>) => void;
  });
  actor: string;
  applyChange(incoming: ChangeEvent): Promise<"applied" | "ignored" | "conflict-resolved" | "refreshed">;
  write(table: string, id: string, row: Record<string, unknown> | null, options?: Op | WriteOptions): Promise<WriteResult>;
  delete(table: string, id: string, options?: WriteOptions): Promise<WriteResult>;
  flushQueue(errorPolicy?: ErrorPolicyValue): Promise<number>;
  hydrate(changes: ChangeEvent[]): Promise<void>;
  isEcho(incoming: ChangeEvent): Promise<boolean>;
}

export function decodeBackendFrame(frame: unknown): ChangeEvent[];
export function decodeSupabaseChange(payload: unknown): ChangeEvent | null;
export function startSupabase(opts: {
  client: unknown;
  sync: SyncClient;
  tables: string[];
  schema?: string;
  filter?: string;
  onStatus?: (status: string) => void;
}): { stop(): void };
export function makeBackendSender(opts: {
  baseUrl: string;
  getToken?: () => string | Promise<string>;
  fetchImpl?: typeof fetch;
}): (change: ChangeEvent) => Promise<{ committed_version: Hlc }>;
export function startBackendStream(opts: {
  baseUrl: string;
  sync: SyncClient;
  wsPath?: string;
  token?: string;
  getToken?: () => string | Promise<string>;
  onReconnect?: () => Promise<void>;
  onStatus?: (status: string) => void;
  WebSocketImpl?: typeof WebSocket;
}): { stop(): void };
// --- distributed single-flusher lease (lease.mjs, docs/leases.md) -----------

/** Handle contract the injected lock client must return (FiduciaLockClient shape). */
export interface LeaseLockHandle {
  fencingToken: number;
  leaseExpiresMs?: number;
  renew(ttlMs?: number): Promise<unknown>;
  release(): Promise<unknown>;
}
/** Injected lock client contract — @fiducia/client's FiduciaLockClient satisfies it. */
export interface LeaseLockClient {
  lock(
    key: string,
    opts: { ttl?: number; holder?: string; maxWaitTime?: number; signal?: AbortSignal },
  ): Promise<LeaseLockHandle>;
  tryLock(key: string, opts: { ttl?: number; holder?: string }): Promise<LeaseLockHandle | null>;
}

export const DEFAULT_LEASE_TTL_MS: number;
export function flusherLeaseKey(dbName: string, actor: string): string;
export class LeaseTimeoutError extends Error {
  key: string;
  waitedMs: number;
}
export class LeaseLostError extends Error {
  key: string;
}

export interface SyncLeaseOptions {
  client: LeaseLockClient;
  key: string;
  ttlMs?: number;
  renewIntervalMs?: number;
  /** Must be unique PER INSTANCE — a shared holder id defeats mutual exclusion. */
  holder?: string;
  renewFailureLimit?: number;
  onLost?: (err: LeaseLostError) => void;
  onRenewError?: (err: unknown, consecutiveFailures: number) => void;
}
export class SyncLease {
  constructor(opts: SyncLeaseOptions);
  readonly held: boolean;
  readonly fencingToken: number | null;
  readonly leaseExpiresMs: number | null;
  key: string;
  acquire(opts?: { maxWaitMs?: number; signal?: AbortSignal }): Promise<this>;
  tryAcquire(): Promise<boolean>;
  release(): Promise<void>;
}
export function withSyncLease<T>(
  opts: SyncLeaseOptions & { maxWaitMs?: number; signal?: AbortSignal },
  fn: (lease: SyncLease) => Promise<T> | T,
): Promise<T>;

export function startSync(opts: {
  actor: string;
  tables: string[];
  dbName?: string;
  store?: Store;
  telemetry?: Telemetry;
  writeMode?: WriteModeValue;
  errorPolicy?: ErrorPolicyValue;
  conflictResolution?: ConflictResolutionValue;
  backend?: { baseUrl: string; wsPath?: string; getToken?: () => string | Promise<string> };
  supabase?: { client: unknown; filter?: string; schema?: string };
  hydrateFetch?: (table: string) => Promise<ChangeEvent[]>;
  lease?: {
    client: LeaseLockClient;
    key?: string;
    ttlMs?: number;
    renewIntervalMs?: number;
    holder?: string;
    maxWaitMs?: number;
    flushOnAcquire?: boolean;
    onLost?: (err: LeaseLostError) => void;
  };
}): Promise<{ client: SyncClient; lease: SyncLease | null; stop(): void }>;
