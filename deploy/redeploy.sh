#!/usr/bin/env bash
# Darex fast redeploy — pull the latest backend AND frontend, rebuild only the services whose
# inputs changed, restart the frontend, apply new migrations. For routine code pushes.
# Does NOT wipe the DB, volumes or sessions, and leaves unchanged services running.
#
# Usage (on the server, repo root):
#   ./deploy/redeploy.sh                    pull both repos, rebuild only what changed, migrate
#   ./deploy/redeploy.sh dashboard worker   rebuild exactly these services (skips the diff)
#   ./deploy/redeploy.sh --all              rebuild every service (Docker's layer cache still applies)
#   ./deploy/redeploy.sh --plan             show what a redeploy would rebuild, change nothing
#   ./deploy/redeploy.sh --status           show stack status only
#   ./deploy/redeploy.sh --logs             follow the running (or last) deploy. A redeploy runs in the
#                                           background and streams its log, so closing the terminal
#                                           never stops it. --foreground runs it in this terminal.
#   DEPLOY_BRANCH=other FRONTEND_BRANCH=other ./deploy/redeploy.sh
#
# Usage (from a laptop):
#   DEPLOY_HOST=ubuntu@203.0.113.10 DEPLOY_PATH=/opt/darex ./deploy/redeploy.sh
#   (the folders are rsynced, so there is no git history to diff: everything is rebuilt, cached)
#
# How "only what changed" works:
#   - After every successful run the deployed backend and frontend commits are saved in
#     .git/darex-deployed. The next run diffs against those, so a run that failed halfway is
#     retried in full instead of being skipped. No saved state (first run): rebuild all.
#   - Changed paths map to services: apps/dashboard, services/*, packages/* -> dashboard + worker
#     (+ mcp-bridge, built on the dashboard image); apps/inbox -> inbox; infra/docker/<svc>/ -> that
#     service; a new NEW-FRONTEND commit or infra/docker/frontend/ -> frontend. Docs-only: nothing.
#   - A service whose image is missing is always built.
#   - Compose/config changes need no rebuild: `up -d` recreates only containers that drifted.
#   - The frontend is restarted every run so it always serves the latest build.
#
# Never runs `docker compose down`, drops tables, or touches .env.

set -euo pipefail
set -E
trap 'printf "ERROR: redeploy.sh stopped at line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

DO_STATUS=0
DO_PLAN=0
DO_ALL=0
FOREGROUND=0
DO_LOGS=0
SERVICES=()
ARGS=("$@")

for arg in "$@"; do
  case "$arg" in
    --status) DO_STATUS=1 ;;
    --plan) DO_PLAN=1 ;;
    --all) DO_ALL=1 ;;
    --foreground) FOREGROUND=1 ;;
    --logs) DO_LOGS=1 ;;
    --help|-h)
      sed -n '2,36p' "$0"
      exit 0
      ;;
    --*)
      echo "Unknown flag: $arg (try --help)" >&2
      exit 1
      ;;
    *)
      SERVICES+=("$arg")
      ;;
  esac
done

log()  { printf '\n==> %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf 'WARN: %s\n' "$*" >&2; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# Steps shared with deploy.sh (Compose version gate, TrueForge image, darex_app password, Cognee
# volume, failure diagnosis, cache cleanup).
# shellcheck source=deploy/lib.sh
. "$ROOT/deploy/lib.sh"

compose() {
  bash "$ROOT/infra/scripts/compose-cmd.sh" --overlay "$ROOT/deploy/docker-compose.prod.yml" "$@"
}

STATE_FILE="$ROOT/.git/darex-deployed"

# ── status only ──────────────────────────────────────────────────────────────
if [ "$DO_STATUS" -eq 1 ]; then
  compose ps
  echo
  curl -sf "http://127.0.0.1:${DASHBOARD_PORT}/api/health" && echo "  ✓ dashboard health ok" || echo "  ✗ dashboard health FAIL"
  curl -sf "http://127.0.0.1:${FRONTEND_HOST_PORT}/api/health" && echo "  ✓ frontend (and /api proxy) ok" || echo "  ✗ frontend FAIL"
  docker exec darex-postgres pg_isready -U darex -d darex 2>/dev/null && echo "  ✓ postgres ready" || echo "  ✗ postgres not ready"
  exit 0
fi

# ── remote mode ──────────────────────────────────────────────────────────────
if [ -n "${DEPLOY_HOST:-}" ]; then
  local_path="${DEPLOY_PATH:-/opt/darex}"
  command -v rsync >/dev/null 2>&1 || die "rsync required for DEPLOY_HOST mode"
  log "Syncing repo to ${DEPLOY_HOST}:${local_path} (skips .env and secrets)"
  ssh "$DEPLOY_HOST" "mkdir -p '$local_path'"
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
    "$ROOT/" "${DEPLOY_HOST}:${local_path}/"
  log "Running redeploy on ${DEPLOY_HOST}"
  ssh "$DEPLOY_HOST" "cd '$local_path' && SKIP_FRONTEND_PULL=1 bash ./deploy/redeploy.sh ${ARGS[*]+"${ARGS[*]}"}"
  exit 0
fi

# Runs in the background and follows the log, so closing the terminal does not stop it.
# shellcheck source=deploy/detach.sh
. "$ROOT/deploy/detach.sh"
NO_DETACH=$((DO_STATUS || DO_PLAN))
detach_dispatch "$ROOT/deploy/redeploy.sh" ${ARGS[@]+"${ARGS[@]}"}

# ── which files map to which service ─────────────────────────────────────────
# Prints the services whose build inputs include the path (see each Dockerfile's COPY lines).
services_for_path() {
  case "$1" in
    apps/inbox/package.json)                 echo "inbox dashboard worker" ;;
    apps/inbox/*)                            echo "inbox" ;;
    apps/dashboard/package.json)             echo "dashboard worker" ;;
    apps/dashboard/*)                        echo "dashboard" ;;
    services/workflows/*|services/connectors/*|packages/*|package.json|pnpm-lock.yaml|pnpm-workspace.yaml|infra/docker/prod-failfast.sh)
                                             echo "dashboard worker" ;;
    infra/docker/dashboard/*)                echo "dashboard" ;;
    infra/docker/worker/*)                   echo "worker" ;;
    infra/docker/mcp-bridge/*)               echo "mcp-bridge" ;;
    infra/docker/sandbox/*)                  echo "sandbox" ;;
    infra/docker/frontend/*|deploy/docker-compose.prod.yml) echo "frontend" ;;
    *) ;;
  esac
}

in_list() { # in_list item list...
  local item=$1; shift
  local x
  for x in "$@"; do [ "$x" = "$item" ] && return 0; done
  return 1
}

# ── pull latest backend code ─────────────────────────────────────────────────
HAVE_GIT=0
[ -d "$ROOT/.git" ] && HAVE_GIT=1
AFTER=""
if [ "$HAVE_GIT" -eq 1 ]; then
  BRANCH="${DEPLOY_BRANCH:-main}"
  BEFORE="$(git -C "$ROOT" rev-parse HEAD)"
  if [ "$DO_PLAN" -eq 0 ]; then
    log "Pulling $BRANCH from origin"
    git -C "$ROOT" fetch origin "$BRANCH"
    if [ -n "$(git -C "$ROOT" status --porcelain --untracked-files=no)" ]; then
      die "Repo has local edits to tracked files — stash or discard them first."
    fi
    git -C "$ROOT" checkout "$BRANCH"
    git -C "$ROOT" merge --ff-only "origin/$BRANCH"
    AFTER="$(git -C "$ROOT" rev-parse HEAD)"
    if [ "$BEFORE" = "$AFTER" ]; then
      info "Backend already up to date at ${AFTER:0:12}"
    else
      info "✓ Backend ${BEFORE:0:12} → ${AFTER:0:12}"
      # If this script itself changed, restart with the new version
      if git diff --name-only "$BEFORE" "$AFTER" | grep -q "deploy/redeploy.sh"; then
        log "redeploy.sh updated — restarting with new version"
        exec bash "$ROOT/deploy/redeploy.sh" "${ARGS[@]}"
      fi
    fi
  else
    AFTER="$BEFORE"
  fi
else
  info "No .git directory — deploying files already on disk (everything is rebuilt, cached)"
fi

# ── pull latest frontend (its own repo) ──────────────────────────────────────
# Clone on first run, then fast-forward to FRONTEND_BRANCH. Laptop mode sets SKIP_FRONTEND_PULL=1.
FRONT_DIR="$ROOT/NEW-FRONTEND"
FRONT_BEFORE=""
FRONT_AFTER=""
sync_frontend() {
  local branch="${FRONTEND_BRANCH:-feat/new-frontend}"
  local url="${FRONTEND_REPO_URL:-https://github.com/DarexAI-AI-Startup/agentic-os-frontend.git}"
  if [ "${SKIP_FRONTEND_PULL:-0}" = "1" ]; then
    [ -f "$FRONT_DIR/package.json" ] || die "NEW-FRONTEND/package.json is missing after the sync."
    info "Using the NEW-FRONTEND files that were synced"
    return 0
  fi
  command -v git >/dev/null 2>&1 || die "git is required to update NEW-FRONTEND"
  if [ ! -d "$FRONT_DIR/.git" ]; then
    if [ -f "$FRONT_DIR/package.json" ]; then
      warn "NEW-FRONTEND has no .git directory — deploying the files already on disk"
      return 0
    fi
    log "Cloning the frontend ($branch) into NEW-FRONTEND"
    GIT_TERMINAL_PROMPT=0 git clone --branch "$branch" "$url" "$FRONT_DIR" \
      || die "Could not clone $url. For a private repo set FRONTEND_REPO_URL with a deploy token or SSH URL."
  else
    FRONT_BEFORE="$(git -C "$FRONT_DIR" rev-parse HEAD)"
    if [ "$DO_PLAN" -eq 1 ]; then return 0; fi
    log "Pulling the frontend $branch from origin"
    git -C "$FRONT_DIR" fetch origin "$branch"
    if [ -n "$(git -C "$FRONT_DIR" status --porcelain --untracked-files=no)" ]; then
      die "NEW-FRONTEND has local edits to tracked files. Discard them, then re-run."
    fi
    git -C "$FRONT_DIR" checkout "$branch"
    git -C "$FRONT_DIR" merge --ff-only "origin/$branch"
  fi
}
sync_frontend
if [ -d "$FRONT_DIR/.git" ]; then
  FRONT_AFTER="$(git -C "$FRONT_DIR" rev-parse HEAD)"
  if [ -n "$FRONT_BEFORE" ] && [ "$FRONT_BEFORE" != "$FRONT_AFTER" ]; then
    info "✓ Frontend ${FRONT_BEFORE:0:12} → ${FRONT_AFTER:0:12}"
  else
    info "Frontend at ${FRONT_AFTER:0:12}"
  fi
fi

# ── load .env ────────────────────────────────────────────────────────────────
[ -f "$ROOT/.env" ] || die "Missing .env"
set -a
# shellcheck disable=SC1091
. "$ROOT/.env"
set +a

# The containers fail fast on these; stop here with a clear message instead of a restart loop.
# (--plan changes nothing, so it does not need them.)
if [ "$DO_PLAN" -eq 0 ]; then
  for key in CHANNEL_SECRETS_KEY EVOLUTION_API_KEY EVOLUTION_WEBHOOK_SECRET; do
    eval "val=\${$key:-}"
    [ -n "$val" ] || die "$key is missing in .env (see deploy/env.production.example)"
  done
  case "${CHANNEL_SECRETS_KEY}" in
    0000000000000000000000000000000000000000000000000000000000000000) die "CHANNEL_SECRETS_KEY is the all-zero dev default." ;;
  esac
  # An .env written before these existed: deploy.sh generates them (this script never edits .env).
  for key in APP_DB_PASSWORD MCP_BRIDGE_SECRET; do
    eval "val=\${$key:-}"
    [ -n "$val" ] || die "$key is missing in .env. Run ./deploy/deploy.sh once: it adds missing secrets and leaves the rest alone."
  done
  check_compose_version
fi

# ── work out what to rebuild ─────────────────────────────────────────────────
# Every service that has a build section, with its image name.
BUILDABLE=()
IMAGES=()
while IFS=' ' read -r svc img; do
  [ -n "$svc" ] || continue
  BUILDABLE+=("$svc")
  IMAGES+=("$img")
done < <(compose config --format json | python3 -c 'import sys,json
d=json.load(sys.stdin)
for k,v in sorted(d["services"].items()):
    if v.get("build"):
        print(k, v.get("image") or d["name"]+"-"+k)')
[ "${#BUILDABLE[@]}" -gt 0 ] || die "Could not list buildable services from compose."

TO_BUILD=()
add_build() { in_list "$1" "${BUILDABLE[@]}" && ! in_list "$1" "${TO_BUILD[@]+"${TO_BUILD[@]}"}" && TO_BUILD+=("$1") || true; }
REASON=""

LAST_BACKEND=""
LAST_FRONTEND=""
if [ -f "$STATE_FILE" ]; then
  LAST_BACKEND="$(sed -n 's/^backend=//p' "$STATE_FILE")"
  LAST_FRONTEND="$(sed -n 's/^frontend=//p' "$STATE_FILE")"
fi

if [ "${#SERVICES[@]}" -gt 0 ]; then
  for s in "${SERVICES[@]}"; do add_build "$s"; done
  REASON="you named them"
elif [ "$DO_ALL" -eq 1 ]; then
  for s in "${BUILDABLE[@]}"; do add_build "$s"; done
  REASON="--all"
elif [ "$HAVE_GIT" -eq 0 ] || [ -z "$LAST_BACKEND" ] || ! git -C "$ROOT" cat-file -e "${LAST_BACKEND}^{commit}" 2>/dev/null; then
  for s in "${BUILDABLE[@]}"; do add_build "$s"; done
  REASON="no saved deploy state (first run, or no git history) — Docker's layer cache still skips unchanged layers"
else
  # Files changed in the backend repo since the last successful deploy.
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    for s in $(services_for_path "$f"); do add_build "$s"; done
  done < <(git -C "$ROOT" diff --name-only "$LAST_BACKEND" "$(git -C "$ROOT" rev-parse HEAD)")
  # A new frontend commit (or no git history for it) means the frontend image is stale.
  if [ -z "$FRONT_AFTER" ] || [ "$FRONT_AFTER" != "$LAST_FRONTEND" ]; then add_build frontend; fi
  REASON="changes since ${LAST_BACKEND:0:12}"
fi
# mcp-bridge is built FROM the dashboard image: it must follow any dashboard rebuild.
if in_list dashboard "${TO_BUILD[@]+"${TO_BUILD[@]}"}"; then add_build mcp-bridge; fi
# Never deploy a service without an image.
i=0
for s in "${BUILDABLE[@]}"; do
  img="${IMAGES[$i]}"; i=$((i + 1))
  [ -n "$img" ] || continue
  docker image inspect "$img" >/dev/null 2>&1 || { add_build "$s"; info "image $img is missing — will build $s"; }
done
# cognee builds from a sibling repo that is not on every machine; never force it from a diff.
if [ "${#SERVICES[@]}" -eq 0 ] && [ ! -d "$ROOT/../cognee" ]; then
  NEW=(); for s in "${TO_BUILD[@]+"${TO_BUILD[@]}"}"; do [ "$s" = "cognee" ] || NEW+=("$s"); done
  TO_BUILD=("${NEW[@]+"${NEW[@]}"}")
fi

# dashboard first (mcp-bridge builds on it), the rest alphabetically
ORDERED=()
in_list dashboard "${TO_BUILD[@]+"${TO_BUILD[@]}"}" && ORDERED+=(dashboard)
for s in $(printf '%s\n' "${TO_BUILD[@]+"${TO_BUILD[@]}"}" | sort); do [ "$s" = "dashboard" ] || ORDERED+=("$s"); done

# Not for named services or --all: those mean "rebuild this". Otherwise a service whose image exists and
# was last built from exactly the current files (by deploy.sh or a previous redeploy) is left alone.
if [ "${#SERVICES[@]}" -eq 0 ] && [ "$DO_ALL" -eq 0 ] && [ "${FORCE_BUILD:-0}" != "1" ]; then
  KEEP=()
  for s in "${ORDERED[@]+"${ORDERED[@]}"}"; do
    img=""; i=0
    for b in "${BUILDABLE[@]}"; do [ "$b" = "$s" ] && img="${IMAGES[$i]}"; i=$((i + 1)); done
    if service_is_built "$s" "$img"; then info "$s image already built from the current files — skipped"; else KEEP+=("$s"); fi
  done
  ORDERED=("${KEEP[@]+"${KEEP[@]}"}")
fi

log "Plan ($REASON)"
if [ "${#ORDERED[@]}" -gt 0 ]; then
  info "rebuild : ${ORDERED[*]}"
else
  info "rebuild : nothing (no image inputs changed)"
fi
SKIPPED=()
for s in "${BUILDABLE[@]}"; do in_list "$s" "${ORDERED[@]+"${ORDERED[@]}"}" || SKIPPED+=("$s"); done
info "unchanged: ${SKIPPED[*]+"${SKIPPED[*]}"}"
info "frontend : restarted only when its image was rebuilt"
if [ "$DO_PLAN" -eq 1 ]; then exit 0; fi

# ── build ────────────────────────────────────────────────────────────────────
# Cheap failures first: a missing build folder (sibling Cognee checkout) or TrueForge image is
# reported now, not after the other images have built.
[ "${#ORDERED[@]}" -eq 0 ] || check_build_inputs "${ORDERED[@]}"
ensure_trueforge_image

# Rollback safety net. The running containers are not touched until every build has finished, so a
# failed build changes nothing. Past that point a failed swap, health check or migration restores
# these tags (see rollback_deploy). Tagging also keeps the old image safe from `docker image prune`.
ROLLBACK_SVCS=(); ROLLBACK_IMGS=(); ROLLBACK_TAGS=(); ROLLBACK_ARMED=0
for s in "${ORDERED[@]+"${ORDERED[@]}"}"; do
  img=""; i=0
  for b in "${BUILDABLE[@]}"; do [ "$b" = "$s" ] && img="${IMAGES[$i]}"; i=$((i + 1)); done
  [ -n "$img" ] && docker image inspect "$img" >/dev/null 2>&1 || continue
  rb="${img%:*}:rollback"
  if docker tag "$img" "$rb"; then ROLLBACK_SVCS+=("$s"); ROLLBACK_IMGS+=("$img"); ROLLBACK_TAGS+=("$rb"); fi
done

rollback_deploy() {
  local rc=$? i
  trap - EXIT
  if [ "$rc" -eq 0 ] || [ "$ROLLBACK_ARMED" -ne 1 ] || [ "${#ROLLBACK_SVCS[@]}" -eq 0 ]; then exit "$rc"; fi
  ROLLBACK_ARMED=0
  printf '\n==> Deploy failed (exit %s): putting the previous version back (%s)\n' "$rc" "${ROLLBACK_SVCS[*]}" >&2
  for i in "${!ROLLBACK_SVCS[@]}"; do
    docker tag "${ROLLBACK_TAGS[$i]}" "${ROLLBACK_IMGS[$i]}" || printf 'WARN: could not restore %s\n' "${ROLLBACK_IMGS[$i]}" >&2
    # The stamp says "built from the current files"; clear it so the next run rebuilds instead of skipping.
    rm -f "$(build_stamp "${ROLLBACK_SVCS[$i]}")"
  done
  compose up -d --no-build --no-deps --force-recreate "${ROLLBACK_SVCS[@]}" >&2 \
    || printf 'WARN: could not recreate the previous containers; run: ./deploy/redeploy.sh --all\n' >&2
  for _ in $(seq 1 40); do
    curl -sf "http://127.0.0.1:${DASHBOARD_PORT}/api/health" >/dev/null 2>&1 \
      && curl -sf "http://127.0.0.1:${FRONTEND_HOST_PORT}/api/health" >/dev/null 2>&1 && break
    sleep 3
  done
  if curl -sf "http://127.0.0.1:${FRONTEND_HOST_PORT}/api/health" >/dev/null 2>&1; then
    printf '==> Previous version is serving again. The new build failed: read the log above.\n' >&2
  else
    printf '==> Previous containers restarted but the site is not healthy yet: docker logs darex-dashboard\n' >&2
  fi
  exit "$rc"
}
trap rollback_deploy EXIT

for s in "${ORDERED[@]+"${ORDERED[@]}"}"; do
  free="$(df -BG --output=avail / 2>/dev/null | tail -n 1 | tr -dc '0-9' || true)"
  if [ -n "$free" ] && [ "$free" -lt 6 ]; then
    warn "Only ${free} GB disk free before building $s — pruning the build cache"
    docker builder prune -af >/dev/null || warn "Build cache prune failed"
  fi
  log "Building $s"
  compose build "$s"
  record_built "$s"
done

# ── things that must be right before the stack starts ───────────────────────
WAIT_MULT=1; [ "$(nproc --all 2>/dev/null || echo 4)" -gt 2 ] || WAIT_MULT=3
prepare_data_dirs
log "Aligning the darex_app password with APP_DB_PASSWORD"
compose up -d postgres
align_app_role_password

# ── bring up (recreates only containers whose image or config changed) ───────
mem_total_gb="$(awk '/^MemTotal/ {print int($2/1048576)}' /proc/meminfo 2>/dev/null || true)"
LITE="${LITE:-$([ "${mem_total_gb:-99}" -lt 12 ] && echo 1 || echo 0)}"
log "Rolling restart of changed containers — volumes and DB untouched"
ROLLBACK_ARMED=1
start_stack

# The frontend image is rebuilt whenever its repo commit or inputs change, and `up` recreates it then.
# An unchanged image gets no restart: that only added downtime.
if in_list frontend "${ORDERED[@]+"${ORDERED[@]}"}"; then info "frontend was rebuilt and recreated"; else info "frontend unchanged - left running"; fi

# ── migrations (idempotent — skips already-applied) ──────────────────────────
log "Applying any new migrations (already-applied ones are skipped)"
run_migrations

# ── health checks ─────────────────────────────────────────────────────────────
wait_http "dashboard" "http://127.0.0.1:${DASHBOARD_PORT}/api/health" darex-dashboard
wait_http "frontend (and its /api proxy)" "http://127.0.0.1:${FRONTEND_HOST_PORT}/api/health" darex-frontend

PUBLIC="no"
if [ -n "${NEXT_PUBLIC_APP_URL:-}" ] && curl -sf --max-time 20 "${NEXT_PUBLIC_APP_URL}/api/health" >/dev/null 2>&1; then PUBLIC="yes"; fi

# Everything is healthy: the new version stays, so the rollback is no longer needed.
ROLLBACK_ARMED=0

# Save what is now live, only after everything above succeeded.
if [ "$HAVE_GIT" -eq 1 ]; then
  printf 'backend=%s\nfrontend=%s\n' "$(git -C "$ROOT" rev-parse HEAD)" "$FRONT_AFTER" > "$STATE_FILE"
fi

docker_housekeeping

log "Stack status"
compose ps --format "table {{.Name}}\t{{.Status}}\t{{.Ports}}"

cat <<EOF

========================================
✓ REDEPLOY COMPLETE
========================================
  Backend  : $(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)
  Frontend : ${FRONT_AFTER:0:7}${FRONT_AFTER:+ }(refreshed)
  Rebuilt  : ${ORDERED[*]:-nothing}
  Site     : ${NEXT_PUBLIC_APP_URL:-http://127.0.0.1:${FRONTEND_HOST_PORT}} (HTTPS reachable: ${PUBLIC})
  DB       : volumes preserved — all data intact
  Logs     : docker logs darex-dashboard | darex-frontend
  Status   : ./deploy/redeploy.sh --status
========================================
EOF
