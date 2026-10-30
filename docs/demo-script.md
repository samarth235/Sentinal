# Sentinel — Demo Script (target 4–5 minutes)

Setup before going on stage:
- Backend and frontend running (`npm run dev` in `backend/` and `frontend/`), dashboard open at 1366×768 or larger.
- Press **Reset**. Scenario = **S2**, Mode = **scripted** (switch to live only if the API key and network are confirmed).
- If Telegram is configured, phone unlocked with the bot chat open. Otherwise use the dashboard Approve button.
- Backup video ready to play if anything fails.

## 1. Hook (20s)
"AI agents now read your email and web pages, and they can act with your tools. One hidden sentence on a web page can make them leak your customers' data. That's indirect prompt injection, number one on OWASP's Top 10 for LLM applications." *(Check the ranking in claims-to-verify.md.)*

## 2. Threat model (30s)
- **Attacker:** anyone who can put text where the agent reads it (a web page, document or email).
- **Asset:** the agent's tool permissions and the customer data behind them.
- **Out of scope:** malicious users who already have admin rights, and compromised tool servers.

## 3. Attack with the shield OFF (45s)
Select **S2**, press **Run before/after**. Point at the left card as it fills:
"The user asked for a summary of an innocent-looking article. Shield off: the agent queried the customer table and emailed it out." Point at the **Damage** panel: the attacker@evil.test row in red with masked PANs. "That's the attack working."

## 4. Same attack with the shield ON (60s)
The right card turns green: **Attack blocked — rules R3, R4**.
- Point at the **Context** panel: the hidden div is highlighted in red. "Sentinel traced the recipient back to this invisible sentence. The address wasn't in the user's request, so the email is denied."
- Point at the decision card: the plain-English reason, rule **R4**, and the measured latency (quote the number on screen, not a rehearsed one).
- Point at the graph: the red animated edge from the untrusted page to `send_email`.

## 5. Not a blunt blocker (45s)
Select **S1**, shield ON, **Run**. Browsing is allowed (green). The email to the user's own colleague needs approval: approve it on the phone (Telegram) or with the dashboard button. The email appears in the outbox. "Legitimate work goes through; high-impact actions get a human in the loop. If nobody answers, the action is blocked: that's fail-closed."

## 6. The other two scenarios (30s)
- **S3**, Run: asking for PAN and phone numbers is denied by **R3** (field not permitted for this profile).
- **S4**, Run: a payment from the research assistant is denied by **R1** (tool not in the profile).

## 7. Proof the log can't be quietly edited (30s)
In the **Audit** panel press **Verify**: "Chain intact (n rows)". Press **Tamper**: this flips one stored DENY to ALLOW directly in the database. Press **Verify** again: "Tampered at row #k". "Every event is SHA-256 chained, so editing history breaks the chain." Mention that PANs and phone numbers are masked before they are stored.

## 8. Close (20s)
"Framework-agnostic: three lines to wrap any agent's tools. Fail-closed by default. Runs on free tiers today."

## If something breaks
- Socket drops: the dashboard shows a toast and reconnects; refresh restores the last 500 events.
- Telegram silent: use the dashboard Approve/Reject buttons (same endpoint, first answer wins).
- Live mode refuses or misbehaves: switch to scripted. It sends the same calls through the same gateway.
- Anything else: play the backup video.
