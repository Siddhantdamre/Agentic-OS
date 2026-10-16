# Security model and limits

## What xAI documents

- **Approvals:** the UI shows the proposed operation; allow once, create a
  matching rule, or deny. You state boundaries in prompts and Bot descriptions.
- **Auto Review:** independent review model evaluates risky actions (shell,
  plugin calls, computer use, automation writes, delegation) before execution.
  Admins can enforce it org-wide and add team rules; members add personal rules.
- **Local execution:** off the cloud computer, per-command approval by default.
  Docs recommend **Never allow** unless needed.
- **Credentials:** connector tokens are not stored on computers; Bots never get
  OAuth tokens; passwords go through secure input, never chat.
- **Enterprise only:**
  - Network policy: destination allowlists (allow all, defaults + custom,
    team-allowlist-only); directory groups can override; applies in ~1 minute.
  - Audit logs (admin, auth, control-plane) with SIEM streaming.
  - Action Recording: sanitised tool-call records, 90-day retention,
    OpenTelemetry export; conversation export opt-in with credential redaction.
  - SCIM 2.0 (Okta, Entra ID), admin on/off switch, group access, Team Setup
    scripts and encrypted Team Secrets for private networks.
- **Data:** durable disks; daily encrypted backups replicated to a separate
  facility; data deleted or returned within 30 days after termination (DPA).
  No per-org retention policy and no point-in-time restore.

## Documented risks

- **Shared computer is not a security boundary.** All Bots share files, sessions
  and logins. Do not treat separate Bots as isolation. Deleting a Bot does not
  remove its files or sign-ins.
- **Actions look human.** Downstream logs show the member, not the Bot, so AI
  work is hard to tell from human work.
- **Approvals are advisory.** An approval governs a proposed action, not work
  already done. Test runs perform real operations.
- **Prompt injection is reduced, not eliminated.**
- **Sites can block.** Bots defer CAPTCHAs, human verification and explicit bot
  blocks to you rather than bypass them.

## Reviewer-reported gaps (beta)

- No dry-run mode; no confidence thresholds; no knowledge-base grounding (early
  users saw fabricated answers); audit view of Bot actions "coming soon".
- No SOC 2, ISO 27001, GDPR or HIPAA claims; retention follows Cursor's terms.
- Sent emails and CRM writes cannot be recalled.
- Launch-day sign-in failures for some SuperGrok Heavy users.

## Operating limits

| Limit | Value |
|---|---|
| Bots per account | 50 |
| Bots per group chat | 2 to 6 |
| Routines per Bot | 50 |
| Run records kept per routine | 20 |
| Demonstration recording | 10 min, no audio |
| Computer-use tasks per Bot at once | 1 |
| Usage | Weekly allowance, separate from normal Grok/Cursor quota |

## Practical rules

1. Default to draft-and-review; encode "do not send/change" in every prompt.
2. Prefer connectors over browser control.
3. Keep Auto Review rules narrow and action-specific.
4. Avoid regulated data and customer-facing autonomous sends for now.
