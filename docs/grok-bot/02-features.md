# Grok Bot features

## Core

1. **Persistent named Bots.** Create a Bot with a name, a primary job, and a
   description of how it should work. Up to 50 per account.
2. **Own cloud computer.** Linux VM with Chrome, terminal and a durable
   `/workspace`. You can watch the shared desktop live (clicks, typing,
   navigation, status).
3. **Signs into your existing tools.** You authenticate once yourself by taking
   over the Agent Computer; the Bot inherits the browser session. Passwords are
   not pasted into chat.
4. **Connectors first, computer use second.** Marketplace plugins give structured,
   more reliable access (invoke with `@`). Where none exists, the Bot drives the
   browser like a human, including apps with no API or MCP.
5. **Runs while you are away.** Background tasks and routines persist on the cloud
   computer.
6. **Finishes end-to-end, escalates only when needed.** Returns for approval,
   passwords, 2FA, CAPTCHAs, payments, or sites that require a human.

## Working with Bots

7. **Chat like a coworker.** Paste text, links, images, attach files, dictate, or
   use voice chat. The thread shows tool activity, created files and approval
   requests. `Cmd/Ctrl+K` searches messages, files and routines.
8. **Threads and reactions.** Threads keep feedback attached to a result; reactions
   acknowledge. Written replies, not reactions, change instructions.
9. **Memory.** Retains stable preferences, role context and summaries of prior
   work. For critical decisions, ask the Bot to re-verify current sources rather
   than trust memory.
10. **Progressive trust.** Bots learn edge cases and when to escalate versus
    continue, becoming more proactive over time.

## Automation

11. **Skills** (`/`). Reusable instruction sets shared by all your Bots: when to
    use, inputs, access needed, steps, validation, outputs, approval rules.
12. **Routines.** Run a skill on a schedule or after an event (for example a Slack
    message or GitHub notification). Up to 50 per Bot; the last 20 runs kept per
    routine. A **Test run** is available before enabling; enable, pause, edit or
    delete from conversation details.
13. **Teach by demonstration ("watch me once").** Record up to 10 minutes of your
    screen (no audio). The Bot drafts a skill from it; the draft needs refining.

## Collaboration

14. **Multi-Bot parallel work.** Specialist Bots (inbox, recruiting, bug fixes,
    ops) run at once.
15. **Bot-to-Bot messaging.** Bots message each other asynchronously, wake dormant
    Bots, share context, and pass ownership without human routing.
16. **Group chats.** 2 to 6 Bots on one outcome. Use `@bot`, several mentions, or
    `@everyone`. Advice: give each stage a single owner.
17. **Team Bots** (announced 2026-09-28, public beta for Teams and Enterprise
    only). Lets a team share Bots. Shared: files and instructions, skills, app
    plugins, credentials, memory. Kept separate: individual conversations stay
    private, memory and context are separated per user, and computers are per
    user, not per Bot. Third-party analysis flags open questions: who owns the
    shared credentials, which login environment a shared Bot uses, permission
    inheritance, offboarding departing members, and pricing (none published).

## Also documented

- **X / Twitter integration** with free API credits for paid users (one review).
- **Voice input and voice chat** for assigning tasks.
- **Weekly usage allowance** with overage at model rates (see file 06).
- **No-training commitment** for paid plans (one third-party report; verify).

## Governance (see file 05)

18. Approvals with allow once / create rule / deny.
19. **Auto Review:** an independent model checks risky actions (shell commands,
    plugin calls, computer use, automation writes, delegation) before they run.
20. Enterprise: network allowlists, audit logs, action recording, SCIM/SSO,
    OpenTelemetry export.

## Platforms

- Desktop: macOS (Apple silicon and Intel), Windows (x64, Arm64), Linux (.deb,
  .rpm, AppImage). Early reports said Linux was excluded at launch; the current
  docs list it.
- iOS. Android and iPad announced as coming.
- Requires cloud-storage-compatible account (Legacy Privacy Mode is incompatible).

## Verification status: what is confirmed and what is not

I have **not run Grok Bot**. Nothing here was tested first-hand. Status is about
evidence quality, not whether the feature works for you.

| Level | Features | Evidence |
|---|---|---|
| Described by xAI docs | 1-16, 18-20 | Official launch post and `docs.x.ai/grok-bot/*` |
| Announced, thin detail | 17 Team Bots | Announcement plus two third-party write-ups; no xAI doc page read |
| Single third-party source | X integration, no-training commitment, VM size (8 vCPU, about 16 GB RAM, about 120 GB disk) | One review each; not in xAI docs I read |
| Vendor claim, unaudited | "Procurement Bot found more than $100,000 savings" | xAI's own report |
| Not verified by anyone | Reliability, task success rate | Reviewers say no published reliability data exists; it is an early beta |

Known contradictions between sources:

- **Computers:** xAI docs say one shared computer per account for all Bots; a
  third-party summary says each Bot has its own. I follow the docs.
- **Approvals:** xAI docs describe approvals plus Auto Review; one reviewer calls
  approvals advisory with no product-level restrictions. Both can be true: the
  boundaries are prompt-driven, and Auto Review is a separate reviewing model.
- **Launch problems:** some SuperGrok Heavy users could not sign in on day one.

## Gaps that remain

- `x.ai/bot` was not readable (403), so any feature shown only on that landing
  page is missing.
- Docs pages for plans (404) and full Team Bots documentation were not readable.
- Android and iPad clients, and Windows timing for Team Bots, are unreleased or
  unspecified.
