#!/usr/bin/env bash
# Darex production deploy — full setup, build, deploy, validate, health checks.
# Run this ON the server after the repo is cloned, or from a laptop with
# DEPLOY_HOST=user@ip (rsync then remote exec).
#
# Callers: humans, CI/CD. Not imported by application code.
#
# Usage (on the server, repo root):
#   ./deploy/deploy.sh              first run: asks for the domain + OpenRouter key, writes .env
#                                   with generated secrets, sets up Caddy HTTPS, then pull main,
#                                   pull the latest frontend, build, migrate, health, print the link
#   DOMAIN=app.example.com OPENROUTER_API_KEY=sk-or-... ./deploy/deploy.sh   same, no prompts
#   ./deploy/deploy.sh --status     show status only
#   ./deploy/deploy.sh --down       stop all services
#   ./deploy/deploy.sh --no-setup   skip setup checks (if already done)
#   ./deploy/deploy.sh --no-proxy   do not install/configure Caddy (auto-skipped when 80/443 are taken)
#   LITE=1|0 ./deploy/deploy.sh              skip (1) or include (0) the Langfuse stack; default: skip under 12 GB RAM
#   ./deploy/deploy.sh --logs       follow the running (or last) deploy; closing the terminal never
#                                   stops a deploy: it runs in the background and streams its log
#   ./deploy/deploy.sh --foreground run in this terminal instead (also the case when CI is set,
#                                   on the first run that asks questions, or if sudo needs a password)
#   FORCE_BUILD=1 ./deploy/deploy.sh         rebuild the images even when the commits are unchanged (a rerun at the
#                                            same commits otherwise skips builds that are already done)
#   FREE_PORTS=1 ./deploy/deploy.sh          kill host processes holding 13000/13100/15432/18085 (not for systemd
#                                            services: they restart; disable those with systemctl)
#   DEPLOY_BRANCH=other ./deploy/deploy.sh   deploy a different backend branch
#   FRONTEND_BRANCH=other ./deploy/deploy.sh deploy a different frontend branch
#
# The user-facing app is NEW-FRONTEND (its own git repo). Every run pulls its
# latest FRONTEND_BRANCH (default feat/new-frontend) and rebuilds the frontend
# image, so the site always matches the newest frontend commit. It listens on
# 127.0.0.1:${FRONTEND_HOST_PORT} and proxies /api/* to the dashboard (13000).
#
# Usage (from a laptop):
#   DEPLOY_HOST=ubuntu@203.0.113.10 DEPLOY_PATH=/opt/darex ./deploy/deploy.sh
#
# Requires: Docker, Node, pnpm, git (on server)
# Env file: Copy deploy/env.production.example to .env and fill all secrets
# Security: DB_USER=darex_app, ALLOW_DEMO_AUTH=false, HTTPS only
# Proxy: Caddy/nginx in front of loopback :13100 (the frontend; it proxies /api to :13000)

set -euo pipefail
set -E
trap 'printf "ERROR: deploy.sh stopped at line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

DO_STATUS=0
DO_DOWN=0
DO_BUILD=1
DO_SETUP=1
SKIP_ENV_CHECK=0
DO_PROXY=1
FOREGROUND=0
DO_LOGS=0
ARGS=("$@")

for arg in "$@"; do
  case "$arg" in
    --status) DO_STATUS=1 ;;
    --down) DO_DOWN=1 ;;
    --no-build) DO_BUILD=0 ;;
    --no-setup) DO_SETUP=0 ;;
    --skip-env-check) SKIP_ENV_CHECK=1 ;;
    --no-proxy) DO_PROXY=0 ;;
    --foreground) FOREGROUND=1 ;;
    --logs) DO_LOGS=1 ;;
    -h|--help)
      sed -n '2,36p' "$0"
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

SUDO=""; [ "$(id -u)" -eq 0 ] || SUDO="sudo"

# shellcheck source=deploy/lib.sh
. "$ROOT/deploy/lib.sh"


# Non-Docker listeners on a port (Docker's own proxies, i.e. a previous deploy, are fine).
port_holder() { $SUDO ss -tlnpH "sport = :$1" 2>/dev/null | grep -v docker-proxy || true; }

# Host ports the services about to start publish, read from the real compose config (so
# EVOLUTION_PORT and the lite-mode skip are honoured), one per line.
deploy_ports() {
  compose config --format json | LITE="${LITE:-0}" python3 -c 'import sys,json,os
for n,s in json.load(sys.stdin)["services"].items():
    if os.environ["LITE"] == "1" and n.startswith("langfuse-"):
        continue
    for p in s.get("ports", []):
        print(p["published"])' | sort -un
}

# A host process on a port the stack binds makes `up` fail with "address already in use".
# FREE_PORTS=1 kills it, but a systemd/pm2 service restarts it, so recheck and name the unit.
check_ports() {
  local port line pid unit
  for port in $(deploy_ports); do
    line="$(port_holder "$port")"
    [ -n "$line" ] || continue
    pid="$(printf '%s' "$line" | grep -o 'pid=[0-9]*' | head -n 1 | cut -d= -f2)"
    unit="$(ps -o unit= -p "${pid:-0}" 2>/dev/null | tr -d ' ' || true)"
    if [ "${FREE_PORTS:-0}" = "1" ]; then
      warn "Port $port held by a host process — killing it (FREE_PORTS=1): $line"
      $SUDO fuser -k "$port/tcp" || warn "Could not free port $port"
      sleep 2
      [ -z "$(port_holder "$port")" ] || die "Port $port is held again: a service restarts it (unit: ${unit:-unknown}). Run: sudo systemctl disable --now ${unit:-<service>} (a user service: systemctl --user). For Evolution you can set EVOLUTION_PORT in .env instead."
    else
      die "Port $port is held by a host process (unit: ${unit:-unknown}): $line. Stop it (a systemd service: sudo systemctl disable --now ${unit:-<service>}), or re-run with FREE_PORTS=1. For Evolution you can set EVOLUTION_PORT in .env instead."
    fi
  done
}

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
    ""|changeme|replace-with-long-random|replace-with-other-long-random|sk-or-replace-me|pk-lf-replace-me|sk-lf-replace-me|00000000-0000-0000-0000-000000000000|darex-evolution-dev-key|darex-evolution-webhook-dev-secret)
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

# Build the images one at a time. `compose up --build` builds them all in parallel (seven on the
# Azure VM), which ran the disk out ("no space left on device"; the containerd image store also
# keeps layers twice) and starved its single CPU. The dashboard goes first: mcp-bridge is built
# FROM darex-dashboard:local, and a server that never built it would ask Docker Hub for it.
# Each image is skipped on its own when it exists and was last built from the same inputs (see
# service_fingerprint in lib.sh), and is recorded the moment it finishes: a retry after a failed
# build or `up` rebuilds only what did not finish, and a new commit rebuilds only the services
# whose files changed. FORCE_BUILD=1 rebuilds everything; Docker's layer cache still applies.
build_images() {
  local svc img free built=0 skipped=""
  while read -r svc img; do
    if [ "${FORCE_BUILD:-0}" != "1" ] && service_is_built "$svc" "$img"; then
      skipped="$skipped $svc"; continue
    fi
    free="$(df -BG --output=avail / 2>/dev/null | tail -n 1 | tr -dc '0-9')"
    if [ -n "$free" ] && [ "$free" -lt 6 ]; then
      warn "Only ${free} GB disk free before building $svc — pruning the build cache"
      docker builder prune -af >/dev/null || warn "Build cache prune failed"
      free="$(df -BG --output=avail / | tail -n 1 | tr -dc '0-9')"
      [ "${free:-0}" -ge 4 ] || die "Only ${free:-0} GB disk free, not enough to build $svc. Free space (docker image prune -f, see deploy/SERVER.md) and re-run."
    fi
    log "Building $svc"
    compose build "$svc" < /dev/null
    record_built "$svc"
    built=$((built + 1))
  done <<< "$BUILD_LIST"
  [ -z "$skipped" ] || info "✓ Already built from the current files, skipped:$skipped (FORCE_BUILD=1 to rebuild)"
  [ "$built" -gt 0 ] || info "✓ No image needed a build"
}

compose() {
  bash "$ROOT/infra/scripts/compose-cmd.sh" --overlay "$ROOT/deploy/docker-compose.prod.yml" "$@"
}

ask() {
  # ask VAR "prompt": keep an exported value, else prompt on a terminal, else fail.
  local var=$1 prompt=$2 val
  eval "val=\${$var:-}"
  if [ -z "$val" ]; then
    [ -t 0 ] || die "$var is not set. Run: $var=... ./deploy/deploy.sh"
    read -r -p "$prompt " val
    [ -n "$val" ] || die "$var is required"
  fi
  eval "$var=\$val"
}

# First run on a new server: write .env with generated secrets. An existing .env is never
# touched, so database passwords stay stable across deploys.
# An older .env can predate secrets the stack now requires (seen on the Azure VM: no
# APP_DB_PASSWORD). Add only the generated secrets that are missing or placeholders; a
# value that is already set is never changed.
fill_missing_secrets() {
  command -v openssl >/dev/null 2>&1 || return 0
  local key cur val added=""
  for key in DB_PASSWORD APP_DB_PASSWORD SUPERTOKENS_API_KEY DAREX_SESSION_SECRET LITELLM_MASTER_KEY \
             ATOMIC_AGENT_API_KEY EVOLUTION_API_KEY EVOLUTION_WEBHOOK_SECRET NANGO_SECRET_KEY CHANNEL_SECRETS_KEY \
             MCP_BRIDGE_SECRET; do
    cur="$(grep -E "^$key=" "$ROOT/.env" | tail -n 1 | cut -d= -f2- || true)"
    is_placeholder "$cur" || continue
    case "$key" in
      NANGO_SECRET_KEY) val="$(cat /proc/sys/kernel/random/uuid 2>/dev/null || uuidgen | tr 'A-Z' 'a-z')" ;;
      CHANNEL_SECRETS_KEY) val="$(openssl rand -hex 32)" ;;
      *) val="$(openssl rand -hex 24)" ;;
    esac
    if grep -qE "^$key=" "$ROOT/.env"; then
      sed -i.bak "s|^$key=.*|$key=$val|" "$ROOT/.env" && rm -f "$ROOT/.env.bak"
    else
      printf '\n%s=%s\n' "$key" "$val" >> "$ROOT/.env"
    fi
    added="$added $key"
  done
  [ -z "$added" ] || info "✓ .env was missing secrets, generated:$added (existing values untouched)"
}

bootstrap_env() {
  if [ -f "$ROOT/.env" ]; then fill_missing_secrets; return 0; fi
  log "No .env found — creating one with generated secrets"
  command -v openssl >/dev/null 2>&1 || die "openssl is required to generate secrets"
  ask DOMAIN "Public domain pointing at this server (e.g. app.example.com):"
  DOMAIN="${DOMAIN#https://}"; DOMAIN="${DOMAIN%/}"
  ask OPENROUTER_API_KEY "OpenRouter API key (sk-or-...):"
  cp "$ROOT/deploy/env.production.example" "$ROOT/.env"
  chmod 600 "$ROOT/.env"
  local r nango
  r() { openssl rand -hex 24; }
  nango="$(cat /proc/sys/kernel/random/uuid 2>/dev/null || uuidgen | tr 'A-Z' 'a-z')"
  setenv() { sed -i.bak "s|^$1=.*|$1=$2|" "$ROOT/.env" && rm -f "$ROOT/.env.bak"; }
  setenv NEXT_PUBLIC_APP_URL "https://$DOMAIN"
  setenv SUPERUSER_DB_PASSWORD "$(r)"
  setenv DB_PASSWORD "$(r)"
  setenv APP_DB_PASSWORD "$(r)"
  setenv SUPERTOKENS_API_KEY "$(r)"
  setenv DAREX_SESSION_SECRET "$(r)"
  setenv LITELLM_MASTER_KEY "$(r)"
  setenv ATOMIC_AGENT_API_KEY "$(r)"
  setenv EVOLUTION_API_KEY "$(r)"
  setenv EVOLUTION_WEBHOOK_SECRET "$(r)"
  setenv NANGO_SECRET_KEY "$nango"
  setenv CHANNEL_SECRETS_KEY "$(openssl rand -hex 32)"
  setenv MCP_BRIDGE_SECRET "$(r)"
  setenv OPENROUTER_API_KEY "$OPENROUTER_API_KEY"
  info "✓ .env written (chmod 600). Back it up: CHANNEL_SECRETS_KEY seals stored WhatsApp tokens."
}

# HTTPS: install Caddy if missing and route the domain to the frontend (13100).
setup_proxy() {
  [ "$DO_PROXY" -eq 1 ] || { info "Skipping Caddy (--no-proxy)"; return 0; }
  local host="${NEXT_PUBLIC_APP_URL#https://}"; host="${host%%/*}"
  local sudo_cmd="$SUDO"
  if ! command -v caddy >/dev/null 2>&1; then
    if [ -n "$($SUDO ss -tlnH '( sport = :80 or sport = :443 )' 2>/dev/null)" ]; then
      warn "Ports 80/443 are already used (another proxy, e.g. a Caddy container) — not installing Caddy."
      warn "Route $host to that proxy. A Caddy container cannot reach host 127.0.0.1:${FRONTEND_HOST_PORT}: attach it to the darex-net network"
      warn "and use 'reverse_proxy darex-frontend:3100' (steps in deploy/SERVER.md, HTTPS)."
      return 0
    fi
    if command -v apt-get >/dev/null 2>&1; then
      log "Installing Caddy (automatic HTTPS)"
      $sudo_cmd apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg
      curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | $sudo_cmd gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
      curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | $sudo_cmd tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
      $sudo_cmd apt-get update
      $sudo_cmd apt-get install -y caddy
    else
      warn "Caddy is not installed and apt is unavailable — set up HTTPS yourself (deploy/Caddyfile.example)"
      return 0
    fi
  fi
  if ! grep -qs "^$host" /etc/caddy/Caddyfile 2>/dev/null; then
    log "Adding $host to /etc/caddy/Caddyfile -> 127.0.0.1:${FRONTEND_HOST_PORT}"
    printf '\n%s {\n\tencode gzip\n\treverse_proxy 127.0.0.1:%s\n}\n' "$host" "${FRONTEND_HOST_PORT}" | $sudo_cmd tee -a /etc/caddy/Caddyfile >/dev/null
  fi
  $sudo_cmd systemctl enable --now caddy >/dev/null 2>&1 || true
  $sudo_cmd systemctl reload caddy || warn "Could not reload Caddy — check: sudo systemctl status caddy"
  info "✓ Caddy serves https://$host (DNS must point at this server for the certificate)"
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
    CHANNEL_SECRETS_KEY
    EVOLUTION_API_KEY
    EVOLUTION_WEBHOOK_SECRET
    MCP_BRIDGE_SECRET
  )
  local key val
  for key in "${required[@]}"; do
    eval "val=\${$key:-}"
    if is_placeholder "$val"; then
      die "$key is missing or still a placeholder"
    fi
  done
  looks_like_uuid "${NANGO_SECRET_KEY}" || die "NANGO_SECRET_KEY must be Nango's UUID (not a random string)."
  # Seals stored WhatsApp tokens (AES-256-GCM). Losing it means every Meta connection must be redone.
  echo "${CHANNEL_SECRETS_KEY}" | grep -Eq '^[0-9a-fA-F]{64}$' \
    || die "CHANNEL_SECRETS_KEY must be 64 hex characters (openssl rand -hex 32)."
  echo "${CHANNEL_SECRETS_KEY}" | grep -Eq '^0{64}$' && die "CHANNEL_SECRETS_KEY is the all-zero dev default."
  # Compose gives the Postgres superuser this password; unset means the public dev default.
  case "${SUPERUSER_DB_PASSWORD:-}" in
    ""|darex_dev_secret) warn "SUPERUSER_DB_PASSWORD is unset or the dev default — the Postgres superuser uses a known password (loopback only). Set it in .env before the first boot of a new server." ;;
  esac
  return 0
}

# Runs after the new containers are up: new code on the old schema for a few
# seconds is safer than old code on the new schema for the whole image build
# (migration 204 changed the channels unique index that old upserts rely on).
migrate() {
  log "Applying SQL migrations as superuser darex (password: SUPERUSER_DB_PASSWORD, the one compose gave Postgres)"
  run_migrations
}

print_status() {
  compose ps
  echo
  curl -sf "http://127.0.0.1:${DASHBOARD_PORT}/api/health" && echo "  ✓ dashboard health ok" || echo "  ✗ dashboard health FAIL"
  curl -sf "http://127.0.0.1:${FRONTEND_HOST_PORT}/api/health" && echo "  ✓ frontend (and /api proxy) ok" || echo "  ✗ frontend FAIL"
  docker exec darex-postgres pg_isready -U darex -d darex && echo "  ✓ postgres ready" || echo "  ✗ postgres not ready"
}

validate_deployment() {
  log "Validating deployment..."
  local checks_passed=0
  local checks_total=0

  # Check 1: Dashboard health
  checks_total=$((checks_total + 1))
  if curl -sf "http://127.0.0.1:${DASHBOARD_PORT}/api/health" >/dev/null 2>&1; then
    info "✓ Dashboard /api/health responding"
    checks_passed=$((checks_passed + 1))
  else
    warn "✗ Dashboard /api/health not responding"
  fi

  # Check 1b: Frontend page and its /api proxy to the dashboard
  checks_total=$((checks_total + 1))
  if curl -sf "http://127.0.0.1:${FRONTEND_HOST_PORT}/sign-in" >/dev/null 2>&1 && curl -sf "http://127.0.0.1:${FRONTEND_HOST_PORT}/api/health" >/dev/null 2>&1; then
    info "✓ Frontend serving pages and proxying /api to the dashboard"
    checks_passed=$((checks_passed + 1))
  else
    warn "✗ Frontend not serving or not reaching the dashboard — docker logs darex-frontend"
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

  # Check 4: Evolution API (WhatsApp QR link). Warn only: the official API path works without it.
  checks_total=$((checks_total + 1))
  if curl -sf -H "apikey: ${EVOLUTION_API_KEY:-}" "http://127.0.0.1:${EVOLUTION_PORT}/instance/fetchInstances" >/dev/null 2>&1; then
    info "✓ Evolution API responding (WhatsApp QR link)"
    checks_passed=$((checks_passed + 1))
  else
    warn "✗ Evolution API not responding — QR linking is down, docker logs darex-evolution"
  fi

  # Check 5: Docker disk usage
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
  # Node is optional: without it the migrations run in a throwaway Node container.
  if command -v node >/dev/null 2>&1; then info "✓ node installed"; else info "node not installed — fine, migrations run in a container"; fi
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
  local avail_mb; avail_mb=$(free -m | awk 'NR==2 {print $7}')
  [ "$avail_mb" -ge 3000 ] || warn "Only ${avail_mb}MB RAM available — stop other stacks before the build or it may OOM"
  if [ "$mem_gb" -lt 4 ]; then
    warn "Low memory: ${mem_gb}GB (recommend 4GB+)"
  else
    info "✓ Memory OK: ${mem_gb}GB available"
  fi
}

# On the EC2 box this is the step that brings in pushed commits.
# .env is gitignored and is never checked out or deleted.
sync_repo() {
  if [ ! -d "$ROOT/.git" ]; then
    warn "No .git directory — deploying the files already on disk"
    return 0
  fi
  command -v git >/dev/null 2>&1 || die "git is required to update the server checkout"
  local branch="${DEPLOY_BRANCH:-main}"
  local before after
  before="$(git -C "$ROOT" rev-parse HEAD)"
  log "Updating $branch from origin (.env is left untouched)"
  git -C "$ROOT" fetch origin "$branch"
  if [ -n "$(git -C "$ROOT" status --porcelain --untracked-files=no)" ]; then
    die "Server repo has local edits to tracked files. Discard them, then re-run."
  fi
  git -C "$ROOT" checkout "$branch"
  git -C "$ROOT" merge --ff-only "origin/$branch"
  require_in_sync "$ROOT" "$branch"
  after="$(git -C "$ROOT" rev-parse HEAD)"
  info "✓ Checked out $branch at ${after:0:12}"
  if [ "$before" != "$after" ]; then
    log "Deploy script updated with the pull; starting it again"
    exec bash "$ROOT/deploy/deploy.sh" "${ARGS[@]}"
  fi
}

# NEW-FRONTEND is a separate repo (not a submodule), so the backend pull above never
# updates it. Clone it on first run, then fast-forward to the newest FRONTEND_BRANCH.
# Laptop mode (DEPLOY_HOST) rsyncs the folder instead and sets SKIP_FRONTEND_PULL=1.
sync_frontend() {
  local dir="$ROOT/NEW-FRONTEND"
  local branch="${FRONTEND_BRANCH:-feat/new-frontend}"
  local url="${FRONTEND_REPO_URL:-https://github.com/DarexAI-AI-Startup/agentic-os-frontend.git}"
  if [ "${SKIP_FRONTEND_PULL:-0}" = "1" ]; then
    [ -f "$dir/package.json" ] || die "NEW-FRONTEND/package.json is missing after the sync."
    info "✓ Using the NEW-FRONTEND files that were synced"
    return 0
  fi
  command -v git >/dev/null 2>&1 || die "git is required to update NEW-FRONTEND"
  if [ ! -d "$dir/.git" ]; then
    if [ -f "$dir/package.json" ]; then
      warn "NEW-FRONTEND has no .git directory — deploying the files already on disk"
      return 0
    fi
    log "Cloning the frontend ($branch) into NEW-FRONTEND"
    GIT_TERMINAL_PROMPT=0 git clone --branch "$branch" "$url" "$dir" \
      || die "Could not clone $url. For a private repo set FRONTEND_REPO_URL with a deploy token or SSH URL."
  else
    log "Updating the frontend $branch from origin"
    git -C "$dir" fetch origin "$branch"
    if [ -n "$(git -C "$dir" status --porcelain --untracked-files=no)" ]; then
      die "NEW-FRONTEND has local edits to tracked files. Discard them, then re-run."
    fi
    git -C "$dir" checkout "$branch"
    git -C "$dir" merge --ff-only "origin/$branch"
  fi
  info "✓ Frontend at $(git -C "$dir" rev-parse --short=12 HEAD) ($branch)"
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
    --exclude '.next-*/' \
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
  ssh "$host" "cd '$path' && SKIP_FRONTEND_PULL=1 bash ./deploy/deploy.sh ${extra[*]}"
}

if [ -n "${DEPLOY_HOST:-}" ]; then
  remote_deploy "$DEPLOY_HOST"
  exit 0
fi

# =============================================================================
# LOCAL DEPLOYMENT
# =============================================================================

# Runs in the background and follows the log, so closing the terminal does not stop it.
# shellcheck source=deploy/detach.sh
. "$ROOT/deploy/detach.sh"
NO_DETACH=$((DO_STATUS || DO_DOWN))
detach_dispatch "$ROOT/deploy/deploy.sh" ${ARGS[@]+"${ARGS[@]}"}

# Pre-flight checks
if [ "$DO_SETUP" -eq 1 ]; then
  preflight_check
else
  info "Skipping setup checks (--no-setup)"
  check_cmd docker "Install: sudo apt-get install docker.io"
fi

# Environment validation (first run creates .env)
if [ "$DO_STATUS" -eq 0 ] && [ "$DO_DOWN" -eq 0 ]; then bootstrap_env; fi
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

check_compose_version
sync_repo
sync_frontend
setup_proxy

# Small server: skip the Langfuse stack (5 services, about 2.9 GB at their caps). The dashboard
# shows a notice without it. LITE=1 forces this, LITE=0 forces the full stack.
mem_total_gb="$(awk '/^MemTotal/ {print int($2/1048576)}' /proc/meminfo 2>/dev/null || true)"
LITE="${LITE:-$([ "${mem_total_gb:-99}" -lt 12 ] && echo 1 || echo 0)}"
if [ "$LITE" = "1" ]; then
  log "Lite mode (${mem_total_gb:-?} GB RAM): not starting the Langfuse stack (LITE=0 to include it)"
fi

check_port_ownership
check_ports

# A 1-2 vCPU server boots the stack slowly: give every health wait 3x.
WAIT_MULT=1; [ "$(nproc --all 2>/dev/null || echo 4)" -gt 2 ] || WAIT_MULT=3

# Everything that can fail cheaply fails here, before the first slow build. python3 reads the
# compose config; the TrueForge image is built (or its missing checkout reported) first because
# it was the step that used to fail only after every other image had built.
check_cmd python3 "Install: sudo apt-get install python3"
BUILD_LIST="$(compose config --format json | python3 -c 'import sys,json
d=json.load(sys.stdin)
for k in sorted((k for k,v in d["services"].items() if v.get("build")),key=lambda k:(k!="dashboard",k)):
    print(k, d["services"][k].get("image") or d["name"]+"-"+k)')"
ensure_trueforge_image
if [ "$DO_BUILD" -eq 1 ]; then
  check_build_inputs
  build_images
fi
prepare_data_dirs

# Postgres first: the app services (pgbouncer, mcp-bridge, dashboard, worker) cannot log in until
# the darex_app password matches .env, and a stack started before that stalls on an unhealthy
# mcp-bridge (seen on the first Azure deploy).
log "Starting Postgres and aligning the darex_app password with APP_DB_PASSWORD"
compose up -d postgres
align_app_role_password

log "Bringing stack up with production overlay (loopback binds, frontend rebuilt from the latest NEW-FRONTEND)"
start_stack

log "Waiting for Postgres on 127.0.0.1:${POSTGRES_HOST_PORT}"
tries=0
until docker exec darex-postgres pg_isready -U darex -d darex >/dev/null 2>&1; do
  tries=$((tries + 1))
  [ "$tries" -lt $((60 * WAIT_MULT)) ] || die "Postgres did not become ready"
  sleep 2
done

migrate

wait_http "dashboard" "http://127.0.0.1:${DASHBOARD_PORT}/api/health" darex-dashboard 90
wait_http "frontend (and its /api proxy to the dashboard)" "http://127.0.0.1:${FRONTEND_HOST_PORT}/api/health" darex-frontend

print_status

# Final validation
validate_deployment
docker_housekeeping

PUBLIC_OK="no"
if curl -sf --max-time 20 "${NEXT_PUBLIC_APP_URL}/api/health" >/dev/null 2>&1; then
  PUBLIC_OK="yes"
  info "✓ ${NEXT_PUBLIC_APP_URL} answers over HTTPS"
else
  warn "✗ ${NEXT_PUBLIC_APP_URL} does not answer yet — DNS must point here and Caddy needs ~1 min for the certificate"
fi
DEPLOYED_BACKEND="$(git -C "$ROOT" rev-parse --short=10 HEAD 2>/dev/null || echo unknown)"
DEPLOYED_FRONTEND="$(git -C "$ROOT/NEW-FRONTEND" rev-parse --short=10 HEAD 2>/dev/null || echo unknown)"

[ ! -f /var/run/reboot-required ] || warn "A reboot is pending for OS updates — reboot in a quiet window: sudo reboot"

cat <<EOF

========================================
✓ DEPLOYMENT SUCCESSFUL
========================================

LIVE SITE:  ${NEXT_PUBLIC_APP_URL:-https://your-domain}   (HTTPS reachable: ${PUBLIC_OK})
Deployed:   backend ${DEPLOYED_BACKEND}, frontend ${DEPLOYED_FRONTEND}

Environment:
  App URL: ${NEXT_PUBLIC_APP_URL:-https://your-domain}
  Open that URL after this script exits 0. It is the live site.
  Database: Postgres (darex_app user)
  Auth: SuperTokens + Nango OAuth
  LLM: LiteLLM + OpenRouter

Services (loopback only, use Caddy/nginx reverse proxy):
  Frontend (the site) http://127.0.0.1:${FRONTEND_HOST_PORT}   <- point Caddy/nginx here
  Dashboard API      http://127.0.0.1:${DASHBOARD_PORT}/api
  Nango OAuth        http://127.0.0.1:${NANGO_HOST_PORT}
  Langfuse Monitor   http://127.0.0.1:${LANGFUSE_HOST_PORT}  (not started in lite mode)
  Temporal UI        http://127.0.0.1:${TEMPORAL_UI_HOST_PORT}
  LiteLLM            http://127.0.0.1:${LITELLM_HOST_PORT}
  Inbox Worker       http://127.0.0.1:${INBOX_HOST_PORT}
  Evolution (WhatsApp QR) http://127.0.0.1:${EVOLUTION_PORT}
  Agent Sandbox      http://127.0.0.1:8787
  MCP Bridge         ws://127.0.0.1:${MCP_BRIDGE_HOST_PORT}/sse

Next steps:
  1. Configure Caddy/nginx: deploy/Caddyfile.example
  2. Start reverse proxy pointing to http://127.0.0.1:${FRONTEND_HOST_PORT} (the frontend proxies /api to the dashboard)
  3. Access ${NEXT_PUBLIC_APP_URL:-https://your-domain} in browser
  4. SSH tunnel for admin UIs:
     ssh -L 3003:127.0.0.1:${NANGO_HOST_PORT} -L 3002:127.0.0.1:${LANGFUSE_HOST_PORT} -L 8233:127.0.0.1:${TEMPORAL_UI_HOST_PORT} user@host

Monitoring & Operations:
  Status:    ./deploy/deploy.sh --status
  Logs:      docker compose -f infra/docker-compose.yml -f deploy/docker-compose.prod.yml logs -f
  Stop:      ./deploy/deploy.sh --down
  Restart:   docker compose -f infra/docker-compose.yml -f deploy/docker-compose.prod.yml restart

Troubleshooting:
  Dashboard issues:  docker logs darex-dashboard
  Frontend issues:   docker logs darex-frontend
  Database issues:   docker exec -it darex-postgres psql -U darex -d darex
  Service logs:      docker logs <service_name>
  All logs:          docker compose ... logs --all

Security:
  - Frontend and dashboard are loopback-only (127.0.0.1)
  - Use Caddy/nginx reverse proxy with TLS
  - Admin UIs require SSH tunnels
  - Keep .env secrets secure and never commit
  - Rotate API keys periodically

========================================
EOF
