import type { ChangeRecord, PullResult, PushResult } from "./types.js";

/** Server half of the sync loop. Implementations ship changes to Postgres. */
export interface SyncTransport {
  push(changes: ChangeRecord[]): Promise<PushResult>;
  pull(sinceCursor: string, clientId: string): Promise<PullResult>;
}

/**
 * Minimal structural slice of a Supabase client — `@supabase/supabase-js`
 * satisfies this, but it is NOT a dependency; callers hand their own client
 * in. Only the query-builder methods the transport uses are declared.
 */
export interface SupabaseLike {
  from(table: string): {
    upsert(rows: Record<string, unknown>[]): Promise<{ error: { message: string } | null }>;
    select(columns: string): {
      gt(
        column: string,
        value: string,
      ): {
        order(
          column: string,
          options: { ascending: boolean },
        ): Promise<{ data: unknown[] | null; error: { message: string } | null }>;
      };
    };
  };
}

/**
 * Syncs through a `sync_changes` journal table (see schema.sql): pushes
 * append rows, pulls read rows after the cursor. Row-level triggers fan the
 * journal out into the real tables server-side.
 */
export class SupabaseTransport implements SyncTransport {
  constructor(private readonly client: SupabaseLike) {}

  async push(changes: ChangeRecord[]): Promise<PushResult> {
    if (changes.length === 0) return { acked: [] };
    const rows = changes.map((change) => ({
      id: change.id,
      table_name: change.table,
      pk: change.pk,
      op: change.op,
      payload: change.payload,
      client_id: change.client_id,
      updated_at: change.updated_at,
    }));
    const { error } = await this.client.from("sync_changes").upsert(rows);
    if (error) throw new Error(`push failed: ${error.message}`);
    return { acked: changes.map((change) => change.id) };
  }

  async pull(sinceCursor: string, clientId: string): Promise<PullResult> {
    const since = sinceCursor || "1970-01-01T00:00:00Z";
    const { data, error } = await this.client
      .from("sync_changes")
      .select("id,table_name,pk,op,payload,client_id,updated_at")
      .gt("updated_at", since)
      .order("updated_at", { ascending: true });
    if (error) throw new Error(`pull failed: ${error.message}`);
    const rows = (data ?? []) as Array<Record<string, unknown>>;
    const changes: ChangeRecord[] = rows
      .filter((row) => row.client_id !== clientId)
      .map((row, index) => ({
        id: String(row.id),
        table: String(row.table_name),
        pk: String(row.pk),
        op: row.op as ChangeRecord["op"],
        payload: (row.payload as Record<string, unknown>) ?? null,
        client_id: String(row.client_id),
        seq: index,
        updated_at: String(row.updated_at),
      }));
    const cursor =
      rows.length > 0 ? String(rows[rows.length - 1].updated_at) : since;
    return { changes, cursor };
  }
}

/** Plain PostgREST/HTTP flavor of the same journal protocol. */
export class RestTransport implements SyncTransport {
  constructor(
    private readonly baseUrl: string,
    private readonly headers: Record<string, string> = {},
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async push(changes: ChangeRecord[]): Promise<PushResult> {
    if (changes.length === 0) return { acked: [] };
    const response = await this.fetchImpl(`${this.baseUrl}/sync_changes`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        prefer: "resolution=merge-duplicates",
        ...this.headers,
      },
      body: JSON.stringify(
        changes.map((change) => ({
          id: change.id,
          table_name: change.table,
          pk: change.pk,
          op: change.op,
          payload: change.payload,
          client_id: change.client_id,
          updated_at: change.updated_at,
        })),
      ),
    });
    if (!response.ok) throw new Error(`push failed: ${response.status}`);
    return { acked: changes.map((change) => change.id) };
  }

  async pull(sinceCursor: string, clientId: string): Promise<PullResult> {
    const since = sinceCursor || "1970-01-01T00:00:00Z";
    const query = `updated_at=gt.${encodeURIComponent(since)}&order=updated_at.asc`;
    const response = await this.fetchImpl(`${this.baseUrl}/sync_changes?${query}`, {
      headers: this.headers,
    });
    if (!response.ok) throw new Error(`pull failed: ${response.status}`);
    const rows = (await response.json()) as Array<Record<string, unknown>>;
    const changes: ChangeRecord[] = rows
      .filter((row) => row.client_id !== clientId)
      .map((row, index) => ({
        id: String(row.id),
        table: String(row.table_name),
        pk: String(row.pk),
        op: row.op as ChangeRecord["op"],
        payload: (row.payload as Record<string, unknown>) ?? null,
        client_id: String(row.client_id),
        seq: index,
        updated_at: String(row.updated_at),
      }));
    const cursor = rows.length > 0 ? String(rows[rows.length - 1].updated_at) : since;
    return { changes, cursor };
  }
}
