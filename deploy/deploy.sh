#!/usr/bin/env bash
# Darex server deploy — compose + prod overlay + migrate + health.
# Run this ON the server after the repo is there, or from a laptop with
# DEPLOY_HOST=user@ip (rsync then remote exec).
#
# Callers: humans. Not imported by application code.
#
# Usage (on the server, repo root):
#   ./deploy/deploy.sh
#   ./deploy/deploy.sh --status
#   ./deploy/deploy.sh --down
#
# Usage (from a laptop):
#   DEPLOY_HOST=ubuntu@203.0.113.10 DEPLOY_PATH=/opt/darex ./deploy/deploy.sh
#
# Requires: Docker Compose V2, a real .env (see env.production.example).
# Fail-fast: DB_USER=darex_app and ALLOW_DEMO_AUTH=false. Caddy in front of :3000.
# Terraform starter is infra/terraform/ — not invoked by this script.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

DO_STATUS=0
DO_DOWN=0
DO_BUILD=1
SKIP_ENV_CHECK=0

for arg in "$@"; do
  case "$arg" in
    --status) DO_STATUS=1 ;;
    --down) DO_DOWN=1 ;;
    --no-build) DO_BUILD=0 ;;
    --skip-env-check) SKIP_ENV_CHECK=1 ;;
    -h|--help)
      sed -n '2,20p' "$0"
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

is_placeholder() {
  case "${1:-}" in
    ""|changeme|replace-with-long-random|replace-with-other-long-random|sk-or-replace-me|pk-lf-replace-me|sk-lf-replace-me|00000000-0000-0000-0000-000000000000)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

looks_like_uuid() {
  echo "${1:-}" | grep -Eq '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
}

compose() {
  bash "$ROOT/infra/scripts/compose-cmd.sh" --overlay "$ROOT/deploy/docker-compose.prod.yml" "$@"
}

env_check() {
  [ -f "$ROOT/.env" ] || die "Missing $ROOT/.env — copy deploy/env.production.example and fill secrets."
  set -a
  # shellcheck disable=SC1091
  . "$ROOT/.env"
  set +a

  [ "${ALLOW_DEMO_AUTH:-false}" = "false" ] || die "ALLOW_DEMO_AUTH must be false on a server."
  [ "${DB_USER:-}" = "darex_app" ] || die "DB_USER must be darex_app on a server (got '${DB_USER:-}')."
  [ "${APP_DB_USER:-darex_app}" = "darex_app" ] || die "APP_DB_USER must be darex_app on a server (got '${APP_DB_USER:-}')."
  case "${NEXT_PUBLIC_APP_URL:-}" in
    https://*) ;;
    *) die "NEXT_PUBLIC_APP_URL must be https://… (got '${NEXT_PUBLIC_APP_URL:-}')" ;;
  esac

  local required=(
    DB_PASSWORD
    APP_DB_PASSWORD
    SUPERTOKENS_API_KEY
    DAREX_SESSION_SECRET
    NANGO_SECRET_KEY
    LITELLM_MASTER_KEY
    OPENROUTER_API_KEY
    ATOMIC_AGENT_API_KEY
  )
  local key val
  for key in "${required[@]}"; do
    eval "val=\${$key:-}"
    if is_placeholder "$val"; then
      die "$key is missing or still a placeholder"
    fi
  done
  looks_like_uuid "${NANGO_SECRET_KEY}" || die "NANGO_SECRET_KEY must be Nango's UUID (not a random string)."
}

migrate() {
  log "Applying SQL migrations as superuser darex"
  DB_HOST=127.0.0.1 \
    DB_PORT=5432 \
    DB_USER=darex \
    DB_PASSWORD="${DB_PASSWORD:-}" \
    DB_NAME="${DB_NAME:-darex}" \
    node "$ROOT/infra/db/migrate.js"
}

print_status() {
  compose ps
  echo
  curl -sf "http://127.0.0.1:3000/api/health" && echo "  dashboard health ok" || echo "  dashboard health FAIL"
  docker exec darex-postgres pg_isready -U darex -d darex || true
}

remote_deploy() {
  local host="$1"
  local path="${DEPLOY_PATH:-/opt/darex}"
  local extra=()
  command -v rsync >/dev/null 2>&1 || die "rsync is required for DEPLOY_HOST mode"
  [ "$DO_BUILD" -eq 0 ] && extra+=(--no-build)
  [ "$SKIP_ENV_CHECK" -eq 1 ] && extra+=(--skip-env-check)
  log "Syncing repo to $host:$path (env files are NOT overwritten)"
  ssh "$host" "mkdir -p '$path'"
  rsync -az --delete \
    --exclude '.git/' \
    --exclude 'node_modules/' \
    --exclude '.next/' \
    --exclude 'dist/' \
    --exclude '.turbo/' \
    --exclude '.env' \
    --exclude '.env.*' \
    --exclude 'apps/dashboard/.env.local' \
    --exclude 'infra/.env' \
    --exclude '*.pem' \
    --exclude '*.key' \
    "$ROOT/" "$host:$path/"
  log "Running deploy on $host"
  ssh "$host" "cd '$path' && bash ./deploy/deploy.sh ${extra[*]}"
}

if [ -n "${DEPLOY_HOST:-}" ]; then
  remote_deploy "$DEPLOY_HOST"
  exit 0
fi

command -v docker >/dev/null 2>&1 || die "Docker is required on this server"
command -v node >/dev/null 2>&1 || die "Node is required on this server to run migrate.js"

if [ "$SKIP_ENV_CHECK" -eq 0 ]; then
  env_check
else
  [ -f "$ROOT/.env" ] || die "Missing .env"
  set -a
  # shellcheck disable=SC1091
  . "$ROOT/.env"
  set +a
fi

if [ "$DO_STATUS" -eq 1 ]; then
  print_status
  exit 0
fi

if [ "$DO_DOWN" -eq 1 ]; then
  log "Stopping production compose (volumes kept)"
  compose down
  exit 0
fi

UP_ARGS=(up -d)
if [ "$DO_BUILD" -eq 1 ]; then
  UP_ARGS+=(--build)
fi

log "Bringing stack up with production overlay (loopback binds)"
compose "${UP_ARGS[@]}"

log "Waiting for Postgres on 127.0.0.1:5432"
tries=0
until docker exec darex-postgres pg_isready -U darex -d darex >/dev/null 2>&1; do
  tries=$((tries + 1))
  [ "$tries" -lt 60 ] || die "Postgres did not become ready"
  sleep 2
done

migrate

log "Waiting for dashboard health on 127.0.0.1:3000"
tries=0
until curl -sf "http://127.0.0.1:3000/api/health" >/dev/null; do
  tries=$((tries + 1))
  [ "$tries" -lt 90 ] || die "Dashboard /api/health did not become ready — check: docker logs darex-dashboard"
  sleep 2
done

print_status

cat <<EOF

----------------------------------------------------------
Deployed on this machine. Dashboard is loopback-only:

  curl http://127.0.0.1:3000/api/health

Put Caddy/nginx in front using deploy/Caddyfile.example so
${NEXT_PUBLIC_APP_URL:-https://your-domain} reaches :3000.

SSH tunnels for admin UIs:
  ssh -L 3003:127.0.0.1:3003 -L 3002:127.0.0.1:3002 -L 8233:127.0.0.1:8233 user@host

Then: Nango :3003, Langfuse :3002, Temporal :8233.

Status:  ./deploy/deploy.sh --status
Stop:    ./deploy/deploy.sh --down
----------------------------------------------------------
EOF
