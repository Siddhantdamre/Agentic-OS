#!/usr/bin/env bash
#
# Hardening runner — survives Docker Desktop stopping mid-suite.
#
# Runs the four hardening steps IN ORDER, one at a time, persisting each result
# to .harden-state/ before the next begins. If the Docker engine disappears
# (session teardown kills it on this machine), the engine is restarted and the
# step RESUMES from the last completed case rather than starting over.
#
# Process interruption is explicitly NOT a test failure: completed cases keep
# their real verdicts, and only genuinely unrun cases are executed again.
#
# Usage: bash infra/scripts/harden-run.sh [step...]
#        bash infra/scripts/harden-run.sh quality failover isolation reliability
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
export PATH="/c/Users/siddh/nodejs/node-v24.15.0-win-x64:$PATH:/c/Users/siddh/AppData/Local/Programs/DockerDesktop/resources/bin"
STATE="$ROOT/infra/scripts/.harden-state"
mkdir -p "$STATE"

export CHATWOOT_WEBHOOK_SECRET="${CHATWOOT_WEBHOOK_SECRET:-darex-chatwoot-webhook-secret-dev}"
export DB_RESOLVER_USER="${DB_RESOLVER_USER:-darex}"
export DB_RESOLVER_PASSWORD="${DB_RESOLVER_PASSWORD:-darex_dev_secret}"
export DB_USER="${DB_USER:-darex_app}"
export DB_PASSWORD="${DB_PASSWORD:-darex_app_dev_secret}"
export REPLY_TIMEOUT_MS="${REPLY_TIMEOUT_MS:-90000}"

log() { echo "[harden-run $(date -u +%H:%M:%S)] $*"; }

engine_up() { timeout 15 docker info --format '{{.ServerVersion}}' >/dev/null 2>&1; }

ensure_engine() {
  engine_up && return 0
  log "docker engine down — restarting Docker Desktop"
  powershell.exe -NoProfile -Command \
    'if (-not (Get-Process -Name "Docker Desktop" -ErrorAction SilentlyContinue)) { Start-Process "$env:LOCALAPPDATA\Programs\DockerDesktop\Docker Desktop.exe" }' \
    >/dev/null 2>&1
  for _ in $(seq 1 30); do
    sleep 15
    engine_up && { log "engine back"; return 0; }
  done
  log "ERROR: engine did not return"
  return 1
}

ensure_stack() {
  ensure_engine || return 1
  # Dashboard must answer before any step can drive traffic.
  for _ in $(seq 1 30); do
    code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 http://127.0.0.1:3000/ 2>/dev/null)
    [ "$code" != "000" ] && [ -n "$code" ] && return 0
    sleep 5
  done
  log "dashboard not answering — bringing stack up"
  (cd "$ROOT/infra" && docker compose --env-file .env up -d >/dev/null 2>&1)
  for _ in $(seq 1 30); do
    code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 http://127.0.0.1:3000/ 2>/dev/null)
    [ "$code" != "000" ] && [ -n "$code" ] && return 0
    sleep 5
  done
  return 1
}

# Run one step, retrying ONLY when the engine died. A step that completes with
# failures is a real result and is not retried.
run_step() {
  local step="$1" attempt=1 max=4
  while [ "$attempt" -le "$max" ]; do
    ensure_stack || { log "cannot reach stack; aborting $step"; return 1; }
    log "step=$step attempt=$attempt"
    node "$ROOT/infra/scripts/harden-suite.js" --only="$step" 2>&1 | tee "$STATE/$step.log"
    local rc=${PIPESTATUS[0]}

    if engine_up; then
      log "step=$step finished rc=$rc (engine healthy — result is real)"
      return "$rc"
    fi
    # Engine vanished mid-step: the run was interrupted, not failed.
    log "step=$step INTERRUPTED (engine died) — will resume from checkpoint"
    attempt=$((attempt + 1))
  done
  log "step=$step exceeded interruption retries"
  return 1
}

STEPS=("$@")
[ ${#STEPS[@]} -eq 0 ] && STEPS=(quality failover isolation reliability)

declare -A RC
for s in "${STEPS[@]}"; do
  run_step "$s"
  RC[$s]=$?
  log "=== $s complete (rc=${RC[$s]}) — state saved to $STATE/$s.json ==="
done

echo ""
echo "================ HARDENING RUN SUMMARY ================"
for s in "${STEPS[@]}"; do
  printf "  %-12s rc=%s\n" "$s" "${RC[$s]}"
done
echo "  state dir: $STATE"
