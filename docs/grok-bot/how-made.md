# How Grok Bot is made, and how to build one like it

**Honest scope.** xAI has not published Grok Bot's source or internals. What is
below is split into three labels so you can tell fact from guess:

- **[Documented]** stated by xAI's docs or launch post
- **[Reported]** one third-party source, not in xAI docs
- **[Inferred]** my engineering reasoning about what must exist for the documented
  behaviour to work. Treat as a design, not a leak.

Section 0 (added later) adds material found online: Cursor's engineering blog, a
third-party teardown, and open-source clones. Where section 0 and the rest of this
file disagree, trust section 0.

The product is not magic. It is an ordinary agent loop, a sandboxed computer, a
browser it can drive, a memory store, a scheduler and an approval layer, glued
together. Every piece is buildable with off-the-shelf parts.

---

## 0. What the internet actually says about the internals (added after more research)

Since the first draft, I found real engineering material. It changes several
"Inferred" items into "Reported" and gives concrete names to copy. Labels below:
**[Cursor]** from Cursor's own engineering blog, **[Analysis]** from a
third-party teardown of a Grok Bot box (a public gist, not xAI-published, so treat
as unverified), **[Review]** from a product review.

### 0.1 Who runs it and on what

- Grok Bot is a **computer-use agent that runs in Cursor's cloud**, one dedicated
  cloud computer per user account. Reported as a **Firecracker microVM** with
  hardware-level separation between users. **[Review / search summaries]**
- Bots are locked to **xAI models**; no option to swap in another provider.
  Cloud-only, no self-hosting. **[Review]**
- Built-in connectors listed by one review: Gmail, Google Calendar, Google Drive,
  OneDrive, Outlook, Microsoft Teams, SharePoint, Salesforce. Custom MCP servers
  must be publicly reachable. **[Review]**
- Memory cannot be inspected, corrected, exported or deleted per item. **[Review]**
- Bots can hand coding work to separate **cloud coding agents** on their own
  machines and branches, watched by the parent Bot. **[Analysis]**

### 0.2 The internal design (teardown of a Bot's box) **[Analysis]**

Not an xAI document. It is a useful blueprint anyway.

```
 Client  --HTTP/SSE-->  Gateway :1340  (auth: origin + bearer token)
                            |
                     host process ("host-main"): decides what a turn means
                            |  ConnectRPC (daemon token)
                     Execution daemon :1337
                       shell + files, PTY/tmux (:1338), MCP subprocesses,
                       X11 computer use + screenshots
                            |
        per display N:  ConnectRPC :14000+N   VNC :5900+N   Chrome CDP :9222+N
```

Key ideas worth copying:

| Idea | How it works |
|---|---|
| Two processes | A **host** owns conversations, prompts and policy; a separate **execution daemon** does shells, files, MCP and screens. The model never runs on the machine it controls |
| Async prompts | `sendPrompt` returns once the prompt is durably stored (a `clientNonce` makes it idempotent); replies arrive later as transcript events over an SSE `/events` stream |
| Turn sequence | new request id, snapshot the agent profile, build context, discover MCP tools **per turn**, restore checkpoint if any, compose the tool-using agent, stream model steps, checkpoint, persist |
| Storage | Canonical state in **SQLite** (key-value plus transcript entries) pointing to **content-addressed blobs** in a second SQLite file. JSONL transcript and search index are rebuildable projections |
| Step checkpoints | A turn can **pause** for an approval, a secret request or a widget and resume **without replaying the turn** |
| Agent kinds | Named durable agents (own SQLite state and profile); task **subagents** (share the parent's box, own transcript); remote cloud coding agents |
| Browser | Two modes: **DOM automation** through Chrome DevTools (preferred) and **pixel-level X11 computer use** (screenshots plus input). A per-display "busy lease" stops page reloads while computer use is acting; scarce displays are allocated with owner tokens |
| Login sharing | Cookies (including HttpOnly) and localStorage are **mirrored across displays** over loopback CDP, so one sign-in serves every Bot, which is exactly why Bots are not a security boundary |
| Approvals | Per action: **allow** (run), **deny** (return refusal), **needs user** (persist an approval request and pause). Execution-side rules merge admin, user, repository and hardcoded rules, checked by the daemon |
| Automations | Schedules and listeners feed a **trigger hub** that creates a durable wake for a named agent and pushes it through the **ordinary turn queue**. No separate automation engine |
| Layered auth | External gateway (origin and bearer), internal RPC (daemon token), display routes (owner token), model access (short-lived refreshed tokens), shell and MCP through policy |
| Failover | Active/passive with a streaming proxy that picks the original host or an SSH path to a local clone; affinity pins concurrent commands to one backend |

### 0.3 Lessons from Cursor's cloud-agent engineering **[Cursor]**

Cursor runs the infrastructure Grok Bot is sold on, and published what it learned:

1. **Decouple three things:** the agent loop, the machine state, and the
   conversation state. The loop lives in **Temporal**, not on the VM, so pods can
   be recycled, prewarmed or made read-only independently, and subagents spawn
   asynchronously.
2. **Their first design failed.** A work-stealing worker design ran at "one 9 of
   reliability." After moving to Temporal it reached over 99% (two 9s), and now
   handles more than 50 million actions a day across over 7 million workflows.
3. **Short workflows beat eternal ones.** Moving from never-ending workflows to
   task-completion workflows made version upgrades faster. Timeouts, retries, async
   tool calls and inference outages are each a separate failure domain.
4. **Conversation state is append-only and streamed**, with retry-aware rewinding.
5. **The environment is the biggest quality lever.** Rebuilding a real dev
   environment on the VM (dependencies, network policy, secret redaction,
   credentials, hibernate and resume, checkpoint and restore) mattered more than
   model choice. They use a Dockerfile as the base image, a supervisor that
   restarts long-running commands, and an environment-inspection MCP so the agent
   can diagnose its own setup.
6. **Security by default:** network egress restrictions, scoped and proxied git
   access, secret scanning in commits, and **secret redaction in tool results** so
   the agent cannot read secret values even if it tries.
7. **Shrink the harness over time.** Early code double-checked the agent and forced
   commits; as models improved, that logic moved into agent-controlled tools.
8. **Prompt for autonomy.** A blocked cloud agent wastes hours, so prompts push it
   to proceed instead of asking.

### 0.4 Real building blocks you can use today

| Need | Options (from the research) | Notes |
|---|---|---|
| Sandboxed computer, strong isolation | **E2B** (Firecracker microVMs, dedicated kernel, snapshots) | Managed; billed per second, about $0.05 per vCPU-hour and $0.016 per GiB-hour |
| Desktop with mouse, keyboard, live stream | **E2B Desktop** package (`@e2b/desktop`) | Built for computer-use agents |
| Fast container sandboxes, stateful workspaces | **Daytona** (containers, shared host kernel, advertised sub-90 ms create, computer-use sandboxes on Linux, macOS, Windows) | Weaker isolation than microVMs |
| Self-host microVMs | **Firecracker** directly, or gVisor/Kata for a middle path | More work, full control |
| Durable orchestration of the loop | **Temporal** | Darex already runs it |
| Browser control | Chrome DevTools Protocol / Playwright, plus X11 screenshots as fallback | Same two-mode split as the teardown |
| Takeover / live view | VNC or **noVNC** per display | Teardown uses VNC ports per display |
| Tool protocol | **MCP** servers as subprocesses, discovered per turn | Darex already has an MCP bridge |
| State | SQLite per agent (as the teardown) or Postgres (Darex) | Keep blobs content-addressed |

### 0.5 Open-source projects you can read or fork **[from an alternatives roundup]**

| Project | License | Why look at it |
|---|---|---|
| **OpenGrokBot** (`github.com/wolfqing/OpenGrokBot`) | MIT | Closest clone: gateway, one Docker container per teammate, headed Chromium with noVNC takeover, SQLite, `MEMORY.md`, cron routines, draft-and-hold approvals, chief-of-staff dispatch, per-bot daily token limits, OpenAI-compatible model API. Node 22, pnpm monorepo (`gateway`, `teammates`, `web`, `deploy`). Unofficial |
| **Rakazo** | Apache-2.0 | Self-hosted; each bot gets a sandboxed browser and shell; signs into tools with approval workflows; runs in Docker behind your firewall |
| **OpenBot** | not stated | Self-hosted agent "coworkers" with isolated computers; documents and conversations in Postgres; AG-UI compatible |
| **Hermes Agent** | MIT | Persistent memory, auto-generates skills from past work, scheduling |
| **NanoClaw** | MIT | Small (about 17,500 lines), each agent group in its own Linux container |
| **OpenClaw** | not stated in roundup | Personal assistant over chat apps; large community |
| **OpenWork**, **Eigent** | not stated | Desktop apps: 50+ models with MCP and skills sharing; multi-agent teams doing browser, file and terminal work |

Check each project's license and maturity yourself before depending on it. I read
only the summaries and the OpenGrokBot README, not the code.

### 0.6 What this changes in the plan below

- Use **two processes** from the start: control plane and a separate execution
  daemon on the computer. Do not let the model host and the controlled machine be
  the same process.
- Put the agent loop in **Temporal** (Darex already has it) and keep VM state and
  conversation state separate. This is the single strongest lesson.
- Add **step checkpoints** so an approval pause does not replay a turn. Darex's
  resume-after-approval is a start; store per-step checkpoints to make it exact.
- Reuse the **turn queue** for routines: a schedule or event just creates a wake-up
  turn. No second engine.
- Implement browser control in **two modes** (DOM first, pixels second) with a
  busy lease.
- Add **secret redaction on tool results** and an egress allowlist. Cheap, high value.
- For a fast start, **fork or study OpenGrokBot** before writing a computer layer.

---

## 1. The parts, and how Grok Bot does each

| # | Part | What Grok Bot does | Label |
|---|---|---|---|
| 1 | Agent loop | A model plans, calls tools, sees results, repeats until done or blocked | Inferred |
| 2 | Sandboxed computer | Linux VM with Chrome, terminal, `/workspace`, durable disk, snapshots | Documented; sizes Reported (8 vCPU, about 16 GB RAM, about 120 GB) |
| 3 | Computer use | Bot sees the screen, clicks and types; one computer-use task per Bot at a time; each Bot has its own screen | Documented |
| 4 | Connectors | Marketplace plugins (MCP-style), installed account-wide, invoked with `@`; tokens never stored on the computer | Documented |
| 5 | Human takeover | You take over the Agent Computer to enter passwords, 2FA, CAPTCHAs, payments | Documented |
| 6 | Persistent sessions | Browser logins persist across tasks and are shared by all Bots | Documented |
| 7 | Per-Bot memory | Preferences, role context, summaries; separate per Bot | Documented |
| 8 | Skills | Reusable instruction sets, invoked with `/`, shared by all Bots | Documented |
| 9 | Routines | Trigger plus skill: schedules and events (Slack, GitHub); 50 per Bot; last 20 runs kept | Documented |
| 10 | Teach by demo | Screen recording up to 10 minutes, no audio, turned into a draft skill | Documented |
| 11 | Multi-Bot messaging | Async messages wake dormant Bots; group chats of 2 to 6; `@mentions` | Documented |
| 12 | Approvals | Show proposed action; allow once, make a rule, or deny | Documented |
| 13 | Auto Review | A separate review model checks risky actions before they run | Documented |
| 14 | Network policy | Enterprise destination allowlists, applied in about a minute | Documented |
| 15 | Audit and telemetry | Action recording (90 days), audit logs, OpenTelemetry export | Documented |
| 16 | Identity | Cursor account, SSO, SCIM 2.0; Bots act as the signed-in member | Documented |
| 17 | Clients | Desktop (macOS, Windows, Linux) and iOS apps; chat with voice input | Documented |
| 18 | Distribution | Runs on Cursor's servers and billing | Documented |

---

## 2. Architecture (my reconstruction)

```
 Clients: desktop app, iOS app (chat, voice, "watch the screen", takeover)
                    |  websocket / SSE
 +------------------v-------------------------------------------------+
 |  Bot API (control plane)                                           |
 |  auth (SSO), Bots, messages, skills, routines, approvals, quotas   |
 +---------+-----------------+------------------+---------------------+
           |                 |                  |
   Scheduler/queue     Agent runtime       Approval + Auto Review
   (routines, wakeups) (loop per Bot)      (policy engine + reviewer LLM)
           |                 |                  |
           +--------+--------+------------------+
                    |
        +-----------v-----------+      +--------------------------+
        | Tool router           |----->| Connectors (MCP servers, |
        |                       |      | OAuth held by a vault)   |
        +-----------+-----------+      +--------------------------+
                    |
        +-----------v---------------------------------------------+
        | Agent Computer (one per account)                        |
        |  Linux VM: Chrome, terminal, /workspace, durable disk   |
        |  screen per Bot, remote-desktop stream to the client    |
        +---------------------------------------------------------+
   Stores: Postgres (Bots, skills, routines, logs), object store
   (files, recordings, snapshots), vector store or notes (memory)
```

Data flow of one task: you message a Bot, the API queues a turn, the runtime loads
the Bot's role, memory and skills, the model chooses a tool, the tool router sends
it to a connector or to the computer, the result returns to the model, and any
risky step first passes approval and review.

---

## 3. How to build the same thing, part by part

### 3.1 Agent loop
- A model with tool calling, run in a loop: think, call tool, read result, repeat.
- Add turn caps, a wall-clock timeout, an output-token cap and a per-turn tool
  budget. Cache identical read-only tool calls inside a turn.
- For computer use, pick a vision-capable model that has a computer-use tool
  (screenshot in, click/type out). Keep this behind an interface so the model can
  be swapped.
- Persist every turn (messages, tool calls, results) so a paused turn can resume
  after an approval.

### 3.2 The Agent Computer (the hard, expensive part)
Options, cheapest first:

| Option | Isolation | Cost to build | Notes |
|---|---|---|---|
| Docker container per org with Xvfb, Chrome, a window manager | Weak (shared kernel) | Days | Fine for prototype; not for untrusted multi-tenant |
| gVisor or Kata containers | Medium | 1 to 2 weeks | Good middle ground |
| Firecracker microVMs (self-hosted or a managed service such as E2B or Fly Machines) | Strong | 2 to 4 weeks | What a real multi-tenant product wants |

Requirements to copy:
- Persistent disk mounted at `/workspace`; treat everything else as disposable.
- Snapshots and "reset to last snapshot".
- A desktop stream so the user can watch and take over: VNC/noVNC, KasmVNC or a
  WebRTC capture, with input events sent back.
- One virtual screen per Bot so Bots do not fight over the mouse; a lock so one Bot
  runs one computer-use task at a time.
- Chrome profile persisted on the disk so logins survive.
- Idle suspend and wake, or you pay for VMs 24/7.

### 3.3 Driving the browser
- **Cheap and reliable first:** control Chrome through Playwright or the Chrome
  DevTools Protocol (DOM, accessibility tree, text) instead of pixels.
- **Fallback:** screenshot-and-click computer use for canvas apps, remote desktops
  and anything the DOM approach cannot read.
- Detect blockers (login wall, CAPTCHA, 2FA prompt, payment) and hand control to
  the user instead of trying to beat them. Grok Bot does the same.

### 3.4 Connectors
- Prefer structured tools over clicking. Host an MCP server (or a tool registry)
  and route tool calls through it.
- Keep OAuth in a separate secret vault (a service such as Nango does this). The
  model and the computer never see tokens; the router attaches them.
- A Marketplace is just a catalogue of connector definitions plus an install
  record per org.
- When a connector is missing, return an honest "not connected" result. Do not let
  the model invent an answer.

### 3.5 Memory
- Per-Bot memory: a small structured store of preferences, role context and
  summaries of past work, injected at the start of a turn. Summarise old
  conversations rather than replaying them.
- Files in `/workspace` are the cross-Bot channel.
- Tell the model to re-verify anything important from live sources.

### 3.6 Skills
- A skill is a markdown file with: when to use, inputs, access needed, steps,
  validation, outputs, approval rules.
- Load the index (name plus one line) into every turn; load the full body only
  when selected, to save context.
- Slash-command picker in the UI.

### 3.7 Routines and scheduling
- Use a durable workflow engine (Temporal, or a cron plus queue) for schedules and
  event triggers.
- Store: owner Bot, skill, schedule and timezone, trigger filter, approval gates,
  failure policy. Keep the last N run records.
- Add "Test run" before enabling, and narrow trigger filters (never "every message").

### 3.8 Teach by demonstration
- Record screen frames plus the actions (clicks, keys, URLs) for up to 10 minutes.
- Send frames and action log to the model and ask for a draft skill with steps and
  checks. Mark it a draft. A human edits it.
- Redact password fields and keystrokes typed into them before storing.

### 3.9 Multi-Bot and group chats
- A message table with sender, target and thread. Delivering a message to a dormant
  Bot enqueues a wake-up turn.
- Group chat is a thread with 2 to 6 member Bots and `@mention` routing.
- Rule that works: one owner per stage to avoid duplicated work.
- Cap fan-out and depth to avoid runaway Bot-to-Bot loops.

### 3.10 Approvals and Auto Review
- Classify every tool action by risk (read, write, send, pay, delete, run local
  command). Reads pass; the rest hit a policy engine.
- Policy result: allow, ask, or deny, with user-created rules ("always allow this
  read-only report").
- Auto Review: a second, independent model call that sees the proposed action and
  the recent context and returns approve, ask or block, catching prompt injection
  and out-of-scope actions.
- Remember the limit Grok Bot's docs admit: an approval controls a proposed action,
  not work already done. Build dry-run and undo where you can; they are Grok Bot's
  main gaps.

### 3.11 Security
- Isolation: one VM per org at minimum; per-Bot isolation if you want a real
  boundary (Grok Bot does not).
- Egress allowlists at the VM network layer.
- Treat all web content as untrusted; fence tool output before it reaches the model.
- Attribute actions to the Bot in downstream logs where possible (Grok Bot logs as
  the human).
- Secrets: vault, short-lived tokens, never in the VM disk.
- Encrypted backups, deletion within a stated time, an audit table that is
  append-only.

### 3.12 Clients and identity
- Web first (chat, desktop viewer, approvals). Desktop and iOS wrappers later.
- Auth with an OIDC/SSO provider; SCIM only when the first enterprise asks.
- Streams: SSE for chat, WebRTC or VNC websocket for the desktop.

### 3.13 Observability
- Trace every turn (model calls, tools, tokens, cost). Keep per-tool-call action
  records and export via OpenTelemetry.
- Quotas: weekly token allowance per user, overage metering.

---

## 4. Build order (minimum first, then upgrade)

| Phase | Goal | Deliverable | Rough effort |
|---|---|---|---|
| 0 | One Bot, chat, tools | Agent loop, 3 to 5 connectors, streaming chat | 1 to 2 weeks |
| 1 | Approvals | Risk classifier, approve/deny UI, resume-after-approval | 1 week |
| 2 | Computer | Per-org container with Chrome, Playwright control, live view, human takeover | 2 to 4 weeks |
| 3 | Persistence | Disk, snapshots, memory, skills, `/workspace` | 2 weeks |
| 4 | Automation | Routines on schedule and events, run history, test run | 2 weeks |
| 5 | Teams of Bots | Bot messaging, group chats, ownership rule, caps | 2 weeks |
| 6 | Hardening | microVM isolation, egress policy, Auto Review, audit, quotas | 4+ weeks |
| 7 | Teach by demo | Recording, redaction, draft skill generator | 2 weeks |

A credible demo is phases 0 to 2. The gap between demo and the product xAI sells is
phase 6: safe multi-tenancy for a machine that holds real logins.

---

## 5. What Darex already has, and what it lacks

Mapped from `AGENTS.md`, `BUILD_STATE.md` and the gap trackers.

| Part | Darex today | Gap |
|---|---|---|
| Agent loop | TrueForge in-process engine and sidecar, turn caps, output-token cap | None |
| Connectors | 62 tool executors, MCP bridge, Nango OAuth vault, honest `connected:false` | Few real OAuth client IDs (human blocker) |
| Approvals | Plan card, approve/edit/cancel, autonomy tiers, resume-after-approval | Auto Review model not present |
| Multi-agent | Crew workflow (manager plus 3 specialists), Ask AI Team mode in progress | No Bot-to-Bot wake-up messaging or group-chat view |
| Memory | Org brain with hybrid vector search, revisions | Per-employee memory scope is still spec |
| Skills | `/api/skills`, runtime gating, allowlist sync | No slash picker confirmed |
| Routines | Temporal workflows, periodic sweeps | No user-facing routine builder with test run |
| Tenancy and audit | RLS, scoped clients, audit table and UI | Migration apply pending; DSR UI open |
| **Agent Computer** | **None** | **Entire phase 2 to 3** |
| **Browser control and takeover** | **None** | **Entire phase 2** |
| Teach by demo | None | Phase 7 |
| Desktop and iOS apps | Web only | Later |

**Shortest path for Darex to get most of the value:** add one thing, a
sandboxed browser tool. Expose it as another tool in the existing executor and MCP
bridge, mark it write-class so it goes through the current approval plan card, and
keep it off unless no connector exists. That reuses the loop, approvals, tenancy
and audit already built, and skips rebuilding phases 0, 1, 4 and most of 5.

Suggested first slice:
1. Per-org container (Chrome plus Playwright) started on demand, stopped when idle.
2. Tool `browser_task` with actions: open, read page text, click, type, screenshot.
3. Read-only by default; any form submit goes to the approval card.
4. Live viewer and takeover in the dashboard.
5. Egress allowlist, and redaction of anything typed into password fields.

---

## 6. Risks to plan for from day one

- **Blast radius.** A machine with real logins is the crown jewel. Do not share one
  VM across unrelated tenants or Bots you do not trust.
- **Prompt injection** from web pages. Fence output, review risky actions, restrict
  egress.
- **Cost.** VMs plus vision-model screenshots are expensive; cache, snapshot,
  suspend, and meter.
- **Reliability.** Sites change, sessions expire, CAPTCHAs appear. Design for
  handoff to a human, not for beating them.
- **Legal and terms of service.** Automating logged-in sessions may breach a site's
  terms. Prefer official APIs, and keep a human in the loop.
- **Accountability.** Log which actions the Bot took, separate from the human.

---

## 7. Sources for this note

xAI docs and launch post, plus third-party reviews listed in
[09-sources.md](09-sources.md). Items labelled Inferred are my design reasoning,
not xAI statements.

Added in section 0:
- [How Grok Bot works: VM, host, gateway, agents (teardown gist)](https://gist.github.com/wtfsayo/b80f74f4f64d18ced8c84502a23148fe) — unofficial, unverified
- [What we've learned building cloud agents (Cursor)](https://cursor.com/blog/cloud-agent-lessons)
- [How we set up our cloud agent environment (Cursor)](https://cursor.com/blog/cloud-agent-environment)
- [Cursor agents can now control their own computers](https://cursor.com/blog/agent-computer-use)
- [Official Grok Bot breakdown (Vellum)](https://www.vellum.ai/blog/official-grok-bot-breakdown)
- [Open-source Grok Bot alternatives (OpenAlternative)](https://openalternative.co/alternatives/grok-bot)
- [OpenGrokBot on GitHub](https://github.com/wolfqing/OpenGrokBot)
- [E2B](https://e2b.dev/) and [E2B vs Daytona (ZenML)](https://www.zenml.io/blog/e2b-vs-daytona)
- [How to sandbox AI agents in 2026](https://manveerc.substack.com/p/ai-agent-sandboxing-guide)

Not read in full: the Cursor computer-use post, the sandbox comparison articles
beyond their summaries, and the code of every open-source project.
