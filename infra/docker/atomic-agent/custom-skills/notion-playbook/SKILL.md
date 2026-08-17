---
name: notion-playbook
description: "Notion workspace operations through mcp.darex — search documents, create pages, and append content blocks. Use for note-taking, knowledge base, 'create a page' or 'find a doc'."
version: 1.0.0
requires_tools:
  - mcp.darex.notion_search
  - mcp.darex.notion_create_page
  - mcp.darex.notion_append_page_content
dangerous: false
---

# Notion Playbook

The org-connected Notion workspace is available via the mcp.darex server.

## Available actions

| Goal | tool | key args |
|---|---|---|
| Search docs | `notion_search` | `query` (optional) |
| Create a page | `notion_create_page` | `title` (required), `parentPageId` (optional) |
| Append content blocks | `notion_append_page_content` | `pageId` (required), `content` (required) |

## Calling convention

```
[{ "tool": "mcp.darex.notion_search", "args": { "org_id": "<ORG_ID>", "query": "roadmap" } }]
[{ "tool": "mcp.darex.notion_create_page", "args": { "org_id": "<ORG_ID>", "title": "Q3 Plan" } }]
[{ "tool": "mcp.darex.notion_append_page_content", "args": { "org_id": "<ORG_ID>", "pageId": "<pageId>", "content": "Bullet list of items\n- item 1\n- item 2" } }]
```

## Rules

- If the user references an existing page by name, use `notion_search` first to resolve its `pageId`.