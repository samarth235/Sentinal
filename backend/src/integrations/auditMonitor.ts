import type { HashChainAuditSink } from "./hashChain.js";

export interface AuditMonitorOptions {
  chain: HashChainAuditSink;
  verifyEveryMinutes: number;
  anchorEveryMinutes: number;
  /** Where alerts and anchors go (Telegram when configured, otherwise the log). */
  notify: (text: string, kind: "alert" | "anchor") => Promise<void> | void;
}

export interface AuditMonitorState {
  last_verified_at: string | null;
  last_result: "valid" | "broken" | "truncated" | "error" | null;
  last_anchor: { seq: number; hash: string; at: string } | null;
  highest_seq_seen: number;
}

/**
 * Keeps the audit chain honest after the demo:
 *  - verifies the whole chain on a schedule and alerts on the first broken row;
 *  - detects tail truncation (the newest rows deleted), which a hash chain alone cannot,
 *    by remembering the highest seq it has seen;
 *  - posts the head hash to an external channel (Telegram) so history cannot be rewritten
 *    and re-hashed without contradicting a message that lives outside the database.
 */
export function startAuditMonitor(opts: AuditMonitorOptions) {
  const state: AuditMonitorState = { last_verified_at: null, last_result: null, last_anchor: null, highest_seq_seen: 0 };
  let alerted = false;

  async function verify(): Promise<AuditMonitorState> {
    try {
      const [result, head] = await Promise.all([opts.chain.verify(), opts.chain.head()]);
      state.last_verified_at = new Date().toISOString();
      const seq = head?.seq ?? 0;
      if (!result.valid) {
        state.last_result = "broken";
        if (!alerted) await opts.notify(`🚨 Sentinel audit chain BROKEN at row #${result.broken_at}. Someone edited the audit log.`, "alert");
        alerted = true;
      } else if (seq < state.highest_seq_seen) {
        state.last_result = "truncated";
        if (!alerted) await opts.notify(`🚨 Sentinel audit chain TRUNCATED: head is #${seq}, but #${state.highest_seq_seen} existed before.`, "alert");
        alerted = true;
      } else {
        state.last_result = "valid";
        alerted = false;
      }
      state.highest_seq_seen = Math.max(state.highest_seq_seen, seq);
    } catch (err) {
      state.last_result = "error";
      console.error("[sentinel] audit verify failed:", (err as Error).message);
    }
    return state;
  }

  async function anchor(): Promise<void> {
    try {
      const head = await opts.chain.head();
      if (!head || head.seq === state.last_anchor?.seq) return;
      state.last_anchor = { ...head, at: new Date().toISOString() };
      await opts.notify(`🔗 Sentinel audit anchor\nrow #${head.seq}\n${head.hash}`, "anchor");
    } catch (err) {
      console.error("[sentinel] audit anchor failed:", (err as Error).message);
    }
  }

  const timers: NodeJS.Timeout[] = [];
  if (opts.verifyEveryMinutes > 0) {
    void verify();
    timers.push(setInterval(() => void verify(), opts.verifyEveryMinutes * 60_000));
  }
  if (opts.anchorEveryMinutes > 0) timers.push(setInterval(() => void anchor(), opts.anchorEveryMinutes * 60_000));
  for (const t of timers) t.unref();

  return {
    state,
    verify,
    anchor,
    stop: () => timers.forEach((t) => clearInterval(t)),
  };
}
