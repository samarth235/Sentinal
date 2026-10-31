import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { flipVerdict, HashChainAuditSink, pickTamperTarget, type AuditRow, type ChainStore } from "./hashChain.js";

const MIGRATION = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../sql/001_audit_log.sql");
// Arbitrary constant key for the advisory lock that serialises appends across processes.
const CHAIN_LOCK_KEY = 4242001;

interface DbRow {
  seq: string;
  run_id: string;
  event_type: string;
  payload: unknown;
  created_at: Date;
  prev_hash: string;
  hash: string;
}

const toRow = (r: DbRow): AuditRow => ({
  seq: Number(r.seq),
  run_id: r.run_id,
  event_type: r.event_type,
  payload: r.payload,
  created_at: r.created_at.toISOString(),
  prev_hash: r.prev_hash,
  hash: r.hash,
});

export class PostgresChainStore implements ChainStore {
  readonly kind = "postgres" as const;
  private ready: Promise<void> | null = null;

  constructor(private readonly pool: pg.Pool) {}

  /** Runs the migration once (CREATE TABLE IF NOT EXISTS). */
  init(): Promise<void> {
    this.ready ??= fs.readFile(MIGRATION, "utf8").then((sql) => this.pool.query(sql).then(() => undefined));
    // Allow a retry if the first attempt failed (e.g. DB not up yet).
    this.ready.catch(() => (this.ready = null));
    return this.ready;
  }

  async append(build: (tail: { seq: number; hash: string } | null) => AuditRow): Promise<AuditRow> {
    await this.init();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1)", [CHAIN_LOCK_KEY]);
      const last = await client.query<{ seq: string; hash: string }>("SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1 FOR UPDATE");
      const tail = last.rows[0] ? { seq: Number(last.rows[0].seq), hash: last.rows[0].hash } : null;
      const row = build(tail);
      await client.query(
        "INSERT INTO audit_log (seq, run_id, event_type, payload, created_at, prev_hash, hash) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [row.seq, row.run_id, row.event_type, JSON.stringify(row.payload), row.created_at, row.prev_hash, row.hash],
      );
      await client.query("COMMIT");
      return row;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async list(runId?: string): Promise<AuditRow[]> {
    await this.init();
    const res = runId
      ? await this.pool.query<DbRow>("SELECT * FROM audit_log WHERE run_id = $1 ORDER BY seq", [runId])
      : await this.pool.query<DbRow>("SELECT * FROM audit_log ORDER BY seq");
    return res.rows.map(toRow);
  }

  async tamper(): Promise<number | null> {
    await this.init();
    const res = await this.pool.query<DbRow>("SELECT * FROM audit_log WHERE event_type = 'decision.made' ORDER BY seq");
    const target = pickTamperTarget(res.rows.map(toRow));
    if (!target) return null;
    await this.pool.query("UPDATE audit_log SET payload = $1 WHERE seq = $2", [JSON.stringify(flipVerdict(target.payload)), target.seq]);
    return target.seq;
  }

  async ping(): Promise<void> {
    await this.init();
    await this.pool.query("SELECT 1");
  }

  async head(): Promise<{ seq: number; hash: string } | null> {
    await this.init();
    const res = await this.pool.query<{ seq: string; hash: string }>("SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1");
    return res.rows[0] ? { seq: Number(res.rows[0].seq), hash: res.rows[0].hash } : null;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async setPayload(seq: number, payload: unknown): Promise<void> {
    await this.init();
    await this.pool.query("UPDATE audit_log SET payload = $1 WHERE seq = $2", [JSON.stringify(payload), seq]);
  }
}

export function createPostgresAudit(databaseUrl: string): HashChainAuditSink {
  const needsTls = /sslmode=require|neon\.tech|supabase\.co|supabase\.com/.test(databaseUrl) && !/sslmode=disable/.test(databaseUrl);
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 5, ...(needsTls && !/sslmode=/.test(databaseUrl) ? { ssl: { rejectUnauthorized: true } } : {}) });
  pool.on("error", (err) => console.error("[sentinel] postgres pool error:", err.message));
  return new HashChainAuditSink(new PostgresChainStore(pool));
}
