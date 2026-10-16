# End-to-end flow harness

Drives real flows through the real dashboard server, the real tool gate and the real database, with no keys and no
network. Only the things outside our process are faked, locally:

| Fake | Stands in for | How |
|---|---|---|
| `fake-world.js` `/v1/chat/completions` | the language model | An OpenAI-compatible server. What it answers is scripted by the prompt: `[[call:gmail_send {...}]]` makes it call that tool; after a tool result it writes a final answer. |
| `fake-world.js` `/nango/...` | the connection broker | Says "connected" with a fake token, or "revoked" / "never connected" when a flow asks. |
| `fake-world.js` `/provider/<host>/...` | Gmail and other provider APIs | Records every call; can be told to fail. |
| `intercept.js` | the network | Preloaded into the harness dashboard server (`NODE_OPTIONS=--require`). Calls to a known provider host are rewritten to the fake. Nothing else is touched. |

The dashboard runs in-process agent turns when `DAREX_LOCAL_MODEL_BASE_URL` is set, so no workflow engine is needed.

## Run it

```bash
pnpm --filter @darex/dashboard build        # the harness starts the built server
DB_PORT=5432 infra/harness/run-flows.sh      # all flows
infra/harness/run-flows.sh F3                # only flows whose name contains F3
```

Needs a migrated Postgres (the same `DB_*` / `DB_RESOLVER_*` variables as the other `infra/scripts/check-*` scripts),
`psql`, and ports 3011 and 4999 (`HARNESS_PORT`, `WORLD_PORT`). It makes throwaway workspaces and deletes them.
If something already answers on either port, the run stops with that message: a stand-in or server left over from
another run would answer instead of the run's own copy, and 22 of the 91 checks failed that way once for reasons
that were not the product's.
The values it starts the server with are labelled `harness-only-...` and exist only for the run.

## What the flows cover

F1 a read runs and reaches the provider · F2 a send is held, nothing leaves · F3 approving sends it once and records it
truthfully · F4 reject · F5 edit then approve · F6 provider failure is recorded as failed · F7 watching mode records and
sends nothing · F8 a paused team does nothing · F9 another workspace cannot see or approve · F10 an auditor cannot
approve · F11 a revoked connection is reported honestly · F12 a customer message through to a stored reply · F13 a
message that tries to make the agent email an attacker sends nothing · F14 a dead approval card says so plainly · F15 a call denied in the chat card runs nothing and leaves no approval · F16 allowing in the chat card is the approval: one send, no second approval, a durable record · F17 a pause after the card still stops it · F18 an Allow covers only its own call · F19 a failure after Allow is recorded as failed · F20 an auditor cannot allow · F21 watching mode still sends nothing · F22 a double click sends once · F23 a two-person refund: the chat Allow is the first approval · F24 a member cannot allow a refund.

## What it does not cover

Real model answers and their quality, real providers (so it cannot catch a provider changing its API), workflow-engine
workflows (nurture, reminders, sweeps, data erasure), browsers, and anything that needs a real OAuth connection.

## Adding a flow

Add `flow('Fnn what should be true', async () => { ... })` to `flows.js`. `seed()` makes a workspace and a session
cookie, `ask()` / `chatApprove()` / `decide()` / `inbound()` call the real routes, `providerCalls()` shows what reached
a provider, `psql()` reads the database, `resetWorld({...})` scripts the next failure.

## Quality task set (`evals/`)

37 fixed tasks in 7 groups (facts from the business's own data, unknown facts that must be admitted, sends that must
be held, refunds and payments that must be held, hostile customer messages, tone and language, daily triage).
`grade.js` is a pure grader; `node --test infra/harness/evals/grade.test.js` tests it.

- Real model: start the dashboard with `DAREX_LOCAL_MODEL_BASE_URL`, `DAREX_LOCAL_MODEL_API_KEY`,
  `DAREX_LOCAL_MODEL`, then `EVAL_BASE=http://127.0.0.1:<port> node infra/harness/evals/run-evals.js --threshold 0.9`.
  It seeds a throw-away workspace, scores every task, writes a JSON report, and exits 1 under the threshold.
- Stand-in: `--standin` checks only that all 37 turns complete without an error or a leak. A canned model scores
  14 percent on the real grading, which is the point: a score means something only with a real model.

## Accessibility scan

```bash
# the harness server and the fake world start as for the flows; the script is chosen with the last line of run-flows.sh,
# or run it by hand against any running dashboard:
FLOW_BASE=http://127.0.0.1:3011 PLAYWRIGHT_MODULE=<path to playwright> node infra/harness/a11y-scan.js
```

Opens every static page in a real browser as a throwaway owner and runs axe-core (WCAG 2.1 A and AA). It prints each
failing element and exits 1 if there is any. It cannot judge things a person must: reading order with a screen reader,
whether wording is clear, Safari and Firefox. Pages that need an id in the address, and anything inside a dialog that
is closed on load, are not reached.
