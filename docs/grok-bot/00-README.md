# Grok Bot (x.ai/bot) — research notes

Research on xAI's **Grok Bot**, the "AI teammates that finish the work" product
at <https://x.ai/bot>. Compiled 2026-09-30 from xAI's own announcement and docs
plus independent reviews.

| File | What it covers |
|---|---|
| [01-what-it-is.md](01-what-it-is.md) | Product summary, timeline, who ships it, architecture |
| [02-features.md](02-features.md) | Every capability, feature by feature |
| [03-how-it-works.md](03-how-it-works.md) | Setup, task flow, skills, routines, group chats, approvals |
| [04-use-cases-and-roles.md](04-use-cases-and-roles.md) | The 8 shipped roles with example prompts |
| [05-security-and-limits.md](05-security-and-limits.md) | Security model, gaps, what it is bad at |
| [06-plans-and-pricing.md](06-plans-and-pricing.md) | Plans, price, availability, limits |
| [07-grok-platform-and-crawler.md](07-grok-platform-and-crawler.md) | Rest of Grok (chat, API) and the unrelated "GrokBot" web crawler |
| [08-takeaways-for-darex.md](08-takeaways-for-darex.md) | What this means for Darex |
| [09-sources.md](09-sources.md) | Links, and what could not be verified |

## One-paragraph summary

Grok Bot (beta, announced 2026-08-11) lets you create named, always-on AI
teammates. Each one works on a **cloud computer** (Linux VM with browser,
terminal and file system), signs into your existing tools, and completes
multi-step jobs without supervision, coming back only for approval. It uses
connectors where they exist and falls back to **computer use** (clicking a real
browser) where they do not. Bots remember your preferences, learn workflows by
watching you once, run on schedules or events, and coordinate with each other in
group chats. It ships through Cursor's plans and SuperGrok Heavy.

## Read this first

- `x.ai/bot` itself returned **HTTP 403** to the fetcher. Content here comes from
  `x.ai/news/introducing-grok-bot`, `docs.x.ai/grok-bot/*`, and third-party
  write-ups. See [09-sources.md](09-sources.md).
- "Grok Bot" (the product) is **not** the "GrokBot" web crawler. See file 07.
- This repo contains no Grok integration. Nothing in the codebase mentions grok.
