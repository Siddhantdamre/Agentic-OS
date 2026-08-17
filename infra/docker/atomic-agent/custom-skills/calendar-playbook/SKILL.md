---
name: calendar-playbook
description: "Google Calendar operations through mcp.darex — list upcoming events, create events with optional Google Meet, and check free/busy availability. Use for scheduling, meeting invites, or 'when am I free'."
version: 1.0.0
requires_tools:
  - mcp.darex.calendar_list_events
  - mcp.darex.calendar_create_event
  - mcp.darex.calendar_check_availability
dangerous: false
---

# Google Calendar Playbook

The org-connected Google Calendar is available via the mcp.darex server.

## Available actions

| Goal | tool | key args |
|---|---|---|
| Upcoming events (next 7 days) | `calendar_list_events` | none required |
| Create event (+ optional Meet) | `calendar_create_event` | `summary`, optional `startTime`, `endTime`, `description`, `location`, `timeZone`, `attendees` |
| Find free slots | `calendar_check_availability` | optional `startTime`, `endTime`, `durationMinutes`, `dayStart`, `dayEnd` |

## Calling convention

```
[{ "tool": "mcp.darex.calendar_create_event", "args": { "org_id": "<ORG_ID>", "summary": "Team sync", "startTime": "2026-08-13T10:00:00", "endTime": "2026-08-13T10:30:00", "attendees": ["a@b.com"] } }]
[{ "tool": "mcp.darex.calendar_check_availability", "args": { "org_id": "<ORG_ID>", "durationMinutes": 60, "dayStart": "2026-08-13T09:00:00", "dayEnd": "2026-08-13T17:00:00" } }]
```

## Rules

- If the user does not give a start time, prefer `check_availability` first.
- Use ISO 8601 local timestamps for `startTime`/`endTime`.