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
The values it starts the server with are labelled `harness-only-...` and exist only for the run.

## What the flows cover

F1 a read runs and reaches the provider · F2 a send is held, nothing leaves · F3 approving sends it once and records it
truthfully · F4 reject · F5 edit then approve · F6 provider failure is recorded as failed · F7 watching mode records and
sends nothing · F8 a paused team does nothing · F9 another workspace cannot see or approve · F10 an auditor cannot
approve · F11 a revoked connection is reported honestly · F12 a customer message through to a stored reply · F13 a
message that tries to make the agent email an attacker sends nothing · F14 a dead approval card says so plainly.

## What it does not cover

Real model answers and their quality, real providers (so it cannot catch a provider changing its API), workflow-engine
workflows (nurture, reminders, sweeps, data erasure), browsers, and anything that needs a real OAuth connection.

## Adding a flow

Add `flow('Fnn what should be true', async () => { ... })` to `flows.js`. `seed()` makes a workspace and a session
cookie, `ask()` / `chatApprove()` / `decide()` / `inbound()` call the real routes, `providerCalls()` shows what reached
a provider, `psql()` reads the database, `resetWorld({...})` scripts the next failure.
