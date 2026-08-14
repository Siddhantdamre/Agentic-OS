#!/usr/bin/env bash
# Darex production deploy — full setup, build, deploy, validate, health checks.
# Run this ON the server after the repo is cloned, or from a laptop with
# DEPLOY_HOST=user@ip (rsync then remote exec).
#
# Callers: humans, CI/CD. Not imported by application code.
#
# Usage (on the server, repo root):
#   ./deploy/deploy.sh              full deploy with setup & validation
#   ./deploy/deploy.sh --status     show status only
#   ./deploy/deploy.sh --down       stop all services
#   ./deploy/deploy.sh --no-setup   skip setup checks (if already done)
#
# Usage (from a laptop):
#   DEPLOY_HOST=ubuntu@203.0.113.10 DEPLOY_PATH=/opt/darex ./deploy/deploy.sh
#
# Requires: Docker, Node, pnpm, git (on server)
# Env file: Copy deploy/env.production.example to .env and fill all secrets
# Security: DB_USER=darex_app, ALLOW_DEMO_AUTH=false, HTTPS only
# Proxy: Caddy/nginx in front of loopback :3000

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

DO_STATUS=0
DO_DOWN=0
DO_BUILD=1
DO_SETUP=1
SKIP_ENV_CHECK=0

for arg in "$@"; do
  case "$arg" in
    --status) DO_STATUS=1 ;;
    --down) DO_DOWN=1 ;;
    --no-build) DO_BUILD=0 ;;
    --no-setup) DO_SETUP=0 ;;
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
info() { printf '    %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
warn() { printf 'WARN: %s\n' "$*" >&2; }

# Check command exists and report status
check_cmd() {
  local cmd=$1
  local hint=$2
  if ! command -v "$cmd" >/dev/null 2>&1; then
    die "Missing required: $cmd. $hint"
  fi
  info "✓ $cmd installed"
}

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
  curl -sf "http://127.0.0.1:3000/api/health" && echo "  ✓ dashboard health ok" || echo "  ✗ dashboard health FAIL"
  docker exec darex-postgres pg_isready -U darex -d darex && echo "  ✓ postgres ready" || echo "  ✗ postgres not ready"
}

validate_deployment() {
  log "Validating deployment..."
  local checks_passed=0
  local checks_total=0

  # Check 1: Dashboard health
  checks_total=$((checks_total + 1))
  if curl -sf "http://127.0.0.1:3000/api/health" >/dev/null 2>&1; then
    info "✓ Dashboard /api/health responding"
    checks_passed=$((checks_passed + 1))
  else
    warn "✗ Dashboard /api/health not responding"
  fi

  # Check 2: Postgres connectivity
  checks_total=$((checks_total + 1))
  if docker exec darex-postgres pg_isready -U darex -d darex >/dev/null 2>&1; then
    info "✓ Postgres database ready"
    checks_passed=$((checks_passed + 1))
  else
    warn "✗ Postgres database not responding"
  fi

  # Check 3: All containers running
  checks_total=$((checks_total + 1))
  local stopped
  stopped=$(compose ps --services --filter "status=exited" | wc -l)
  if [ "$stopped" -eq 0 ]; then
    info "✓ All containers running"
    checks_passed=$((checks_passed + 1))
  else
    warn "✗ $stopped containers exited"
  fi

  # Check 4: Docker disk usage
  checks_total=$((checks_total + 1))
  local docker_gb
  docker_gb=$(docker system df | awk '/Local Volumes/ {print $4}' | sed 's/GiB//' | awk '{print int($1)}')
  if [ -n "$docker_gb" ] && [ "$docker_gb" -lt 50 ]; then
    info "✓ Docker usage OK: ${docker_gb}GB"
    checks_passed=$((checks_passed + 1))
  else
    warn "Docker usage check skipped or high"
  fi

  log "Validation: $checks_passed/$checks_total checks passed"
  if [ "$checks_passed" -lt 2 ]; then
    die "Deployment validation failed"
  fi
}

preflight_check() {
  log "Running pre-flight system checks (Ubuntu/Linux server)"

  # Check OS
  if ! grep -iq "ubuntu\|debian" /etc/os-release 2>/dev/null; then
    warn "Not detected as Ubuntu/Debian — deployment may still work"
  else
    info "✓ Ubuntu/Debian detected"
  fi

  # Check required commands
  check_cmd docker "Install: sudo apt-get install docker.io"
  check_cmd node "Install: curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash - && sudo apt-get install -y nodejs"
  check_cmd git "Install: sudo apt-get install git"

  # Check Docker daemon
  if ! docker ps >/dev/null 2>&1; then
    die "Docker daemon not running. Try: sudo systemctl start docker"
  fi
  info "✓ Docker daemon running"

  # Check disk space
  local free_gb
  free_gb=$(df "$ROOT" | awk 'NR==2 {print $4}' | awk '{print int($1/1048576)}')
  if [ "$free_gb" -lt 10 ]; then
    warn "Low disk space: ${free_gb}GB free (recommend 10GB+)"
  else
    info "✓ Disk space OK: ${free_gb}GB free"
  fi

  # Check memory
  local mem_gb
  mem_gb=$(free -g | awk 'NR==2 {print $2}')
  if [ "$mem_gb" -lt 4 ]; then
    warn "Low memory: ${mem_gb}GB (recommend 4GB+)"
  else
    info "✓ Memory OK: ${mem_gb}GB available"
  fi
}

remote_deploy() {
  local host="$1"
  local path="${DEPLOY_PATH:-/opt/darex}"
  local extra=()
  command -v rsync >/dev/null 2>&1 || die "rsync is required for DEPLOY_HOST mode"
  [ "$DO_BUILD" -eq 0 ] && extra+=(--no-build)
  [ "$DO_SETUP" -eq 0 ] && extra+=(--no-setup)
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

# =============================================================================
# LOCAL DEPLOYMENT
# =============================================================================

# Pre-flight checks
if [ "$DO_SETUP" -eq 1 ]; then
  preflight_check
else
  info "Skipping setup checks (--no-setup)"
  check_cmd docker "Install: sudo apt-get install docker.io"
fi

# Environment validation
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

# Final validation
validate_deployment

cat <<EOF

========================================
✓ DEPLOYMENT SUCCESSFUL
========================================

Environment:
  App URL: ${NEXT_PUBLIC_APP_URL:-https://your-domain}
  Database: Postgres (darex_app user)
  Auth: SuperTokens + Nango OAuth
  LLM: LiteLLM + OpenRouter

Services (loopback only, use Caddy/nginx reverse proxy):
  Dashboard API      http://127.0.0.1:3000/api
  Nango OAuth        http://127.0.0.1:3003
  Langfuse Monitor   http://127.0.0.1:3002
  Temporal UI        http://127.0.0.1:8233
  LiteLLM            http://127.0.0.1:4000
  Inbox Worker       http://127.0.0.1:3004
  Agent Sandbox      http://127.0.0.1:8787
  MCP Bridge         ws://127.0.0.1:8790/sse

Next steps:
  1. Configure Caddy/nginx: deploy/Caddyfile.example
  2. Start reverse proxy pointing to http://127.0.0.1:3000
  3. Access ${NEXT_PUBLIC_APP_URL:-https://your-domain} in browser
  4. SSH tunnel for admin UIs:
     ssh -L 3003:127.0.0.1:3003 -L 3002:127.0.0.1:3002 -L 8233:127.0.0.1:8233 user@host

Monitoring & Operations:
  Status:    ./deploy/deploy.sh --status
  Logs:      docker compose -f infra/docker-compose.yml -f deploy/docker-compose.prod.yml logs -f
  Stop:      ./deploy/deploy.sh --down
  Restart:   docker compose -f infra/docker-compose.yml -f deploy/docker-compose.prod.yml restart

Troubleshooting:
  Dashboard issues:  docker logs darex-dashboard
  Database issues:   docker exec -it darex-postgres psql -U darex -d darex
  Service logs:      docker logs <service_name>
  All logs:          docker compose ... logs --all

Security:
  - Dashboard is loopback-only (127.0.0.1)
  - Use Caddy/nginx reverse proxy with TLS
  - Admin UIs require SSH tunnels
  - Keep .env secrets secure and never commit
  - Rotate API keys periodically

========================================
EOF
