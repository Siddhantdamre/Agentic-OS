#!/usr/bin/env bash
# Darex local start — boot compose, migrate, probe, then stay in the foreground
# streaming every service log until Ctrl+C (or run host Next with --dev).
# Callers: humans from repo root; package.json start:stack. Not imported by
# application code. Ctrl+C stops the log view; containers keep running.
#
# Usage:
#   ./start.sh              full stack, migrate, restart app, wait until healthy
#   ./start.sh --dev        infra without dashboard, then pnpm dev on :3000
#   ./start.sh --no-build   skip image rebuild
#   ./start.sh --lite       stop Langfuse (~2 GB RAM) after boot; chat and billing still work,
#                           only LLM trace dashboards are off
#   ./start.sh --seed       run db:seed (default on; connector catalog is empty without it)
#   ./start.sh --checks     probes only (stack already running)
#   ./start.sh --down       stop compose (keep volumes)
#
# Migrations always connect as superuser `darex`. Runtime apps use darex_app.

set -euo pipefail

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
DO_LITE=0
DO_SEED=1
DO_CHECKS_ONLY=0
DO_DOWN=0
SKIP_INSTALL=0

for arg in "$@"; do
  case "$arg" in
    --dev) DO_DEV=1 ;;
    --lite) DO_LITE=1 ;;
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
  TrueForge     http://127.0.0.1:8791  (external — required for agent turns)
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

if ! docker info >/dev/null 2>&1; then
  if [ "$(uname -s)" = "Darwin" ] && [ -d "/Applications/Docker.app" ]; then
    log "Docker is not running. Opening Docker Desktop..."
    open -a Docker
    i=0
    until docker info >/dev/null 2>&1; do
      i=$((i + 1))
      if [ "$i" -ge 90 ]; then
        die "Docker Desktop did not become ready. Open it yourself, wait until it says running, then re-run ./start.sh"
      fi
      sleep 2
    done
    echo "  [PASS] Docker daemon is running"
  else
    die "Docker daemon is not running. Start Docker, then re-run ./start.sh"
  fi
fi

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

log "Build workspace packages the dashboard and worker import"
pnpm --filter @darex/shared-types build
pnpm --filter @darex/workflows build

# Compose builds Cognee from the sibling checkout, not from this repo.
if [ ! -f "$ROOT/../cognee/Dockerfile" ]; then
  log "Cloning cognee v1.5.4 next to this repo"
  git clone --depth 1 --branch v1.5.4 https://github.com/topoteretes/cognee.git "$ROOT/../cognee"
fi

# Named volumes are root-owned. Cognee runs as uid 1000 and TrueForge as
# uid 10001, so the first boot cannot create /data/system or /app/data.
prepare_data_dirs() {
  if docker image inspect darex-cognee:1.5.4 >/dev/null 2>&1; then
    docker run --rm --user 0:0 --entrypoint "" \
      -v infra_cognee-data:/data darex-cognee:1.5.4 \
      sh -c 'mkdir -p /data/cognee /data/system && chown -R 1000:1000 /data' \
      && echo "  [PASS] cognee data dir owned by uid 1000"
  fi
  if docker image inspect truefoundry-server:latest >/dev/null 2>&1; then
    docker run --rm --user 0:0 --entrypoint "" \
      -v infra_trueforge-data:/app/data truefoundry-server:latest \
      sh -c 'mkdir -p /app/data && chown -R 10001:10001 /app/data' \
      && echo "  [PASS] trueforge data dir owned by uid 10001"
  fi
}

UP_ARGS=(up -d)
if [ "$DO_BUILD" -eq 1 ]; then
  UP_ARGS+=(--build)
  # mcp-bridge is FROM darex-dashboard:local and does not install from npm.
  log "Build dashboard image before the rest of the stack"
  compose build dashboard
fi

if [ "$DO_DEV" -eq 1 ]; then
  log "Starting infra (dashboard scaled to 0 — host Next will bind :3000)"
  compose "${UP_ARGS[@]}" --scale dashboard=0
else
  log "Starting full compose stack (dashboard + worker + agent + sandbox)"
  compose "${UP_ARGS[@]}"
fi

log "Fixing data-volume ownership"
prepare_data_dirs
docker restart darex-cognee darex-trueforge >/dev/null 2>&1 || true

if [ "$DO_LITE" -eq 1 ]; then
  log "Lite mode: stopping Langfuse (frees ~2 GB; start again with ./start.sh)"
  docker stop darex-langfuse-worker darex-langfuse-server darex-langfuse-clickhouse darex-langfuse-minio darex-langfuse-redis >/dev/null 2>&1 || true
fi

log "Waiting for Postgres"
wait_cmd "postgres" 60 docker exec darex-postgres pg_isready -U darex -d darex

migrate

# Dashboard and worker boot in parallel with migrate. Restart them so they
# see the schema that just landed, then block until the UI is actually up.
if [ "$DO_DEV" -eq 0 ]; then
  log "Restarting dashboard and worker against the migrated database"
  compose up -d dashboard worker inbox mcp-bridge trueforge
fi

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
  log "Waiting for dashboard /api/health"
  i=0
  until curl -sf "http://localhost:${DASHBOARD_PORT:-3000}/api/health" >/dev/null; do
    i=$((i + 1))
    if [ "$i" -ge 180 ]; then
      docker logs darex-dashboard --tail 80 >&2 || true
      die "Dashboard /api/health did not come up. Fix the log above, then re-run ./start.sh"
    fi
    if [ $((i % 15)) -eq 0 ]; then
      printf '    still waiting for dashboard (%ss)\n' "$((i * 2))"
    fi
    sleep 2
  done
  echo "  [PASS] dashboard /api/health"
fi

run_checks
print_urls

if [ "$DO_DEV" -eq 1 ]; then
  log "Starting host dashboard (pnpm dev) — Ctrl+C stops Next, compose keeps running"
  exec pnpm --filter @darex/dashboard dev
fi

log "Live logs (all services). This stays attached until you press Ctrl+C."
log "Ctrl+C stops the log view only. The stack keeps running. Stop it with ./start.sh --down"
trap 'printf "\n==> Log view stopped. Stack is still running. Stop it with ./start.sh --down\n"; exit 0' INT TERM
compose logs -f --tail 40
