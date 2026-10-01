# DareXAI One vs everyone else, in plain words

> Written 2026-10-01. Source: `how-we-are-different.md`, `BUILD_STATE.md`, the
> competitor report in `docs/new-109-pg-plan/competitors/`, the Grok Bot notes
> in `docs/grok-bot/` and the credit model in `docs/new-109-pg-plan/payment/`. No code paths
> in this file on purpose. It says what we built, what others built, and where
> we are different. Anything not proven live is marked **not proven yet**.

---

## 1. The short version

Every other company does **one job**. We built **one whole team on one shared
brain**.

- Sales bots only find and email leads.
- Support bots only answer customers.
- Automation tools only run "if this, then that" scripts.
- Memory tools only remember things. They do no work.

DareXAI One puts a **Growth employee, a Customer employee and an Operations
employee** (plus specialists) in one workspace. They share one memory and one
set of connected tools. They do real work, ask a human before anything risky,
and keep working even when a provider goes down. You talk to all of them from
one **Ask AI chat**.

---

## 1A. Our position: we run company operations on your behalf

We do not sell a tool you operate. We sell **the operations of your company,
done for you**. Growth, Customer and Operations work happens on its own, every
day, without you writing prompts or checking each step.

**What "automatic" means here**

- **It starts itself.** Morning triage at 9 AM, lead search every day, buying
  signals every 4 hours, replies the moment a customer writes, reminders when a
  rep is slow. Nobody has to ask.

- **No middleman to translate.** You do not need a developer, a consultant or
  a workflow builder. Employees arrive ready, and the chat understands plain
  requests.

- **It finishes the job.** It changes the real system: refunds, calendar, CRM,
  WhatsApp, email. It does not hand you a draft and stop.

- **It keeps going.** Durable runs survive restarts and provider outages.

**What you see: the high-level view, not the details**

- A **two-minute brief** each morning in Slack and WhatsApp.
- A **unified inbox** where only real decisions show up, as one-click cards.
- A **home briefing**, **ROI and cost views**, and the **Company Brain** page.
- An **audit log** behind all of it, so detail is there when you want it.

**Where it is not fully automatic, on purpose.** Anything that cannot be undone
always asks a person first, and a refund above the set limit goes to a manager.
Low-confidence replies wait for the owner. This is the safety that makes
handing over operations reasonable. You set how much freedom each employee has.

---

## 2. Us vs the other "brains" (memory and knowledge products)

Some products sell only the brain: a place where an AI stores what it learned.
Examples are Mem0, Zep (Graphiti), Letta and Cognee. Other products sell an
"answers from your documents" layer on top of a help desk.

A brain alone does not do anything. Someone still has to build the employees,
connect the tools, add approvals and keep it running. We built the brain **and
the workers that use it**.

| Question | Memory-only products | Document-answer overlays | DareXAI One |
|---|---|---|---|
| Stores what the AI learned | Yes, that is all they do | Partly, from docs only | Yes, from conversations, deals, tickets and docs |
| Uses more than one memory method | Usually one | Usually one | **Three together**: database search, a knowledge graph and agent memory. A slow one never blocks the answer |
| Keeps each customer company separate | You build that yourself | Varies | **Built in.** Each workspace has its own memory and its own data wall |
| Forgets stale facts | Some do, some do not | Rarely | **Yes.** Old facts lose rank, and conflicting facts go to a human to review |
| Each employee learns only its own area | No | No | **Yes.** A sales employee does not absorb support secrets |
| Shows what the AI knows | Developer dashboards | Rarely | **Company Brain page** for normal users |
| Cites its sources | Rarely | Sometimes | **Yes.** Answers point back to the real record |
| Takes action on what it knows | **No** | **No** | **Yes.** Refunds, calendar moves, CRM updates, WhatsApp replies |
| Erases a person's data on request | You build it | You build it | **Yes.** Export and delete jobs for privacy requests. The knowledge graph part is **not covered yet** |

**In one line:** others sell the brain. We sell the brain **and** the staff.

---

## 3. Us vs the other AI employee and support companies

Prices are from our own competitor research. They are public or procurement
estimates and can change.

| Company | What they do | What it costs | What they do not do | What we do instead |
|---|---|---|---|---|
| **11x** (Alice, Julian) | Outbound sales and inbound rep | About $45,000 to $60,000 a year to start. Often $120,000+ with more workers | Their workers do not talk to each other. No internal operations. No refunds, no calendar, no data cleaning | Growth, Customer and Operations share one brain. From $49 a month |
| **Artisan** (Ava) | Outbound email | About $250 to $600 a month entry, $2,000+ for real use. Credits run out fast | Email only. No WhatsApp. No refunds. No safety ladder | Email, WhatsApp, refunds, calendar and approvals in one product |
| **Lindy** | Personal assistant for one person's inbox | $30 to $100 per user a month plus credits | Built for one person, not a company. Asks in loose chat bubbles | Built for a whole company, with a clear one-click decision card |
| **Salesforce Agentforce** | AI inside Salesforce | About $2 per conversation, or about $0.10 per action | Only useful if you live in Salesforce. Needs admins and months of setup | Works with HubSpot, Zoho, Google, Slack, WhatsApp and more. Connect in minutes |
| **Sierra** | Support for big enterprises | $150,000 to $500,000+ a year plus setup fees | Support only. Will not serve small and mid companies. 3 to 6 months to launch | Support plus sales plus operations, for growing companies |
| **Decagon** | Support for tech scaleups | $50,000 a year base plus usage. Median deal about $430,000 | Support only. Costs money, never makes money | Whole workforce from $49 a month. Growth employee finds revenue |
| **Ada** | Support automation | About $70,000 a year median | Stays inside support. Cannot touch sales or operations | One brain across all three |
| **Yellow.ai** | Chat and voice bots | $0.99 per resolution, $50,000+ a year for enterprise | Old rule-tree roots. Needs partners to set up | Built on modern AI agents from the start |
| **Intercom Fin** | Support inside Intercom | Per seat fee **plus** $0.99 per resolved chat | Lives only inside Intercom. Waits for messages | Connects to outside tools. Growth employee starts conversations |
| **Moveworks** | Internal IT and HR help | About $130,000 a year median | Employees only. Cannot talk to customers or sell | Works for customers, leads and internal operations |
| **Eesel** | Answer drafts on top of a help desk | $0.40 per ticket, $239+ a month | Drafts only. Cannot change records or run actions | Takes the action, not just the draft |
| **Cassidy** | Build-it-yourself AI workflows | $500 to $2,500 a month | You build and test every prompt. Workflows fail silently on timeouts | Ready-made employees on day one. Durable runs that recover |
| **Regie** | Sales email | $180 to $499 per user a month, 5 to 10 seat minimum | Stops at outbound email | Whole team, credits you can see |
| **Sybill** | Call notes and CRM updates | $30 to $108 per user a month | Logs what happened. Does not do the work | Does the work |
| **Attention** | Live coaching for sales reps | About $1,200 to $3,000 per rep a year | Helps a human. Does not replace the manual work | Does the work itself |
| **Bland** | Voice calling infrastructure | $0.11 to $0.14 a minute plus up to $499 a month | Developer tool. No company memory | Finished product for business users |
| **Clay** | Lead data spreadsheet | $185 a month and up | You build every formula and column | The employee hunts leads by itself |
| **CrewAI** | Code framework for agents | $20,000 to $80,000 a year for enterprise | Needs engineers. You write every tool | Ready for business operators, tools already connected |
| **Zapier and Make** | "If this, then that" automation | $20 to $100 a month, AI steps cost 5 to 20 tasks | Breaks on messy input. No company memory | Reasons through messy input. Remembers |
| **Devin** (Cognition) | One coding agent | $500 a month plus usage | Code only | Different job: we run the business, not the codebase |

**Our price:** **$49 a month for 10,000 credits, $99 a month for 30,000
credits**, then a custom Enterprise plan (section 6). No per-seat tax, no
per-reply fee, no six-figure contract.

---

## 3A. Us vs Grok Bot (the closest new rival)

**What it is.** Grok Bot (xAI, beta, announced 2026-08-11) lets you create
named, always-on AI teammates. Each one works on a cloud computer with a
browser and terminal, signs into your tools, and finishes jobs, coming back
only for approval. It runs through Cursor's plans and SuperGrok. It is a
strong idea, and it is close to ours: named employees, chat as the front door,
approval before risky actions, teams of bots.

Everything about Grok Bot here comes from xAI's announcement, xAI docs and
outside reviews. **We have not run it.** It is an early beta, so treat this as
direction, not a verdict.

| Question | Grok Bot | DareXAI One |
|---|---|---|
| Who is it for | Anyone who wants a general helper. You decide the job | Businesses. Growth, Customer and Operations employees ready on day one |
| How it does work | Connectors first. Where none exists, it clicks through a real browser like a person | Direct, checked connections to business tools. It says plainly when one is not connected |
| Memory | **Per bot.** Bots share files and logins, not one company brain | **One shared company brain** with role-scoped learning and a page to see it |
| Answers from your company rules | No grounding in a company knowledge base. Early users saw made-up answers | Answers from your own policies with citations. Says so when it does not know |
| Separation between bots | **One shared computer for all bots.** Shared logins and files. Not a security boundary | Each employee has its own tool list. Picking one never widens its powers. Each company is walled off at the database |
| Approvals | Allow once, allow by rule, deny. Reviewers call them advisory, and a test run does real work | Four-level autonomy ladder. Anything irreversible always asks. One-click decision cards |
| Who did it, in the logs | Actions look like the human user did them | Every change is attributed to the employee that made it, in an append-only audit log |
| Dry run and confidence | None reported | Low-confidence replies wait for the owner |
| Undoing a mistake | Sent emails and CRM writes cannot be recalled | Refund limits, address changes only before shipping, approval above limits |
| If a provider goes down | Not described | Durable runs resume. Outgoing work queues and replays after an outage |
| WhatsApp | Not a headline feature | Built in: QR or official API, several numbers, voice notes, hand-off to a human |
| Compliance | No SOC 2, ISO 27001, GDPR or HIPAA claims reported | Privacy export and delete jobs. Knowledge-graph part not covered yet |
| Price | Bundled in plans: Cursor $20 to $200 a month, $120 a seat for Teams, SuperGrok $30 to about $99 promo. Weekly allowance, **number not published**, overage at model rates | **$49 for 10,000 credits or $99 for 30,000.** You can see what each action costs |
| Status | Early beta. Some users could not sign in on day one. Team Bots has no published price | Built and tested on our dev stack. Gaps listed in section 7 |

**Where Grok Bot is better, honestly:**

- It can use **any website**, even one with no connection, because it drives a
  real browser. We depend on connectors.

- It has a real cloud computer with files, a terminal and a desktop you can watch.
- **Watch me once:** record your screen and it drafts a skill from it.
- Desktop and iPhone apps, and a big company behind it.

**Why we still win for a business:** the shared company brain, grounded
answers, per-employee limits, real approvals with real attribution, WhatsApp,
and a price you can read before you buy. Grok Bot gives you a smart assistant
on a computer. We give you a department that already knows how your company
works.

**Also in this group:** Lindy, Cassidy and CrewAI (table above) are the other
"build your own AI helper" products. They share the same gaps: no shared
company brain, no ladder of approvals, and no durable runs.

---

## 4. Seven things nobody else does together

1. **One shared brain.** A cancellation reason found by Customer changes what
   Growth pitches and what Operations checks. Single-job tools cannot do this.
2. **Resolve, don't just reply.** Over 60 real actions change real systems:
   Stripe, Calendar, Shopify, HubSpot, Gmail, WhatsApp, Sheets and more.
3. **Autonomy ladder with approval.** Four levels. Anything that cannot be
   undone always asks a person first, through a one-click decision card.
4. **Durable work.** If a server restarts or a provider is down, the job still
   finishes. A promise like "I'll update you at 4 PM" still fires at 4 PM.
5. **Honest by design.** If a tool is not connected, the AI says so and shows
   a connect link. It never invents data. Empty screens never hide errors.
6. **Real multi-company safety.** Every company's data is walled off at the
   database level. The company comes from the login, never from what a user
   types.
7. **Simple, visible price.** $49 or $99 a month, paid in credits you can
   see. Priced against a human hire, not against a software seat.

---

## 5. Everything we built

### 5.1 Growth employee: finds and wins revenue

- **Lookalike finder.** Studies deals you already won and finds similar companies.
- **Market scout.** Searches every day for companies that fit your ideal customer and adds them to your CRM, with a daily cap.
- **Buying-signal radar.** Watches for funding, hiring and tech changes every 4 hours.
- **Website visitor identifier.** Spots a company visiting your site repeatedly, finds the right person to contact, and creates a lead.
- **Lost-deal reviver.** Wakes up leads that went quiet for 90+ days when fresh news about them appears.
- **"Why today?" reasoner.** Gives a two-sentence reason to reach out now.
- **Pre-meeting dossier.** Sends a one-page brief to Slack when a demo is booked.
- **Outreach drafter.** Writes a personal email. You approve or edit in one click, and it sends through Gmail.
- **Smart reply sorter.** Sorts replies into interested, objection, out of office or unsubscribe. Updates the deal stage and alerts the rep.
- **Voice and style learner.** When you reject a lead as "wrong fit", it saves that as a rule for next time.

### 5.2 Customer employee: resolves, 24/7

- **Fast replies on every channel.** WhatsApp and web chat get an instant acknowledgement, then the real answer follows.
- **Account profiler.** Knows the customer's real revenue (Stripe), lifecycle stage (HubSpot) and open tickets (Zendesk). Escalates VIPs.
- **Company rulebook expert.** Answers from your own policies with citations. Refund answers use the customer's real last charge.
- **Self-service rescheduling.** Moves the real calendar event, tells attendees, logs it in HubSpot.
- **Automated refunds.** Checks the real amount and age. Refunds inside 14 days and $100 on its own. Asks a manager above that.
- **Order address fixer.** Changes a Shopify address only while the order has not shipped.
- **Never-forgotten promises.** Spots "I'll get back to you at 4 PM" and sets a timer that survives restarts.
- **Manager approval cards.** Policy exceptions arrive as one-click cards, also pushed to Slack.
- **Angry-customer radar.** Tracks mood across a conversation. Sends one Slack alert a day.
- **Knowledge-gap finder.** Groups the questions it could not answer into a ranked list of missing policies to write.

### 5.3 Operations employee: the daily COO

- **9 AM morning triage** in your own timezone.
- **Executive standup brief.** Two-minute summary to Slack and WhatsApp.
- **Expected-vs-actual checker.** Audits your operating standards all day.
- **Slow-rep reminder.** Nudges at 3 hours. Tells the manager at 5.
- **Workload balancer.** Gives new leads to the least busy rep and respects quiet hours.
- **Duplicate cleaner.** Merges obvious duplicates. Sends unsure ones to a person.
- **Missing-info filler.** Pulls phone and job title from email signatures. Fills blanks only, never overwrites.
- **Calendar conflict fixer.** Adds Meet links, flags double-bookings, pings guests who have not confirmed.
- **Stuck-deal unblocker.** Drafts a nudge for deals idle 10+ days.
- **Outage safety shield.** During a provider outage it holds outgoing work and sends it once the provider is back.

### 5.4 The wider team and ready-made packs

- **More roles:** Executive, Customer Support, Sales and Lead Gen, Marketing and Analytics, Research, Finance, plus custom employees you define.
- **Each employee has its own tool list, personality and memory.** Picking an employee never gives it extra powers.
- **Industry packs** install a whole team at once. There is a general business pack (sales, support, operations) and a **real estate brokerage pack** (buyer lead handling, showings, listings) with local regulation and charge helpers.
- **Day-one setup.** A new workspace starts with useful employees, not an empty screen.

### 5.5 Ask AI chat: the front door

- **Plan, confirm, run.** Simple asks get answered straight away. Big asks become a plan card you can approve, edit or reject. Independent steps run at the same time.
- **Pick who answers.** Three modes: **Auto** (it chooses and tells you why), **Pick one** (locked to one employee, with a hand-off if you ask something outside their job) and **Team** (a crew of up to 3). Type `@Name` to direct one message.
- **Team from chat.** A manager combines the specialists' reports into one answer.
- **Plans survive.** Close the tab and come back. Finished steps do not run twice. Cancel really stops the work. Editing a plan needs approval again.
- **Connect a tool from the chat** and the answer uses the best tool you have.
- **Readable results.** Search results show inline. A paused step says what it is waiting for.
- **Cost controls.** A cap on answer length, repeated identical reads reused, no filler in replies, empty prompts rejected.

### 5.6 Shared brain and memory

- **Company Brain page** shows what the AI has learned about your business.
- **Three memory methods working together.** Database search first, a knowledge graph, and agent memory. Results merge with the real records cited first. A slow method never delays the answer.
- **One memory space per company**, tuned to business talk: preferences, budgets, deadlines, promises, objections. Small talk is ignored.
- **Stays fresh.** Old facts rank lower. Facts that disagree go to a person.
- **Role-scoped learning.** Each employee only remembers what its role should.
- **Safe operator tools** to browse databases, memory, logs and status. Read-only by design.

### 5.7 Connected tools

About **60 to 139 actions** (the count depends on how you group them) across:

- **Google:** Gmail, Calendar, Drive, Docs, Sheets, Slides, Forms, Tasks, Meet, Chat, Contacts, Ads, Analytics, Search Console, Business Profile
- **Microsoft:** Outlook, Calendar
- **CRM:** HubSpot, Salesforce, Zoho
- **Money:** Stripe, Razorpay, QuickBooks
- **Commerce and support:** Shopify, Zendesk, Intercom
- **Team and docs:** Slack, Notion, GitHub
- **Messaging and social:** Twilio, LinkedIn, Meta Ads
- **Signing:** DocuSign, Leegality
- **Research:** Apollo, web search and page reading
- **Data and files:** read-only database questions, a code sandbox, file actions locked to the workspace

Safety built around tools: a connection service handles logins, every tool says
honestly when it is not connected, tool output is cleaned before the AI sees
it, outbound web links are checked so the AI cannot be tricked into hitting
internal systems, each provider has rate limits, and a circuit breaker stops
repeated failures. The same tools are also offered to the agent runtime.

### 5.8 WhatsApp, built in

- **Two ways to connect:** scan a QR code, or use the official Meta API with "Continue with Facebook" sign-up. A third provider is a small addition later.
- **Several numbers per workspace**, QR and official mixed, each with its own settings. A customer who texts two numbers gets two separate threads.
- **Auto-reply modes:** full AI employee, simple AI from your own instructions, a fixed message, or off.
- **Who and when:** everyone, an allow list or a block list. Every message or only new chats. Business hours in your timezone with an away message.
- **Human handoff:** when a teammate replies, the AI pauses for the time you choose.
- **Choose which employee answers**, or let it pick a customer or support role.
- **Voice notes and images** are transcribed or described, then answered.
- **24-hour window handling** for the official API, with an optional fallback template message.
- **Waiting note** when the AI is unsure and holds its answer for the owner.
- **Security:** Meta tokens are encrypted at rest, never sent to the browser, and webhooks need secrets.
- **Status:** sign-in to reply verified on the dev stack. **Real phone scan and real Meta number: not proven yet.**

### 5.9 Login, accounts and access

- Email sign-up, login, forgot and reset password.
- Terms acceptance stored at sign-up.
- Sessions that can be revoked.
- Social login and enterprise single sign-on.
- Two-step login with an authenticator app (MFA).
- Invite links with roles: owner, admin, member, billing, auditor.
- Workspace switcher and "create a workspace".
- Failed logins are recorded.
- Money actions such as refunds and payments check the user's role.

### 5.10 Trust, safety and governance

- **Autonomy ladder.** Four tiers, scored by how reversible, how wide the impact and how confident the AI is. Irreversible always asks.
- **Confidence gate.** Low-confidence customer replies wait for the owner.
- **Audit log.** Append-only record of every change, including billing.
- **Privacy requests.** Export and delete jobs for a person's data, checked after deletion.
- **Untrusted content handling** and **quiet hours**.
- **Never fabricates.** Empty screens, errors and unconnected tools say what is true.
- **Company data walls** in the database, with a low-privilege runtime role and query time limits.
- **Spend guard.** Per-company usage meters, soft and hard limits, and a circuit breaker on model spend.

### 5.11 The business platform around it

- **Billing:** plans, seats, failed-payment handling, Stripe and Razorpay, billing history.
- **Platform admin console** on a separate database login: drill into a company, kill switch, plan overrides, feature flags, and support login-as that the owner must allow.
- **Company lifecycle:** suspend, soft delete, scheduled purge.
- **Rate limits per company**, an observability page and alert delivery.
- **Analytics:** ROI and cost-health views, a home briefing, and one inbox with deep links.
- **Skills and packs** you can install.
- **Self-hosted stack:** database, durable workflow engine, login service, tracing, model gateway, agent runtime, memory engines and WhatsApp service, with deploy scripts that stop early if a secret is missing.

---

## 6. Pricing and credits

### 6.1 The plans

| | **Starter** | **Pro** | **Enterprise** |
|---|---|---|---|
| Price | **$49 a month** | **$99 a month** | Custom |
| Credits each month | **10,000** | **30,000** | Agreed with you |
| Cost per 1,000 credits | $4.90 | $3.30 | Volume price |
| Who it is for | One small team trying the workforce | A team running all three employees every day | Large teams, many numbers, strict security and audit needs |

Enterprise is a quote. It can include a pooled credit amount, single sign-on,
a support agreement, custom employees and packs, and help with setup. The
exact list is agreed per customer.

### 6.2 What a credit is (credits explained)

A credit is our unit for **one piece of work**. One credit is about one simple
action by an employee. Bigger jobs use more credits. You are never charged for
a job that could not run.

| What the employee does | Credits |
|---|---|
| Ask AI simple question | 2 |
| Ask AI builds a plan | 5 |
| Each step of an approved plan that changes something | 3 |
| Reply to one WhatsApp message | 3 |
| Web search | 5 |
| Deep web research job | 20 |
| Wake up one stale lead with a drafted message | 8 |
| Morning triage of inbox, calendar and CRM | 15 |
| A team run (manager plus three employees) | 35 |
| Read in a document of about 5 pages | 1 |
| Idle background checks with nothing new | 0 |

**Rules that keep it fair:**

- **Failures are free.** If a tool is not connected or a call fails, it costs 0 credits.
- **Live meter.** Credits come off as work happens, per company, and you can see the balance.
- **Warning first, then stop.** Soft limit warns you. Hard limit pauses work and tells the owner, instead of failing in silence.
- **Top up anytime.** Extra credit packs can be bought when you run low, with optional auto top-up.
- **Unused credits:** our earlier plan allowed a 60-day rollover on top-ups. Confirm whether this applies to the monthly allowance.

### 6.3 What this means in practice

At the rates above, 10,000 credits is roughly 3,300 plan steps, or 3,300
WhatsApp replies, or 5,000 simple questions. 30,000 credits is three times
that. A typical team with three employees used about 16,500 credits a month in
our earlier estimate, which fits inside Pro.

### 6.4 Price against the others

| Product | What you pay | What you get |
|---|---|---|
| **DareXAI One Starter** | $49 a month | 10,000 credits, all employees, one shared brain |
| **DareXAI One Pro** | $99 a month | 30,000 credits |
| Grok Bot | $20 to $200 a month, inside Cursor or SuperGrok | One weekly allowance, size not published. Overage at model rates |
| Lindy | $30 to $100 per user, plus credits | One person's assistant |
| Intercom Fin | $29 to $132 per seat plus $0.99 per resolution | Support only |
| Eesel | From $239 a month plus $0.40 per ticket | Draft answers |
| Zapier | $20 to $100, AI steps cost 5 to 20 tasks | Scripts, no memory |
| 11x | $3,750 to $5,000 a month, annual | One sales worker |
| Decagon and Sierra | $50,000 to $500,000+ a year | Support only |

### 6.5 Open points to settle before we publish

- **Margin check.** Our earlier cost model was built for 25,000 credits at $299 a month (old plan). At **$99 for 30,000 credits**, a customer who uses every credit on the heaviest reasoning work could cost us close to the price. A typical customer uses about 55 to 65 percent and stays healthy. Decide whether to cap the heaviest actions or price them higher.
- **The older plan files** still show the old $99, $299 and $799 plans. Update them so there is one price list.
- **What each plan includes** besides credits (seats, WhatsApp numbers, employees). This doc assumes the same product on every plan and only credits differ. Confirm.

---

## 7. Where we are honestly not finished

| Area | Status |
|---|---|
| Growth, Customer, Operations (30 features) | Built |
| Ask AI plan, team and mode selector | Built and tested live |
| WhatsApp | Built, verified on dev stack. **Not proven with a real phone or real Meta number** |
| Memory engines | Built. **Privacy delete and export do not yet cover the knowledge graph** |
| Business platform tables (migrations 116 to 122) | Built in code. **Were not applied to the live database when last noted** |
| Company purge | Partial. Unknown workflow ids and outside vector stores are skipped |
| Needs a human | OAuth client IDs (HubSpot, Stripe, Notion, Slack, Shopify, Zendesk, Intercom, Microsoft, Salesforce), the Nango public key, Meta token rotation, a licensed property-listing data client, payment keys and price IDs, admin DNS |

Competitor numbers come from our own research, not from the competitors.
Grok Bot facts come from xAI's docs and outside reviews. We have not run it.
Check everything before quoting outside the company.
