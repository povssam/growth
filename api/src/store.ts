/**
 * Job store: a single SQLite-backed Durable Object (free tier, no D1 database needed).
 * `DbShim` mirrors the subset of the D1 API the Worker uses (prepare/bind/first/all/run),
 * so the rest of the code is storage-agnostic.
 */
import { DurableObject } from "cloudflare:workers";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY, tool TEXT NOT NULL, mode TEXT NOT NULL, status TEXT NOT NULL,
    progress REAL NOT NULL DEFAULT 0, message TEXT, input_key TEXT NOT NULL, output_key TEXT,
    poster_key TEXT, before_key TEXT, options TEXT NOT NULL, provider_job_id TEXT,
    attempts INTEGER NOT NULL DEFAULT 0, estimate_usd REAL NOT NULL DEFAULT 0, cost_usd REAL,
    gpu_seconds REAL, stats TEXT, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS jobs_created ON jobs (created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS uploads (key TEXT PRIMARY KEY, name TEXT, bytes INTEGER, duration REAL, created_at INTEGER NOT NULL)`,
];

type Row = Record<string, string | number | null>;

export class JobStore extends DurableObject {
  constructor(ctx: DurableObjectState, env: never) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      for (const s of SCHEMA) ctx.storage.sql.exec(s);
    });
  }

  exec(sql: string, params: (string | number | null)[]): { rows: Row[]; changes: number } {
    const cur = this.ctx.storage.sql.exec(sql, ...params);
    const rows = cur.toArray() as Row[];
    return { rows, changes: cur.rowsWritten };
  }
}

type Stub = { exec(sql: string, params: (string | number | null)[]): Promise<{ rows: Row[]; changes: number }> };

export class DbShim {
  constructor(private stub: Stub) {}
  prepare(sql: string) {
    const stub = this.stub;
    const make = (params: (string | number | null)[]) => ({
      bind: (...p: (string | number | null | undefined)[]) => make(p.map((v) => (v === undefined ? null : v))),
      async first<T>(): Promise<T | null> {
        const r = await stub.exec(sql, params);
        return (r.rows[0] as T) ?? null;
      },
      async all<T>(): Promise<{ results: T[] }> {
        const r = await stub.exec(sql, params);
        return { results: r.rows as T[] };
      },
      async run() {
        const r = await stub.exec(sql, params);
        return { meta: { changes: r.changes } };
      },
    });
    return make([]);
  }
}
