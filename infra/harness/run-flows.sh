#!/usr/bin/env bash
# Through-and-through flows against the REAL dashboard server, gate and database, with no keys and no network:
# the model and the providers (Gmail, the connection broker) are local fakes. See README.md.
#
# Needs: a migrated Postgres (DB_* variables, as the other check scripts), psql, and a built dashboard
#        (pnpm --filter @darex/dashboard build). Usage: infra/harness/run-flows.sh [flow-name-fragment]
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
export HARNESS_DIR="${HARNESS_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/darex-harness.XXXXXX")}"
PORT="${HARNESS_PORT:-3011}"
WORLD_PORT="${WORLD_PORT:-4999}"

export DB_HOST="${DB_HOST:-127.0.0.1}" DB_PORT="${DB_PORT:-5432}" DB_NAME="${DB_NAME:-darex}"
export DB_USER="${DB_USER:-darex_app}" DB_PASSWORD="${DB_PASSWORD:-darex_app_dev_secret}"
export APP_DB_PASSWORD="${APP_DB_PASSWORD:-${DB_PASSWORD}}"
export DB_RESOLVER_USER="${DB_RESOLVER_USER:-darex}" DB_RESOLVER_PASSWORD="${DB_RESOLVER_PASSWORD:-darex_dev_secret}"

# Values that exist only for this run. They are labelled so nobody mistakes them for real credentials.
export DAREX_SESSION_SECRET="harness-only-session-secret-0123456789abcdef"
export MCP_BRIDGE_SECRET="harness-only-bridge-secret-0123456789abcdef"
export CHATWOOT_WEBHOOK_SECRET="harness-only-webhook-secret"
export NEXT_PUBLIC_APP_URL="http://127.0.0.1:${PORT}" NEXT_TELEMETRY_DISABLED=1
export DAREX_ORG_RATE_LIMIT_PER_MINUTE=1000000 RATE_LIMIT_PER_MINUTE=1000000 RATE_LIMIT_WEBHOOK_RPS=1000 RATE_LIMIT_ASK_AI_RPS=1000
export DAREX_LOCAL_MODEL_BASE_URL="http://127.0.0.1:${WORLD_PORT}/v1" DAREX_LOCAL_MODEL_API_KEY="harness-only-model-key" DAREX_LOCAL_MODEL="fake-model"
export NANGO_HOST="http://127.0.0.1:${WORLD_PORT}/nango" NANGO_SECRET_KEY="harness-only-broker-key"
export WORLD_URL="http://127.0.0.1:${WORLD_PORT}" WORLD_PORT
# No agent sidecar exists in this harness: a closed port, so a production start does not refuse to run and a card for a
# session this server no longer holds fails the way it would after a restart.
export TRUEFORGE_URL="${TRUEFORGE_URL:-http://127.0.0.1:1}"
# Same idea for the sign-in service: a production start refuses to run sign-in without an address, and the dashboard
# falls back to its own database when the service does not answer, which is what the demo's real sign-in form uses.
export SUPERTOKENS_CONNECTION_URI="${SUPERTOKENS_CONNECTION_URI:-http://127.0.0.1:1}"
export NODE_OPTIONS="--require ${HERE}/intercept.js"
export FLOW_BASE="http://127.0.0.1:${PORT}"

# A copy of the stand-ins or the dashboard left running on these ports would answer instead of the ones started
# below, with a different log folder, and the flows would fail for reasons that are not the product's.
for spec in "fake-world:${WORLD_PORT}:/__health" "dashboard:${PORT}:/login"; do
  IFS=: read -r _name _port _path <<<"$spec"
  _code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:${_port}${_path}" 2>/dev/null || true)"
  if [ -n "$_code" ] && [ "$_code" != "000" ]; then
    echo "port ${_port} already answers (${_name}); stop it first so the flows use their own copy"; exit 2
  fi
done

PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT

node "$HERE/fake-world.js" > "$HARNESS_DIR/world.out" 2>&1 & PIDS+=($!)
( cd "$ROOT/apps/dashboard" && exec ./node_modules/.bin/next start -p "$PORT" ) > "$HARNESS_DIR/dashboard.out" 2>&1 & PIDS+=($!)

for _ in $(seq 1 90); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:${PORT}/login" || true)" = "200" ] && break
  sleep 1
done
curl -sf "http://127.0.0.1:${WORLD_PORT}/__health" > /dev/null || { echo "fake world did not start; see $HARNESS_DIR/world.out"; exit 2; }
[ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/login")" = "200" ] || { echo "dashboard did not start; see $HARNESS_DIR/dashboard.out"; exit 2; }

if [ -n "${HARNESS_SCRIPT:-}" ]; then
  # Same servers and stand-ins, a different script on top (a11y-scan.js, soak.js, demo.js ...).
  node "$HERE/$HARNESS_SCRIPT" ${HARNESS_ARGS:-}
else
  node "$HERE/flows.js" "${1:-}"
fi
