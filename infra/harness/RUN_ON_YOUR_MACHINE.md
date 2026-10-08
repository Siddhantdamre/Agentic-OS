# Run the checks on your own machine

The sandbox has no model key, no real mail or WhatsApp account and no Docker daemon, so these four checks are
yours to run. Each prints PASS or FAIL lines and exits non-zero on failure. Paste the output back.

Keep keys in environment variables or an untracked local file. Never put them in a commit or a chat.

## 0. Start the app the way you normally do
Postgres up, migrations applied, `pnpm install`, `pnpm build`, then the dashboard (`pnpm --filter @darex/dashboard start`).

## 1. Real model answers (the quality score)
Start the dashboard with your model set:

    export DAREX_LOCAL_MODEL_BASE_URL=<your OpenAI-compatible base url>
    export DAREX_LOCAL_MODEL_API_KEY=<your key>
    export DAREX_LOCAL_MODEL=<model name>

Then, from the repo root, with the same database variables the dashboard uses:

    EVAL_BASE=http://127.0.0.1:3000 node infra/harness/evals/run-evals.js --threshold 0.9

37 tasks, scored per group. It seeds a throw-away workspace and removes it afterwards. The JSON report lists each
failed task with the reason and the model's answer. A pass rate under 90 percent exits 1.

## 2. Soak (does it stay up)
    FLOW_BASE=http://127.0.0.1:3000 node infra/harness/soak.js 60

Sends signed customer messages, questions and held-then-approved sends for 60 minutes (use 1440 for 24 hours).
Fails on any 5xx, a stuck approval, or memory growing more than 60 percent after warm-up. Run it against a build
started from `pnpm start`, not the dev server.

## 3. Clean container build (same everywhere)
    docker build -f Dockerfile.dashboard -t darex-dashboard .

Then run the container against your database and repeat step 2 for 10 minutes against it. If the build fails,
send the last 30 lines.

## 4. Real mail or WhatsApp (optional, one test account)
Connect one test Gmail or one WhatsApp number through the connection broker, set `NANGO_HOST` and
`NANGO_SECRET_KEY` to your own broker, and send only to addresses you own. Ask the assistant to email one of them,
approve the card, and confirm it arrives. Tell me what you saw: I cannot see your accounts.
