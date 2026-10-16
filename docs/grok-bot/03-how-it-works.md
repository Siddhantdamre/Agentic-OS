# How Grok Bot works

## Setup (6 steps, per xAI docs)

1. **Install** the desktop app (auto-updates; Settings has manual check).
2. **Sign in** with your Cursor account (SSO supported). You need a paid Cursor
   individual/Teams plan or SuperGrok.
3. **Create a Bot**: name, primary job, description.
4. **Assign a first task** by text, dictation or voice chat.
5. **Authenticate tools** by taking over the Agent Computer when the Bot asks.
6. **Review and refine**, then save the result as a skill or routine.

Example Bot spec from the docs:

> Name: Piper. Job: Product performance. Investigate questions using
> observability tools, preserve links and screenshots, separate evidence from
> hypotheses, return a summary with the highest-impact issue first.

## Writing a good task

Include: **outcome, sources, constraints, deliverable, review point.**

> Summarize the document in five bullets. List dates, decisions and open
> questions separately. Cite sources. Don't modify the original.

Lead with the outcome, link the source of truth, say what the Bot may change and
what needs approval, and ask for links or screenshots as evidence.

## One task, end to end

```
you: "reconcile this week's expenses, draft follow-ups, don't send"
 -> Bot picks connector if installed, else opens Chrome on its cloud computer
 -> works through the steps, saves files to /workspace
 -> hits a login/2FA/CAPTCHA  -> pauses, asks you to take over the screen
 -> proposes an external action -> approval prompt (allow once / rule / deny)
 -> returns summary + drafts; you review, then approve sending
```

## Access model

- Access is granted conversationally as the Bot asks. There is no pre-built
  permission matrix.
- Connectors install account-wide from the Marketplace. Connector tokens are not
  stored on the computer; Bots never receive OAuth tokens.
- Browser sessions persist across tasks and across Bots. Some sites expire
  sessions and require re-verification.
- Bots act **as the signed-in member**, not as a separate identity.

## Skills and routines

- **Skill** = reusable recipe (when to use, inputs, steps, validation, outputs,
  approvals). Stored privately, shared by all your Bots.
- **Routine** = trigger + skill. Before creating one, decide: owning Bot,
  schedule and timezone, input source, output location, approval gates, failure
  handling.
- **Triggers:** schedules, or events from Cursor account integrations (Slack
  message, GitHub notification).
- **Best practice:** narrow matchers (never "every new message"), always require
  approval before posting externally, automate prep work first, add stale-data
  policies, re-test after upstream system changes.

## Collaboration flow

- Group chat of 2 to 6 Bots with one shared outcome and visible handoffs.
- Bots pass work asynchronously; a message wakes a dormant Bot.
- Bots do not share memory, only files, browser sessions and messages.

## Maintenance

Settings, Updates: update software while keeping files, or reset to the last
snapshot. Treat temp dirs, manually installed packages and uncommitted app state
as replaceable; keep durable work in `/workspace`.
