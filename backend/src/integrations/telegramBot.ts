import { Bot, InlineKeyboard } from "grammy";
import type { ReplayResult } from "../replay.js";
import type { Decision } from "../types.js";
import type { SentinelBus } from "./bus.js";
import type { VerifyResult } from "./hashChain.js";
import { maskDeep, maskText } from "./masking.js";

export interface TelegramOptions {
  token: string;
  allowedChatId: string;
  /** Optional: when non-empty, only these Telegram user ids may approve (matters if the chat is a group). */
  allowedUserIds?: string[];
  timeoutSeconds: () => number;
  bus: SentinelBus;
  /** Person A's resolver; first answer wins, later answers return false. */
  resolve: (decisionId: string, approve: boolean, approver: string) => boolean;
  pending: () => Decision[];
  /** Latest decisions, oldest first (for /status). */
  recent: () => Decision[];
  /** Audit chain check for /status; null when no hash-chained store is configured. */
  verify: () => Promise<VerifyResult | null>;
  /** Read-only re-evaluation against the current policy file (for /replay). */
  replay: (decisionId: string) => Promise<ReplayResult | null>;
  /** Tests: a pre-built bot that is not started (no network polling). */
  bot?: Bot;
}

const clip = (s: string, n = 200) => (s.length > n ? `${s.slice(0, n)}…` : s);
const shortHash = (h: string) => h.slice(0, 12);

/** First evidence excerpt from the context the agent read (not from the arguments themselves). */
function evidenceLine(d: Decision): string | null {
  const ev = d.reasons.flatMap((r) => r.evidence ?? []).find((e) => !e.segment_id.startsWith("arg:"));
  return ev ? `Evidence: "${clip(maskText(ev.excerpt))}"` : null;
}

function formatArgs(args: Record<string, unknown>): string {
  return Object.entries(maskDeep(args))
    .map(([k, v]) => {
      const s = typeof v === "string" ? v : JSON.stringify(v);
      const short = s.length > 200 ? `${s.slice(0, 200)}…` : s;
      return typeof v === "string" && k !== "to" && k !== "payee" ? `${k}="${short}"` : `${k}=${short}`;
    })
    .join(", ");
}

/**
 * Approvals over Telegram (long polling). Only TELEGRAM_ALLOWED_CHAT_ID may approve or reject:
 * the approval channel is itself an attack surface. No commands can change permissions.
 */
export function startTelegramBot(opts: TelegramOptions) {
  const bot = opts.bot ?? new Bot(opts.token);
  const messages = new Map<string, { id: number; text: string }>(); // decision_id -> sent message
  const browsed = new Map<string, string[]>(); // run_id -> URLs read (for the "tainted" line)
  const allowed = String(opts.allowedChatId);
  const users = new Set((opts.allowedUserIds ?? []).map(String));

  opts.bus.on("tool.requested", (e) => {
    if (e.call.tool === "browse_url" && typeof e.call.args.url === "string") {
      const list = browsed.get(e.run_id) ?? [];
      list.push(e.call.args.url.replace(/^https?:\/\//, ""));
      browsed.set(e.run_id, list);
    }
  });

  opts.bus.on("run.finished", (e) => browsed.delete(e.run_id));

  // Blueprint: tell the operator when an attack is stopped, not only when approval is needed.
  opts.bus.on("decision.made", async (e) => {
    const d = e.decision;
    if (d.verdict !== "DENY" || d.outcome !== "BLOCKED" || d.rule_id === "SHIELD_OFF") return;
    const text = [
      "🛑 Sentinel blocked a tool call",
      `Tool: ${d.call.tool}   Rule: ${d.rule_id}   Impact: ${d.impact}`,
      `Args: ${formatArgs(d.call.args)}`,
      `Why: ${d.reasons.map((r) => r.message).join(" ")}`,
      evidenceLine(d),
      `Decision: ${d.decision_id} (/replay ${d.decision_id})`,
    ]
      .filter(Boolean)
      .join("\n");
    try {
      await bot.api.sendMessage(allowed, text);
    } catch (err) {
      console.error("[sentinel] telegram deny alert failed:", (err as Error).message);
    }
  });

  opts.bus.on("approval.requested", async (e) => {
    const d = e.decision;
    const urls = browsed.get(e.run_id) ?? [];
    const text = [
      "⚠️ Sentinel needs approval",
      `Tool: ${d.call.tool}   Impact: ${d.impact}`,
      `Args: ${formatArgs(d.call.args)}`,
      `Why: ${d.reasons.map((r) => r.message).join(" ")}`,
      `Session tainted: ${d.session_tainted ? `yes${urls.length ? ` (read ${urls.join(", ")})` : ""}` : "no"}`,
      `Times out in ${opts.timeoutSeconds()}s → blocked`,
    ].join("\n");
    const keyboard = new InlineKeyboard().text("✅ Approve", `a:${d.decision_id}`).text("❌ Reject", `r:${d.decision_id}`);
    try {
      const msg = await bot.api.sendMessage(allowed, text, { reply_markup: keyboard });
      messages.set(d.decision_id, { id: msg.message_id, text });
    } catch (err) {
      console.error("[sentinel] telegram send failed:", (err as Error).message);
    }
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
    const chatId = String(ctx.callbackQuery.message?.chat.id ?? ctx.chat?.id ?? "");
    if (chatId !== allowed) {
      console.warn(`[sentinel] telegram: rejected approval attempt from chat ${chatId}`);
      return void (await ctx.answerCallbackQuery({ text: "Not authorised to approve.", show_alert: true }));
    }
    if (users.size && !users.has(String(ctx.from.id))) {
      console.warn(`[sentinel] telegram: rejected approval attempt from user ${ctx.from.id}`);
      return void (await ctx.answerCallbackQuery({ text: "Not authorised to approve.", show_alert: true }));
    }
    const m = /^([ar]):(.+)$/.exec(ctx.callbackQuery.data);
    if (!m) return void (await ctx.answerCallbackQuery());
    const approver = `telegram:${ctx.from.username ?? ctx.from.id}`;
    const ok = opts.resolve(m[2], m[1] === "a", approver);
    await ctx.answerCallbackQuery({ text: ok ? "Recorded." : "Already resolved." });
  });

  // Read-only commands. None of them can change permissions or policy.
  const authorised = (chatId: number, userId?: number) => String(chatId) === allowed && (!users.size || users.has(String(userId)));

  bot.command("pending", async (ctx) => {
    if (!authorised(ctx.chat.id, ctx.from?.id)) return;
    const list = opts.pending();
    await ctx.reply(list.length ? list.map((d) => `• ${d.call.tool} (${d.decision_id})`).join("\n") : "No pending approvals.");
  });

  bot.command("status", async (ctx) => {
    if (!authorised(ctx.chat.id, ctx.from?.id)) return;
    let chain = "not configured";
    try {
      const v = await opts.verify();
      if (v) chain = v.valid ? `intact (${v.rows} rows)` : `BROKEN at row #${v.broken_at}`;
    } catch (err) {
      chain = `check failed: ${(err as Error).message}`;
    }
    const recent = opts.recent();
    const lines = [
      "Sentinel status",
      `Pending approvals: ${opts.pending().length}`,
      `Audit chain: ${chain}`,
      recent.length ? "Recent decisions:" : "No decisions yet.",
      ...recent.reverse().map((d) => `• ${d.call.tool}: ${d.verdict} ${d.rule_id}${d.outcome ? ` (${d.outcome})` : ""}`),
    ];
    await ctx.reply(lines.join("\n"));
  });

  bot.command("replay", async (ctx) => {
    if (!authorised(ctx.chat.id, ctx.from?.id)) return;
    const id = ctx.match.trim();
    if (!/^dec_[\w-]{1,40}$/.test(id)) return void (await ctx.reply("Usage: /replay <decision_id>"));
    try {
      const r = await opts.replay(id);
      if (!r) return void (await ctx.reply("Unknown decision."));
      const policy = r.policy_hash === r.original_policy_hash ? `same policy (${shortHash(r.policy_hash)})` : `policy changed ${shortHash(r.original_policy_hash)} → ${shortHash(r.policy_hash)}`;
      await ctx.reply(`Replay of ${id} against the current policy file:\n${r.decision.verdict} ${r.decision.rule_id} — ${clip(r.decision.reasons.map((x) => x.message).join(" "), 300)}\n${policy}. Nothing was executed.`);
    } catch (err) {
      await ctx.reply(`Replay failed: ${(err as Error).message}`);
    }
  });

  bot.catch((err) => console.error("[sentinel] telegram error:", err.message));
  if (!opts.bot) {
    bot.start({ drop_pending_updates: true }).catch((err) => console.error("[sentinel] telegram bot stopped:", (err as Error).message));
    console.log("[sentinel] telegram approval bot started (long polling)");
  }
  return bot;
}
