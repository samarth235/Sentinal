import { describe, expect, it } from "vitest";
import { DataType, newDb } from "pg-mem";
import type pg from "pg";
import { HashChainAuditSink } from "../src/integrations/hashChain.js";
import { PostgresChainStore } from "../src/integrations/postgresAudit.js";
import type { Decision } from "../src/types.js";

/**
 * Exercises the real SQL against pg-mem (an in-process Postgres emulator). pg-mem has no
 * advisory locks, so pg_advisory_xact_lock is registered as a no-op; the in-process queue
 * still serialises appends. Set TEST_DATABASE_URL to run the same flow on real Postgres.
 */
function memPool(): pg.Pool {
  const db = newDb();
  db.public.registerFunction({ name: "pg_advisory_xact_lock", args: [DataType.integer], returns: DataType.text, implementation: () => "" });
  const { Pool } = db.adapters.createPg();
  return new Pool() as pg.Pool;
}

async function realPool(): Promise<pg.Pool | null> {
  if (!process.env.TEST_DATABASE_URL) return null;
  const { default: pgReal } = await import("pg");
  const pool = new pgReal.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await pool.query("DROP TABLE IF EXISTS audit_log");
  return pool;
}

const decision = (verdict: string) => ({ verdict, call: { args: { body: "ABCPE1234F" } } }) as unknown as Decision;

describe.each([
  ["pg-mem", async () => memPool()],
  ["real postgres", realPool],
])("postgres audit chain (%s)", (_name, makePool) => {
  it("migrates, chains, masks, verifies, and detects tampering", async (ctx) => {
    const pool = await makePool();
    if (!pool) return ctx.skip();
    const chain = new HashChainAuditSink(new PostgresChainStore(pool));

    await chain.append({ type: "run.started", run_id: "r1", scenario_id: "S2_injection", shield: true, mode: "scripted" });
    await Promise.all([
      chain.append({ type: "decision.made", run_id: "r1", decision: decision("ALLOW") }),
      chain.append({ type: "decision.made", run_id: "r1", decision: decision("DENY") }),
      chain.append({ type: "agent.message", run_id: "r2", text: "hi" }),
    ]);

    const rows = await chain.list();
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3, 4]);
    expect((await chain.list("r2")).map((r) => r.seq)).toEqual([4]);
    expect(JSON.stringify(rows)).not.toContain("ABCPE1234F");
    expect(await chain.verify()).toEqual({ valid: true, rows: 4 });

    const seq = await chain.tamper();
    expect(seq).toBe(3);
    const v = await chain.verify();
    expect(v).toMatchObject({ valid: false, broken_at: 3 });
    await pool.end();
  });
});
