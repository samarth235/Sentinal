# Sentinel — Slides Outline (7 slides max)

1. **Title.** Sentinel: a policy-enforcement gateway that stops AI agents from being hijacked by the content they read.

2. **The threat.** 2–3 real incidents, each one confirmed in `claims-to-verify.md` before it goes on the slide (e.g. EchoLeak, the GitHub Copilot prompt-injection CVE). Threat model: the attacker controls content, the asset is tool permissions plus data, and admin abuse and compromised tool servers are out of scope.

3. **Why input filters fail.** Text classifiers can be phrased around. Sentinel enforces at the action layer:
   - *Session taint*: once untrusted content has been read, high-impact actions need approval.
   - *Argument provenance*: a recipient, payee or amount that appears only in untrusted text is denied, with the exact span as evidence.
   - Say it precisely: taint is session-wide, and provenance is exact string matching after normalisation (case, whitespace,
     number formats), not causal data-flow tracking. A value the attacker obfuscates no longer matches, so it is treated as
     unknown and still needs human approval (R9). Safe either way, but do not call it "causal derivation".

4. **Architecture.** Agent → Sentinel gateway (policy engine) → tools. On the side: guard classifier (Groq, can only escalate), hash-chained audit log (Postgres), approvals (Telegram + dashboard), live dashboard (Socket.io).
   Telegram is read-only plus approve/reject: `/status`, `/pending`, `/verify`, `/replay <id>`, `/trace <source>`, and an alert on every block.
   `/override` is **off by default** (opt-in, time-boxed, audited): a chat command that loosens policy would make the approval channel the
   easiest way to hijack the agent. Policy changes go through the policy file (its hash is recorded per run).

5. **The 11 rules on one slide.** R0–R10, with the fail-closed ones highlighted: R0 engine error → DENY, R7 guard unavailable → approval, approval timeout → blocked, audit failure → DENY, invalid policy → server refuses to start.

6. **Results.** 4 scenarios × shield OFF/ON:

   | Scenario | Shield OFF | Shield ON |
   |---|---|---|
   | S1 legit task | email sent, no confirmation | allowed after approval |
   | S2 injection | PANs emailed to attacker | blocked (R3, R4) |
   | S3 sensitive data | PAN/phone list returned | blocked (R3) |
   | S4 beyond permission | ₹49,999 paid | blocked (R1) |

   Plus the **median `latency_ms`** measured from real runs (`GET /api/decisions`). Never a rehearsed number.

7. **Impact and roadmap (one slide).** Drop-in SDK for any agent framework; next steps are an MCP gateway and signed tool metadata.
