---
name: support-tickets
description: "Support ticket operations through mcp.darex — create and update Zendesk tickets, and interact with Intercom conversations. Use when the user mentions a support ticket, helpdesk, complaint, or customer conversation queue."
version: 1.0.0
requires_tools:
  - mcp.darex.zendesk_fetch_tickets
  - mcp.darex.zendesk_create_ticket
  - mcp.darex.zendesk_update_ticket
  - mcp.darex.intercom_fetch_conversations
dangerous: false
---

# Support Playbook (Zendesk / Intercom)

The org-connected support desk is available via the mcp.darex server.

## Available actions

| Goal | tool | key args |
|---|---|---|
| List recent tickets | `zendesk_fetch_tickets` | none required |
| Create a ticket | `zendesk_create_ticket` | optional `subject`, `description`, `priority` |
| Update a ticket | `zendesk_update_ticket` | `ticketId` (required), optional `status`, `priority`, `subject`, `comment`, `assignee_id` |
| Open Intercom conversations | `intercom_fetch_conversations` | none required |

## Calling convention

```
[{ "tool": "mcp.darex.zendesk_create_ticket", "args": { "org_id": "<ORG_ID>", "subject": "Login issue", "description": "User cannot log in", "priority": "urgent" } }]
[{ "tool": "mcp.darex.zendesk_update_ticket", "args": { "org_id": "<ORG_ID>", "ticketId": "123", "status": "solved", "comment": "Reset password and verified access" } }]
```

## Rules

- Use `status` values Zendesk understands (open / pending / solved / closed).