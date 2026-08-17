---
name: docs-playbook
description: "Google Docs operations through mcp.darex — create documents, read full text, and append content. Use when the user wants to create/read/edit a Google Doc or a written report/letter."
version: 1.0.0
requires_tools:
  - mcp.darex.docs_create
  - mcp.darex.docs_read
  - mcp.darex.docs_append
dangerous: false
---

# Google Docs Playbook

The org-connected Google Docs account is available via the mcp.darex server.

## Available actions

| Goal | tool | key args |
|---|---|---|
| Create a new document | `docs_create` | `title` (optional) |
| Read full text of a document | `docs_read` | `documentId` (required) |
| Append text to a document | `docs_append` | `documentId` (required), `content` (required) |

## Calling convention

```
[{ "tool": "mcp.darex.docs_create", "args": { "org_id": "<ORG_ID>", "title": "Weekly Report" } }]
[{ "tool": "mcp.darex.docs_append", "args": { "org_id": "<ORG_ID>", "documentId": "<documentId>", "content": "Body text to append" } }]
```

## Rules

- Use the `documentId` returned by `docs_create` for subsequent read/append steps.
- If the user wants a multi-section document, create once then append sections.