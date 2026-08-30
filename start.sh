#!/usr/bin/env bash
# Darex local start — boot compose, migrate, probe, then leave the stack up
# (or run host Next with --dev). Callers: humans from repo root; package.json
# start:stack. Not imported by application code.
#
# Usage:
#   ./start.sh              full compose + migrate + health checks
#   ./start.sh --dev        infra without dashboard, then pnpm dev on :3000
#   ./start.sh --no-build   skip image rebuild
#   ./start.sh --seed       also run db:seed
#   ./start.sh --checks     probes only (stack already running)
#   ./start.sh --down       stop compose (keep volumes)
#
# Migrations always connect as superuser `darex`. Runtime apps use darex_app.

set -euo pipefail

# ── Observability is opt-in, and local dev opts in ─────────────────────────
# The six Langfuse services sit behind the "observability" compose profile
# because they are 2.47 GB of a 4.05 GB idle stack and a first VPS deploy on a
# 6 GB box cannot spare that for a product with no traffic yet.
#
# Local development is the one place tracing earns its keep while building, so
# start.sh turns it on. A deploy does not — see deploy/RUNBOOK.md. Set
# COMPOSE_PROFILES yourself to override.
export COMPOSE_PROFILES="${COMPOSE_PROFILES:-observability}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

# Ensure setup is complete before starting
SETUP_MARKER="$ROOT/.setup-done"
if [ ! -f "$SETUP_MARKER" ]; then
  echo "Setup not complete. Running setup.sh first..."
  bash "$ROOT/setup.sh" || exit 1
fi

DO_BUILD=1
DO_DEV=0
DO_SEED=0
DO_CHECKS_ONLY=0
DO_DOWN=0
SKIP_INSTALL=0

for arg in "$@"; do
  case "$arg" in
    --dev) DO_DEV=1 ;;
    --no-build) DO_BUILD=0 ;;
    --seed) DO_SEED=1 ;;
    --checks|--check) DO_CHECKS_ONLY=1 ;;
    --down) DO_DOWN=1 ;;
    --skip-install) SKIP_INSTALL=1 ;;
    -h|--help)
      sed -n '2,16p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown flag: $arg (try --help)" >&2
      exit 1
      ;;
  esac
done

log() { printf '\n==> %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

need() {
  command -v "$1" >/dev/null 2>&1 || die "Missing '$1'. Install it and retry."
}

compose() {
  bash "$ROOT/infra/scripts/compose-cmd.sh" "$@"
}

wait_cmd() {
  local name="$1" tries="$2"
  shift 2
  local i=0
  until "$@"; do
    i=$((i + 1))
    if [ "$i" -ge "$tries" ]; then
      die "Timed out waiting for $name"
    fi
    sleep 2
  done
}

ensure_env() {
  if [ ! -f "$ROOT/.env" ]; then
    if [ -f "$ROOT/.env.example" ]; then
      cp "$ROOT/.env.example" "$ROOT/.env"
      log "Created .env from .env.example — edit secrets before expecting live tools."
    else
      die "No .env and no .env.example"
    fi
  fi
  set -a
  # shellcheck disable=SC1091
  . "$ROOT/.env"
  set +a
  # Next.js only auto-loads env files from the app's own directory, never
  # the repo root — without this, apps/dashboard boots with DB_PASSWORD
  # unset and every DB call fails.
  if [ ! -e "$ROOT/apps/dashboard/.env.local" ]; then
    ln -s ../../.env "$ROOT/apps/dashboard/.env.local"
    log "Linked apps/dashboard/.env.local -> ../../.env"
  fi
}

migrate() {
  log "Applying SQL migrations as superuser darex (not darex_app)"
  DB_HOST="${DB_HOST:-localhost}" \
    DB_PORT="${DB_PORT:-5432}" \
    DB_USER=darex \
    DB_PASSWORD="${DB_PASSWORD:-darex_dev_secret}" \
    DB_NAME="${DB_NAME:-darex}" \
    node "$ROOT/infra/db/migrate.js"
}

run_checks() {
  log "Running health probes"
  node "$ROOT/infra/scripts/check-phase0.js" || true
  if [ -f "$ROOT/infra/scripts/check-auth-nango.js" ]; then
    node "$ROOT/infra/scripts/check-auth-nango.js" || true
  fi
  if curl -sf "http://localhost:${DASHBOARD_PORT:-3000}/api/health" >/dev/null; then
    echo "  [PASS] dashboard /api/health"
  else
    echo "  [WAIT] dashboard /api/health not up yet (first image build can take several minutes)"
  fi
}

print_urls() {
  cat <<EOF

----------------------------------------------------------
Darex is up (local). Open:

  Dashboard     http://localhost:${DASHBOARD_PORT:-3000}
  Nango OAuth   http://localhost:3003   paste real client IDs here
  Langfuse      http://localhost:3002
  Temporal UI   http://localhost:8233
  LiteLLM       http://localhost:4000
  Inbox health  http://localhost:3004/health
  atomic-agent  http://127.0.0.1:8787
  MCP bridge    http://127.0.0.1:8790/sse

First UI path: /register → /connectors → /ask-ai

Still operator (not a start.sh bug):
  - NANGO_SECRET_KEY must be Nango's UUID
  - Real OAuth client IDs in Nango UI
  - Rotate META_ACCESS_TOKEN if WhatsApp outbound 401s
  - JINA_API_KEY for web_search / web_extract
  - Re-connect Gmail if the token predates gmail.compose

Logs:  pnpm infra:logs
Stop:  ./start.sh --down
----------------------------------------------------------
EOF
}

need docker
need node

if [ "$DO_DOWN" -eq 1 ]; then
  log "Stopping compose (volumes kept)"
  ensure_env
  compose down
  exit 0
fi

ensure_env

if [ "$DO_CHECKS_ONLY" -eq 1 ]; then
  run_checks
  print_urls
  exit 0
fi

need pnpm

if [ "$SKIP_INSTALL" -eq 0 ]; then
  log "pnpm install"
  pnpm install
fi

log "Build @darex/shared-types (workspace types)"
pnpm --filter @darex/shared-types build

UP_ARGS=(up -d)
if [ "$DO_BUILD" -eq 1 ]; then
  UP_ARGS+=(--build)
fi

if [ "$DO_DEV" -eq 1 ]; then
  log "Starting infra (dashboard scaled to 0 — host Next will bind :3000)"
  compose "${UP_ARGS[@]}" --scale dashboard=0
else
  log "Starting full compose stack (dashboard + worker + agent + sandbox)"
  compose "${UP_ARGS[@]}"
fi

log "Waiting for Postgres"
wait_cmd "postgres" 60 docker exec darex-postgres pg_isready -U darex -d darex

migrate

if [ "$DO_SEED" -eq 1 ]; then
  log "Seed (no fake rows — connectivity check)"
  DB_HOST="${DB_HOST:-localhost}" \
    DB_PORT="${DB_PORT:-5432}" \
    DB_USER=darex \
    DB_PASSWORD="${DB_PASSWORD:-darex_dev_secret}" \
    DB_NAME="${DB_NAME:-darex}" \
    node "$ROOT/infra/db/seed.js"
fi

if [ "$DO_DEV" -eq 0 ]; then
  log "Waiting for dashboard /api/health (compose image may still be compiling)"
  i=0
  until curl -sf "http://localhost:${DASHBOARD_PORT:-3000}/api/health" >/dev/null; do
    i=$((i + 1))
    if [ "$i" -ge 90 ]; then
      echo "Dashboard health not ready yet — it may still be building. Check: docker logs darex-dashboard"
      break
    fi
    sleep 2
  done
fi

run_checks
print_urls

if [ "$DO_DEV" -eq 1 ]; then
  log "Starting host dashboard (pnpm dev) — Ctrl+C stops Next, compose keeps running"
  exec pnpm --filter @darex/dashboard dev
fi
