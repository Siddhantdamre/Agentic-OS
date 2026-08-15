#!/usr/bin/env bash
# Cross-platform setup for Darex (Windows, Mac, Linux/Ubuntu)
# Run once before start.sh to ensure all dependencies and configs are ready

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

log() { printf '\n==> %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
info() { printf '    %s\n' "$*"; }

compose() {
  bash "$ROOT/infra/scripts/compose-cmd.sh" "$@"
}

# Detect OS
detect_os() {
  case "$(uname -s)" in
    Linux*)     echo "linux" ;;
    Darwin*)    echo "macos" ;;
    MINGW*|MSYS*|CYGWIN*) echo "windows" ;;
    *)          echo "unknown" ;;
  esac
}

OS=$(detect_os)
log "Detected OS: $OS"

# Check for required commands
check_command() {
  local cmd=$1
  local install_hint=$2

  if ! command -v "$cmd" >/dev/null 2>&1; then
    die "Missing '$cmd'. $install_hint"
  fi
  info "✓ $cmd installed"
}

# Install instructions per OS
install_hint_docker() {
  case "$OS" in
    windows)
      echo "Download Docker Desktop: https://www.docker.com/products/docker-desktop"
      ;;
    macos)
      echo "brew install docker (via Docker Desktop recommended)"
      ;;
    linux)
      echo "sudo apt-get update && sudo apt-get install -y docker.io docker-compose"
      ;;
  esac
}

install_hint_node() {
  case "$OS" in
    windows|macos)
      echo "Download from https://nodejs.org (LTS) or: brew install node"
      ;;
    linux)
      echo "curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash - && sudo apt-get install -y nodejs"
      ;;
  esac
}

install_hint_pnpm() {
  echo "npm install -g pnpm (requires npm/Node.js)"
}

# =============================================================================
# REQUIREMENT CHECKS
# =============================================================================

log "Checking system requirements..."

check_command docker "$(install_hint_docker)"
check_command node "$(install_hint_node)"
check_command pnpm "$(install_hint_pnpm)"

# Check Docker daemon is running
log "Verifying Docker daemon..."
if ! docker ps >/dev/null 2>&1; then
  die "Docker daemon not running. Start Docker and retry."
fi
info "✓ Docker daemon is running"

# =============================================================================
# ENVIRONMENT SETUP
# =============================================================================

log "Setting up environment..."

if [ ! -f "$ROOT/.env" ]; then
  if [ -f "$ROOT/.env.example" ]; then
    cp "$ROOT/.env.example" "$ROOT/.env"
    log "Created .env from .env.example"
    log "⚠️  Review .env — update secrets before running live integrations"
  else
    die "No .env.example found"
  fi
fi

# Load env vars
set -a
# shellcheck disable=SC1091
. "$ROOT/.env"
set +a

# Next.js only auto-loads env files from the app's own directory, never the
# repo root — without this, apps/dashboard boots with DB_PASSWORD unset and
# every DB call (including the WhatsApp webhook) fails.
if [ ! -e "$ROOT/apps/dashboard/.env.local" ]; then
  ln -s ../../.env "$ROOT/apps/dashboard/.env.local"
  log "Linked apps/dashboard/.env.local -> ../../.env"
fi

# =============================================================================
# DEPENDENCIES
# =============================================================================

log "Installing Node dependencies (pnpm install)..."
pnpm install

log "Building shared types..."
pnpm --filter @darex/shared-types build

# =============================================================================
# DOCKER SETUP
# =============================================================================

log "Building Docker images..."
compose build --progress=plain

# =============================================================================
# DATABASE PREPARATION
# =============================================================================

log "Starting database container..."
compose up -d postgres

# Wait for Postgres to be ready
log "Waiting for Postgres..."
tries=0
until docker exec darex-postgres pg_isready -U darex -d darex >/dev/null 2>&1; do
  tries=$((tries + 1))
  if [ "$tries" -ge 60 ]; then
    die "Postgres failed to start after 120s"
  fi
  sleep 2
done
info "✓ Postgres ready"

# Run migrations
log "Applying database migrations..."
DB_HOST="${DB_HOST:-localhost}" \
  DB_PORT="${DB_PORT:-5432}" \
  DB_USER=darex \
  DB_PASSWORD="${DB_PASSWORD:-darex_dev_secret}" \
  DB_NAME="${DB_NAME:-darex}" \
  node "$ROOT/infra/db/migrate.js"

# =============================================================================
# MARK SETUP COMPLETE
# =============================================================================

SETUP_MARKER="$ROOT/.setup-done"
touch "$SETUP_MARKER"

log "Setup complete! Run ./start.sh to begin"
