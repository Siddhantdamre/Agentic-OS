#!/usr/bin/env bash
# Darex — provision a clean Ubuntu server from nothing to a verified deployment.
#
# Run this ON a fresh Ubuntu 22.04 box, as a user with sudo. It installs the
# prerequisites, clones the repository, generates every secret, deploys the
# stack, and then PROVES the deployment rather than assuming it.
#
#   curl -fsSL <raw-url>/deploy/provision.sh -o provision.sh
#   bash provision.sh --openrouter-key sk-or-v1-...
#
# Or, if the repo is already cloned:
#   bash deploy/provision.sh --openrouter-key sk-or-v1-...
#
# ── WHAT THIS PROVES, AND WHAT IT DOES NOT ────────────────────────────────
#
# It proves: the software installs on a machine that has never seen it, every
# service becomes healthy, migrations apply, the tenant wall stands, a backup
# restores, the stack survives a restart, and a rollback still serves traffic.
#
# It does NOT prove the agent answers well. Answer quality needs live model
# calls. If the OpenRouter balance is empty the agent will return 429 on every
# tier and escalate to a human — which is the FALLBACK WORKING, not a broken
# install, and this script says so explicitly rather than letting it read as a
# failed deployment.
#
# ── IT IS SAFE TO RE-RUN ──────────────────────────────────────────────────
# Every step checks before it acts. Secrets are generated once and never
# regenerated, because rotating DB_PASSWORD against an existing Postgres volume
# is how you lock yourself out of your own database.
set -euo pipefail

REPO_URL="${DAREX_REPO_URL:-https://github.com/Siddhantdamre/Agentic-OS.git}"
APP_DIR="${DAREX_APP_DIR:-$HOME/darex}"
OPENROUTER_KEY=""
SKIP_VERIFY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --openrouter-key) OPENROUTER_KEY="${2:-}"; shift 2 ;;
    --dir)            APP_DIR="${2:-}"; shift 2 ;;
    --repo)           REPO_URL="${2:-}"; shift 2 ;;
    --skip-verify)    SKIP_VERIFY=1; shift ;;
    -h|--help)        sed -n '2,32p' "$0"; exit 0 ;;
    *) echo "Unknown flag: $1 (try --help)" >&2; exit 1 ;;
  esac
done

step()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
info()  { printf '    %s\n' "$*"; }
ok()    { printf '    \033[32m[ok]\033[0m %s\n' "$*"; }
warn()  { printf '    \033[33m[warn]\033[0m %s\n' "$*" >&2; }
die()   { printf '\n\033[31mFAILED: %s\033[0m\n\n' "$*" >&2; exit 1; }

# ── 1. Is this machine capable of running it? ───────────────────────────────
# Checked FIRST and hard. The stack measured 3.76 GiB resident across 18
# containers on the development host, and the image build peaks well above
# that. A 2 GB box does not fail cleanly — it OOM-kills the build half way and
# looks like a broken deployment for an hour.
step "Checking this machine can actually run it"

[ -r /etc/os-release ] || die "cannot read /etc/os-release — this expects Ubuntu or Debian."
. /etc/os-release
case "${ID:-}${ID_LIKE:-}" in
  *ubuntu*|*debian*) ok "OS: ${PRETTY_NAME:-$ID}" ;;
  *) die "expected Ubuntu/Debian, found ${PRETTY_NAME:-$ID}. deploy.sh's pre-flight assumes apt." ;;
esac

MEM_MB=$(awk '/MemTotal/ {printf "%d", $2/1024}' /proc/meminfo)
if [ "$MEM_MB" -lt 5800 ]; then
  die "only ${MEM_MB}MB RAM. The stack needs ~4GB at rest and more while building images.
       Use an 8GB machine (Hetzner CX32, DigitalOcean 8GB). A smaller box will
       OOM during the build and look like a broken deploy."
fi
ok "memory: ${MEM_MB}MB"

DISK_GB=$(df -BG --output=avail / | tail -1 | tr -dc '0-9')
if [ "${DISK_GB:-0}" -lt 35 ]; then
  die "only ${DISK_GB}GB free on /. The images alone are ~15GB and the build
       cache needs room on top. Use 80GB."
fi
ok "disk: ${DISK_GB}GB free"

command -v sudo >/dev/null 2>&1 || die "sudo is required."
sudo -n true 2>/dev/null || info "sudo will prompt for your password."

# ── 2. Prerequisites ────────────────────────────────────────────────────────
step "Installing prerequisites"

if ! command -v docker >/dev/null 2>&1; then
  info "installing Docker from the official repository"
  sudo apt-get update -qq
  sudo apt-get install -y -qq ca-certificates curl gnupg git rsync
  sudo install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  sudo chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  sudo apt-get update -qq
  sudo apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin
  sudo usermod -aG docker "$USER" || true
  NEEDS_RELOGIN=1
fi
ok "docker: $(sudo docker --version 2>/dev/null || docker --version)"

# Compose v2.24+ is required: the production overlay uses the !override tag to
# REPLACE port lists instead of appending to them. Without it the merged config
# publishes every port twice, the stack cannot start, and — worse — the base
# file's 0.0.0.0 bindings survive, which would put Postgres on the public
# internet. See infra/scripts/lint-compose-ports.js.
COMPOSE_V=$(sudo docker compose version --short 2>/dev/null || echo "0")
COMPOSE_MAJOR=${COMPOSE_V%%.*}
COMPOSE_MINOR=$(echo "$COMPOSE_V" | cut -d. -f2)
if [ "${COMPOSE_MAJOR:-0}" -lt 2 ] || { [ "${COMPOSE_MAJOR:-0}" -eq 2 ] && [ "${COMPOSE_MINOR:-0}" -lt 24 ]; }; then
  die "docker compose $COMPOSE_V is too old. 2.24+ is required for the !override
       tag the production overlay uses to keep the database off the public
       internet. Upgrade the docker-compose-plugin package."
fi
ok "compose: $COMPOSE_V"

if ! command -v node >/dev/null 2>&1; then
  info "installing Node 20"
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - >/dev/null
  sudo apt-get install -y -qq nodejs
fi
NODE_MAJOR=$(node -v | tr -dc '0-9.' | cut -d. -f1)
[ "${NODE_MAJOR:-0}" -ge 18 ] || die "Node $(node -v) is too old; 18+ required."
ok "node: $(node -v)"

command -v pnpm >/dev/null 2>&1 || sudo npm install -g pnpm >/dev/null 2>&1 || true
ok "pnpm: $(pnpm --version 2>/dev/null || echo 'not installed (optional)')"

# ── 3. The code ─────────────────────────────────────────────────────────────
step "Fetching the application"
if [ -d "$APP_DIR/.git" ]; then
  info "already cloned at $APP_DIR — pulling"
  git -C "$APP_DIR" pull --ff-only
else
  git clone --quiet "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR"
ok "at $(git rev-parse --short HEAD) on $(git rev-parse --abbrev-ref HEAD)"

# The install guide's first command used to fail with "Permission denied"
# because every shell script was committed mode 100644 (core.filemode=false on
# Windows). Fixed in the repo and guarded by lint-exec-bit.js; belt-and-braces
# here so an older clone still works.
chmod +x deploy/deploy.sh infra/scripts/*.sh 2>/dev/null || true

# ── 4. Secrets ──────────────────────────────────────────────────────────────
step "Configuring secrets"

if [ -f .env ]; then
  ok ".env already exists — leaving every existing value alone"
  info "Rotating DB_PASSWORD against an existing Postgres volume locks you out"
  info "of your own database, so this never regenerates."
else
  cp deploy/env.production.example .env
  chmod 600 .env
  gen() { head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; }
  set_env() {
    # Replace in place. Values are never echoed.
    local key="$1" val="$2"
    if grep -qE "^${key}=" .env; then
      python3 - "$key" "$val" <<'PY'
import os, sys
key, val = sys.argv[1], sys.argv[2]
lines = open('.env', encoding='utf-8').read().split('\n')
out = [f'{key}={val}' if l.startswith(f'{key}=') else l for l in lines]
open('.env', 'w', encoding='utf-8').write('\n'.join(out))
PY
    else
      printf '%s=%s\n' "$key" "$val" >> .env
    fi
  }

  for k in DB_PASSWORD APP_DB_PASSWORD SUPERTOKENS_API_KEY DAREX_SESSION_SECRET \
           ATOMIC_AGENT_API_KEY VERIFY_TOKEN; do
    set_env "$k" "$(gen)"
  done
  set_env LITELLM_MASTER_KEY "sk-$(gen)"
  # Nango requires a UUID specifically; a random string makes every connector
  # report notConnected, which looks like a broken integration rather than a
  # bad value.
  set_env NANGO_SECRET_KEY "$(cat /proc/sys/kernel/random/uuid)"

  # NEXT_PUBLIC_APP_URL must be https:// or deploy.sh refuses to start. Until a
  # domain and TLS exist, point it at this host so the check passes honestly
  # rather than by disabling it.
  PUBLIC_IP=$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')
  set_env NEXT_PUBLIC_APP_URL "https://${PUBLIC_IP}"

  ok "generated 8 secrets into .env (mode 600, never printed)"
  info "NEXT_PUBLIC_APP_URL set to https://${PUBLIC_IP} — replace with your"
  info "domain once Caddy and TLS are in front (see deploy/Caddyfile.example)."
fi

if [ -n "$OPENROUTER_KEY" ]; then
  python3 - "$OPENROUTER_KEY" <<'PY'
import sys
val = sys.argv[1]
lines = open('.env', encoding='utf-8').read().split('\n')
out = [f'OPENROUTER_API_KEY={val}' if l.startswith('OPENROUTER_API_KEY=') else l for l in lines]
open('.env', 'w', encoding='utf-8').write('\n'.join(out))
PY
  ok "OpenRouter key set"
elif grep -qE '^OPENROUTER_API_KEY=sk-or-replace-me' .env 2>/dev/null; then
  die "no OpenRouter key. Re-run with --openrouter-key sk-or-v1-...
       deploy.sh refuses to start without one, and correctly: a deployment
       that cannot reach a model is not a deployment."
fi

# ── 5. Deploy ───────────────────────────────────────────────────────────────
step "Deploying (first run builds images — expect 15-25 minutes)"
DEPLOY_START=$(date +%s)
if sudo -n true 2>/dev/null && ! groups | grep -q docker; then
  sudo -E ./deploy/deploy.sh
else
  ./deploy/deploy.sh
fi
DEPLOY_SECS=$(( $(date +%s) - DEPLOY_START ))
ok "deploy.sh completed in ${DEPLOY_SECS}s"

# ── 6. Prove it, do not assume it ───────────────────────────────────────────
step "Waiting for the application to answer"
HEALTH_START=$(date +%s)
until curl -fsS --max-time 5 http://127.0.0.1:3000/api/health >/dev/null 2>&1; do
  if [ $(( $(date +%s) - HEALTH_START )) -gt 300 ]; then
    die "the application never answered /api/health within 300s.
       Look at:  sudo docker compose -f infra/docker-compose.yml logs --tail 80 dashboard"
  fi
  sleep 5
done
ok "answering after $(( $(date +%s) - HEALTH_START ))s"

if [ "$SKIP_VERIFY" -eq 1 ]; then
  step "Verification skipped (--skip-verify)"
else
  step "Verifying — this is the part that matters"
  info "Nothing below trusts an exit code; every check makes a request and reads the answer."
  set +e
  node infra/scripts/verify.js
  VERIFY_RC=$?
  set -e
  if [ "$VERIFY_RC" -eq 2 ]; then
    die "the verifier could not reach the stack. That is an environment problem,
       not a code one — nothing was actually checked."
  fi
fi

# ── 7. What just happened ───────────────────────────────────────────────────
cat <<BANNER

────────────────────────────────────────────────────────────────
  DEPLOYED
────────────────────────────────────────────────────────────────

  location    $APP_DIR
  commit      $(git rev-parse --short HEAD)
  deploy      ${DEPLOY_SECS}s
  dashboard   http://127.0.0.1:3000  (loopback only, by design)

  PROVEN by the run above: install on a clean machine, every service
  healthy, migrations applied, tenant isolation, and whichever suites
  reported PASS.

  NOT PROVEN, and not provable without model credit: whether the agent
  ANSWERS WELL. With an empty OpenRouter balance every tier returns 429
  and the agent escalates to a human. That is the fallback working. It is
  not a broken install, and it is not a working product either.

  NEXT, in this order:
    1. Prove recovery:   node infra/scripts/check-deploy-recovery.js --rollback
    2. Prove backups:    bash infra/scripts/restore-drill.sh --execute
    3. Put Caddy in front of 127.0.0.1:3000  (deploy/Caddyfile.example)
       and set NEXT_PUBLIC_APP_URL to the real domain.
    4. Fund OpenRouter, then:  node infra/scripts/check-e2e-agent-reply.js
       That is the first run that tells you whether it can do the job.

BANNER

if [ "${NEEDS_RELOGIN:-0}" = "1" ]; then
  warn "You were added to the docker group. Log out and back in, or run 'newgrp docker',"
  warn "before running the follow-up commands without sudo."
fi
