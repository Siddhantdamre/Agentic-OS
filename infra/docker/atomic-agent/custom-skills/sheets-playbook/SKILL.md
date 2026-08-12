---
name: sheets-playbook
description: "Google Sheets operations through mcp.darex — create spreadsheets, read a range, and append rows. Use for tabular data, budgets, reports, or 'make a sheet/list'."
version: 1.0.0
requires_tools:
  - mcp.darex.sheets_create
  - mcp.darex.sheets_read
  - mcp.darex.sheets_append_row
dangerous: false
---

# Google Sheets Playbook

The org-connected Google Sheets account is available via the mcp.darex server.

## Available actions

| Goal | tool | key args |
|---|---|---|
| Create a new spreadsheet | `sheets_create` | `title` (optional) |
| Read rows from a range | `sheets_read` | `spreadsheetId` (required), `range` (optional, default `A1:Z100`) |
| Append one or more rows | `sheets_append_row` | `spreadsheetId` (required), `values` (array of arrays), or `row` array, or `value` string |

## Calling convention

```
[{ "tool": "mcp.darex.sheets_create", "args": { "org_id": "<ORG_ID>", "title": "Budget" } }]
[{ "tool": "mcp.darex.sheets_append_row", "args": { "org_id": "<ORG_ID>", "spreadsheetId": "<id>", "values": [["Name","Amount"],["Ops","1200"]] } }]
[{ "tool": "mcp.darex.sheets_read", "args": { "org_id": "<ORG_ID>", "spreadsheetId": "<id>", "range": "A1:B5" } }]
```

## Rules

- When appending, pass `values` as an array of row arrays (each row is an array of cell values).
- Use the `spreadsheetId` returned by `sheets_create` for follow-up read/append steps.