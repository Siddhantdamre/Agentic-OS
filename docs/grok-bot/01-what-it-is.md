# What Grok Bot is

**Tagline:** "AI teammates that finish the work" / "AI teammates you can give real
work to."

Grok Bot is an app for creating persistent AI agents ("Bots"). Each Bot is a named
teammate with a job description, its own memory, and access to a real cloud
computer. You message it like a coworker (desktop or iPhone), it does the work in
the actual tools, and it returns when it needs a human decision.

## Timeline

| Date | Event |
|---|---|
| Feb 2026 | SpaceX acquires xAI (per third-party coverage) |
| Apr 2026 | Cursor (Anysphere) partners with SpaceX on model training; not acquired |
| 2026-08-11 | Grok Bot announced, early beta |
| 2026-09-28 | Team Bots announced: public beta for Teams and Enterprise |
| Pending | Android and iPad clients; enterprise waitlist |

## Who ships it

xAI builds it, but distribution and billing run through **Cursor**: downloads,
onboarding, sign-in (Cursor account, SSO) and plans. Bots run on Cursor's servers.
SuperGrok Heavy subscribers also get access.

## Architecture

```
You (desktop / iOS chat, voice)
        |
   Grok Bot app  --- skills (/)  connectors (@)  routines
        |
   Bot A   Bot B   Bot C        each Bot: own memory + own screen
        \    |    /
   ONE shared cloud computer per account
   (Linux VM: Chrome, terminal, /workspace, saved logins)
        |
   Connectors/plugins (Marketplace)  or  computer use (clicking UI)
        |
   Your real tools: CRM, email, Slack, ad platforms, legacy web apps
```

Key architectural facts:

- **One computer per account, shared by all Bots.** Files, browser sessions and
  logins are common. Sign in once for one Bot and all your Bots have that session.
- **Memory is per Bot.** Conversation history, role context and learned
  preferences are separate; context moves between Bots via shared files and
  browser sessions, or by Bots messaging each other.
- **Own screen per Bot.** Bots work in parallel, but one Bot runs only one
  computer-use task at a time.
- **Cloud, not local.** Work continues when you close the laptop. The computer is
  separate from your machine; local command execution needs explicit approval.
- **Limits:** up to 50 Bots per account, 2 to 6 Bots per group chat, 50 routines
  per Bot.

## What makes it different from a chatbot

| Chatbot | Grok Bot |
|---|---|
| Drafts, suggests | Does the work inside the real tool |
| Stops when you close the tab | Keeps working offline |
| Needs an API or MCP | Can use any website via computer use |
| One conversation | Persistent teammates with memory, routines, group chats |
