---
name: gmail-playbook
description: "Gmail inbox operations through the mcp.darex connectors — fetch/triage emails, extract OTP codes, parse attachments, draft and send. Use when the user asks about email, inbox, messages, drafts, or OTP/verification codes."
version: 1.0.0
requires_tools:
  - mcp.darex.gmail_fetch
  - mcp.darex.gmail_triage
  - mcp.darex.gmail_extract_otp
  - mcp.darex.gmail_extract_attachment
  - mcp.darex.gmail_draft_email
  - mcp.darex.gmail_send
dangerous: false
---

# Gmail Playbook

The org-connected Gmail account exposes these tools via the mcp.darex server.
Always pass the org_id in the tool args exactly as given in your system context.

## Available actions

| Goal | tool | action | key args |
|---|---|---|---|
| Latest emails | `gmail_fetch` | `fetch_latest_emails` | `count` (optional) |
| Categorized inbox | `gmail_triage` | `triage_emails` | `count` (optional) |
| OTP / verification codes | `gmail_extract_otp` | `extract_otp` | `count` (optional) |
| Attachment text (PDF/text) | `gmail_extract_attachment` | `extract_attachment` | `subject`, `filename`, `count` |
| Create a draft (no send) | `gmail_draft_email` | `draft_email` | `to`, `subject`, `body`, optional `cc`/`bcc` |
| Send an email | `gmail_send` | `send_email` | `to`, `subject`, `body` |

## Calling convention

```
[{ "tool": "mcp.darex.gmail_fetch", "args": { "org_id": "<ORG_ID>", "count": 5 } }]
[{ "tool": "mcp.darex.gmail_draft_email", "args": { "org_id": "<ORG_ID>", "to": "x@y.com", "subject": "Subject", "body": "Body text" } }]
```

## Rules

- Prefer drafting over sending unless the user explicitly asks to send.
- Never invent a recipient email — if the user did not provide one, ask for it.
- For OTPs, return the code plus surrounding context, not just the code.