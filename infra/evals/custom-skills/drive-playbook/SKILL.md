---
name: drive-playbook
description: "Google Drive operations through mcp.darex — search files, list folder contents, extract text from files, upload, and share. Use for finding/reading files in the org Google Drive."
version: 1.0.0
requires_tools:
  - mcp.darex.drive_search
  - mcp.darex.drive_list
  - mcp.darex.drive_get_text
  - mcp.darex.drive_upload
  - mcp.darex.drive_share
dangerous: false
---

# Google Drive Playbook

The org-connected Google Drive is available via the mcp.darex server.

## Available actions

| Goal | tool | key args |
|---|---|---|
| Search files by name | `drive_search` | `query` (optional), `maxResults` (optional) |
| List files in a folder | `drive_list` | `folderId` (optional, default root), `maxResults` (optional) |
| Extract text of a file | `drive_get_text` | `fileId` (required), `mimeType` (optional) |
| Upload a text file | `drive_upload` | `name`, `content`, `parentId` (optional) |
| Share / grant access | `drive_share` | `fileId`, `role` (e.g. writer/reader), `email` |
| Create a Google Doc | `mcp.darex.docs_create` | `title` (optional) |
| Create a Google Sheet | `mcp.darex.sheets_create` | `title` (optional) |

## Calling convention

```
[{ "tool": "mcp.darex.drive_search", "args": { "org_id": "<ORG_ID>", "query": "invoice", "maxResults": 10 } }]
[{ "tool": "mcp.darex.drive_get_text", "args": { "org_id": "<ORG_ID>", "fileId": "<fileId>" } }]
```

## Rules

- `drive_search` returns file metadata; to read contents call `drive_get_text` with the returned `fileId`.
- A "not connected" result for google-drive only affects Drive — Sheets/Docs are separate connectors; try them directly.