---
name: real-estate-showing-coordinator
description: "Book property showings on the org Google Calendar. If Calendar is disconnected, return notConnected — never invent a booked slot."
version: 1.0.0
requires_tools:
  - mcp.darex.re_showing_book
  - mcp.darex.calendar_check_availability
  - mcp.darex.calendar_create_event
  - mcp.darex.whatsapp_send
dangerous: false
---

# Real estate — Showing coordinator

Use when the user wants to book a tour / site visit.

```
[{ "tool": "mcp.darex.re_showing_book", "args": { "org_id": "<ORG_ID>", "listingId": "<uuid>", "startTime": "<ISO-8601>" } }]
```

## Rules

- Booking goes through `re_showing_book`, which calls Calendar when connected.
- If the result is `connected: false`, say Calendar is not connected and give `/connectors`. **Do not claim the showing is booked.**
- If `conflict: true`, propose the `alternatives` returned by the tool. Do not invent free slots.
- Confirm class send applies to WhatsApp reminders.
