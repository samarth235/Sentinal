import { Bot, InlineKeyboard, webhookCallback } from "grammy";
import type { RequestHandler } from "express";
import type { ReplayResult } from "../replay.js";
import type { Decision } from "../types.js";
import type { SentinelBus } from "./bus.js";
import type { VerifyResult } from "./hashChain.js";
import { maskDeep, maskText } from "./masking.js";

export interface TelegramOptions {
  token: string;
  allowedChatId: string;
  /** Optional: when non-empty, only these Telegram user ids may approve or run commands (matters if the chat is a group). */
  allowedUserIds?: string[];
  timeoutSeconds: () => number;
  bus: SentinelBus;
  /** First answer wins; later answers return false. */
  resolve: (decisionId: string, approve: boolean, approver: string) => boolean;
  pending: () => Decision[];
  /** Latest decisions, oldest first (for /status). */
  recent: () => Decision[];
  /** Audit chain check for /status and /verify; null when no hash-chained store is configured. */
  verify: () => Promise<VerifyResult | null>;
  /** Read-only re-evaluation against the current policy file (for /replay). */
  replay: (decisionId: string) => Promise<ReplayResult | null>;
  /** Extra lines for /status (metrics, guard, policy version). */
  statusExtra?: () => Promise<string[]> | string[];
  /** Forensics for /trace: decisions influenced by untrusted content matching the query. */
  trace?: (query: string) => Promise<string>;
  /** Temporary permission overrides for /override. Absent => the command is unavailable. */
  overrides?: {
    grant: (profile: string, tool: string, minutes: number, by: string) => Promise<string>;
    list: () => string;
    clear: (by: string) => Promise<string>;
  };
  /** Send a message when a call is blocked outright (default true). */
  notifyDeny?: boolean;
  /** Public backend URL: use a webhook at <url>/telegram/webhook instead of long polling. */
  webhookUrl?: string;
  webhookSecret?: string;
  /** Tests: a pre-built bot that is not started (no network polling). */
  bot?: Bot;
}

export interface TelegramHealth {
  mode: "polling" | "webhook" | "test";
  last_sent_at: string | null;
  last_error: string | null;
  failed_sends: number;
}

const clip = (s: string, n = 200) => (s.length > n ? `${s.slice(0, n)}…` : s);
const shortHash = (h: string) => h.slice(0, 12);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** First evidence excerpt from the context the agent read (not from the arguments themselves). */
function evidenceLine(d: Decision): string | null {
  const ev = d.reasons.flatMap((r) => r.evidence ?? []).find((e) => !e.segment_id.startsWith("arg:"));
  return ev ? `Evidence: "${clip(maskText(ev.excerpt))}"` : null;
}

function formatArgs(args: Record<string, unknown>): string {
  return Object.entries(maskDeep(args))
    .map(([k, v]) => {
      const s = typeof v === "string" ? v : JSON.stringify(v);
      const short = clip(s);
      return typeof v === "string" && k !== "to" && k !== "payee" ? `${k}="${short}"` : `${k}=${short}`;
    })
    .join(", ");
}

/**
 * Human-in-the-loop over Telegram. Only TELEGRAM_ALLOWED_CHAT_ID (and, when set, TELEGRAM_ALLOWED_USER_IDS)
 * may approve, reject or run commands: the approval channel is itself an attack surface. Every command is
 * read-only except /override, which needs an explicit user allow-list, is time-boxed and is audited.
 */
export function startTelegramBot(opts: TelegramOptions) {
  const bot = opts.bot ?? new Bot(opts.token);
  const messages = new Map<string, { id: number; text: string }>(); // decision_id -> sent message
  const sources = new Map<string, string[]>(); // run_id -> untrusted sources read (for the "tainted" line)
  const deniedSent = new Set<string>();
  const allowed = String(opts.allowedChatId);
  const users = new Set((opts.allowedUserIds ?? []).map(String));
  const health: TelegramHealth = { mode: opts.bot ? "test" : opts.webhookUrl ? "webhook" : "polling", last_sent_at: null, last_error: null, failed_sends: 0 };

  /** Send with retries (rate limits and network blips must not lose an approval request). */
  async function send(text: string, extra: Parameters<typeof bot.api.sendMessage>[2] = {}): Promise<number | null> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const msg = await bot.api.sendMessage(allowed, clip(text, 4000), extra);
        health.last_sent_at = new Date().toISOString();
        health.last_error = null;
        return msg.message_id;
      } catch (err) {
        health.last_error = (err as Error).message;
        const retryAfter = (err as { parameters?: { retry_after?: number } }).parameters?.retry_after;
        if (attempt < 3) await sleep(retryAfter ? retryAfter * 1000 : 400 * attempt);
      }
    }
    health.failed_sends++;
    console.error("[sentinel] telegram send failed after 3 attempts:", health.last_error);
    void opts.bus.publishSafe({ type: "system.notice", run_id: "system", level: "error", text: `Telegram delivery failed (${health.last_error}). Use the dashboard to approve.` });
    return null;
  }

  const authorised = (chatId: unknown, userId: unknown) => String(chatId) === allowed && (users.size === 0 || users.has(String(userId)));

  opts.bus.on("context.added", (e) => {
    if (e.segment.trust !== "UNTRUSTED" || e.segment.tool === "browse_url") return; // pages are tracked by URL below
    const list = sources.get(e.run_id) ?? [];
    list.push(e.segment.label ?? e.segment.tool ?? "untrusted content");
    sources.set(e.run_id, list);
  });
  opts.bus.on("tool.requested", (e) => {
    if (e.call.tool === "browse_url" && typeof e.call.args.url === "string") {
      const list = sources.get(e.run_id) ?? [];
      list.push(e.call.args.url.replace(/^https?:\/\//, ""));
      sources.set(e.run_id, list);
    }
  });
  opts.bus.on("run.finished", (e) => sources.delete(e.run_id));

  // Blueprint step 8: tell the operator when an attack is stopped, not only when approval is needed.
  opts.bus.on("decision.made", async (e) => {
    const d = e.decision;
    if (opts.notifyDeny === false) return;
    if (d.verdict !== "DENY" || d.outcome !== "BLOCKED" || d.rule_id === "SHIELD_OFF" || deniedSent.has(d.decision_id)) return;
    deniedSent.add(d.decision_id);
    if (deniedSent.size > 5000) deniedSent.clear();
    await send(
      [
        "🛑 Sentinel blocked a tool call",
        `Tool: ${d.call.tool}   Rule: ${d.rule_id}   Impact: ${d.impact}`,
        `Args: ${formatArgs(d.call.args)}`,
        `Why: ${maskText(d.reasons.map((r) => r.message).join(" "))}`,
        evidenceLine(d),
        `Decision: ${d.decision_id} (/replay ${d.decision_id})`,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  });

  opts.bus.on("approval.requested", async (e) => {
    const d = e.decision;
    const read = [...new Set(sources.get(e.run_id) ?? [])];
    const text = [
      "⚠️ Sentinel needs approval",
      `Tool: ${d.call.tool}   Impact: ${d.impact}   Profile: ${d.call.profile}`,
      `Args: ${formatArgs(d.call.args)}`,
      `Why: ${maskText(d.reasons.map((r) => r.message).join(" "))}`,
      `Session tainted: ${d.session_tainted ? `yes${read.length ? ` (read ${read.join(", ")})` : ""}` : "no"}`,
      `Decision: ${d.decision_id}`,
      `Times out in ${opts.timeoutSeconds()}s → blocked`,
    ].join("\n");
    const keyboard = new InlineKeyboard().text("✅ Approve", `a:${d.decision_id}`).text("❌ Reject", `r:${d.decision_id}`);
    const id = await send(text, { reply_markup: keyboard });
    if (id !== null) messages.set(d.decision_id, { id, text });
  });

  opts.bus.on("approval.resolved", async (e) => {
    const sent = messages.get(e.decision_id);
    if (!sent) return;
    messages.delete(e.decision_id);
    const status =
      e.result === "approved" ? `✅ Approved by ${e.approver ?? "unknown"}` : e.result === "rejected" ? `❌ Rejected${e.approver ? ` by ${e.approver}` : ""}` : "⏱️ Timed out — blocked";
    try {
      // Editing the text without reply_markup also removes the buttons.
      await bot.api.editMessageText(allowed, sent.id, `${sent.text}\n\n${status}`);
    } catch (err) {
      console.error("[sentinel] telegram update failed:", (err as Error).message);
    }
  });

  bot.on("callback_query:data", async (ctx) => {
    const chatId = ctx.callbackQuery.message?.chat.id ?? ctx.chat?.id ?? "";
    if (!authorised(chatId, ctx.from.id)) {
      console.warn(`[sentinel] telegram: rejected approval attempt from chat ${chatId} user ${ctx.from.id}`);
      return void (await ctx.answerCallbackQuery({ text: "Not authorised to approve.", show_alert: true }));
    }
    const m = /^([ar]):(.+)$/.exec(ctx.callbackQuery.data);
    if (!m) return void (await ctx.answerCallbackQuery());
    const approver = `telegram:${ctx.from.username ?? ctx.from.id}`;
    const ok = opts.resolve(m[2], m[1] === "a", approver);
    await ctx.answerCallbackQuery({ text: ok ? "Recorded." : "Already resolved or expired." });
  });

  // Every command below is restricted to the allowed chat (and users).
  bot.use(async (ctx, next) => {
    if (ctx.callbackQuery) return next();
    if (!ctx.message?.text?.startsWith("/")) return;
    if (!authorised(ctx.chat?.id, ctx.from?.id)) {
      console.warn(`[sentinel] telegram: ignored command from chat ${ctx.chat?.id} user ${ctx.from?.id}`);
      return;
    }
    return next();
  });

  const reply = async (ctx: { reply: (t: string) => Promise<unknown> }, fn: () => Promise<string> | string) => {
    try {
      await ctx.reply(clip(await fn(), 4000));
    } catch (err) {
      await ctx.reply(`⚠️ ${(err as Error).message}`);
    }
  };

  const HELP = [
    "Sentinel commands",
    "/status — pending approvals, audit chain, recent decisions",
    "/pending — approvals waiting for an answer",
    "/verify — check the audit hash chain",
    "/replay <decision_id> — re-evaluate a decision against the current policy (read-only)",
    opts.trace && "/trace <url or text> — every action influenced by that source",
    opts.overrides && "/override <profile> <tool> <minutes> — temporarily allow a tool (max 60 min)",
    opts.overrides && "/override list | /override clear",
  ]
    .filter(Boolean)
    .join("\n");

  bot.command(["start", "help"], (ctx) => reply(ctx, () => HELP));

  bot.command("pending", (ctx) =>
    reply(ctx, () => {
      const list = opts.pending();
      return list.length ? list.map((d) => `• ${d.call.tool} (${d.call.profile}) — ${d.decision_id}`).join("\n") : "No pending approvals.";
    }),
  );

  bot.command("status", (ctx) =>
    reply(ctx, async () => {
      let chain = "not configured";
      try {
        const v = await opts.verify();
        if (v) chain = v.valid ? `intact (${v.rows} rows)` : `BROKEN at row #${v.broken_at}`;
      } catch (err) {
        chain = `check failed: ${(err as Error).message}`;
      }
      const recent = [...opts.recent()].reverse();
      const extra = opts.statusExtra ? await opts.statusExtra() : [];
      return maskText(
        [
          "Sentinel status",
          `Pending approvals: ${opts.pending().length}`,
          `Audit chain: ${chain}`,
          ...extra,
          recent.length ? "Recent decisions:" : "No decisions yet.",
          ...recent.map((d) => `• ${d.call.tool}: ${d.verdict} ${d.rule_id}${d.outcome ? ` (${d.outcome})` : ""}`),
        ].join("\n"),
      );
    }),
  );

  bot.command("verify", (ctx) =>
    reply(ctx, async () => {
      const v = await opts.verify();
      if (!v) return "No hash-chained audit store is configured.";
      return v.valid ? `✅ Audit chain intact — ${v.rows} rows` : `🚨 Audit chain BROKEN at row #${v.broken_at}`;
    }),
  );

  bot.command("replay", (ctx) =>
    reply(ctx, async () => {
      const id = ctx.match.trim();
      if (!/^dec_[\w-]{1,40}$/.test(id)) return "Usage: /replay <decision_id>";
      try {
        const r = await opts.replay(id);
        if (!r) return "Unknown decision.";
        const policy = r.policy_hash === r.original_policy_hash ? `same policy (${shortHash(r.policy_hash)})` : `policy changed ${shortHash(r.original_policy_hash)} → ${shortHash(r.policy_hash)}`;
        const then = r.original ? `\nThen: ${r.original.verdict} ${r.original.rule_id}${r.original.verdict !== r.decision.verdict ? "   ⚠️ verdict changed" : ""}` : "";
        return maskText(
          `Replay of ${id} against the current policy file${r.reconstructed ? " (context rebuilt from the audit log)" : ""}:\n${r.decision.verdict} ${r.decision.rule_id} — ${clip(r.decision.reasons.map((x) => x.message).join(" "), 300)}${then}\n${policy}. Nothing was executed.`,
        );
      } catch (err) {
        return `Replay failed: ${(err as Error).message}`;
      }
    }),
  );

  if (opts.trace) {
    const trace = opts.trace;
    bot.command("trace", (ctx) =>
      reply(ctx, () => {
        const q = ctx.match.trim();
        if (q.length < 3) return "Usage: /trace <url or text from the suspicious content>";
        return trace(q);
      }),
    );
  }

  if (opts.overrides) {
    const ov = opts.overrides;
    bot.command("override", (ctx) =>
      reply(ctx, () => {
        const by = `telegram:${ctx.from?.username ?? ctx.from?.id}`;
        const [a, b, c] = ctx.match.trim().split(/\s+/).filter(Boolean);
        if (!a || a === "list") return ov.list();
        if (users.size === 0) return "Overrides are disabled: set TELEGRAM_ALLOWED_USER_IDS so only named people can change permissions.";
        if (a === "clear") return ov.clear(by);
        const minutes = Number(c);
        if (!b || !Number.isFinite(minutes)) return "Usage: /override <profile> <tool> <minutes>";
        return ov.grant(a, b, minutes, by);
      }),
    );
  }

  bot.catch((err) => console.error("[sentinel] telegram error:", err.message));

  let handler: RequestHandler | undefined;
  if (opts.bot) {
    // Tests: updates are fed with bot.handleUpdate(); nothing is started.
  } else if (opts.webhookUrl) {
    handler = webhookCallback(bot, "express", { secretToken: opts.webhookSecret }) as unknown as RequestHandler;
    void bot.api
      .setWebhook(`${opts.webhookUrl}/telegram/webhook`, { secret_token: opts.webhookSecret, drop_pending_updates: true, allowed_updates: ["message", "callback_query"] })
      .then(() => console.log("[sentinel] telegram webhook registered"))
      .catch((err) => console.error("[sentinel] telegram setWebhook failed:", (err as Error).message));
    void bot.init().catch((err) => console.error("[sentinel] telegram init failed:", (err as Error).message));
  } else {
    void bot.api
      .deleteWebhook()
      .catch(() => undefined)
      .then(() => bot.start({ drop_pending_updates: true, allowed_updates: ["message", "callback_query"] }))
      .catch((err) => console.error("[sentinel] telegram bot stopped:", (err as Error).message));
    console.log("[sentinel] telegram approval bot started (long polling)");
  }
  if (!opts.bot) {
    void bot.api
      .setMyCommands([
        { command: "status", description: "Pending approvals, audit chain, recent decisions" },
        { command: "pending", description: "Approvals waiting for an answer" },
        { command: "verify", description: "Verify the audit hash chain" },
        { command: "replay", description: "Re-evaluate a decision: /replay <id>" },
        ...(opts.trace ? [{ command: "trace", description: "Actions influenced by a source: /trace <url>" }] : []),
        ...(opts.overrides ? [{ command: "override", description: "Temporary tool permission (max 60 min)" }] : []),
        { command: "help", description: "All commands" },
      ])
      .catch(() => undefined);
  }

  return {
    bot,
    health,
    /** Express handler for POST /telegram/webhook (webhook mode only). */
    webhook: handler,
    /** Send an arbitrary notice to the approval chat (audit alerts, anchors). */
    notify: (text: string) => send(text).then(() => undefined),
    stop: async () => {
      if (!opts.webhookUrl && !opts.bot) await bot.stop().catch(() => undefined);
    },
  };
}
