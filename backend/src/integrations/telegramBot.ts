import { Bot, InlineKeyboard } from "grammy";
import type { Decision } from "../types.js";
import type { SentinelBus } from "./bus.js";
import { maskDeep } from "./masking.js";

export interface TelegramOptions {
  token: string;
  allowedChatId: string;
  timeoutSeconds: number;
  bus: SentinelBus;
  /** Person A's resolver; first answer wins, later answers return false. */
  resolve: (decisionId: string, approve: boolean, approver: string) => boolean;
  pending: () => Decision[];
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
  const bot = new Bot(opts.token);
  const messages = new Map<string, { id: number; text: string }>(); // decision_id -> sent message
  const browsed = new Map<string, string[]>(); // run_id -> URLs read (for the "tainted" line)
  const allowed = String(opts.allowedChatId);

  opts.bus.on("tool.requested", (e) => {
    if (e.call.tool === "browse_url" && typeof e.call.args.url === "string") {
      const list = browsed.get(e.run_id) ?? [];
      list.push(e.call.args.url.replace(/^https?:\/\//, ""));
      browsed.set(e.run_id, list);
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
      `Times out in ${opts.timeoutSeconds}s → blocked`,
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
    const m = /^([ar]):(.+)$/.exec(ctx.callbackQuery.data);
    if (!m) return void (await ctx.answerCallbackQuery());
    const approver = `telegram:${ctx.from.username ?? ctx.from.id}`;
    const ok = opts.resolve(m[2], m[1] === "a", approver);
    await ctx.answerCallbackQuery({ text: ok ? "Recorded." : "Already resolved." });
  });

  bot.command("pending", async (ctx) => {
    if (String(ctx.chat.id) !== allowed) return;
    const list = opts.pending();
    await ctx.reply(list.length ? list.map((d) => `• ${d.call.tool} (${d.decision_id})`).join("\n") : "No pending approvals.");
  });

  bot.catch((err) => console.error("[sentinel] telegram error:", err.message));
  bot.start({ drop_pending_updates: true }).catch((err) => console.error("[sentinel] telegram bot stopped:", (err as Error).message));
  console.log("[sentinel] telegram approval bot started (long polling)");
  return bot;
}
