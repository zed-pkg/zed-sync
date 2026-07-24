import type { ChangeRecord, Op } from "./types.js";

/** Promise wrapper over a bare IDBRequest. */
function req<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

const DB_NAME = "zed-sync";
const DB_VERSION = 1;
export const STORE_OUTBOX = "outbox";
export const STORE_TABLES = "tables";
export const STORE_META = "meta";

/**
 * Local persistence: `tables` holds the optimistic materialized state
 * (key `${table}:${pk}`), `outbox` journals pending changes in seq order,
 * `meta` keeps the pull cursor. All three are written in one transaction so
 * optimistic state and its journal entry cannot diverge.
 */
export class LocalDb {
  private constructor(private readonly db: IDBDatabase) {}

  static async open(indexedDb: IDBFactory = globalThis.indexedDB): Promise<LocalDb> {
    const request = indexedDb.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_OUTBOX)) {
        db.createObjectStore(STORE_OUTBOX, { keyPath: "seq", autoIncrement: true });
      }
      if (!db.objectStoreNames.contains(STORE_TABLES)) {
        db.createObjectStore(STORE_TABLES);
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META);
      }
    };
    return new LocalDb(await req(request));
  }

  /** Apply a mutation locally and journal it, atomically. */
  async apply(
    table: string,
    pk: string,
    op: Op,
    payload: Record<string, unknown> | null,
    clientId: string,
  ): Promise<ChangeRecord> {
    const change: Omit<ChangeRecord, "seq"> = {
      id: crypto.randomUUID(),
      table,
      pk,
      op,
      payload,
      client_id: clientId,
      updated_at: new Date().toISOString(),
    };
    const tx = this.db.transaction([STORE_OUTBOX, STORE_TABLES], "readwrite");
    const seq = await req(tx.objectStore(STORE_OUTBOX).add(change));
    const key = `${table}:${pk}`;
    if (op === "delete") {
      await req(tx.objectStore(STORE_TABLES).delete(key));
    } else {
      await req(tx.objectStore(STORE_TABLES).put(payload, key));
    }
    await txDone(tx);
    return { ...change, seq: seq as number };
  }

  /** Overwrite local state from a remote change (no outbox entry). */
  async applyRemote(change: ChangeRecord): Promise<void> {
    const tx = this.db.transaction(STORE_TABLES, "readwrite");
    const key = `${change.table}:${change.pk}`;
    if (change.op === "delete") {
      await req(tx.objectStore(STORE_TABLES).delete(key));
    } else {
      await req(tx.objectStore(STORE_TABLES).put(change.payload, key));
    }
    await txDone(tx);
  }

  async get(table: string, pk: string): Promise<unknown> {
    const tx = this.db.transaction(STORE_TABLES, "readonly");
    return req(tx.objectStore(STORE_TABLES).get(`${table}:${pk}`));
  }

  async pending(): Promise<ChangeRecord[]> {
    const tx = this.db.transaction(STORE_OUTBOX, "readonly");
    const rows = await req(tx.objectStore(STORE_OUTBOX).getAll());
    return rows as ChangeRecord[];
  }

  /** Drop acked changes from the journal. */
  async ack(ids: string[]): Promise<void> {
    const acked = new Set(ids);
    const tx = this.db.transaction(STORE_OUTBOX, "readwrite");
    const store = tx.objectStore(STORE_OUTBOX);
    const rows = (await req(store.getAll())) as ChangeRecord[];
    for (const row of rows) {
      if (acked.has(row.id)) {
        await req(store.delete(row.seq));
      }
    }
    await txDone(tx);
  }

  async getCursor(): Promise<string> {
    const tx = this.db.transaction(STORE_META, "readonly");
    return ((await req(tx.objectStore(STORE_META).get("cursor"))) as string) ?? "";
  }

  async setCursor(cursor: string): Promise<void> {
    const tx = this.db.transaction(STORE_META, "readwrite");
    await req(tx.objectStore(STORE_META).put(cursor, "cursor"));
    await txDone(tx);
  }
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
