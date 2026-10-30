import http from "node:http";
import { AddressInfo } from "node:net";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { io as ioClient } from "socket.io-client";
import { runScripted } from "../src/agent/scriptedRun.js";
import { StaticApprovalProvider } from "../src/integrations/approvals.js";
import { SentinelBus } from "../src/integrations/bus.js";
import { canonicalJson } from "../src/integrations/canonicalJson.js";
import { GroqGuard, type GroqLike } from "../src/integrations/groqGuard.js";
import { HeuristicGuard } from "../src/integrations/guard.js";
import { HashChainAuditSink, MemoryChainStore, verifyChain } from "../src/integrations/hashChain.js";
import type { Providers } from "../src/integrations/index.js";
import { maskDeep, maskText } from "../src/integrations/masking.js";
import { attachSocketBridge } from "../src/integrations/socketBridge.js";
import { initPolicy } from "../src/policy/loader.js";
import { createRun } from "../src/runs.js";
import { getScenario } from "../src/scenarios.js";
import { mockTools } from "../src/tools/mockTools.js";
import { reset } from "../src/tools/state.js";
import type { BusEvent, ToolCall } from "../src/types.js";

beforeAll(() => initPolicy("./src/policy/policy.yaml"));
beforeEach(() => reset());

function harness() {
  const chain = new HashChainAuditSink(new MemoryChainStore(null));
  const bus = new SentinelBus();
  const providers: Providers = { guard: new HeuristicGuard(), approvals: new StaticApprovalProvider("approved"), audit: chain };
  bus.useAudit(() => providers.audit);
  return { bus, providers, chain };
}

describe("canonicalJson", () => {
  it("is stable regardless of key order", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: "x" } })).toBe(canonicalJson({ a: { c: "x", d: [1, { y: 2, z: 1 }] }, b: 1 }));
    expect(canonicalJson({ a: undefined, b: 2 })).toBe('{"b":2}');
  });
});

describe("masking", () => {
  it("masks PAN, phone and account numbers without changing length", () => {
    expect(maskText("PAN ABCPE1234F")).toBe("PAN ABCPE****F");
    expect(maskText("call 9800000001")).toBe("call ******0001");
    expect(maskText("mail attacker@evil.test")).toBe("mail attacker@evil.test");
    const masked = maskDeep({ account_number: "000111222301", nested: ["ABCPE1234F"] });
    expect(masked).toEqual({ account_number: "********2301", nested: ["ABCPE****F"] });
    const text = "x ABCPE1234F y 9800000001";
    expect(maskText(text)).toHaveLength(text.length);
  });
});

describe("hash-chained audit", () => {
  it("S2 run => chain valid; tamper => verify fails at the tampered row", async () => {
    const h = harness();
    const run = createRun(getScenario("S2_injection")!, true, "scripted", h.bus);
    await runScripted(run, { bus: h.bus, providers: h.providers });

    expect(await h.chain.verify()).toEqual({ valid: true, rows: (await h.chain.list()).length });
    const rows = await h.chain.list();
    expect(rows[0].prev_hash).toBe("0".repeat(64));
    expect(rows[1].prev_hash).toBe(rows[0].hash);

    const tampered = await h.chain.tamper();
    expect(tampered).not.toBeNull();
    const result = await h.chain.verify();
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.broken_at).toBe(tampered);
  });

  it("stores masked payloads only", async () => {
    const h = harness();
    const run = createRun(getScenario("S3_sensitive")!, false, "scripted", h.bus);
    await runScripted(run, { bus: h.bus, providers: h.providers });
    const dump = JSON.stringify(await h.chain.list());
    expect(dump).not.toContain("ABCPE1234F");
    expect(dump).toContain("ABCPE****F");
  });

  it("serialises concurrent appends into one unforked chain", async () => {
    const h = harness();
    await Promise.all(Array.from({ length: 50 }, (_, i) => h.chain.append({ type: "agent.message", run_id: "r", text: `m${i}` })));
    const rows = await h.chain.list();
    expect(rows.map((r) => r.seq)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    expect(verifyChain(rows).valid).toBe(true);
  });

  it("append failure propagates (gateway then denies)", async () => {
    const chain = new HashChainAuditSink({
      kind: "memory",
      append: async () => {
        throw new Error("db down");
      },
      list: async () => [],
      tamper: async () => null,
    });
    await expect(chain.append({ type: "agent.message", run_id: "r", text: "x" })).rejects.toThrow("db down");
    // queue still works after a failure
    await expect(chain.append({ type: "agent.message", run_id: "r", text: "y" })).rejects.toThrow("db down");
  });
});

describe("groq guard", () => {
  const call: ToolCall = { call_id: "c", run_id: "r", session_id: "s", profile: "research_assistant", tool: "send_email", args: { to: "x" }, requested_at: "" };
  const fake = (content: string | (() => Promise<never>)): GroqLike => ({
    chat: { completions: { create: async () => (typeof content === "string" ? { choices: [{ message: { content } }] } : content()) } },
  });

  it("parses a valid reply and only sends argument names", async () => {
    let body: any;
    const client: GroqLike = {
      chat: { completions: { create: async (b) => ((body = b), { choices: [{ message: { content: '{"label":"injection","score":0.95,"rationale":"x"}' } }] }) } },
    };
    const g = new GroqGuard({ model: "m", timeoutMs: 1000, client });
    const text = mockTools.browse_url({ url: "https://news.example.test/ai-trends-2026" }, "r").text;
    expect(await g.classify({ call: { ...call, args: { to: "secret@x.test" } }, untrustedText: text })).toEqual({
      available: true, label: "injection", score: 0.95, provider: "groq",
    });
    expect(JSON.stringify(body.messages)).not.toContain("secret@x.test");
  });

  it("fails closed on malformed JSON, errors and timeouts", async () => {
    const down = { available: false, label: "unknown", score: 0, provider: "groq" };
    expect(await new GroqGuard({ model: "m", timeoutMs: 1000, client: fake("not json") }).classify({ call, untrustedText: "t" })).toEqual(down);
    expect(await new GroqGuard({ model: "m", timeoutMs: 1000, client: fake('{"label":"maybe","score":2}') }).classify({ call, untrustedText: "t" })).toEqual(down);
    expect(await new GroqGuard({ model: "m", timeoutMs: 1000, client: fake(async () => { throw new Error("429"); }) }).classify({ call, untrustedText: "t" })).toEqual(down);
    const hang: GroqLike = {
      chat: { completions: { create: (_b, opts) => new Promise((_, rej) => opts?.signal?.addEventListener("abort", () => rej(new Error("aborted")))) } },
    };
    expect(await new GroqGuard({ model: "m", timeoutMs: 20, client: hang }).classify({ call, untrustedText: "t" })).toEqual(down);
  });
});

describe("socket bridge", () => {
  it("streams the full S2 event sequence, masked, plus a snapshot on connect", async () => {
    const h = harness();
    const server = http.createServer();
    await new Promise<void>((r) => server.listen(0, r));
    const bridge = attachSocketBridge(server, h.bus, "*");
    const port = (server.address() as AddressInfo).port;

    const client = ioClient(`http://localhost:${port}`, { transports: ["websocket"] });
    const events: BusEvent[] = [];
    client.on("sentinel:event", (e: BusEvent) => events.push(e));
    await new Promise<void>((r) => client.on("sentinel:snapshot", () => r()));

    const finished = new Promise<void>((r) => client.on("sentinel:event", (e: BusEvent) => e.type === "run.finished" && r()));
    const run = createRun(getScenario("S2_injection")!, false, "scripted", h.bus);
    await runScripted(run, { bus: h.bus, providers: h.providers });
    await finished;

    const types = events.map((e) => e.type);
    expect(types[0]).toBe("run.started");
    expect(types).toContain("context.added");
    expect(types).toContain("decision.made");
    expect(types.at(-1)).toBe("run.finished");
    expect(JSON.stringify(events)).not.toContain("ABCPE1234F");
    expect(JSON.stringify(events)).toContain("attacker@evil.test");

    const late = ioClient(`http://localhost:${port}`, { transports: ["websocket"] });
    const snap = await new Promise<BusEvent[]>((r) => late.on("sentinel:snapshot", r));
    expect(snap.length).toBe(events.length);

    client.close();
    late.close();
    bridge.close();
    server.close();
  });
});
