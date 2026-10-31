import { Bot, InlineKeyboard, webhookCallback, type Transformer } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import type { RequestHandler } from "express";
import type { Decision } from "../types.js";
import type { SentinelBus } from "./bus.js";
import { maskDeep, maskText } from "./masking.js";

export interface TelegramCommands {
  /** One-paragraph health/status summary. */
  status: () => Promise<string>;
  /** Chain verification result, one line. */
  verify: () => Promise<string>;
  /** Re-evaluate a stored decision against the current policy. */
  replay: (decisionId: string) => Promise<string>;
  /** Forensics: decisions influenced by untrusted content matching the query. */
  trace: (query: string) => Promise<string>;
  /** Temporary permission override. Returns a confirmation line; throws on invalid input. */
  overrideGrant: (profile: string, tool: string, minutes: number, by: string) => Promise<string>;
  overrideList: () => string;
  overrideClear: (by: string) => Promise<string>;
}

export interface TelegramOptions {
  token: string;
  allowedChatId: string;
  /** Optional: when non-empty, only these Telegram user ids may approve (matters if the chat is a group). */
  allowedUserIds?: string[];
  timeoutSeconds: () => number;
  bus: SentinelBus;
  /** First answer wins; later answers return false. */
  resolve: (decisionId: string, approve: boolean, approver: string) => boolean;
  pending: () => Decision[];
  commands: TelegramCommands;
  /** Send a message when a call is denied outright (not only for approvals). */
  notifyDeny: boolean;
  /** Public backend URL: use a webhook at <url>/telegram/webhook instead of long polling. */
  webhookUrl?: string;
  webhookSecret?: string;
  /** Tests: skip getMe and intercept Bot API calls. */
  testing?: { botInfo: UserFromGetMe; transformer: Transformer };
}

export interface TelegramHealth {
  mode: "polling" | "webhook";
  last_sent_at: string | null;
  last_error: string | null;
  failed_sends: number;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

function formatArgs(args: Record<string, unknown>): string {
  return Object.entries(maskDeep(args))
    .map(([k, v]) => {
      const s = typeof v === "string" ? v : JSON.stringify(v);
      const short = clip(s, 200);
      return typeof v === "string" && k !== "to" && k !== "payee" ? `${k}="${short}"` : `${k}=${short}`;
    })
    .join(", ");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Human-in-the-loop over Telegram. Only TELEGRAM_ALLOWED_CHAT_ID (and, when set,
 * TELEGRAM_ALLOWED_USER_IDS) may approve, reject or run commands: the approval channel is
 * itself an attack surface. /override additionally requires an explicit user allow-list.
 */
export function startTelegramBot(opts: TelegramOptions) {
  const bot = new Bot(opts.token, opts.testing ? { botInfo: opts.testing.botInfo } : undefined);
  if (opts.testing) bot.api.config.use(opts.testing.transformer);
  const messages = new Map<string, { id: number; text: string }>(); // decision_id -> sent message
  const browsed = new Map<string, string[]>(); // run_id -> sources read (for the "tainted" line)
  const deniedSent = new Set<string>();
  const allowed = String(opts.allowedChatId);
  const users = new Set((opts.allowedUserIds ?? []).map(String));
  const health: TelegramHealth = { mode: opts.webhookUrl ? "webhook" : "polling", last_sent_at: null, last_error: null, failed_sends: 0 };

  /** Send with retries (Telegram rate limits and network blips should not lose an approval). */
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
        if (attempt < 3) await sleep(retryAfter ? retryAfter * 1000 : 500 * attempt);
      }
    }
    health.failed_sends++;
    console.error("[sentinel] telegram send failed after 3 attempts:", health.last_error);
    void opts.bus.publishSafe({ type: "system.notice", run_id: "system", level: "error", text: `Telegram delivery failed: ${health.last_error}. Use the dashboard to approve.` });
    return null;
  }

  const authorised = (chatId: unknown, userId: unknown) => String(chatId) === allowed && (users.size === 0 || users.has(String(userId)));

  opts.bus.on("context.added", (e) => {
    if (e.segment.trust !== "UNTRUSTED") return;
    const list = browsed.get(e.run_id) ?? [];
    list.push(e.segment.label ?? e.segment.tool ?? "untrusted content");
    browsed.set(e.run_id, list);
  });

  opts.bus.on("run.finished", (e) => browsed.delete(e.run_id));

  opts.bus.on("approval.requested", async (e) => {
    const d = e.decision;
    const sources = [...new Set(browsed.get(e.run_id) ?? [])];
    const text = [
      "⚠️ Sentinel needs approval",
      `Tool: ${d.call.tool}   Impact: ${d.impact}   Profile: ${d.call.profile}`,
      `Args: ${formatArgs(d.call.args)}`,
      `Why: ${maskText(d.reasons.map((r) => r.message).join(" "))}`,
      `Session tainted: ${d.session_tainted ? `yes${sources.length ? ` (read ${sources.join(", ")})` : ""}` : "no"}`,
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

  // Blueprint step 8: an outright DENY is also reported, not only approval requests.
  opts.bus.on("decision.made", async (e) => {
    const d = e.decision;
    if (!opts.notifyDeny || !d.shield || d.verdict !== "DENY" || deniedSent.has(d.decision_id)) return;
    deniedSent.add(d.decision_id);
    if (deniedSent.size > 5000) deniedSent.clear();
    await send(
      [
        `⛔ Sentinel blocked ${d.call.tool} (rule ${d.rule_id}, impact ${d.impact})`,
        `Profile: ${d.call.profile}`,
        `Args: ${formatArgs(d.call.args)}`,
        `Why: ${maskText(d.reasons.map((r) => r.message).join(" "))}`,
        `Decision: ${d.decision_id}   (/replay ${d.decision_id})`,
      ].join("\n"),
    );
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
    "/status — health, recent decisions, pending approvals",
    "/pending — approvals waiting for an answer",
    "/verify — check the audit hash chain",
    "/replay <decision_id> — re-evaluate a decision against the current policy",
    "/trace <url or text> — every action influenced by that source",
    "/override <profile> <tool> <minutes> — temporarily allow a tool (max 60 min)",
    "/override list | /override clear",
  ].join("\n");

  bot.command(["start", "help"], (ctx) => reply(ctx, () => HELP));
  bot.command("status", (ctx) => reply(ctx, opts.commands.status));
  bot.command("verify", (ctx) => reply(ctx, opts.commands.verify));
  bot.command("pending", (ctx) =>
    reply(ctx, () => {
      const list = opts.pending();
      return list.length ? list.map((d) => `• ${d.call.tool} (${d.call.profile}) — ${d.decision_id}`).join("\n") : "No pending approvals.";
    }),
  );
  bot.command("replay", (ctx) =>
    reply(ctx, () => {
      const id = ctx.match.trim();
      if (!id) return "Usage: /replay <decision_id>";
      return opts.commands.replay(id);
    }),
  );
  bot.command("trace", (ctx) =>
    reply(ctx, () => {
      const q = ctx.match.trim();
      if (!q) return "Usage: /trace <url or text from the suspicious content>";
      return opts.commands.trace(q);
    }),
  );
  bot.command("override", (ctx) =>
    reply(ctx, () => {
      const by = `telegram:${ctx.from?.username ?? ctx.from?.id}`;
      const [a, b, c] = ctx.match.trim().split(/\s+/).filter(Boolean);
      if (!a || a === "list") return opts.commands.overrideList();
      if (users.size === 0) return "Overrides are disabled: set TELEGRAM_ALLOWED_USER_IDS so only named people can change permissions.";
      if (a === "clear") return opts.commands.overrideClear(by);
      const minutes = Number(c);
      if (!b || !Number.isFinite(minutes)) return "Usage: /override <profile> <tool> <minutes>";
      return opts.commands.overrideGrant(a, b, minutes, by);
    }),
  );

  bot.catch((err) => console.error("[sentinel] telegram error:", err.message));

  let handler: RequestHandler | undefined;
  if (opts.testing) {
    // no polling, no webhook: tests feed updates with bot.handleUpdate()
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
  void bot.api
    .setMyCommands([
      { command: "status", description: "Health, recent decisions, pending approvals" },
      { command: "pending", description: "Approvals waiting for an answer" },
      { command: "verify", description: "Verify the audit hash chain" },
      { command: "replay", description: "Re-evaluate a decision: /replay <id>" },
      { command: "trace", description: "Actions influenced by a source: /trace <url>" },
      { command: "override", description: "Temporary tool permission (max 60 min)" },
      { command: "help", description: "All commands" },
    ])
    .catch(() => undefined);

  return {
    bot,
    health,
    /** Express handler for POST /telegram/webhook (webhook mode only). */
    webhook: handler,
    /** Send an arbitrary notice to the approval chat (audit alerts, anchors). */
    notify: (text: string) => send(text).then(() => undefined),
    stop: async () => {
      if (!opts.webhookUrl) await bot.stop().catch(() => undefined);
    },
  };
}
