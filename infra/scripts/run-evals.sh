#!/usr/bin/env bash
# WS-01 should add CI job calling this
#
# Darex eval-runner (A2 / M6 / R4). Never hits the Ask AI request path.
# Default: fail-closed if memory tables are missing (M1).
# Honest skip of the memory probe only: EVAL_ALLOW_MISSING_MEMORY=1
#
# Usage:
#   bash infra/scripts/run-evals.sh
#   EVAL_ALLOW_MISSING_MEMORY=1 bash infra/scripts/run-evals.sh

set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

yaml_rc=0
mem_rc=0
pf_rc=0

echo ""
echo "=== Darex run-evals.sh ==="
echo "  cwd=$ROOT"
echo "  EVAL_ALLOW_MISSING_MEMORY=${EVAL_ALLOW_MISSING_MEMORY:-}"
echo ""

node infra/evals/runner.js
yaml_rc=$?

node infra/scripts/check-phase6-memory.js
mem_rc=$?

if [ "${EVAL_RUN_PROMPTFOO:-}" = "1" ]; then
  echo ""
  echo "--- Promptfoo CLI (EVAL_RUN_PROMPTFOO=1) ---"
  if command -v promptfoo >/dev/null 2>&1; then
    (cd infra/evals && promptfoo eval -c promptfoo.yaml --no-cache)
    pf_rc=$?
  else
    (cd infra/evals && npx promptfoo eval -c promptfoo.yaml --no-cache)
    pf_rc=$?
  fi
else
  echo ""
  echo "  [INFO] Promptfoo CLI not invoked (Node runner is the source of truth)."
  echo "         YAML lives in infra/evals/. Later: EVAL_RUN_PROMPTFOO=1 bash infra/scripts/run-evals.sh"
  pf_rc=0
fi

echo ""
echo "=== run-evals.sh summary ==="
echo "  yaml_runner_exit=$yaml_rc  memory_probe_exit=$mem_rc  promptfoo_exit=$pf_rc"

if [ "$yaml_rc" -ne 0 ] || [ "$mem_rc" -ne 0 ] || [ "$pf_rc" -ne 0 ]; then
  echo "  FAILED"
  exit 1
fi

echo "  PASSED"
exit 0
