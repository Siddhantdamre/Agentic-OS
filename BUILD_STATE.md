# Darex Build State

## Ask your numbers (core)

- New `services/workflows/src/bi/`: the pure core of "Ask your numbers". Not wired to chat or a screen yet.
- `numbers.ts` pulls every number, rupee amount (lakh, crore, k, Indian grouping), percentage and date out of an answer and refuses the answer unless each one matches a value that was actually computed, with the right unit. `metrics.ts` holds 7 read-only metric queries over money owed and enquiries, each forced to one workspace and checked by the existing SQL guard. `answer.ts` builds the plain answer with its working shown, says "I can't compute that yet" instead of guessing, and lowers confidence when the question has a time word it did not parse.
- Verified: 21 tests. Gold set 40 of 40 (34 answered, 6 correctly refused); 20 of 20 deliberately wrong answers caught; 0 of 20 correct answers flagged.
- Honest limit: the right/wrong answers were written by the same author as the verifier, so 100% is a regression guard, not an independent accuracy figure. Blind spots: a real number attached to the wrong label passes if both values are supplied; spelled-out numbers and "up versus down" are not checked; question routing is keyword-based. Queries must run through the workspace-scoped client, not the model SQL role.

## Cited research pipeline (core)

- New `services/workflows/src/research/`: the pure core of cited outside-world research (market, competitors, regulation). Not wired to a tool yet; the search, page fetch and model are injected.
- Plain rules: a factual sentence is kept only if a source page actually contains the quoted support and every figure in the sentence; anything still unsupported after one repair attempt is removed and listed as "could not verify", never kept. Two sources that disagree are both shown. Unsafe addresses (localhost, private ranges, metadata) are never fetched. Page text is treated as data, never as instructions. Budgets cap queries, pages and characters.
- Verified: 14 tests including a hallucinated number removed, a repaired draft, disagreeing sources and blocked addresses.
- Known limits: fact detection is a heuristic (a purely qualitative claim is not checked); a real quote taken out of context passes; the injected `fetchText` must use the safe fetcher (`safeGet`) because DNS and redirects are not checked here; nothing run against a live search or model.

## Safety rules for governed self-improvement

- New `services/workflows/src/improve/`: the pure rules for letting an AI employee propose a change to itself safely. Nothing is wired into a running agent yet and nothing is stored in the database (in-memory registry only).
- `guard.ts` refuses a candidate that adds a tool, raises the autonomy stage, drops an approval requirement or deletes a protected clause (approval before sending, never promise refunds, escalate complaints). `gate.ts` promotes only on a held-out set with enough cases (10 total, 5 per topic), no topic losing, a real overall gain and no new invented number or over-promise. `rollout.ts` moves draft to shadow to 10% canary to active one step at a time, needs a named person for canary and active, and recommends rollback on an approval drop, failed actions or more complaints. `propose.ts` picks the ONE best-evidenced failure cluster and writes the owner a plain note.
- Verified: 16 tests including four attacks (sneaked-in tool, deleted approval clause, win on the author's own data, overall win that loses on payments).
- Known limits: protected clauses are phrase matches, so a reworded deletion can slip past (human diff review stays essential); `heldOut` is a trusted flag; margins and rollback thresholds are untuned starting values; the direction of `autonomyStage` versus `AutonomyTier` (1-4) in `autonomy.ts` must be checked before wiring.

## Quality tiers for the model router

- New `model-tier.ts`: picks fast / standard / deep per turn. Anything touching money, refunds, complaints, tax, legal or contracts (English, Hinglish and Devanagari) goes to the deep model, because a wrong answer there costs a person; analysis, long messages and attachments go to standard; plain lookups stay fast. When a workspace's model budget is used up a money question steps down one level and says so, never silently.
- `infra/litellm/config.yaml` gains `darex-standard` and `darex-deep` aliases (Anthropic first, OpenAI second) with failover down to `darex-default`. `runLocalTurn` leads with the matching alias only when `DAREX_TIER_ROUTING=1`; off by default, so behaviour is unchanged until the keys exist.
- Verified: 8 tests, tsc clean. NOT verified: any real model answer (no keys here). The OpenAI model names in the config (`gpt-5`, `gpt-5-mini`) are placeholders to check against your account. The per-workspace budget is not yet wired into `deepAllowed` (always true for now).

## Background-check heartbeat and health note

- Worker now leaves a heartbeat per workspace and activity (`agent_activity_health`, migration 213, row-level security forced): when it last finished, when it last failed and a short error cleaned of e-mail addresses and long numbers. It is a Temporal activity interceptor (`activity-health.ts`) that only watches: results and original errors pass through unchanged, a failing recorder is swallowed, successes are written at most once a minute per workspace and activity.
- Why: the old sweep counters in `org_model_spend` were never incremented, so a dead sweep looked the same as a quiet one.
- The Agent Health board shows a note when a background check failed on its last run, or has not run for over a day after running before. Nothing recorded yet is not reported as a problem.
- Model-written SQL may read the table (no customer detail in it). Listed as retained (not erased) by a data-erasure request, since it holds no personal data; the erasure coverage test required that decision.
- Verified: 6 interceptor tests, 24 health-rule tests, 5 database tests as the app role (including no leak between workspaces), RLS coverage 11/11, database-query 41/41, tsc clean.
- NOT verified: the interceptor inside a real worker. There is no Temporal server in the sandbox, so wiring (`interceptors.activityInbound` in `worker.ts`) is checked by types only. First thing to confirm on a machine with the full stack.

## Agent health: is each AI employee doing its job? (2026-10-16)

- Question asked: are all the AI employees working rightly? Reading the code showed there was no screen that could answer it: the Health page showed workspace-wide metrics, and nothing said which employee was idle, stuck behind a person, failing, or being rewritten by the owner.
- New panel "Your AI team, one by one" at the top of the Health page, one line per employee with a status in words and the reason: Needs attention (approvals waiting more than 2 days, or 3+ and 20% of approved actions failing to run, the same thresholds the Trust page uses), Keep an eye on it (nothing done in 7 days or never, or you rewrote 40% of its drafts, or turned down 30%, each only from 5 decisions up), Working well, Just started, Paused. Notes above the list name customer messages that failed to arrive (the unresolved webhook queue) and a switched-off team. Pure rules in `lib/agent-health.ts`, SQL in `lib/agent-health-query.ts` (reuses the Trust page's per-employee counts), route `GET /api/observability/agents`, component `AgentHealthPanel`.
- Found while checking it on the demo workspace: a brand-new employee with an approval waiting three days showed as "Just started", which hid the stuck work (fixed, test first); and the wording "waited more than 2 days" was wrong when only the oldest of two approvals was old, so it now says "2 approvals are waiting; the oldest for 3 days".
- Found while reading the code, not fixed here: `recordModelSpend` can count idle and busy sweep passes per day, but nothing passes the flag, so those counters are always 0 and no database signal says a sweep is alive. Next step: a worker-level activity heartbeat (not testable here, there is no workflow engine in the sandbox).
- Verified: 18 rule tests (the new-employee and wording cases failed first), 4 real-database tests as the application role (stuck, watch, paused, new; failed messages counted; another workspace's data never appears), 6 component tests (including: a reply that is not a team overview is shown as a failure, never as an empty team, which an existing page test caught), the full dashboard suite, and in a real browser the panel shows "Needs attention: 2 approvals are waiting; the oldest for 3 days" and "1 customer message failed to arrive".
- Not verified: against real production traffic, or that the thresholds suit real owners (they are starting values).

## Replay your week: final independent score and the last gaps (2026-10-16)

- The grader was frozen at commit `14e454e` and a second independent author, who never saw it, wrote 50 new cases for five more businesses (a phone-repair shop, a pet clinic, a wedding photographer, a home bakery, a yoga studio; `replay/cases-set-b.js`). **Final score on the frozen grader:** invented numbers or times 16 of 17 (94%), promises the owner did not make 8 of 10 (80%), hand-offs missed 6 of 8 (75%), wrong language 8 of 8 (100%), wrong facts with no number or promise 0 of 7. Of the 43 mistakes that contain a number, a time, a promise, a missed hand-off or the wrong language, 38 were caught (88%); of all 50 wrong drafts, 38 (76%). Right drafts wrongly flagged: 2 of 50 (4%); look-alike traps 5 of 5.
- Reading the three runs together: on the grader author's own set the score was 100%, on the first independent set 57% and 25% for the two hardest kinds, on the second 94% and 80%. The independent numbers are the honest ones; the first set is what the second one improved on.
- The 7 failures were all wording the rules did not list: a bare `400` written by the owner (so `Rs 400` looked invented), `4:30 baje`, `free of cost`, `wapas kar denge`, `non-refundable` and `isn't refundable` read as promises, `uske baad ... bata paayenge` and `check karke batayenge` as hand-offs. Fixed test-first (5 new tests); after the fixes all three sets score 100% on invented numbers, hand-offs and language, and 100%, 88%, 100% on promises (the one miss is a free offer stretched beyond what the owner offered), with 0, 1 and 0 false alarms. Those post-fix numbers are development data, not a new claim.
- What this says about the approach: every fix was a word list, and the next author will find words that are not on it. Rules are right as the first, cheap, model-independent layer (they catch the costly mistakes: a made-up price or time, a promise, a missed hand-off) but the long tail, and every wrong fact, needs a second layer where a model compares each claim with the owner's facts. That layer needs a model key and is not built.
- Verified: 37 grader tests, 602 workflows tests.

## Replay your week: what an independent set showed, and the fixes (2026-10-16)

- To test whether the first grader generalises, an independent author (a separate agent that never saw the grader, told to write drafts meant to fool a simple checker) wrote 40 new cases for four businesses that are not property: a dental clinic, a saree boutique, a coaching class and a caterer (`replay/cases-set-a.js`). The frozen first grader scored: invented numbers 8 of 14 (57%), promises 2 of 8 (25%), hand-offs 6 of 6, wrong language 6 of 6, wrong facts 0 of 6, and 5 of 40 right drafts wrongly flagged. The 100% on my own set did not hold up, which is the reason for the exercise.
- What it showed and the fixes (each test-first, 9 new tests): amounts said in words ("pachaas hazaar", "savaa lakh", "gyarah hazaar paanch sau", "seven hundred rupees", "डेढ़ हज़ार"); times said in words or with baje ("half past five", "quarter to eight", "saadhe saat baje"), compared with a time given as 5pm without mixing up am and pm; promises in other words ("make an exception", "zero interest", "paisa wapas mil jayega", "bina charge ke", "on the house", "I give you my word"), with Hindi negation read after the verb; hand-offs in other words ("she will ring you back", "main khud aapko phone karunga"); Hinglish read from what is missing as well as what is there; a reply in the language the owner used is not wrong; and a policy stated in the present tense ("follow-ups within 7 days are free") is not a promise but "we will refund" is.
- After the fixes, on that same set (now development data): invented 14 of 14, promises 7 of 8, hand-offs 6 of 6, language 6 of 6, wrong facts 0 of 6, 1 of 40 right drafts flagged. On the first set: all caught, 0 false alarms. Still missed by design: a promise stretched beyond what the owner said (the owner offered a free fall and pico, the draft also made stitching free); a wrong statement with no number or promise. The one remaining false alarm is a label disagreement: the author called an English reply to a Hinglish customer and owner "good"; the rule flags it and I think the rule is right.
- Verified: 32 grader tests, 601 workflow tests. Not yet tested: a third set written after this freeze (next), and real model drafts.

## Replay your week: the grader and a first simulation (2026-10-16)

- New `services/workflows/src/replay/grade.ts`: the comparison at the heart of "Replay your week". A customer message the owner already answered is replayed through the AI in a sandbox (nothing is sent) and the draft is graded against what the owner really said and the owner's own facts. Plain text rules, no model, so every model is judged the same way. It checks, in order of cost: an invented number or clock time (money read as `₹88,00,000`, `Rs 88 lakh`, `88 lac`, `1.2 crore`, `45k`, `₹९२ लाख`, times like `5pm`); a promise the owner did not make (refund, cashback, discount, waived fee, guarantee, free; each its own kind, and a policy the owner wrote down may be quoted with its condition but not promised outright); a hand-off missed (the owner said "let me call you" and the draft carried on); a reply in the wrong language (English to Hinglish or Hindi, or the reverse; flagged, not unsafe); and how close the draft is to the owner's own reply. It refuses to judge fewer than 10 cases, and each topic (price, availability, viewing, payment, complaint, other) needs 5 of its own before it can be called ready, so autonomy is earned per kind of question, not as one switch.
- `infra/harness/replay-sim.js` and `replay/cases.js`: 40 made-up customer messages (English, Hinglish, Hindi) each with the owner's real reply, one right draft and one realistic wrong draft; five stand-in "AI employees" (careful, hallucinating, over-promising, eager, English-only) replay them. First run before any tuning: invented numbers 16/16 caught, wrong language 6/6, hand-offs 6/6, promises 7/9, right drafts wrongly flagged 3 of 40. The misses were real: Hinglish drafts with few marker words read as English, and a refund policy in the facts allowed any refund promise. Both fixed test-first (3 new tests). After: 16/16, 6/6, 9/9, 6/6, 0 of 40 false alarms, 7 of 7 look-alike traps passed.
- Known blind spot, reported and not hidden: a wrong statement with no number and no promise in it ("it was sold last week") is not seen (0 of 3). Seeing it needs a model to compare claims with the facts.
- Caveat: those numbers are on data I wrote and then tuned against, so they show the rules work, not how they generalise. A second set written by an independent author who never saw the grader is the real test (next entry).
- Verified: 23 grader tests (written first; the first run failed to compile, the later additions failed before the fix), 600 of 600 workflow tests, tsc clean.

## A demo business to sign in to (2026-10-15)

- New `infra/harness/demo-seed.js` and `demo.js`: with the harness servers up, `HARNESS_SCRIPT=demo.js infra/harness/run-flows.sh` fills a labelled demo business through the product's own API (2 listings, 3 enquiries, money owed, 2 customer chats answered by the stand-in model) plus a viewing for tomorrow and two emails held for approval by the real gate, prints `DEMO READY` with the sign-in (`owner@demo.test`), and removes everything on Ctrl-C. `run-flows.sh` now takes `HARNESS_SCRIPT` and `HARNESS_ARGS` so the same servers can run any script (flows, soak, accessibility scan, demo) and sets a dead address for the sign-in service, as it already did for TrueForge, because a production start refuses to serve sign-in without one and falls back to its own database when nothing answers.
- Found while building it: the showings API refuses to book while no calendar is connected (right, it cannot know about conflicts), so the demo writes its viewing straight into the table; and signing in through the form needs `provisioning_completed_at` set, not a wizard step.
- Verified: a real browser signed in through the form and walked 17 screens (sign-up, sign-in, Home, Ask AI answer, Approvals with an approve, Inbox, Inquiries, Showings, Money owed, Trust, Autonomy, Connectors, Terms, two phone views); the approved email reached the fake Gmail exactly once.
- Seen on those screens and not changed: the owner's own Ask AI conversation also appears in the Inbox as a "Customer" thread, and Home shows "Some background features are running slowly" because the demo has no workflow engine or tracing service (it is the honest degraded banner).
- Not tried: a laptop. `run-flows.sh` is bash, so Windows needs WSL or Git Bash; the steps are in `RUN_ON_YOUR_MACHINE.md` section 5.

## A repeatable accessibility check (2026-10-15)

- New `infra/harness/a11y-scan.js`: opens every static page (40) in a real browser as a throwaway owner and runs axe-core (WCAG 2.1 A and AA); prints each failing element and exits 1 on any. It reuses the harness's seed and session cookie, finds Playwright through `PLAYWRIGHT_MODULE` and Chromium through `CHROMIUM_PATH`, so it is not tied to this machine. `axe-core` 4.13.0 is a dev dependency of the dashboard (an addition of one package; nothing in production changes).
- Why: the first scan (150 failing elements) was a one-off run from a scratch script; without a repeatable check the contrast and naming fixes would drift back as screens are added.
- Verified: 0 failing elements on 40 pages against the production build; the first run of the committed script caught one more failure (see the previous entry), so it does find things.
- Limits are written in the README: it cannot judge screen-reader flow or wording, does not reach pages that need an id, and does not open dialogs.

## Green buttons with white text meet the contrast minimum (2026-10-15)

- The accessibility scan of the harness found one more failure the first axe run did not reach: white 12 px bold text on `bg-emerald-600` is 3.8:1 (the minimum is 4.5). It showed only on the Connectors page once the gateway card is visible. The same pair is used on 9 buttons and badges in 7 files (brief, connectors, work items, plan card, two WhatsApp forms, the markdown reply); all are now `emerald-700` (hover `emerald-800`), 5.5:1 or better.
- Verified: the scan reports 0 failing elements on 40 pages after a production rebuild.

## Production dependency audit: 8 known vulnerabilities down to 2 (2026-10-15)

- `pnpm audit --prod` reported 8 known vulnerabilities (2 critical, 4 high, 2 low), all in packages pulled in by other packages. Six are closed with overrides in the root `package.json`, in the same style as the existing ones: `proxy-addr` (critical, IP spoofing through the forwarded-for list), `shell-quote` (critical, command injection through a line break), `source-map-js` (high, event-loop denial of service), `katex` (low), and `@modelcontextprotocol/sdk` raised from 1.29.0 to 1.32.1 (high, an OAuth client could send credentials to the wrong server; the transitive copies are forced up too).
- Verified: the audit now reports 2 (down from 8); `tsc` clean for both services; 577 of 577 workflow tests with the new MCP SDK; dashboard 1120 tests; production build; the 27 flows (118 checks) and the webhook check pass on the new build.
- Not fixed, on purpose: `braces` (high, a stack-exhaustion denial of service on deeply nested patterns) has no patched release anywhere, and `cookie` 0.4.0 inside the sign-in library (low) would need a major bump of a security-critical package; both are build- or parse-time, not reachable by a visitor. Both are listed here so the next audit does not rediscover them.

## The workflows build no longer needs a POSIX shell (2026-10-15)

- `pnpm build` in the workflows service ended with `mkdir -p dist/metrics && cp ...`, which does not exist in a Windows command prompt, so a clean checkout on a Windows machine failed at the last step of the build. It now runs `scripts/copy-assets.js`, plain Node, which creates the folder and copies `core-kpis.yaml` the same way on Windows, macOS and Linux.
- Verified: the script run on a throwaway copy copies the file byte for byte and is safe to run twice; `pnpm --filter @darex/workflows build` puts `dist/metrics/core-kpis.yaml` in place; 577 of 577 workflow tests.
- Not verified: an actual Windows machine. The change removes the one POSIX-only command found in the build scripts; `setup.bat` and `start.bat` exist but were not run.

## Every page passes the automated WCAG 2.1 AA scan (2026-10-15)

- Found by running axe-core (WCAG 2.1 A and AA) in a real browser over all 40 pages: 150 elements failed. 144 were text contrast (muted text at 2.4 to 4.3 against the 4.5 minimum, on the cream and white pages), 2 icon-only back buttons and the team-size slider had no name, the organisation-name field had a label not tied to it, and 2 links inside sentences were told apart by colour alone.
- Fixed at the source: `slate-400` and `slate-500` in `tailwind.config.js` are now 4.6:1 or better on every light surface; `text-amber-600` and `text-emerald-600` became the next shade down (43 files); the two back buttons are named "Back", the slider "Team size"; the organisation-name and invite-email fields are tied to their labels; the two in-sentence links are underlined. My own change made the sign-in "Or sign in with email" divider and the conversations "open" badge worse on dark cards, so those use a light green there.
- Verified: axe went from 150 failing elements to 0 on 40 pages (same scan, same signed-in owner); 2 new name tests failed first; dashboard 1120 tests, tsc and lint clean; the 36-page click-through and focus check still pass.
- Not verified: a person with a screen reader, Safari or Firefox, the pages that need an id in the address, and anything inside modals that are closed on load.
- Visual change to know about: secondary grey text is a little darker everywhere on the light pages, and the two grey levels are now close to each other.

## A request id on every response (2026-10-15)

- Before this, a customer who hit an error could tell support only "something went wrong around 3 pm"; nothing tied a screen to a log line. The middleware now puts an `X-Request-Id` on every response, redirects and refusals included. An id sent by a proxy is kept when it is 1 to 64 plain characters (`A-Z a-z 0-9 _ -`) so one request has one id end to end; anything else is replaced with a fresh UUID, because the value ends up in logs.
- Verified: 4 unit tests; on the running production build `/login` returns a generated id and `/api/health` with `x-request-id: abc-123` returns `abc-123`.
- Not done: the id is not yet printed in the server's error logs or shown on the error screens. That is the next small step, and needs a pass over about 150 route handlers.

## Sign-up consent is a real choice, and Terms and Privacy pages exist (2026-10-15)

- Found by reading the sign-up page: the "I agree to the Terms of Service and Privacy Policy" box was ticked before the person touched it, and both links were dead (`href="#"` with the click cancelled). A pre-ticked box is not agreement, and there was nothing to agree to.
- Now the box starts unticked (the server already refuses sign-up without it), and the links open `/terms` and `/privacy` in a new tab so a half-filled form is not lost. Both pages are public, readable by someone already signed in, and server-rendered with no script. They say in plain words what the product does today: employees prepare actions and sensitive ones wait for approval, each workspace is kept apart in the database, text goes to the configured AI model service, connected apps can be disconnected, and data can be exported or deleted from Settings.
- Verified: 5 new tests (written before the pages existed): unticked by default, links go to the real pages, both paths public for signed-out and signed-in, content mentions approval/export/delete. The 36-page browser run now includes both pages.
- Needs you before launch: the pages say, in a visible note, that no lawyer has reviewed them, and they contain `[add your contact email before launch]` twice. The text is a starting draft, not legal advice; the company name, governing law and refund terms are yours to add.

## Browser security headers on every response (2026-10-15)

- Found by reading the live response headers: nothing the dashboard sent carried a browser protection (no framing block, no content-type lock, no referrer policy, no HTTPS-only hint) and every page announced `X-Powered-By: Next.js`. The proxy example in `deploy/` adds none either, so a launch behind it would have shipped the same.
- Now `security-headers.js` (plain CommonJS so `next.config.js` can share it) sends on every path: `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` turning camera, microphone and location off, and `Strict-Transport-Security` in production only. The content policy is deliberately small (`frame-ancestors 'none'; base-uri 'self'; object-src 'none'`): it says nothing about scripts, styles, connections or forms, so it cannot break the inline load guard or the sign-in redirects. The chat widget customers embed is a script, not a framed page, so nothing here blocks it. `poweredByHeader` is off.
- Verified: 5 contract tests (written first, failed on a missing module); production build; `curl -D -` on the running build shows all six headers on `/login`; the 36-page browser run, the 27 flows and the dead-click guard still pass.
- Not done: a full script policy (`script-src`). It needs a nonce for the inline load guard and a pass over every page; the small policy above is the part that is safe without that.

## Ask AI can say who owes the owner money (2026-10-09)

- New read-only chat tool `dues_list` (inside the operations tool): open and disputed dues oldest first with days late, plus the totals, in the same words the Money owed page uses. It returns buyer names, invoice numbers, amounts and dates and never a phone number or email. It runs on its own, with no approval card, because it only reads. Sending a reminder stays on the Money owed page and in Approvals.
- The Ask AI welcome now always offers "Who owes me money?" as one of its four starters, after at most two connected-app tasks and "What needs me today?"; before, a workspace with several apps connected would never have seen it. The chat picks the tool up when a message talks about money owed, overdue or unpaid.
- Verified: flow F27 passes 7 of 7 against the real server and database (two dues recorded, the tool runs without a card, "2 open, 1 past the due date", buyers oldest first with 45 days late, no phone or email in the answer, nothing sent and nothing waiting, another workspace is told nothing is owed and sees none of it); workflows tests 577 pass; 8 welcome tests (1 new). In the chat-coverage matrix the tool is green because it was probed through the chat; the four Money owed actions that change data stay red.
- Not verified: how a real model words the answer. The stand-in model repeats the tool result.

## A page for money owed to you, in the sidebar (2026-10-09)

- New page "Money owed to you" (first item in the Work group of the sidebar and in the phone menu). Three totals at the top (owed, late, interest you may claim), a box to paste a list, a short form for the bank rate and whether the business is a registered small supplier, and one card per due: buyer, invoice, amount, a pill ("45 days late", "Due 29 Oct 2026", Paid, Disputed), the plain next step, and the actions Write a reminder, They paid, They dispute this, Reopen. A reminder opens an editable draft with an English or Hindi (in English letters) switch and the button "Send for my approval"; it lands in Approvals and nothing reaches the buyer before a person says yes.
- Found by using it in a real browser as an owner: a line that could not be read was reported inside a box that closed itself once other lines were saved, so the owner would never have seen that line was missing. The message now sits above the box until dismissed, and the box stays open while there is one. The page also said "Not due yet." twice on a card; and the Hindi formal reminder switched to English for the interest sentence, which now reads in Hindi too.
- Verified: tsc and lint clean; the wording, fetch-handling, error-display and focus contracts pass; 14 wording tests; in a real browser the whole journey works: pasted list with one bad line (reported), totals Rs 1,65,500.50 owed and Rs 1,20,000 late, interest Rs 2,419.89 for a registered supplier, a Hindi draft, the held email in Approvals, the A key approving it, exactly one email at the provider, marking one paid drops the totals, no sideways scroll at phone width, 0 server errors.
- Not built yet: an Ask AI tool and starter ("Who owes me money?"), a Razorpay payment link in the reminder, and matching a Razorpay payment to a due automatically.

## The API for money owed: import, list, mark paid, remind through approval (2026-10-09)

- `GET /api/dues` lists what is owed with each due's days late, interest and next step, oldest first, plus totals (owed, overdue, interest, paid). `POST /api/dues` imports a pasted list and reports unreadable lines by number while saving the rest. `PATCH /api/dues/[id]` marks a due paid (with a payment reference), disputed or open again. `PUT /api/dues/settings` stores the two facts the interest depends on: the bank rate the owner has checked, and whether the business is a registered small supplier. `POST /api/dues/[id]/remind` previews the draft, or sends it through the same gate as every message to a customer, so it waits in Approvals.
- Rules: a paid due is never chased; a reminder inside 3 days of the last is refused so the buyer is not pestered; the statutory interest wording appears only for a registered supplier with a bank rate set; changing a due needs an owner, admin or manager; settings need an owner or admin; every query is limited to the signed-in workspace. The reminder goes out as the workspace's customer-facing employee, preferring Customer Support.
- Verified: new flow F26 passes 16 of 16 against the real server and database (import with one bad line reported, totals 165,500.50, interest for a registered supplier, preview sends nothing, the reminder waits in Approvals, approving sends exactly one email to the buyer, a second reminder inside 3 days refused, paid due never chased, another workspace sees none of it and cannot change it, model SQL cannot read the phone). Found by that flow: the first version asked for an "executive" employee that a normal workspace may not have and silently prepared nothing; fixed. 8 unit tests for the view helper.
- The four new actions are rows in the chat-coverage matrix at red: they cannot be done from Ask AI yet.

## Reading a pasted list of dues and writing the reminder (2026-10-09)

- `lib/dues-text.ts`: `parseDuesPaste` reads dues pasted from a spreadsheet or typed one per line (buyer, invoice number, amount, invoice date, credit days, phone), with tabs, pipes, semicolons or commas, amounts like `1,20,000` or `₹ 45,500.50`, dates as `12/08/2026`, `12-08-26` or `2026-08-12`, and a header row skipped. A line it cannot read gets one plain sentence naming the line and the problem ("Line 2: I could not read the amount \"abc\"."); the good lines are still kept. Future-dated invoices, zero amounts and more than 200 lines are refused.
- `draftReminder` writes the WhatsApp-ready draft in three tones, in English or Roman Hindi. Friendly and firm never threaten, blame or mention legal action. The statutory interest appears only in the formal tone, only when the owner has said the business is a registered small supplier, and as a figure to confirm. The payment link is added only when there is one.
- Verified: 13 unit tests, tsc and lint clean. No screen uses these yet.

## A place to record who owes the owner money (2026-10-09)

- Migration 212 adds `org_dues`: one row per amount a buyer owes the workspace (buyer, optional phone and email, invoice number, amount, invoice date, agreed credit days, due date, open / paid / disputed, when last reminded and how many times). Paid is only set by the owner or a matched payment; a buyer saying they paid does not close it, the same rule as rent charges.
- Tenant isolation: row-level security forced with the usual hardened policy. It holds personal data, so it is registered in the erasure list (`dsr/tables.ts`), and model-written SQL may read only the business columns (name, amount, dates, status); phone, email and the note are withheld at column level.
- Verified: applies to the sandbox database and re-runs as a no-op; `check-rls-coverage.js` 11 of 11 (it failed 1 of 11 until the reader-role decision was made, which is what it exists to force); `check-database-query.js` 41 of 41; the erasure-list test passes; the reader role can see `buyer_name` and cannot see `buyer_phone`.
- Nothing reads or writes the table yet: the API, page and chase flow follow.

## First piece of getting paid: the rules for money owed to the owner (2026-10-09)

- Audit as a new owner of a business that is not property (an auto-parts supplier, fresh workspace, real browser): nothing in the product is about getting paid. No sidebar item, no Ask AI starter, no page. The sidebar (Inquiries, Listings, Showings) is shaped for property whatever the business sells, and it has about 25 entries. The tools exist but nothing joins them: `razorpay_create_payment_link`, `whatsapp_send`, `sheets_read`, and a rent-charges table that only knows rent.
- Added `lib/dues-engine.ts`, the rules for money owed to the owner, as pure functions with 16 tests: the day payment is due (the agreed credit period capped at 45 days, or 15 days if none was agreed), days overdue, interest at three times the bank rate with monthly rests (the bank rate is always an input; the screens must tell the owner to check the current RBI figure), and the next reminder step. A reminder is friendly under 8 days, firm to 30 days, formal with the interest mentioned after that, never closer than 3 days to the last one, never sent for something paid, and a disputed due goes to the owner. After 60 days it prepares an escalation pack for the owner to review. Nothing is ever sent without the owner's approval.
- Source of the rules: the Act's sections as summarised in the research notes for this feature (a secondary source), not checked against the Gazette. Not legal advice; the interest figure is meant for the owner to review before it is used in any notice.
- Not built yet: the table for dues, the page, the Ask AI starter and tool, reconciliation against Razorpay payments, and the filing pack. Verified: 16 unit tests, tsc and lint clean.

## Home no longer says the same thing twice (2026-10-08)

- Found in the same read-through: with approvals waiting, the banner at the top of Home said "3 approvals are waiting for you" and the "Today so far" card repeated it twice more ("Something needs you today.", "3 approvals are waiting for you.").
- The digest now reports only what happened in the last 24 hours (new enquiries, answers given, emails sent, showings coming up) and leaves waiting approvals to the banner. A day with nothing new reads "Quiet so far. Nothing new in the last 24 hours."
- Verified: 7 unit tests (one new: the lines never mention approvals); in a real browser Home shows the banner once and the card lists the enquiries and answers.

## Plain wording on Listings, Showings, Inquiries, Insight and the connect errors (2026-10-08)

- Found by reading the running pages as a customer would: Listings said "This module is gated by the real-estate pack. Recommended connectors stay disconnected until you connect them on /connectors", Inquiries said "Kanban of real inquiry work items" and "recommended is not the same as connected", Showings pointed at "/listings" and "/connectors" as typed paths, Insight was headed "Semantic metrics" and spoke of an "open-ended agent", and two connect errors told the person to "use the BYOK form" and said "Graph verifies the token". The earlier vocabulary check did not know these phrases.
- Now each says the same thing in business words ("Your properties. Nothing is made up: an empty list means none have been added yet.", "Go to Connectors", "Business numbers"), and the vocabulary contract bans these phrases and any visible typed path to a page, so they cannot return. "Work items" stays: it is a name customers see in the sidebar.
- Verified: the contract fails on 35 places before the edits and passes after; in a real browser the Listings, Showings, Inquiries and Insight pages show the new sentences, with 0 server errors across 10 pages.

## The flow harness sets a closed agent-sidecar address (2026-10-08)

- Check-in 28 ran the new flow F25 through `run-flows.sh` and 2 checks failed, although F25 passed against the audit stack. Cause: `run-flows.sh` never set `TRUEFORGE_URL`, and a production start refuses to build the sidecar address without it, so the expired-card path ended in a configuration error instead of a connection error. The audit stack set it, the flow script did not.
- `run-flows.sh` now exports `TRUEFORGE_URL=http://127.0.0.1:1` (a closed port; the harness has no sidecar) unless one is given. Flow F14 (an approval card whose chat is gone) expected the old wording that pointed at Decisions; it now expects "nothing was run or sent" and "ask again", the wording the product has since the card-expiry change.
- Verified: `run-flows.sh` ends with 95 passed, 0 failed (25 flows); it was 93 passed, 2 failed before the change and 94 of 95 after the first half.

## Home shows what happened today and what needs the owner (2026-10-08)

- New `GET /api/digest` and a Home card, "Today so far": what is waiting for the owner, showings in the next 24 hours, new enquiries, customer messages answered and approved emails sent in the last 24 hours, and an estimate of reply time saved (about 2 minutes per answer, labelled as an estimate, zero when nothing was answered). The wording lives in `lib/owner-digest.ts` so it is tested without a database.
- Why: the value of the assistant was invisible unless the owner opened five pages. A quiet day reads "A quiet day so far. Nothing needs you."
- Verified: 6 unit tests; in a real browser a new workspace shows the quiet sentence, and after one send is held the card shows "Something needs you today." and "1 approval is waiting for you."; a second workspace sees 0 waiting (isolation). Every query is limited to the signed-in workspace.
- Not verified: the time-saved figure against real usage; it is a fixed estimate.

## The approval card says what cannot be taken back (2026-10-08)

- Gmail and WhatsApp cannot recall a message, so a true "undo" for a sent email is not possible. Instead of promising one, the approval card now says so before the owner decides: "Once sent, this cannot be taken back." for emails and messages, and "Money moves as soon as you approve." for refunds and payments. Changes that can simply be changed again show nothing.
- Verified: 3 new unit tests on the wording; in a real browser the held email's card shows the sentence. A delayed-send undo window would change when sends happen, which is a product decision and was not built.

## A soak run and instructions for the checks only the owner's machine can do (2026-10-08)

- Added `infra/harness/soak.js`: steady signed customer messages, plain questions, and held sends approved in chat against a running dashboard, sampling the server's memory and the database connections. It fails on any 5xx, an approval that did not finish, a stuck pending row, unanswered messages, or memory growing more than 60 percent after warm-up.
- Added `infra/harness/RUN_ON_YOUR_MACHINE.md`: exact commands for the four checks the sandbox cannot do (real model score, a 24-hour soak, a clean Docker build, one real mail or WhatsApp account). The sandbox has no model key, no accounts and no Docker daemon.
- Verified: a 30-minute run, 1968 requests (1136 inbound, 378 questions, 227 held sends approved in chat), 0 failures, all 227 approvals finished, 0 stuck, every message answered, memory 310 to 379 MB (22 percent, inside the limit but worth watching in the 24-hour run).
- Not verified: 24 hours, a clean container build, a real model or real accounts.

## A scored task set so answer quality is a number (2026-10-08)

- Added `infra/harness/evals/`: 37 tasks in 7 groups (facts from the business's data, unknown facts that must be admitted, sends held for approval, refunds and payments held, hostile customer messages, tone and language, daily triage), a pure grader and a runner that seeds a throw-away workspace, scores every task through `/api/ask-ai`, writes a JSON report and exits 1 under a threshold (default 90 percent).
- Why: "comparable to the best" had no measurement. The checks are deliberately about outcomes a business owner cares about: the right price, no invented facts, nothing sent without approval, nothing sent to an attacker, no claim that something was sent when it was only held.
- Verified: 6 grader unit tests; stand-in run completes all 37 turns with no error or leak; the same set graded for real against the canned stand-in reply scores 5 of 37 (14 percent), so the grader tells good from bad.
- Not verified: any score from a real model. That needs the user's model key and is the next step; scores from the stand-in mean nothing and the runner says so.

## A chat approval card that outlives its server now says so (2026-10-08)

- Found while closing the project: a held chat card lives in the server that asked for it. After a restart (or the 30 minute clean-up) answering it ended in "approve it from Decisions", but nothing is waiting in Decisions at that point, so the person was sent to an empty page.
- `resumeTrueForgeTurn` now throws a named `ApprovalExpiredError` when the session is unknown here and the fallback sidecar is unreachable or answers 404. The approve route turns it into "This approval card has expired and nothing was sent. Ask again and approve the new card." A genuine timeout still reads as a failure, not as expiry.
- Verified: new unit test `approval-expired.test.ts`; new flow F25 (card, then answer it with a session the server does not know) fails 2 of 4 checks before and passes 4 of 4 after: person told the card expired, no mention of Decisions, nothing reached the provider, no pending row created.
- Not done: making the card itself survive a restart would need a durable record at card time, which the single-approval design avoids on purpose (no second approval in Decisions). Left as a product decision.

## Every Insight card has its own plain sentence (2026-10-07)

- Found on the Insight page: two metrics had no sentence of their own, so their cards fell back to "Work items not yet done or cancelled = 7 from the metrics registry SQL."
- Now every metric in `core-kpis.yaml` has its own sentence ("Work items that are still open.", "Messages customers sent in this period."), and the fallback, should a new metric lack one, reads "Counted from your own business data, not estimated."
- Measured on the Insight page in a real browser: cards mentioning SQL 1 -> 0.
- Proof: the registry-copy contract (`kpi-copy-plain.test.ts`) now also requires every metric to have its own sentence (3 tests).

## The sidebar keeps the page you are on in view (2026-10-07)

- Found by opening pages from the lower groups at 1280x800: with a group open the list is longer than the window and scrolls with no scrollbar, so on Billing, Connectors, Autonomy, Insight, Audit, Trust and Packs the highlighted item was scrolled out of sight, and a person could not see where they were.
- Now the list scrolls the current page into view when you arrive on it, and again once the account name appears in the footer (which shortens the list). It does not move when you open or fold a group, so a group you just opened stays where you are looking.
- Measured in a real browser on 9 pages from the lower groups, the highlighted item in view: 2 of 9 -> 9 of 9.
- Proof: 1 component test, red against the old shell.

## The line saying why a message went to an employee is in plain words (2026-10-07)

- Found in the chat: "Routed to Emma: low confidence — support, not round-robin", the router's internal note, shown to the customer. Others it can produce: "emergency keyword — dispatch, not ISA", "greeting — solo support, no crew".
- Now the same line reads "Routed to Emma: not sure which team fits, so your first point of contact took it"; the other router notes are mapped the same way (an urgent request, a greeting, a general question, your daily summary, a research question, "matches their role"). A reason that is not in the list is shown as written, so nothing is hidden.
- Measured in a real browser, before and after, on the same chat message: internal router words on screen (round-robin, ISA, crew, fallback) 1 -> 0.
- Proof: 1 test over 9 router notes (red against the old code); the 19 other ask-mode tests are unchanged and pass.

## A plan's steps name the app and the action in words (2026-10-07)

- Found in the chat plan card: each step carried a tag such as `mcp.google-sheets.sheets_read`, `mcp.google-calendar.calendar_list_events`.
- Now the tag reads "Google Sheets · Read", "Google Calendar · List events", "Gmail · Draft email", from a tool id or from a tool and an action; it never prints `mcp.` or an underscore.
- Measured in a real browser on a showing request that produces a plan, before and after: internal ids on the plan card 3 -> 0.
- Proof: 4 label tests and 1 plan card test (`lib/__tests__/plan-step-label.test.ts`, `components/chat/__tests__/PlanCard.test.tsx`).
- Not changed: a request that mentions a showing is still turned into a plan by the keyword classifier even when it is one email to send.

## Listing prices read as money (2026-10-07)

- Found by opening Listings with real rows: prices were printed as stored, "9600000" and "14500000", and the status as "under_offer" in the table and its filter.
- Now prices read in the local way for their currency, rupees grouped as in India ("₹96,00,000", "₹1,45,00,000"), other currencies in their own style, a dash when there is no price, and words such as "On request" kept as written; an unknown currency code does not throw. Status shows as "Under offer".
- Measured in a real browser on four listing rows, before and after: price cells readable as money 0 of 4 -> 4 of 4.
- Proof: 6 tests in `lib/__tests__/format-price.test.ts`.
- Not changed: listing prices in other places (inquiry summaries, chat answers) are as the data or the model writes them.

## Customer screens use plain words, and a test keeps them that way (2026-10-07)

- Found by reading every page as a customer, in a real browser (35 pages, a new and a busy workspace, counting developer words that a person can see): Billing listed `DAREX_STRIPE_SECRET_KEY` and other setting names; Insight printed metric ids (`channel_logs`, `work_items`, "in SQL") and "Honest gap: core.revenue_collected_7d"; Autonomy titled its rules `answer_faq`, `refund_payment`; Skills listed `mcp.darex.calendar_create_event`; Connectors said "Connect OAuth" on every card and named Nango, a vendor, in messages and a link to its admin screen; Health named `DAREX_ALERT_WEBHOOK_URL`; Settings named `RESEND_API_KEY` and `MAIL_FROM`; Home, Packs and onboarding said "seeded pending rows" and "until you finish OAuth".
- Now: codes are shown as words (`answer_faq` -> "Answer FAQ", via `humanizeId`); Billing says "Card payments (Stripe): not set up yet" and "Your administrator still needs to finish setting up 2 payment settings", with meters "Nearing limit" and "Limit reached"; Insight cards (metric registry copy, `core-kpis.yaml`) read in business words, with no metric id; connectors say "Connect", "Opening sign-in…" and "Connecting this app isn’t switched on yet. Ask your administrator to set it up."; Settings, Health, Packs, onboarding, the WhatsApp dialog and the rent-charge messages likewise.
- Measured in a real browser on the same 35 pages and two workspaces, before and after: developer words a person can see 230 -> 8 (-96%); pages with any 13 -> 3. The 8 left are legitimate: "Tenant" (a person renting, in real estate, 4) and "Webhooks" in Settings, where the customer pastes the address into Meta (4; both are on the contract's allow-list with the reason).
- Contract: `customer-vocabulary.test.ts` now also bans OAuth, tool ids, `mcp.` ids, internal shorthand ("SoR", "org-union") and any SCREAMING_SNAKE setting name, and it reads the fixed words of templates, conditionals and `a || b` (it ignored them before, which is how 19 hits including the vendor name Nango stayed hidden). New contract `kpi-copy-plain.test.ts` checks the metric registry copy (red against the old file). Other proof: 5 `humanizeId` tests, 2 insight-gap tests, Autonomy tests updated to the new names.
- Not changed: the administrator tab on a connector's page still lists the setting names to provide, under a heading that says so (allow-listed). Skill descriptions that come from the database are shown as stored.

## The Inbox can be read at laptop width, and no longer looks like a test tool (2026-10-07)

- Found by using it at 1280x800: four columns (filters 256 px, list 320 px, conversation, context 288 px) left the conversation 112 px wide, so the header, the status control and the reply buttons were cut off. A conversation from the assistant showed as "ask-ai:97fdee74-209e-4942-b3e3-edb8399840c7", and the reply box offered "Simulate Customer (Triggers Live AI Response)" next to the real reply button.
- Now the filter column is a drawer opened by a "Filters" button (it stays a column at 1536 px and wider), the context column appears only at 1536 px and wider, the list is narrower (288 px, 320 px from 1280 px), and the header controls wrap on a phone. Names show as the customer's name, a phone number or an email address; an Ask AI chat shows as "Ask AI chat", a website visitor id as "Website visitor", a bare id as "Unnamed contact". A phone number stays beside a name. The reply box has "Reply to customer" and "Private note"; the practice mode is one small "Practise as the customer" link, and says what it does when on.
- Measured in a real browser, before and after: conversation width at 1280x800 112 -> 656 px (+486%); controls cut off at 1280x800 6 -> 0 and on a phone 1 -> 0; "Simulate" text visible yes -> no; raw ids on screen 0 -> 0 (the Ask AI chat now reads "Ask AI chat").
- Proof: 6 page tests (4 red first) and 8 name tests. The reply text in the screenshots ("I read your message (CONNECTED INTEGRATIONS …") is the harness's stand-in model echoing its prompt, not the product.
- Not changed: the Inbox is still a dark theme inside a light app; making it match is a larger visual redesign. The practice mode is still there for people who want it.

## Home tells a new customer what to do first, and speaks plainly (2026-10-07)

- Found by using the product as a new customer: Home for an empty workspace was four tiles reading "N/A" and "0", a banner reading "Infrastructure: healthy · 1 active channels · 1 AI employees", and the line "Numbers below come from your org stats. Empty queues stay empty." Nothing said what to do first.
- Now a "Get started" card shows three steps with a tick for each one that is done: Connect your first app, Teach it your business (adds anything to the Brain), Ask your first question (a chat with an answer in it). Each is a link to the page that does it. It shows nothing for an account that has done all three, nothing while the facts are still loading, nothing when a lookup fails (an unknown is not shown as "not done"), and can be hidden, which the browser remembers. Whatever the account has done so far is ticked.
- The status line reads "Everything is running · 1 channel connected · 1 AI employee" (or "Some services are slow" or "down"), with the plural fixed, and the subtitle reads "What happened in your business, and what needs you." The setup panel after onboarding no longer says "seeded pending rows" and "OAuth credentials".
- Measured in a real browser on a new workspace, before and after: a first step shown 0 -> 3; developer words on Home 2 -> 0.
- Proof: 7 component tests in `components/home/__tests__/GetStarted.test.tsx` (steps and links, ticks and count, gone when all done, an empty chat is not a question, a failed lookup shows nothing, hide and remember, waits for the channel count).
- Not changed: the four tiles still show "N/A" when there is no data. NEW-FRONTEND needs the same card.

## Ask AI greets in plain words and offers four useful starters (2026-10-07)

- Found by using the product as a new customer: the first message said "Core tools (no OAuth): `database_query`, `web_search`, `web_extract`, `file_ops`" and "point you to `/connectors` — I will not invent results", the page header said "no OAuth connectors yet", and the only starter was "Ask about our Darex data". The other four starters were hard-coded tasks with made-up addresses ("lead@company.com"), shown only when a matching app was connected.
- Now the greeting says what the assistant can do for this business, names the connected apps in words ("work with WhatsApp"), says a message is always shown before it is sent, and links to Connectors when nothing is connected. There are always four starters, none needing an app that is not connected, and connected apps come first (WhatsApp: "Catch up on WhatsApp"; Gmail: "Reply to my latest emails"; Calendar: "What is on tomorrow?"). None of them invents an address or contact. The header says "connected: WhatsApp" or "no apps connected yet". `@Name` mode reads "@Sarah will answer this message" instead of "overrides mode … org-union tools".
- Measured in a real browser on a new workspace with WhatsApp connected, before and after: developer words in the first message 7 -> 0; starters 1 -> 4, each a real task; a request that was not understood on the first screen: 0.
- Proof: 7 tests in `lib/__tests__/ask-ai-welcome.test.ts` (greeting without and with apps, readable app names, four starters, none with invented contacts, no starter for an unconnected app).
- Not changed: the model's own wording of answers (needs a real model; the harness model only echoes). NEW-FRONTEND needs the same text.

## The sidebar names every page and groups them by what a person is doing (2026-10-07)

- Before, measured in a real browser at 1280x800: 23 icon-only links with the name only in a hover tooltip, no grouping, Showings had no way in from the sidebar or the phone tabs, and two items lit up on the Customer page (Employees as well as Customer). On a tablet-width window the icon rail scrolled 840 px with the scrollbar hidden.
- Now the wide sidebar (1024 px and up) writes each name next to its icon and groups the pages: Home, Ask AI, Approvals and Inbox on top with no heading, then Work (Work Items, Plans, Inquiries, Listings, Showings), Your team, Knowledge and reports, Oversight and Setup. Work is open and the other four are folded the first time; a person's own choice is kept in the browser (`darex.nav.closed`; a browser that refuses storage just forgets it), and the group you are in never folds. Exactly one item is highlighted: the longest link that matches the address.
- The narrow icon rail (768-1023 px) uses the same folding with a small chevron between groups, so it shows 11 icons and scrolls 123 px instead of 27 icons and 840 px. Showings is also in the phone "More" sheet.
- Measured on the same page, same machine: icon-only links 23 -> 0 on the wide sidebar; every group heading visible without scrolling at 1280x800; highlighted items on Customer 2 -> 1; pages with no way in 1 -> 0.
- Proof: 10 component tests in `components/shell/__tests__/nav.test.tsx`, including folding, remembering, a browser that blocks storage, the badge, and the rail toggle; the contract tests for touch targets, focus and nav parity still pass.
- Not changed: the separate NEW-FRONTEND repository (not reachable from here) needs the same change. The organisation switcher is still an icon with no text.

## Chat-answer widget styles load only with an answer that has a widget (2026-10-07)

- Every page, the sign-in page included, downloaded 290 KB of stylesheet (33 KB gzipped) for the answer-widget library, imported in `globals.css`, although only a chat answer containing an `openui` block uses it. The two imports moved into `OpenUiFenceBlock`, which is already loaded on demand. Stylesheet bytes on a page: 376 KB before, 72 KB after (-81%).
- Proof: contract test `first-load-weight.test.ts` (2 of 3 red first). In a real browser: the first load fetches only the 72 KB stylesheet; after an answer with an `openui` block the two widget stylesheets are fetched.
- The page-level totals for this and the previous entry are measured together (below).

## The chat approval card shows what is being approved (2026-10-07)

- Since a chat Allow is the approval (entry below), the card has to show what is being approved. It said only "Tool Approval Required for `gmail_send`" with Approve and Deny: a person approved an email without seeing who it goes to or what it says.
- Now the card says what the call would do ("Send email "Saturday appointment" to priya@example.test"), shows To, Subject and the message, and "Needs your OK". It uses the same wording code as the Approvals page (`describeHeldAction`). If the call's arguments cannot be read it falls back to the old card; nothing is invented.
- How: each approval request now carries `summary` and `call` (tool, action, arguments; strings cut to 4,000 characters, nested values dropped). A call's arguments are streamed in fragments (the first has the id and name and empty arguments; the JSON follows in fragments that carry only the call's index), so `rememberToolCalls` assembles them by index; a first attempt read the first fragment and produced an empty card, found only by looking at the real stream. Resumed turns capture them too, so a second approval in the same chat shows its card.
- Proof: 8 workflow tests (assembling fragments, two calls in one message, unreadable arguments, long messages), 4 card tests, 4 normaliser tests. In a real browser against the real stack: the card shows the recipient, subject and message, and Approve sends that email once.
- Not changed: the chat's plan card still lists internal ids such as `mcp.google-sheets.sheets_read`, and a request that mentions a showing is turned into a plan by the keyword classifier even when it is one email to send.

## The sidebar no longer loads every page's code on every page (2026-10-07)

- Measured in a real browser on nine pages: every page load fetched 58 static files (~463 KB gzipped) and made 21 prefetch requests, and the file list was the same on every page, because Next prefetches each visible link by default and the sidebar draws 25. A person opening Billing downloaded the code of Ask AI, Settings and every other page, and the server rendered 21 pages it was never asked for.
- Now the sidebar and phone tabs set `prefetch={false}` and load a page ahead of the click only on hover, keyboard focus or touch (`usePrefetchOnIntent`, each page at most once), so clicking is still quick.
- Measured on the same nine pages, same machine, before and after (with the stylesheet entry above): requests per page load 90 -> 33 (-63%); prefetch requests 21 -> 1; static files 58 -> 22; estimated bytes on the wire (gzip of the files actually fetched) 463 KB -> 204 KB (-56%); stylesheet 376 KB -> 72 KB. Server calls for the page's own data are unchanged (10 on average).
- Proof: 3 component tests (all red first); the measurement script re-run.
- Not measured here: how much faster a page feels on a slow phone connection. Bytes and requests fell by more than half; the felt time was not timed on a real device.

## Home and the Morning brief no longer say nothing needs you while approvals wait (2026-10-07)

- Found in the same browser pass: with three emails held for approval, the Morning brief said "Nothing needs you. 0 things handled." and the Home "Needs Attention" count was 0. Held actions were counted nowhere a person looks first.
- `ApprovalsCallout` (Home and Morning brief): "3 approvals are waiting for you" with a Review button, and nothing at all when none are waiting or the count is unknown. The brief's "Nothing needs you." now appears only when that is true.
- Proof: 3 component tests and 2 page tests (the brief one is red against the old page: it printed "Nothing needs you" with three waiting).

## An Approvals page: every held action in one place, readable, with edit and approve-together (2026-10-07)

- Before: the only place to approve a held action was the bottom of the "Employee health" page, under ten metric tiles. A held email read as `Send email "About your enquiry" to anita@example.test` with Approve and Reject: no message text, no reason, no way to fix a word. Finding it meant opening 15 sidebar pages (two of them misleading or crashing). Approving 20 routine messages was 20 clicks.
- New page `/approvals` and a sidebar entry with a live count badge (phone: a primary tab with the badge). Each waiting action shows who asked, what it would do, to whom, the message itself as plain text, why it was held in plain words, the approvals still needed ("1 of 2 approvals given") and the time left. Approve, Reject, and Edit (change the message, then "Approve with changes", which sends the edited text as the replacement arguments). Several plain actions can be selected and approved together; a payment or a two-person action has no checkbox and is read and approved on its own. Keyboard: J/K move, A approve, R reject, X select (never while typing). The result of each decision is on the card in words: "Approved and sent.", "Approved, but it did not run: ...", "Your approval is recorded. It needs 1 more person before it runs." A "Done" tab shows how earlier ones ended (Sent, Rejected, Did not run, Expired). If the list cannot load it says so, never "Nothing is waiting".
- `GET /api/decisions` now names the employee (looked up inside the same workspace, so a row cannot name someone else's employee), leaves out requests that have already expired, and answers `?count=1` with the number alone (one count, no row data) for the badge, which checks every 30 s while the tab is visible and at once when anything is decided.
- Proof: 11 page tests, 9 client tests, 5 badge tests, 5 route tests, 10 view tests. In a real browser against the real stack: 8 held emails decided with 9 actions (keyboard approve, keyboard reject, edit, select-all, approve-selected); 7 emails reached the provider, the rejected one did not, and the edited one carried the edited text. Plain approvals in bulk: N clicks before, 2 after.
- Not changed: the Health page still lists approvals (now with the same card). Whether to retire that list is a product call.

## A held action no longer crashes the Customer tab, and says what it would do (2026-10-07)

- Found by opening every page as a person would, in a real browser, on a workspace with data (the first time the pages were driven with held actions present). `/employees/customer` showed "This tab failed to load" for any workspace with a held send, payment or signature. React error 31: the server stores the card's recommendation as `{ optionId, basis }` and `DecisionCardPanel` typed it as text and rendered it.
- The same cards were unreadable everywhere: the work-item board listed three cards titled "decision" in Backlog, because the card stored no sentence about what the action would do (the board already looked for `card.summary`).
- Fix: `heldActionCard` (workflows) stores `title`, `summary` and `reasonCode` on the card; the held row also keeps `reasonCode`. `lib/approval-view.ts` (new, pure) turns a held action into what a person needs to decide: who, what, to whom, the message text as plain text (html stripped, 600 characters), why it was held in plain words, approvals still needed, and time left. Credentials in the arguments are never shown. `DecisionCardPanel` uses it, renders the recommendation as the option's name, and still accepts the older text shape.
- Proof: 4 component tests (3 red first, one reproducing React error 31), 10 for `approval-view`, 3 for the card builder.
- Cards already stored before this change have no summary; the card derives one from the stored call, so they read correctly too.

## Allowing a call in the chat card is the approval: no second one in Decisions (2026-10-06)

- Before: Ask AI shows a card; the person clicks Allow; the gate then held the same send, payment, signature, publish or delete again as a database approval, so the person had to approve it a second time in Decisions. The chat said "Waiting for approval" after they had approved.
- Now: the SDK hands the tool set the person's answer with the call, so an allowed call is known to be exactly the one on the card, with its stored arguments. When the gate holds it, the hold is approved on the spot by the person who clicked, through `decideApproval` (the same path as Decisions: role checks, dual approval, expiry, audit that fails loudly, execute with the approved row id), marked `via: 'chat'` in the audit entries. The model is told the real outcome: executed, did not run, or still waiting for another approval.
- Nothing is bypassed. The call still goes through the whole gate first: the pause switch, the employee's tool card, persona denial, watching mode (level 0 records and runs nothing, so no approval row exists), the critic. Pay and refund role rules and two-person approval are applied by `decideApproval`: a refund that needs a second person leaves the row waiting with this person's approval recorded, and the second person finishes it in Decisions. A call with no Allow is never approved for anyone, and a denied call never reaches the gate (previous entry).
- The hold made for an allowed call is not announced to the managers' Slack channel (the person is deciding it right now). If it stays open (needs another person, or recording failed) it is announced then (`announceParkedAction`).
- A double click or two tabs answering the same card at once: the second is refused ("already being handled") instead of running beside the first. Before this change that only produced two holds; with the Allow being the approval it could have sent twice.
- If recording the approval throws, the model and the person are told to check Decisions before asking again (never "nothing was run": the tool may already have run). If the tool ran and only its audit entry failed, it is reported as having run (`AuditWriteError.afterExecution`).
- Proof: 13 new unit tests in the workflows package (tool set, gate flag, outcome mapping) and 12 in the dashboard (adapter, audit channel, after-execution flag), red first. Real stack, harness flows F16 to F24 (91 of 91 checks across all 24 flows): one Allow sends exactly one email with no second approval and a durable executed row, audit entries once each, inbox card closed; two Allows at once send one; one allowed and one denied call in the same turn send one; a provider failure after Allow is recorded as failed; an auditor or member is refused before anything runs; level 0 sends nothing and leaves no row; pausing after the card appeared stops the send; a two-person refund waits after the chat Allow and runs exactly once after the second person.
- Applies to in-process turns (the default). The TrueForge sidecar path (`DAREX_INPROCESS_TURNS=false`) still asks twice.
- Not changed: a card whose server restarted before the click is still dead (open, `gap26sept/decisions.md` row 11); the person is told to ask again or approve from Decisions.
- Found on the way and not changed (row 13): nothing sets `required_approvals` above its default of 1, so the documented "refunds need two approvals" fallback never applies and an owner's single approval runs a refund. Enforcing it would stop a one-owner workspace from refunding at all, so it needs a product decision.

## A call the person denied in the chat card no longer runs (2026-10-06)

- Found by flow F15 in the keyless harness while checking what a chat approval leaves behind: after Deny, a pending approval row existed. The in-process tool set (`DarexLocalToolSet`) ignored the second argument the SDK passes to `callTool`, which is the person's answer to the card. So a denied call went to the gate like any other: a send, payment, signature, publish or delete was held as a new approval in Decisions (a request for something the person had just refused), and a write the workspace lets run on its own would have run.
- Fix: `callTool(params, decision)` returns "The person denied this action, so it was not run" before the tool-call budget and before the gate when `decision.status` is `deny`. Nothing is counted or dispatched.
- Proof: 2 unit tests, red first (a type error and 2 failures without the fix); harness flow F15 (deny leaves no row and the audit log has the deny).
- Not changed here: allowing a card still ends in a second approval in Decisions. That is the next entry.

## Keyless end-to-end flow harness (2026-10-06)

- `infra/harness/` runs 14 flows through the real dashboard server, tool gate and database with a local fake model, connection broker and provider. The model server answers in OpenAI format and is scripted by the prompt; calls to provider hosts are rewritten to the fake by a preloaded script. No keys, no network, no workflow engine: the dashboard runs agent turns in-process when `DAREX_LOCAL_MODEL_BASE_URL` is set.
- Flows: a read runs; a send is held; approving sends once and records truthfully; reject; edit then approve; a provider failure is recorded as failed; watching mode records and sends nothing; a paused team does nothing; another workspace cannot see or approve; an auditor cannot approve; a revoked connection is reported honestly; a customer message through to a stored reply; a message that tries to make the agent email an attacker sends nothing; a dead approval card says so plainly.
- Result: 50 of 50 checks on the final build. It is what found the approval defects in the two entries above; the unit tests could not, because they stub the executor.
- Observed and not changed: at level 0 a chat send still shows the approval card first and only after Allow does the gate record it as a watching-mode decision. Of five ordinary customer messages sent inbound, four were answered ("email me the brochure", "send me the price list on WhatsApp", "how do I pay the booking amount", a showing-time question) and one was held for a person before the agent could answer ("Can I sign the agreement online?", a plain question about signing).
- Not covered: real model answers, real providers, workflow-engine workflows (reminders, nurture, sweeps, data erasure), browsers. Not wired into CI (it needs a built dashboard and a database): run `infra/harness/run-flows.sh`.

## A person is never shown Node's own network error text (2026-10-06)

- Found while testing what a chat approval card does after the server restarts: the approve route answered `fetch failed`. The chat that was waiting lives in the memory of the server that asked, so after a restart (or on a second replica) it is gone and nothing runs, and the person was shown Node's bare network message because two streamed error events (`ask-ai/approve`, and the crew path in `ask-ai`) sent `err.message` as it was.
- `publicErrorMessage` now treats the bare network messages (`fetch failed`, `socket hang up`, `terminated`, `other side closed`) as internal text. Both routes use it, with a sentence that says what is true and what to do: "We couldn’t finish that approval, so nothing was run. Please ask again, or approve it from Decisions."
- Contract test `stream-error-contract.test.ts`: no route may stream an error event whose text is a raw caught error (a string literal or `publicErrorMessage(...)` only). It found exactly those two.
- Proof: 4 new sanitiser cases and 2 contract tests, red first and naming both routes; harness flow F14.
- Not fixed: a held chat approval still does not survive a restart; the person is told to ask again or approve it from Decisions (open in `gap26sept/decisions.md`).

## Approving a held send, payment or signature now runs it, and a failed run is recorded as failed (2026-10-06)

- Found by driving the real stack with a local fake model and provider (entry below). Ask AI wants to send an email, it is held for approval, the owner approves it in Decisions. The API answered "executed", the row was marked executed and the audit log said `decision.approved_and_executed`, but the provider received nothing and a second pending approval had been created. Approving that one did the same again.
- Cause: `lib/decide-approval.ts` re-ran the call as a brand-new call. The gate runs a held send, payment, signature, publish, delete or command only when the call returns as the approved row (`approvedPendingActionId`, documented as "set only by the approval executor"), and nothing in the app ever set it. It also passed the approving person as `userId`, which the executor does not read (the gate reads `actorUserId`), so a payment approval would have been refused for having no approver and an approved send during quiet hours deferred as if no person had approved. Reads, drafts and ordinary writes were unaffected, which is how this was missed.
- Fix: re-enter with the row id, the approving person, source `approval`, and the employee that asked (only when the stored id is well formed), so that employee's tool card still applies.
- Second defect in the same function: only a thrown error counted as a failure. A result with status `error` or `pending_approval` (a provider failure, or a gate refusal such as a paused team) was stored as `executed` with a success audit entry. Now `execution_failed`, and the person sees one plain sentence (a provider's status code and raw reply are removed).
- Proof: 11 new unit tests (the row id, approver and employee are passed; error, held-again and gate-refusal results are failures; no internal text reaches the person; a real success is still executed). Harness flows F3 to F6 against the real stack: exactly one send reaches the provider, with the edited text when edited; no new approval appears; approving twice is refused; a provider 500 is recorded as `execution_failed` with no `approved_and_executed` audit row. Before the fix the same run showed the provider receiving nothing and a third pending approval.
- Not changed, now open in `gap26sept/decisions.md`: approving in the chat card and then again in Decisions are two approvals for one action (the chat asks first, then the gate holds the call again as a database approval). Which one should be the single approval is a product decision.

## Trust page: how far the team can be trusted to act alone, and the evidence (2026-10-06)

- New page `/trust` (sidebar and phone menu; a test now fails if a sidebar page is missing from the phone menu, which found this page missing at first). It shows the level and what that level lets the team do, what moving up needs with the measured progress, the watching-mode decisions waiting for a yes or no, each employee's last 30 days (a small sample is labelled too small to judge, never shown as a percentage), the history of level changes with who and why, and pause and resume buttons (a customer had no way to pause their own team).
- `GET /api/trust` is one read of all of it for the session's workspace, with `canManage` and `canReview` so the page hides buttons a role cannot use.
- The "what each level allows" table is data (`lib/trust-levels.json`) and `trust-levels-parity.test.ts` in the workflows package runs the real gate for every level and every action class and fails if the table is wrong. Writing it caught a mistake in my first draft: at level 0 payments and deletions are sent for approval, not merely recorded, because the gate checks "irreversible" before the level.
- Findings, stated on the page and in `gap26sept/autonomy.md` (rows 9 to 11), not changed here:
  - Levels 2 and 3 allow exactly what level 1 allows. Anything that sends, pays, signs, publishes, deletes or runs commands is parked for approval before the level is consulted, so earning a higher level unlocks nothing today. Which actions earned trust should unlock is a product decision. The page says so.
  - The Health page's "Approval rate" is `executed ÷ escalated`, not approved ÷ decided. The Trust page uses approved ÷ decided by a person and labels it differently.
  - Nothing writes `outcome_feedback`, so undone actions and complaints cannot count for or against an employee. The page says they are not tracked yet and never shows them as zero.
- Proof: 16 page tests plus 3 for pause and resume, 5 route tests, 6 level-table tests, 3 gate-parity tests, 2 navigation tests. Real browser against the sandbox database, 34 of 34: level and rows; watching-mode answers saved with who answered and surviving a reload; a forged request with 999 reviews refused; an early move recorded as an override with the reason, the evidence and an audit entry; pause drops to level 0 and is in the history; resume; no sideways scroll at 390 px and no control under 24 px. Dashboard 902 of 902 (plus 11 database tests when a database is present), workflows 549 of 549, `tsc` and lint clean.
- Not verified: a real model producing real proposals (the evidence in the browser run was seeded), real devices, Safari and Firefox.

## Earned autonomy: the server counts the evidence and every level change is recorded (2026-10-06)

- What was wrong: `PATCH /api/org/rollout` asked the browser for the evidence (weeks in stage, divergences, approval rate, decisions) and checked the answer, so anyone allowed to change settings could type their way up, and `force` skipped the check. The first stage's evidence (`shadow_reviewed`, `shadow_agreed`) was never written by anything, so leaving level 0 was only possible by forcing it. Nothing recorded who changed a level, and pausing silently reset it to 0.
- Migration 211: `agent_shadow_reviews` (one operator answer per watching-mode decision, changeable) and `org_autonomy_stage_events` (every change with the measured evidence). Both forced RLS, hardened policy, read granted to `darex_sql_reader`; both added to the data-erasure list. `check-rls-coverage` caught the missing reader decision before this was committed.
- `lib/trust-query.ts` counts everything in SQL for the session's workspace: decisions on parked actions per employee (approved as is, approved after editing, turned down, expired, failed to run), watching-mode reviews, open divergences, when the stage began. `lib/trust-evidence.ts` turns counts into a recommendation (advance, hold, pull back) and refuses to judge fewer than 10 decisions. `lib/employee-rollout.ts` now exports the exit requirements, tested against `canAdvanceStage` over a grid of inputs so the two cannot disagree.
- `PATCH /api/org/rollout` now ignores any numbers in the body. A move up needs the measured evidence, or `force` (still allowed for owners and admins) which is stored as an override with their reason and the evidence at that moment. One level at a time; refused while paused; a level that is not 0 to 3 is a 400 (it used to become 0). Level and history are written in one transaction, and the change goes to the audit log as `settings.update`. `GET /api/org/rollout` keeps its shape; the review counts now come from the review table.
- `GET` and `POST /api/trust/shadow`: list what is waiting for an answer and record an answer. Approvers only; a decision from another workspace, or one that was not a watching-mode decision, is a 404.
- Pausing from the app (`writeKillSwitch`) records the drop to level 0.
- Behaviour change to know about: the body fields `weeksInStage`, `stateDivergences`, `approvalRate`, `decisionsInStage` and `shadow*` are ignored (they were the bypass). The live frontend is a separate repo I cannot see; if it sends them, nothing breaks, they are just not used.
- Proof: 14 route tests (forged evidence refused, override recorded, atomic write, audit entry), 8 review-route tests, 17 evidence tests, 7 requirement tests, 5 pause-history tests, 4 for the sentence helper; 11 tests against a real migrated database as the application role with two workspaces (`TRUST_DB_TEST=1`, run in the CI isolation job); `check-rls-coverage` 11 of 11; the data-erasure coverage test 7 of 7; migration applies twice as a no-op.
- Not done: a pause by Darex support goes through the platform role and is recorded in the platform audit log, not in this history (the page then dates the level as approximate). The pull-back thresholds are starting values no production data has tuned.

## Watching-mode decisions keep a plain sentence (2026-10-06)

- In watching mode (level 0) a call that would have had a side effect is recorded and not run. The ledger kept only "suppressed via shadow_stage" and the raw call, so there was nothing a person could be asked "would you have done this?" about.
- The gate already builds one plain sentence for every call (the one on an approval card). It now passes that sentence to the ledger for watching-mode decisions only, and `writeLedgerRow` stores it as `context_payload.summary`. Other ledger rows are unchanged.
- Proof: 2 new gate tests (the sentence is kept on a watching-mode send; no other decision carries one); the 34 gate and confirm tests pass.
- Not changed: rows written before this have no sentence; the review list shows the action in words for those.

## Small controls are big enough to tap on a phone (2026-10-05)

- Measured in a real browser at 375 px wide across 34 pages: no page scrolls sideways, but 143 controls were under the 24 px minimum of WCAG 2.2, and five repeated controls accounted for about 120 of them ("Test & details", "View Details & Test", "Connector Settings", "Connect missing tools", the banner's dismiss button).
- One touch-only rule in `app/globals.css` (`@media (pointer: coarse)`, so desktop is unchanged) gives `.touch-target` a 44 px minimum height and width, and those five controls carry the class.
- Proof: `touch-targets.test.ts` (6 tests); the same browser run now finds 22 controls under 24 px (from 143) and 340 under 44 px (from 461).
- Not fixed: the remaining 22 (small links in cards, two 13 px checkboxes) and the 340 that are under the comfortable 44 px, mostly dense lists and chips. Not verified: real devices (Chromium touch emulation only).
## Chat coverage matrix exists and CI keeps it complete (2026-10-09)

- `AGENTS.md` and the ASK-G01 audit row pointed at `gap26sept/chat-coverage.md`, which did not exist, so nothing tracked whether every tool and tab action can be done from Ask AI. `services/workflows/src/scripts/chat-coverage.ts` (`pnpm --filter @darex/workflows chat-coverage`, after a build) now writes it: one row per chat tool (154, with provider action, risk and whether approval is required) and one per mutating dashboard API route a tab calls (83; webhooks, auth, the chat itself, the public widget and platform admin excluded). Regeneration keeps any status cell edited by hand, and new rows start 🔴.
- `chat-coverage.test.ts` (in the workflows test run) fails when a tool or route has no row or a row is stale, and checks that hand-set statuses survive regeneration.
- Every row is 🔴: none has been proved live from `/ask-ai` yet. Tab-action rows don't yet name the chat tool that covers them.
- Verified: workflows tests pass, including the 2 new ones. This change is docs and tooling only; runtime behaviour is unchanged.

## Instagram DMs read and reply from Ask AI (2026-10-09)

- Chat had no Instagram tools: inbound DMs reached the inbox and the auto-reply agent, but Ask AI could neither read them nor answer one. New `instagram` tool module with `instagram_list_messages` (stored DMs, `messages.channel_key = 'instagram'`, RLS-scoped, optionally one contact by IGSID) and `instagram_send` (Graph `/{ig_user_id}/messages`, send-risk, approval first). Credentials come from the connected `instagram` channel meta (same keys as `channel-outbound.ts`), else `META_ACCESS_TOKEN`; a connected channel puts the tool on the turn allowlist through `mergeRuntimeAllowlist`.
- The send refuses outside Meta's 24-hour window (no inbound DM from that contact in 24 h) and refuses a recipient id that is not a numeric IGSID before anything reaches a Graph URL. Inbound HITL and dashboard confirm classes treat it as a send.
- Verified: 487 `@darex/workflows` tests (new cases in `messaging-actions.test.ts`: IGSID validation, risk of both actions, tool-to-action wiring) and 625 dashboard tests, dashboard typecheck. Not verified: a live list or send against a real Instagram account. A chat-sent DM is not written back to `messages` (the WhatsApp chat send behaves the same).

## Outlook, Slack and WhatsApp read and reply from Ask AI (2026-10-06)

- Chat could send on these channels but not read or answer a conversation. Outlook was list and send only; Slack could post but not see channels or threads; WhatsApp could only send.
- Outlook: `outlook_list_messages` takes a search `query`, new `outlook_read_message` (full body as text), `outlook_reply` (Graph `reply`/`replyAll`, approval first), `outlook_draft_reply` (`createReply`/`createReplyAll`), `outlook_send` takes bcc and comma-separated `to`. Message ids are validated and URL-encoded before reaching Graph.
- Slack: new `slack_list_channels`, `slack_read_thread` (`conversations.replies`) and `slack_reply_thread` (posts with `thread_ts`, approval first; needs an explicit channel, never the ops fallback). `slack_read_channel` takes a limit. The thread action is named `send_reply` on purpose: "thread" contains "read", so a name like `reply_in_thread` was classed as a read by the risk check, which a test caught.
- WhatsApp: new `whatsapp_list_messages` reads stored inbound and outbound messages (`messages.channel_key = 'whatsapp'`, RLS-scoped), optionally for one phone matched on its last 10 digits. Replying stays `whatsapp_send`, which already goes to approval.
- Inbound HITL treats `outlook_reply` and `slack_reply_thread` as sends.
- Verified: 485 `@darex/workflows` tests (new `messaging-actions.test.ts`: search URL, id validation, Slack ts, phone key, the risk class of every new action, tool-to-action wiring) and 625 dashboard tests. Not verified: live calls to Graph, Slack or the WhatsApp query against a real database. The Slack token may lack `channels:read` and `groups:history`; Slack then returns a clear `missing_scope` error.

## Gmail reply-all from Ask AI (2026-10-06)

- `gmail_reply` and `gmail_draft_reply` take `reply_all: true`. The reply goes to the sender (Reply-To, else From) and copies everyone else on the original To/Cc. The connected account's own address (from the Gmail profile) and duplicates are dropped. When you reply-all to your own sent mail, the first person you wrote to becomes the main recipient. An explicit `to`/`cc` from the caller still wins or is added.
- Verified: new `replyAllRecipients` / `parseAddressList` tests (quoted names with commas, case-insensitive self and duplicate removal, own sent mail, Reply-To). Not verified: a live reply-all against Gmail.

## Keyboard focus is visible everywhere; reduced motion is honoured (2026-10-05)

- Measured with Tab in a real browser across 11 pages: of 169 keyboard stops, 6 showed no outline or ring (the sign-in and sign-up fields and the conversation reply box), because the screens clear the outline with `outline-none` and nothing replaces it.
- One rule in `app/globals.css`: a 2 px outline on `:focus-visible` for links, buttons, fields and tabbable elements, with the pseudo-class doubled so it beats `.focus\:outline-none:focus`; script-focused `tabindex="-1"` elements are left alone. A `prefers-reduced-motion` block removes animation and transition time. The skip link already existed in the app shell.
- Proof: `focus-and-motion.test.ts` (4 tests); the same Tab run now shows 0 of 169 stops without a visible focus.
- Not verified: Safari and Firefox; contrast ratios and screen-reader flow need a person.

## A page whose scripts fail to load now says so (2026-10-05)

- A server started before a rebuild kept serving old pages whose script files no longer existed: the page loaded (HTTP 200) and looked normal, then nothing responded to clicks, and nothing on screen said why. Reproduced here: the page's own script file answered 400.
- `lib/load-guard.ts` is a plain inline script in the server-rendered `<head>` (so it runs even when every other script is missing). It shows a banner with a Reload button when a `/_next/` script or style file fails to load, or when the page has not come alive after 12 s; `<AliveBeacon />` marks the page alive once React takes over and removes the banner if a slow start already raised it. One banner at most, and a failed image or third-party script is ignored.
- Proof: 9 unit tests; in a real browser the check (healthy, page script 404, all scripts blocked, all scripts delayed 3 s) went from 2 of 6 to 6 of 6. A slow page is not warned.
- Not verified: Safari and Firefox (Chromium only); a real cached-stale-build incident on a laptop.

## Gmail read, reply and reply-draft from Ask AI (2026-10-05)

- Gmail gains `read_email` (one message in full by id), `reply_email` (sent in the original thread with `In-Reply-To`/`References`, `Re:` subject, to the Reply-To/From unless `to` is given; send-risk, approval first) and `draft_reply` (same, saved as a draft). Chat tools: `gmail_read_email`, `gmail_reply`, `gmail_draft_reply`; `gmail_send` takes cc/bcc. Before this, chat could only start new emails, so "reply to that email" produced an unthreaded message or a refusal.
- All outgoing mail goes through `buildRawEmail`, which strips CR/LF from model-supplied headers (no header injection), RFC 2047-encodes non-ASCII subjects and base64-encodes the body. Message ids are validated before reaching a Gmail URL. Inbound HITL treats `gmail_reply` as a send.
- Verified: 476 `@darex/workflows` and 625 dashboard tests, including new Gmail cases (header injection, unicode subject, threading headers, `Re:` once, action risks). Not verified: a live read, reply or draft against a real Gmail account, because no local stack was running.

## Below the skill tier minimum a call asks for approval instead of failing (2026-10-05)

- "Send an email" from chat failed with `Action blocked: autonomy tier 1 is below skill minimum 2 for "gmail"`. The skill-tier check in `tool-gate.ts` refused every non-read call, including drafts, and also ran on the approval executor's re-entry, so even a human-approved send could never execute. Below the skill minimum a call now parks for approval (reason `skill_tier`; sends already park as `confirm_class`), drafts are not tier-checked (they reach nobody), and an approved re-entry skips the check.
- Verified: `@darex/workflows` tests, including new gate cases (below-tier send parks, non-confirm write parks as `skill_tier`, draft runs, approved send runs). Not verified: a live send through the deployed chat, because no local stack was running.

## Connector tokens go only to the workspace's own host (2026-10-02)

- Connectors: `shopify.ts` and `zendesk.ts` built the request host from the model-written payload first and then attached the workspace's token (`attacker.example/x?` in the Zendesk subdomain redirected it). `tools/host-guard.ts` now makes the connection's own host win, accepts a payload host only if it names that same store, REFUSES a payload host when the workspace has no recorded store (anyone can register a free Shopify or Zendesk store, so a valid-looking host proves nothing; such a workspace must reconnect), treats a recorded but unusual value as an error instead of falling through to the deployment default (`pickTrusted`), and every outbound call uses `redirect: 'error'` (fetch forwards custom headers such as X-Shopify-Access-Token on a cross-origin redirect).
- Proof: 24 unit tests (`host-guard.test.ts`), listed in the workflows `test` script.
- Not verified: real Shopify or Zendesk calls.

## Model-written SQL runs as a restricted, read-only role (2026-10-02)

- Found by running the repo's own migrations (001-206) and the compiled SQL tool as one tenant with fake secrets: `database_query` ran as the full application role behind a keyword filter. It was accepted and returned another tenant's email and password hash (`auth_lookup_user_by_email`, a SECURITY DEFINER helper), the caller's own password hashes, webhook secret (`orgs.meta`) and channel token (`channels.meta`), and hashes through `query_to_xml(...)`. Writes, `set_config`, `pg_*` and multi-statement queries were already refused. 17 of 42 attack queries executed. `database_query` is in the always-allowed core tools (tool-gate.ts), so no approval stood in front of it.
- Fix, three layers that each hold without the one before: `tools/sql-guard.ts` (a tokeniser that fails closed, with SECURITY DEFINER names read from `pg_proc`), a READ ONLY transaction with a statement timeout and a result bound applied inside Postgres, and migration `207_sql_reader_role.sql` (NOLOGIN `darex_sql_reader`, entered with `SET LOCAL ROLE`: column-level SELECT on tenant tables minus the credential columns, no write, no `set_config`, no EXECUTE on any SECURITY DEFINER function; PUBLIC's EXECUTE on those functions and on `set_config` is revoked after darex, darex_app and darex_platform are granted it explicitly). `tools/org-limiter.ts` caps concurrent SQL calls per workspace at 3 (`SQL_TOOL_MAX_CONCURRENT_PER_ORG`); `SQL_TOOL_TIMEOUT_MS` defaults to 10 s. `SELECT *` on a table with a withheld column is refused and the tool tells the model to name columns. If 207 is not applied the tool refuses rather than running as the application role.
- Also in 207: every view is made `security_invoker` (none exist today), and the app role loses CREATE on `public` (`infra/db/init` no longer grants it).
- Proof: `infra/scripts/check-database-query.js` (41 assertions, reads rows back instead of trusting the tool) and `check-rls-coverage.js` (11; fails on a view that is not security_invoker, a tenant table without forced RLS or a grant decision, a SECURITY DEFINER function the reader can run, and any credential-looking column the reader can read), both now in the CI `isolation` job. Against the original `database.ts` the SQL check fails 15 of 40 (credential reads, helper call, unbounded flood). Four planted schema defects each fail the RLS check. From an empty database: 84 migrations apply and re-run as a no-op, the isolation suite passes, workflows `tsc`, dashboard `tsc`, and 490 workflows unit tests pass (the three new test files are also listed in the `test` script in `package.json`, which runs an explicit file list and would otherwise skip them).
- Review fixes (a code review of this change found these, each now covered): one trailing `;` is accepted (models write it constantly); `lo_*`, `dblink*` and `crosstab*` are refused only when called, so a column such as `lo_reason` stays readable; a failed ROLLBACK marks the connection for destruction so the next tenant never inherits a half-open reader-role transaction; a `42501` from `SET ROLE` gives the operator a migration message instead of telling the model to "name the columns"; the SECURITY DEFINER name cache is 60 s, not 5 minutes. A SECURITY DEFINER function added by a later migration is executable by PUBLIC (so by the reader) until revoked; `check-rls-coverage.js` fails the build until it is, and the guard's own list picks it up within a minute.
- Not verified: a real model, the live stack, the dashboard unit tests and lint, and migration 207 on a copy of production data. Before applying 207 to a shared database run `\du` and check no other login role relied on PUBLIC's EXECUTE on `set_config` or on a SECURITY DEFINER function. A NEW credential column on an already-granted table is readable until withheld; the RLS check now fails on that.

## Ask AI shows one plain sentence when an AI turn fails (2026-10-05)

- Ask AI: a failed turn used to put "I encountered an issue while processing your request: <internal reason>" and a step named "TrueForge Agent Turn" into the chat, and the route forwarded `result.error` to the browser. `services/workflows/src/turn-failure.ts` now supplies one plain sentence; the reason stays in `error` (retry logic) and in the logs; the route passes any forwarded error through `publicErrorMessage` (`ask-ai-error-forwarding.test.ts`).
- Proof: 4 workflow tests (all failed first), the route contract (5 offenders before, 0 after), workflows 479 of 479 on a clean copy, and the real-browser first-run journey passes 6 of 6 with a clean answer area.
- Not verified: a real provider failure; the live site.

## First-run experience: plain wording and explained failures on every customer screen (2026-10-05)

- Against company main 9d141bc. Customer-facing screens and shared components only.
- Wording: customer screens named internal parts ("Nango", "Temporal", "Langfuse", "RLS", "Postgres", "notConnected", "Phase 3 Ready", a hard-coded `localhost:3000` webhook URL). 67 hits in source at the start; `lib/__tests__/customer-vocabulary.test.ts` now reads all customer-facing source and fails on any developer term. Two terms are allowed with reasons (Settings webhook URLs that the customer pastes into Meta/Chatwoot; the word "tenant" in real estate). The operator console under `app/(platform)` is not scanned.
- Failures: the client now answers a dropped connection, a rate limit and an empty 500 with a plain sentence (`lib/client-error.ts`: `responseErrorMessage`, `networkErrorMessage`). Before: 16 of 164 browser fetch calls were unguarded (onboarding saves, password reset, invites, listings, showings, growth decisions), 32 on-screen errors passed `err.message` through ("Failed to fetch"), 26 messages carried an HTTP status, and five pages (insight, plans, skills, brain, billing) showed an empty list or nothing when their request failed. Contracts: `client-fetch-contract`, `client-error-display-contract`, `app/(dashboard)/__tests__/load-failure.test.tsx` (15 tests, 13 failed first).
- Recovery pages: forgot-password, reset-password and invite never ended in a stuck button or an endless spinner when the connection dropped; forgot-password no longer says "we sent a reset link" when the server answered 429 or 5xx.
- Onboarding: the last step has a hint when no channel is chosen, and no longer shows "Unexpected end of JSON input" on an empty failure.
- Proof: dashboard 790 tests in 120 suites, `tsc` clean, production build passes. Real browser (headless Chromium) on the built server: 0 developer words on 31 screens; 29 of 29 pages handle a server error, a rate limit and a dropped connection (the four onboarding forms are covered by unit tests); 31 of 31 pages load by clicking with no script error. The six-step first-run journey needs the next commit (the failed-turn sentence) to pass its last check.
- Operational note: a server started before a rebuild serves old pages whose script files no longer exist; the page loads (200) and nothing responds to clicks. Restart the server after every build.
- Not verified: the live frontend (separate repo), a hosted model, the production server.

## Temporal outages cost one request, not every request (2026-10-05)

- `getTemporalClient` started a fresh connect on every call, so with Temporal down each request that needed it hung for the 5 s connect timeout before the direct fallback ran (`/api/brain/reindex` and `/api/dsr/export` took 5.0 s each, every time). `createLazyConnector` (`temporal-connect.ts`) shares one attempt among concurrent callers, caches a success, and after a failure answers null at once for `TEMPORAL_RETRY_BACKOFF_MS` (default 10 s). `TEMPORAL_CONNECT_TIMEOUT_MS` (default 5 s) is unchanged. 7 tests; workflows suite 475 before, 482 after. Measured end to end with Temporal down: 4 sequential requests took 4,992, 24, 16 and 21 ms (before: about 5,000 ms each).
- Not verified: behaviour against a real Temporal restart.

## The TrueForge proxy no longer forwards caller identity, cookies or stale encoding headers (2026-10-05)

- TrueForge proxy (`/api/trueforge/*`, new upstream): the tenant's own identity headers were forwarded from the caller whenever the session scope could not be established, the caller's cookie and Authorization header were passed to the upstream service, upstream Set-Cookie and a stale `content-encoding` were passed back, and encoded `..` segments were not refused (no practical effect today: the proxy already exposes every upstream path to any signed-in member). Four of six route tests failed on the original; all pass now, and a run over real HTTP against a fake gzip upstream confirms each point. Not changed and worth a decision: every authenticated member can reach every path of the TrueForge HTTP API through this route.
- Proof: 23 tests (4 of 6 route tests failed on the original) and 9 of 9 checks over real HTTP against a fake gzip upstream.
- Not verified: the live site; the per-path allowlist is a design question for the owners.

## The API boundary: bad input answers 4xx, errors are logged and not leaked (2026-10-05)

- Against company main 9d141bc (5 Oct, Next 15.5 and React 19).
- Request bodies: 53 routes answered 500 for `null`, malformed JSON or NUL characters. Every route now reads its body with `jsonBodyOrEmpty` (`lib/safe-json.ts`); `route-body-contract.test.ts` fails the build on a bare `request.json()` (it caught the two e-mail verification routes added upstream the same day). Sign-up: e-mail over 254 characters is refused before the pattern runs; passwords 8 to 1024. Ask AI: prompt over 100,000 characters answers 413 (`ASK_AI_MAX_PROMPT_CHARS`).
- Races: 12 parallel backfills answered 11 x 200 and 1 x 500 (check-then-insert on the default autonomy rules); two simultaneous saves of one autonomy rule had the same shape. Both now tolerate the unique violation.
- Errors: 34 routes copied `err.message` into their response, which can carry a database host and port, a table or constraint name or a setting name. `publicErrorMessage` (`lib/public-error.ts`) keeps what a person can act on and hides the rest; `route-error-body-contract.test.ts` enforces it. 54 catch blocks answered 500 and logged nothing; each now logs, and `route-500-logging-contract.test.ts` enforces it. `/api/analytics/cost` no longer returns Langfuse setting names to tenants.
- Proof (measured on a7b03fa, before the later commits in this series): dashboard 707 tests in 109 suites (584 before this work), `tsc` clean, lint unchanged, production build passes; fuzz of 3,298 requests: 0 critical, 0 high, 0 review, no HTTP 500; the 92 remaining 5xx are 502/503 answers where a dependency is not configured (TrueForge, Langfuse, Nango, Evolution, Meta signup).
- Not verified: the live frontend, a hosted model, the production server.

## The per-tenant webhook URL resolves again; a failed credential no longer falls through to the inbox map (2026-10-03)

- `POST /api/webhooks/chatwoot?org_id=<id>&token=<secret>` (the documented per-tenant URL) answered 400 "Cannot resolve organization" for a valid active org, so no message was stored and the agent never replied. `orgs` is FORCE ROW LEVEL SECURITY and the route resolves the tenant before any org context exists, but the `?org_id=` and `X-Darex-Org-Id` branches ran a plain `SELECT ... FROM orgs` on the pool. Measured: 4 orgs as owner, 0 visible to `darex_app`.
- Migration 210 defines `org_resolve_by_id_and_secret` (SECURITY DEFINER, active orgs only, empty secret refused, execute granted to `darex` and `darex_app`; idempotent, so a no-op replace where the function already exists). The route resolves Bearer, `?org_id=`+`?token=` and `X-Darex-Org-Id`+`?token=` only through definer functions, and a malformed id is a 400.
- Behaviour change, deliberate: a per-org credential that is presented and does not validate stops the request (400) instead of falling through to the inbox map named in the body (`?org_id=<B>&token=<A's secret>` could land in a third org that owned that inbox row). A tenant whose Chatwoot URL carries a stale token and only worked through the inbox map sees 400 until the URL is corrected.
- Proof: 10 route tests (4 failed before), 8 database assertions as `darex_app` (3 of 8 before the migration, 8 of 8 after), 11 of 11 over real HTTP, inbound end-to-end 8 of 8.
- Not verified: a real Chatwoot instance; the migration on a copy of production data.

## Next 15 upgrade follow-up: codemod leftovers, React 19 peers, params test (2026-10-05)

- The async-request-api codemod left `Promise<Promise<{ id }> | { id }>` types with `await Promise.resolve((await context.params))` in the listings, showings, packs config and integrations ping routes, plus `@next-codemod-error` comments on two re-exports. These are now plain `Promise<{ id }>` with `await context.params`. Both re-export targets (`employees/growth/page`, `api/listings` GET) take no params, so the warnings didn't apply.
- `@testing-library/react` 14 and `lucide-react` 0.368 declared React 18-only peers. Moved to RTL 16 (adds `@testing-library/dom` 10) and lucide-react 0.562, the version `@openuidev` already installs, so it dedupes. Every icon import still type-checks.
- New `lib/__tests__/route-params-async.test.ts` calls 11 dynamic handlers with Promise params. A valid id must reach auth and an invalid one must 400 first. Mutation-checked: un-awaiting `params` in one route fails its case.
- Verified: typecheck (also with no `.next/`), lint, 621 dashboard tests, `next build`, audit gate exit 0. `next dev` serves the auth pages (200) and they hydrate with no browser console errors, dashboard pages redirect (307), and dynamic API routes return 401. Not verified: signed-in pages, because the local Postgres/SuperTokens stack wasn't running.
## Email routing only claims inbox triage, not every message with "email" (2026-10-05)

- The routing rule added for email and inbox triage (to Emma / Customer Support) matched the bare words "email" and "gmail" at weight 0.88, so "Email the qualified lead the demo invite" (Sales outreach) and "Draft a reply to this ad-lead email" (Marketing) were taken from their owners and sent to Support; two `employee-capabilities` rows failed in CI. The pattern now needs inbox-triage phrasing (inbox, mailbox, recent/unread/new/latest emails, emails in Gmail, triage/check/fetch my email or inbox). The three triage examples from the original change still route to Emma, and a new test asserts that writing or sending an email does not.
- Verified: 470 `@darex/workflows` tests and 603 dashboard tests pass with a fresh workflows build (the dashboard test reads the built `dist`, so a stale build hides this). Not verified: live Ask AI routing on real phrasing beyond these examples.

## Deleting a Cognee dataset keeps its marker until the delete succeeds (2026-10-05)

- A branch change in `deleteCogneeDataset` removed the org's "dataset present" marker before calling Cognee's delete. If the delete then failed, the marker was gone while the dataset still existed, so search skipped that org's data and the next DSR delete could not find it; `memory/cognee-client.test.ts` ("keeps the dataset marked present when the delete fails") caught it and failed the branch's CI unit-test step. The marker is again removed only after the delete returns ok or 404.
- Verified: all 468 `@darex/workflows` tests pass after merging main into the branch. Not verified: a delete against a real Cognee instance.

## A server checkout with commits that are not on origin/main is refused (2026-10-05)

- A redeploy failed in the worker image build with duplicate `hasCogneeDataset` / `DATASET_CACHE_TTL_MS` declarations in `cognee-client.ts`: the server's checkout had both its own agent-written version and the one on `main`, which happens when `main` is merged into a server branch and the conflict is resolved by keeping both sides. `main` itself had one definition and CI was green.
- `redeploy.sh` ran `git merge --ff-only origin/main`, which reports "up to date" when the checkout is ahead of origin, so commits made on the box (and merge commits from `git pull`) were built and deployed untested.
- New `require_in_sync` (`deploy/lib.sh`) runs right after the merge in `redeploy.sh` and `deploy.sh`: if `origin/<branch>..HEAD` has any commit it stops, names up to five of them, and prints the recovery (`git branch backup-<date> && git reset --hard origin/main`). `ALLOW_LOCAL_COMMITS=1` deploys them anyway with a warning, for a deliberate hotfix. A checkout that is only behind origin still fast-forwards.
- Verified: `tests/deploy-sync-guard.sh` (9 checks on real temporary git repos: in sync, behind, a commit on the server refused and named, override warns, a `git pull` merge commit refused, clean after reset) runs in CI. Not yet verified: on the VM itself.

## The dashboard runs on Next 15 and React 19 (2026-10-05)

- Next 14.2.35 carried two critical and eight high advisories (fix needs 15.5.24+), which the CI audit gate had been allowlisting. `apps/dashboard` now uses Next 15.5, React 19 and eslint-config-next 15. The `@next/codemod` async-request-api pass changed `params` to a promise in 11 route/page files (the rest already used `await cookies()`), the obsolete `experimental.instrumentationHook` flag is gone, `BottomTabs` keeps a plain `<a>` for the sign-out endpoint (a `Link` would prefetch it) with a lint exemption, and the connectors link in `ActionPermissionCard` is now a `Link`.
- The allowlist in `infra/scripts/audit-gate.js` is down to `braces` (no upstream patch). Production advisories: 2 critical and 9 high before, 0 critical and 1 high (`braces`) now.
- Verified: typecheck, `next build`, all 599 dashboard tests, the audit gate exits 0. `next dev` serves `/login` (200), redirects `/` to login (307) and answers API routes (401 unauthenticated); `next start` without production secrets stops at the `MCP_BRIDGE_SECRET` boot guard, so the instrumentation hook still runs. Not verified: signed-in pages and flows, React 19 behaviour in third-party UI packages beyond the build, and a deployed run.
- nodemailer 10 (override) is only loaded by supertokens-node's SMTP delivery services, which the dashboard never configures; its `createTransport`/`sendMail` API was exercised with a JSON transport. A real SMTP send is untested because nothing sends through it. A global pnpm 11 prints a harmless "pnpm.overrides ignored" warning but runs the pinned 9.0.0; moving to pnpm 11 was tried and rejected for now (its minimum-release-age policy refuses nodemailer 10.0.15 and nanoid 3.3.20, published under 24 hours ago).

## CI dependency audit gates on production deps with pinned overrides (2026-10-05)

- CI's `Dependency audit` step (`pnpm audit --audit-level=high`) failed every push with 88 advisories (2 critical, 38 high); typecheck, build, tests, the RLS suite and the deny-list job were already green. Root `package.json` now has `pnpm.overrides` for axios, fast-uri, @grpc/grpc-js, nanoid, postcss, nodemailer (6 to 10, pulled in by supertokens-node), hono, ip-address, qs and yaml, and the lockfile is regenerated. Production advisories drop from 88 to 25 (9 high, 2 critical).
- The step is now `node infra/scripts/audit-gate.js`: it audits production deps only and fails on any high/critical advisory not in its allowlist. pnpm 9.0.0 (the pinned `packageManager`) ignores `pnpm.auditConfig.ignoreGhsas`, so the allowlist lives in the script. Accepted for now: the Next 14.2.35 advisories (fix is the Next 15.5.24+ major upgrade of apps/dashboard, not done) and `braces` (no upstream patch). Dev-only advisories (jest, eslint) are no longer gated.
- Verified: the gate exits 0 locally with pnpm 9.0.0 and the new lockfile. Not verified: a CI run after the push, the dashboard build and tests with the overridden versions, and a real email send through nodemailer 10 from supertokens-node.

## A guard stops Darex from taking another project's ports (2026-10-05)

- The VM also runs mtip (80/443, 47020-47544), WA-AKG (3030, 3306), TrueForge (8085, 8791) and openclaw (18789). Nothing checked Darex's ports against them: `deploy.sh` ignored every Docker proxy, and `redeploy.sh` had no check, so a clash only showed up as a `compose up` failure after images were built.
- `check_port_ownership` in `deploy/lib.sh` now runs in both scripts before any build or recreate. It reads the real ports from `compose config` and refuses when one is outside Darex's range (10000-19999, set in `deploy/ports.conf`), in `OTHER_PROJECTS_PORTS` (18789 openclaw), used twice, or already held by anything that is not a `darex-*` container (it names the holder). Our own containers holding a port is fine: they are about to be replaced.
- SearXNG moved from 8088 to 18088 (`SEARXNG_HOST_PORT`) so every Darex port is in the range; nothing on the host used 8088, services reach it as `searxng:8080`. A server `.env` that still sets `DASHBOARD_PORT=3000` or `EVOLUTION_PORT=8086` now fails the guard instead of silently keeping the old ports.
- `tests/deploy-port-guard.sh` (10 cases against stubbed compose/ss/docker: clean, own containers, below range, above range, reserved, duplicate, other project's container, host process, substring port, `.env` override) runs in CI. Also run against the real prod compose config: passes, and DASHBOARD_PORT=3000, MCP_BRIDGE_HOST_PORT=18789 and EVOLUTION_PORT=47033 are each refused.
- Not yet verified: the live holder check on the VM itself (it runs on the next redeploy).

## Cognee search skips orgs that have no dataset yet (2026-10-05)

- Every agent turn paid for a slow Cognee `/search` even for an org that has no Cognee dataset. `hasCogneeDataset(orgId)` now reads `/api/v1/datasets` (2 s timeout) and `searchCognee` returns `[]` without searching when Cognee answered and the org has no `org_<id>` dataset.
- Safety: any doubt searches anyway (HTTP error, timeout, thrown fetch, a list that is not an array of named datasets). A cached "no" is re-checked after 5 s because another process may have created the dataset; a cached "yes" lasts 30 s. `rememberCognee` marks the dataset present at once; `deleteCogneeDataset` only forgets it after the delete succeeded. The check runs before the search timer starts, so it neither eats the search budget nor leaves a timer behind.
- Rewritten from the server's first version (its early return leaked the search timer, a failed delete hid live memory for 30 s, and a stale "no" from another process hid new memory). Its Hindsight change, a hardcoded `darex-hindsight-dev-key` fallback in `hindsight-client.ts`, was not taken: compose already provides that variable to the worker and dashboard.
- Verified: 7 new tests in `cognee-client.test.ts` (empty list, exact-name match, search skipped vs reaching Cognee, error / throw / odd shape all search anyway, 5 s recheck, remember, failed delete). Not yet verified: against a live Cognee.

## Unknown Nango connections no longer show as revoked (2026-10-05)

- A 400 or an "unknown connection" answer from Nango counted as `revoked`, so a connector that was never linked told people to reconnect it. `resolveNangoAuth` now treats only 401, `invalid_grant` and revoked or expired tokens as revoked; unknown connection or provider config is `never-configured`, and a token without the needed scope is `never-configured` instead of "no access token".
- The live probe passes the connector key and resolves the Google Workspace connectors through the umbrella Google login (`resolveGoogleAuth`).
- Origin: written on the server by an agent and run there; reviewed, re-authored and landed from the `vm-agent-fixes-2026-10-05` branch. Verified: workflows build, 461 tests including the new probe test. Not yet verified: the Connectors tab against a real Google account after redeploy.

## Redeploy rolls back a failed swap and builds the dashboard faster (2026-10-05)

- `next build` had no build cache, so every code change recompiled the whole dashboard (several minutes on the 2 vCPU VM). The dashboard Dockerfile now mounts a persistent `.next/cache` for the build; the install layer was already cached by lockfile and only reruns when `package.json` or the lockfile change.
- `redeploy.sh` already built every image before touching a running container, so a failed build left the old version serving. New: before building it tags each image it is about to replace as `<image>:rollback`. If anything after the swap fails (compose up, health checks, migrations) it restores those tags, recreates only those containers with `--no-build --no-deps`, waits for the site to answer, clears the "already built" stamp (otherwise the next run would skip the rebuild and redeploy the old image) and still exits non-zero. Migrations are not reversed; they are additive and idempotent.
- The frontend is no longer restarted on every run, only when its image was rebuilt; the restart was extra downtime for an unchanged image.
- Not zero downtime: dashboard and frontend are single containers, so a recreate is a gap of the container start time. True zero downtime needs two replicas behind the proxy (not built).
- Verified: shell syntax; the rollback function run against stubbed docker/compose/curl (restores tags, recreates, clears the stamp on failure; does nothing when disarmed or on success). Not yet verified: a real failing deploy on the VM.

## Production host ports live in one file, deploy/ports.conf (2026-10-05)

- Host ports were `${NAME:-default}` repeated across `docker-compose.prod.yml`, `deploy.sh`, `redeploy.sh` and `lib.sh`, so a port change meant editing several files and a missed one probed a dead port (Evolution health check defaulted to 8085 while prod binds 18085).
- New `deploy/ports.conf` is the only place a prod host port is set. `lib.sh` loads it for both deploy scripts, `infra/scripts/compose-cmd.sh` passes it to compose whenever a `--overlay` is used, and the prod overlay reads each name with `${NAME:?...}`, so a missing value fails the config instead of publishing a wrong port. A per-machine `.env` still wins because it loads after. SearXNG and Crawl4AI host ports are now `SEARXNG_HOST_PORT` / `CRAWL4AI_HOST_PORT` (dev keeps its 8088 / 11235 fallback).
- Port values themselves are unchanged. Caddy (the proxy in front of the stack) is not read by compose: its upstream still has to match `FRONTEND_HOST_PORT` by hand (`deploy/Caddyfile.example`).
- Verified: `compose-cmd.sh --overlay deploy/docker-compose.prod.yml config` renders all 22 published ports on 127.0.0.1 from the file; `FRONTEND_HOST_PORT=23100` overrides; with the file removed, config fails with "POSTGRES_HOST_PORT missing". Not yet verified: a live redeploy on the VM.

## Password signups verify their email address (2026-10-05)

- Signup created a working session for any address, typed or not. Migration `209_email_verification.sql` adds `users.email_verified_at` (every existing user is backfilled as verified, so turning enforcement on locks nobody out), a hashed single-use 24h `email_verification_tokens` table, and four SECURITY DEFINER functions (create, consume, mark, check) in the same style as password reset.
- Signup now emails a link to `/verify-email?token=...` (new page; `POST /api/auth/verify-email` consumes the token and audits `auth.email_verified`; `POST /api/auth/resend-verification` always answers OK so it cannot reveal which accounts exist). A signup that accepts an invite sent to that address is marked verified at once.
- Enforcement is opt-in: with `REQUIRE_EMAIL_VERIFICATION=true`, signup returns 202 `VERIFY_EMAIL` without a session and password login returns 403 `EMAIL_NOT_VERIFIED` (audited as a denied login). Without the flag the email is still sent but nothing is blocked, because a deploy with no `RESEND_API_KEY` could never verify anyone. OAuth/SSO logins are not gated: the provider verifies the address. Before migration 209 every check degrades to "verified".
- NEW-FRONTEND still has to handle the `VERIFY_EMAIL` and `EMAIL_NOT_VERIFIED` responses (show "check your inbox" plus a resend button) before the flag is turned on; the dashboard's own login page does not yet either.
- Verified: dashboard `tsc --noEmit` clean; jest 599/599 including new `email-verification.test.ts` (flag, hashing of the token, bad/expired/used tokens, pre-migration fallback, public paths). Not verified: migration 209 (no Postgres running here), the routes over HTTP, a real mail send, or the login gate end to end.

## Worker agent turns are traced in Langfuse (2026-10-05)

- Only dashboard routes traced turns. Turns the worker runs (inbound WhatsApp/email/SMS/widget replies via WorkItemWorkflow, crews, sweeps) used a no-op tracer, so the busiest customer-facing traffic never showed in Langfuse (27sept OPS-B03). Spend was already metered (`recordTurnSpend`).
- New `src/langfuse-trace.ts` posts the same ingestion batch as the dashboard helper (trace with the org as `userId`, plus a generation with token usage, duration and USD cost when reported). `runAgentTurnActivity` fires it after each turn, without waiting, with employee, conversation, tools used and step count; failed turns are level ERROR. It is not added to `runTrueForgeTurn`, which dashboard chat also uses and already traces. A missing config is logged once per process and an ingest failure is logged; neither affects the turn. The worker container already gets `LANGFUSE_HOST` and keys from compose.
- Verified: `langfuse-trace.test.ts` (event-level timestamp, trace/generation link, usage and cost mapping, config), workflows suite, typecheck. Not verified: ingestion into a running Langfuse (not up locally).

## Each embed job keeps its own text (2026-10-05)

- The text an embed job was about to embed lived in `knowledge_sources.metadata.pendingText`, one row per source. Conversation write-back queues a job on every message for the same source, so the second write replaced the first and both jobs embedded the later text; the earlier message was never indexed (27sept MEM-B03).
- Migration `208_ingestion_job_payload.sql` adds `ingestion_jobs.payload` (JSONB). The three places that queue text (worker `persistEmbedJobWithClient`, dashboard `enqueueEmbedJob` for the first part and for each `#chunk-N`) write the text on the job and no longer on the source row. Both worker claim paths read the job's payload first and fall back to `metadata.pendingText` only for jobs queued before 208. `markJob` clears the payload when a job finishes, so raw text is not kept. Brain re-index takes the newest queued job's text before the old metadata copy.
- Verified: typechecks, workflows 454/454, dashboard 594/594. Migration 208 applied locally; through the real `enqueueEmbedJobFromWorker`, two jobs queued back to back for one conversation kept their own texts and the source row held none. Rows deleted. Not verified: EmbedWorkflow embedding them (no Temporal/LiteLLM run).

## Stripe writes carry an idempotency key (2026-10-05)

- No provider write sent an idempotency key, so a Temporal retry of a plan step, or an approval executed twice, could create a second Stripe charge, refund, customer or payment link (27sept RT-B10).
- `providerIdempotencyKey` (`tools/shared.ts`) derives `darex-<sha256>` from org, a durable anchor (approved pending-action id, else workflow id), tool, action and the arguments (key order ignored). `invokeProvider` passes it on `ToolActionContext.idempotencyKey`; Stripe adds `Idempotency-Key` to its write POSTs (one per action). A call with no anchor (a chat turn, which RT-B03 no longer retries) gets no key, so identical but separate chat requests are not merged. Two identical writes in one plan do collapse into one at Stripe.
- Not done: Razorpay, Twilio and HubSpot. No idempotency header was verified for them, so none is guessed; plan steps there still rely on the per-step `claimIdempotent`.
- Verified: `provider-idempotency.test.ts` (same step same key, any field change a new key, no anchor no key), workflows suite, typecheck. Not verified: the header against Stripe (no test account; Stripe auth goes through Nango).

## The Gmail tool can search, not only read the latest emails (2026-10-05)

- `gmail_fetch` listed the newest N messages only, so "find the invoice email from Acme" read the last ten and hoped (27sept TOOL-G01).
- `gmail_fetch` takes an optional `query` in Gmail search syntax (`from:`, `subject:`, `is:unread`, `newer_than:`), sent as `q`. The URL is built by `gmailListUrl` (URLSearchParams encoding, query trimmed and capped at 500 chars, count clamped to 1..50). The reply message and `data.query` say what was searched. The tool description tells the model when to use it.
- Verified: `gmail-http.test.ts` (encoding, clamping, empty query), workflows suite, typecheck. Not verified: a live Gmail account.

## Ask AI plan, approval, mode and crew actions are audited (2026-10-05)

- Only plan approve and tool execute wrote `audit_events`. Cancelling a plan, editing its steps, approving or denying a paused tool in chat, changing who answers (Ask mode), and dispatching a crew left no record of who did it (27sept ASK-E01).
- Migration `207_audit_event_kinds_ask_ai.sql` adds `plan.cancel`, `plan.step_edit`, `tool.approve`, `tool.deny`, `crew.dispatch` to `audit_events_kind_chk` (full union of 150; `AUDIT_EVENT_KINDS` updated, pinned by `audit-events.test.ts`). Plan cancel and step edit (`api/ask-ai/plan`) record the actor; step edits store step ids, tools and on/off plus which steps had arguments edited, never the arguments. `api/ask-ai/approve` writes one row per decision before resuming and returns 500 without resuming if that fails, like `/api/decisions`. The Ask mode save runs every turn, so a `settings.update` (`setting: ask_ai.mode`, from/to) is written only when the mode or employees actually change. Crew dispatch from `/api/ask-ai` and `/api/agent/crew` records the manager and specialist employee ids. Failures on the non-approval paths are logged, not thrown.
- Verified: dashboard typecheck; `ask-ai-plan-rbac.test.ts` (cancel and step-edit cases, arguments absent), `ask-ai-approve-audit.test.ts` (per-decision rows, no resume when the insert fails), `audit-events.test.ts`; migration 207 applied to the local DB and all five kinds inserted (rolled back). Not unit-tested: the mode-change and crew-dispatch rows (large route; typechecked only).

## A chunked file becomes ready once its chunks are indexed (2026-10-05)

- Worker ingest stages a file, queues one embed job per chunk (`path#cN`, each with its own `knowledge_sources` row) and leaves the file's own row at `syncing`. `markJob` only updated the chunk rows, so every chunked Drive file showed "Syncing" forever and never got `last_synced` (27sept MEM-B01).
- `rollupChunkedSource` (`activities/embed.ts`) runs after any chunk job finishes and once more right after staging (all chunks may already be embedded via the hash skip). When no current chunk (`#c0`..`#c<chunkCount-1>`) is pending or syncing, the file becomes `ready` with `last_synced`, or `error` with "N of M parts failed to index". Leftover chunk rows from a longer earlier version are ignored; a disabled file is left alone. Each chunk's update commits before the rollup runs, so the last chunk to finish sees the others.
- Verified: typecheck, workflows suite; against the local Postgres: one of two chunks done left the file syncing, both done made it ready (a stale `#c2` error row ignored), one failed made it error with the reason. Rows deleted. Not verified: a real Drive file through EmbedWorkflow. Known gap: if every chunk is skipped before a row is written (all redacted away), the file stays syncing.

## DSR delete covers every org table, or names why it keeps it (2026-10-05)

- The DSR delete job (`dsr/tables.ts`) listed 36 tables; the schema has 89 with `org_id`. It left customer data behind: CRM entities and identifiers, real-estate inquiries/showings/listings, leases and charges, growth leads and dossiers, intent signals, tool invocations (arguments), failed webhook payloads, notification log, sentiment, feedback, and earlier memory text in `memory_revisions` (27sept SEC-C01, MEM-E01).
- New `CUSTOMER_DATA_TABLES` (25) joins the delete list (61 total). `DSR_RETAINED_TABLES` names the 28 kept tables with a reason: account (users, memberships, invites, push devices), configuration (employees, skills, packs, channels, connectors, widget) and legal records (audit, billing, the DSR request itself), because the org stays a working account. Deleting any of those is a product/legal decision, left open. `tables.test.ts` parses the migrations for `org_id` tables (matches the live schema, 89/89) and fails when one is in neither list; checked by removing one entry. The org soft-delete purge (`lib/org-purge.ts`) also clears `memory_revisions` and `sync_cursors`.
- Verified: workflows dsr tests 14/14, dashboard and workflows typecheck, every listed name exists in the live schema. All FKs onto the new tables are SET NULL or CASCADE, so the order cannot fail. Not verified: a full DSR delete run on a populated org. Still open: export covers fewer tables than delete; org purge does not call Cognee/Hindsight; Nango/Langfuse/SuperTokens/MinIO cleanup.

## A knowledge source can be disabled, and disabling hides its chunks (2026-10-05)

- Retrieval and the Brain list skip memory whose `knowledge_sources` row is `disabled`, but matched `ks.path = source_ref` exactly. Chunk memories carry `path#cN` (worker ingest) or `path#chunk-N` (dashboard embed), so a disabled file's chunks were still retrieved. Nothing could set `disabled` anyway, and every sync upsert wrote its own status over it (27sept MEM-B02).
- The six filters (`memory/retrieve.ts` ×4, `api/brain/route.ts` ×2) now also match the source_ref with the chunk suffix removed (`regexp_replace(source_ref, '#(c|chunk-)[0-9]+$', '')`), so a path with its own `#` is not cut. `PATCH /api/brain/source:<id>` takes `action: disable | enable` (owner/admin, org-scoped, 404 otherwise; enable sets `ready`). Every status write on `knowledge_sources` (ingest upsert and updates, embed `markJob` and upsert, dashboard embed upserts, reindex upsert) keeps `disabled` in place. NEW-FRONTEND Settings > Business has a Disable/Enable button and a "Disabled" chip per source (committed in that repo).
- Verified: `brain-source-disable.test.ts` (4 cases), both typechecks; on the local Postgres in a rolled-back transaction: after disabling, the whole-file row and both chunk formats were hidden and another file's chunk stayed visible, a re-sync upsert plus a `markJob`-style update left it `disabled`, and enable restored `ready`. Frontend: vitest (API client and component), tsc, eslint. Not verified: a browser click-through against the live stack.

## Contact enrichment runs through the tool gate (2026-10-05)

- After a HubSpot contact was created, `backfillContactFieldsActivity` read Gmail and wrote `update_contact` to HubSpot through the raw `executeProvider`: no allowlist, autonomy, approval or audit, and a failed write was swallowed with `.catch(() => undefined)` (27sept EMP-S02, the remaining CRM write).
- Both calls now go through `executeAutonomousToolAction`, injected by `tool-executor.ts` (no circular import), as the employee that created the contact (allowlist, role, employee id, actor, workflow id; `source: 'sweep'`). A HubSpot update that is denied, parked or fails is logged and returned as `reason: crm_sync_<status>`; the local entity update still stands.
- Still raw on purpose: operator-internal Slack/WhatsApp alerts in `activities/customer.ts` and `activities/open-loop-sweep.ts`.
- Verified: typecheck; ran the activity against the local Postgres with a recording executor: Gmail read and HubSpot write both went through it with the creator's allowlist and role, phone and title were filled from the signature, and a denied HubSpot write came back as `crm_sync_denied`. Test entity deleted. Not verified: a real Gmail/HubSpot account.

## A routed employee with no tools no longer inherits the webhook default's tools (2026-10-05)

- `routeEmployeeActivity` merged the router's pick with the caller's defaults. When the pick was a different employee whose card had no tools (a blank custom employee), it inherited the webhook default employee's allowlist and persona, so it could use Customer's Stripe/WhatsApp tools (27sept EMP-B02).
- `mergeRoutedForCaller` now falls back to the caller's allowlist and persona only when the routed employee is the caller's own (`CallerDefaults.employeeId`, passed from `params.employeeId`). Another employee keeps its own empty list, which downstream means core tools plus connected channels only (`mergeRuntimeAllowlist`), not everything. With no caller id, nothing is inherited. Name/role fallback for empty fields is unchanged.
- Verified: `route-employee.test.ts` (new EMP-B02 case; the existing fallback case now names the caller's employee), workflows suite 447/447, typecheck. Not verified: a live inbound webhook routed to a blank custom employee.

## Razorpay key secrets are stored encrypted (2026-10-05)

- The per-org Razorpay key secret was saved as plaintext in `channels.meta` (`keySecret`/`key_secret`), so anyone with DB or backup access could create payment links for that org (27sept RT-S04 / BIZ-S01; the WhatsApp half was already sealed).
- `POST /api/integrations/razorpay` now seals the secret with the same AES-256-GCM helper as the WhatsApp token (`sealSecret`, key `CHANNEL_SECRETS_KEY`), under both legacy names, with a `secret_hint`. It refuses with 503 before calling Razorpay when the key is not set. Readers open it at use: the agent's `razorpay` tool (a secret it cannot open is reported as "reconnect", never sent) and the connector test route (treated as not connected). Old plaintext rows keep working until `node infra/scripts/seal-razorpay-secrets.js [--dry-run]` seals them (idempotent, same shape as `seal-whatsapp-tokens.js`).
- Verified: `razorpay-secret-seal.test.ts` (sealed under both names, never plaintext, opens back, 503 without a key and Razorpay not called); dashboard and workflows typecheck. Ran the backfill on a temporary local row: dry run, seal, re-run skipped, value opens to the original; row deleted. Dev DB had no Razorpay rows. Not verified: a live Razorpay connect and payment link with a real key.

## A retried agent turn no longer re-runs tools the first attempt already ran (2026-10-05)

- `runAgentTurnActivity` (`AutonomousAgentWorkflow`, also the child turn of every inbound `WorkItemWorkflow`) has `maximumAttempts: 2` and catches its own errors, so Temporal retries it only after a 12-minute timeout or a dead worker. The retry re-ran the whole turn, so a send, charge or update from the first attempt could happen twice, sometimes while the first attempt was still running (RT-B03, the part still open after the failover fix).
- The activity now claims `wf:<workflowId>:<runId>:agent-turn:<activityId>` in `idempotency_keys` before running (`runGuardedAgentTurn`). Retries share the key and the workflow's own follow-up turns do not. A retry that finds a finished attempt returns its saved result. One that finds an unfinished attempt runs nothing and returns `turn_retry_held` (customer channels get the escalation holding reply), which `WorkItemWorkflow` turns into needs_attention. A claim error is thrown so Temporal retries the claim; only SQLSTATE 42P01 (table missing) runs unguarded. `isUndefinedTable`'s "does not exist" text match is not used here, because it also matches a missing role or database.
- Inbound redelivery was already deduped: the `WorkItemWorkflow` id is derived from the inbound event, and a second start gets the existing handle.
- Verified: `agent-turn-retry.test.ts` (8 cases), full workflows suite 446/446, typecheck. Also ran against the local Postgres `idempotency_keys` with a real org: the second call with the same key returned the saved result without running, and a concurrent call while the first was running was held. Probe rows deleted. Not verified: a real Temporal activity timeout and retry.


---

Older entries (2026-10-01 and before): `docs/archive/BUILD_STATE-2026-10-01-and-older.md`. Search it with grep, do not read it whole.
