// Compile-only check that the shipped declarations are well-formed and the
// enum-based write API types as intended. `npm run typecheck` compiles this.
import {
  SyncClient,
  MemoryStore,
  WriteMode,
  ErrorPolicy,
  ConflictResolution,
  type ChangeEvent,
  type WriteResult,
  reconcile,
  startSync,
} from "../src/index.js";

const store = new MemoryStore();
const client = new SyncClient({
  store,
  actor: "dev-1",
  writeMode: WriteMode.OPTIMISTIC_QUEUE,
  errorPolicy: ErrorPolicy.EMIT_ONLY,
  conflictResolution: ConflictResolution.SERVER_WINS,
});

// write() returns a typed WriteResult and accepts an enum mode.
const _res: Promise<WriteResult> = client.write("products", "p1", { id: "p1" }, {
  mode: WriteMode.SERVER_FIRST,
  errorPolicy: ErrorPolicy.THROW_ONLY,
});

const change: ChangeEvent = {
  table: "products",
  op: "upsert",
  id: "p1",
  version: { wall_ms: 1, counter: 0, actor: "srv" },
  row: { id: "p1" },
  at_ms: 1,
};
const _decision = reconcile({ version: change.version, dirty: false }, change);

// startSync wires both transports.
const _started = startSync({ actor: "d", tables: ["products"], store });

export {};
