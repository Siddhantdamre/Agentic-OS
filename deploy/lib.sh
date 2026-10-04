#!/usr/bin/env bash
# Steps shared by deploy.sh and redeploy.sh (sourced, never run), so a fix lands in both.
# The caller defines log, info, warn, die and ROOT first; align_app_role_password also needs
# WAIT_MULT, APP_DB_PASSWORD (from .env) and diagnose_stack is used on failures.

# The prod overlay uses `ports: !override` (Compose >= 2.24.4). Older Compose appends
# loopback binds to the kernel's all-interface binds, leaving Postgres/Redis public.
check_compose_version() {
  local v; v="$(docker compose version --short 2>/dev/null || true)"; v="${v#v}"
  [ -n "$v" ] || die "Docker Compose v2 plugin is required (docker compose). Install: sudo apt-get install docker-compose-v2"
  [ "$(printf '%s\n2.24.4\n' "$v" | sort -V | head -n 1)" = "2.24.4" ] \
    || die "Docker Compose $v is too old (need >= 2.24.4) — it would leave database ports public."
}

# The trueforge service runs a local-only image (pull_policy: never) that is built from the
# sibling TrueForge checkout, not from this repo, so `compose build` never makes it. It is also
# lost to `docker image prune -a` once no container uses it. Build it when it is missing.
ensure_trueforge_image() {
  docker image inspect truefoundry-server:latest >/dev/null 2>&1 && return 0
  local src="${TRUEFORGE_DIR:-$ROOT/../trueforge}"
  [ -f "$src/Dockerfile.dev" ] || die "The trueforge service needs the local image truefoundry-server:latest and there is no TrueForge checkout at $src (no Dockerfile.dev). Put the checkout there (or set TRUEFORGE_DIR) with Darex's tenant-header patch (infra/patches/trueforge), then re-run."
  log "Building truefoundry-server:latest from $src (first time; several minutes)"
  docker build -f "$src/Dockerfile.dev" -t truefoundry-server:latest "$src"
  # Multi-tenancy depends on per-request x-tfg-mcp-headers forwarding (see the compose comment).
  if [ "${TRUEFORGE_SKIP_VERIFY:-0}" != "1" ] && ! docker run --rm --entrypoint sh truefoundry-server:latest \
       -c 'grep -rlq x-tfg-mcp-headers dist'; then
    die "truefoundry-server:latest was built but lacks the x-tfg-mcp-headers forwarding that tenant isolation needs. Apply infra/patches/trueforge/darex-tenant-headers.patch to $src and re-run (TRUEFORGE_SKIP_VERIFY=1 skips this check)."
  fi
}

# Named volumes start root-owned, but Cognee runs as uid 1000 and cannot create /data/system on a
# fresh volume (TrueForge's own start wrapper chowns its volume). Same step as start.sh.
prepare_data_dirs() {
  docker image inspect darex-cognee:1.5.4 >/dev/null 2>&1 || return 0
  docker run --rm --user 0:0 --entrypoint "" -v infra_cognee-data:/data darex-cognee:1.5.4 \
    sh -c 'mkdir -p /data/cognee /data/system && chown -R 1000:1000 /data' \
    || warn "Could not prepare the Cognee data volume (Cognee may fail to start)"
}

# Make the darex_app role's password match APP_DB_PASSWORD (see the script for why). Retries until
# Postgres has finished its init scripts and the role exists.
align_app_role_password() {
  local tries=0 out
  while ! out="$(PW="$APP_DB_PASSWORD" docker exec -e PW darex-postgres sh -c "$(cat "$ROOT/infra/scripts/set-app-role-password.sh")" 2>&1)"; do
    tries=$((tries + 1))
    [ "$tries" -lt $((60 * WAIT_MULT)) ] || die "Could not set the darex_app password on Postgres: ${out:-no output}. See: docker logs darex-postgres"
    sleep 2
  done
  info "✓ darex_app password matches APP_DB_PASSWORD"
}

# After a failed `up`, show why: the last log lines of every container that is not running or not
# healthy (the first Azure deploy only said "mcp-bridge is unhealthy", with no reason).
diagnose_stack() {
  local c st
  warn "Last log lines of each container that is not running or not healthy:"
  for c in $(docker ps -a --filter name=darex- --format '{{.Names}}'); do
    st="$(docker inspect -f '{{.State.Status}}/{{if .State.Health}}{{.State.Health.Status}}{{else}}-{{end}}' "$c" 2>/dev/null || true)"
    case "$st" in running/healthy|running/-) continue ;; esac
    printf '\n--- %s (%s)\n' "$c" "$st" >&2
    docker logs --tail 15 "$c" >&2 2>&1 || true
  done
}

# After a good deploy: drop dangling images (the previous build of a rebuilt service) and cap the
# build cache. The cache is what makes a rebuild fast, so it is capped, not emptied. Newer Docker
# calls the flag --reserved-space, older --keep-storage.
docker_housekeeping() {
  local keep="${DOCKER_CACHE_KEEP:-8GB}"
  docker image prune -f >/dev/null || warn "Dangling image prune failed (non-fatal)"
  docker builder prune -f --reserved-space "$keep" >/dev/null 2>&1 \
    || docker builder prune -f --keep-storage "$keep" >/dev/null 2>&1 \
    || warn "Could not cap the build cache (non-fatal)"
}

# ── fail early ───────────────────────────────────────────────────────────────

# Stop before the first (slow) build when a build input is missing: a service whose build context
# or Dockerfile is not on disk (the sibling Cognee checkout, NEW-FRONTEND) used to fail only when
# its turn came, after the other images had built. Arguments: the services about to build
# (none = every buildable service).
check_build_inputs() {
  local out
  out="$(compose config --format json | python3 -c 'import sys,json,os
want=sys.argv[1:]
for k,v in sorted(json.load(sys.stdin)["services"].items()):
    b=v.get("build")
    if not b or (want and k not in want): continue
    ctx=b.get("context","."); df=os.path.join(ctx,b.get("dockerfile","Dockerfile"))
    if not os.path.isdir(ctx): print("%s: build folder %s is missing" % (k,ctx))
    elif not os.path.isfile(df): print("%s: Dockerfile %s is missing" % (k,df))' "$@")" \
    || die "Could not read the compose config. Fix it first: bash infra/scripts/compose-cmd.sh --overlay deploy/docker-compose.prod.yml config"
  [ -z "$out" ] || die "Cannot build, nothing was started:
$out
Clone the missing checkout next to this repo (cognee: ../cognee, frontend: NEW-FRONTEND), then re-run."
}

# ── skip what is already built ───────────────────────────────────────────────

# The paths in this repo that a service's image is built from (same mapping as redeploy.sh's
# diff). Empty for a service with no known inputs.
service_inputs() {
  # The dashboard image copies all of apps/dashboard; the worker image only its package.json
  # (see the COPY lines), so dashboard code changes must not rebuild the worker.
  local shared="apps/inbox/package.json services/workflows services/connectors packages package.json pnpm-lock.yaml pnpm-workspace.yaml infra/docker/prod-failfast.sh"
  case "$1" in
    dashboard)  echo "$shared apps/dashboard infra/docker/dashboard" ;;
    worker)     echo "$shared apps/dashboard/package.json infra/docker/worker" ;;
    mcp-bridge) echo "$shared apps/dashboard infra/docker/dashboard infra/docker/mcp-bridge" ;;  # built FROM the dashboard image
    inbox)      echo "apps/inbox" ;;
    sandbox)    echo "infra/docker/sandbox" ;;
    frontend)   echo "infra/docker/frontend deploy/docker-compose.prod.yml" ;;
  esac
}

# A hash of everything one service's image is built from, or nothing when that cannot be known
# (no git history, a dirty tree, a missing checkout): an empty result never lets a build be skipped.
service_fingerprint() {
  local svc=$1 p parts=""
  git -C "$ROOT" rev-parse HEAD >/dev/null 2>&1 || return 0
  [ -z "$(git -C "$ROOT" status --porcelain --untracked-files=no 2>/dev/null)" ] || return 0
  case "$svc" in
    cognee) git -C "$ROOT/../cognee" rev-parse HEAD 2>/dev/null || true; return 0 ;;  # built from a sibling repo
  esac
  if [ -z "$(service_inputs "$svc")" ]; then
    git -C "$ROOT" rev-parse HEAD; return 0   # unknown service: any new commit rebuilds it
  fi
  for p in $(service_inputs "$svc"); do
    parts="$parts $p=$(git -C "$ROOT" rev-parse "HEAD:$p" 2>/dev/null || echo -)"
  done
  if [ "$svc" = frontend ]; then
    git -C "$ROOT/NEW-FRONTEND" rev-parse HEAD >/dev/null 2>&1 || return 0
    parts="$parts front=$(git -C "$ROOT/NEW-FRONTEND" rev-parse HEAD) url=${NEXT_PUBLIC_APP_URL:-}"
  fi
  printf '%s' "$parts" | { sha256sum 2>/dev/null || shasum -a 256; } | cut -d' ' -f1
}

build_stamp() { printf '%s/built.d/%s' "${DEPLOY_STATE_DIR:-$HOME/.local/state/darex-deploy}" "$1"; }

# True when the image exists and was last built from exactly the current inputs.
service_is_built() { # service image
  local fp; fp="$(service_fingerprint "$1")"
  [ -n "$fp" ] && [ "$(cat "$(build_stamp "$1")" 2>/dev/null || true)" = "$fp" ] \
    && docker image inspect "$2" >/dev/null 2>&1
}

# Called right after a service built, so a run that dies later does not rebuild it on the retry.
record_built() {
  local fp; fp="$(service_fingerprint "$1")"
  mkdir -p "$(dirname "$(build_stamp "$1")")"
  if [ -n "$fp" ]; then printf '%s' "$fp" > "$(build_stamp "$1")"; else rm -f "$(build_stamp "$1")"; fi
}

# ── waiting and migrating ────────────────────────────────────────────────────

# Wait for a URL, but give up the moment the container is dead or restart-looping instead of
# sitting out the whole timeout. Needs WAIT_MULT. max_tries defaults to 60 (x2 s, x WAIT_MULT).
wait_http() { # name url container [max_tries]
  local name=$1 url=$2 ctr=$3 max=$(( ${4:-60} * WAIT_MULT )) tries=0 st rc
  log "Waiting for $name on $url"
  until curl -sf "$url" >/dev/null; do
    st="$(docker inspect -f '{{.State.Status}}' "$ctr" 2>/dev/null || echo missing)"
    rc="$(docker inspect -f '{{.RestartCount}}' "$ctr" 2>/dev/null || echo 0)"
    if [ "$st" = exited ] || [ "$st" = dead ] || [ "$st" = missing ] || { [ "$st" = restarting ] && [ "${rc:-0}" -ge 3 ]; }; then
      diagnose_stack
      die "$name cannot become ready: container $ctr is $st (restarts: ${rc:-0}). Its last log lines are above."
    fi
    tries=$((tries + 1))
    [ "$tries" -lt "$max" ] || { diagnose_stack; die "$name did not become ready in $((max * 2)) s — check: docker logs $ctr"; }
    sleep 2
  done
  info "✓ $name healthy"
}

# Apply the SQL migrations (already-applied ones are skipped) as the Postgres superuser. With no
# Node/pg on the host it uses a throwaway Node container, keeping pg in a named volume so the
# download happens once, not on every deploy.
run_migrations() {
  if command -v node >/dev/null 2>&1 && { [ -d "$ROOT/apps/dashboard/node_modules/pg" ] || [ -d "$ROOT/node_modules/pg" ]; }; then
    DB_HOST=127.0.0.1 DB_PORT="${POSTGRES_HOST_PORT:-15432}" DB_USER=darex \
      DB_PASSWORD="${SUPERUSER_DB_PASSWORD:-darex_dev_secret}" DB_NAME="${DB_NAME:-darex}" \
      node "$ROOT/infra/db/migrate.js"
  else
    docker run --rm --network host -v "$ROOT:/app:ro" -v darex-migrate-deps:/tmp/m -w /app \
      -e DB_HOST=127.0.0.1 -e DB_PORT="${POSTGRES_HOST_PORT:-15432}" -e DB_USER=darex \
      -e DB_PASSWORD="${SUPERUSER_DB_PASSWORD:-darex_dev_secret}" -e DB_NAME="${DB_NAME:-darex}" \
      node:22-bookworm-slim sh -c '{ [ -d /tmp/m/node_modules/pg ] || npm install --no-save --prefix /tmp/m pg@8 >/dev/null; } && NODE_PATH=/tmp/m/node_modules node infra/db/migrate.js'
  fi
}

# Start the stack in two steps: everything the product needs first, then the optional Langfuse
# monitoring stack. Langfuse runs its database migrations on first boot, which on a small VM can
# outlast any sane health window; it used to abort the whole `up` at the end of a long run, after
# the core services were already healthy. Now a slow or failed Langfuse only warns (it keeps
# starting in the background, restart: always). No core service depends on a langfuse-* service.
# LITE=1 skips Langfuse entirely.
start_stack() {
  local core=() lf=() svc
  while IFS= read -r svc; do
    case "$svc" in langfuse-*) lf+=("$svc") ;; *) core+=("$svc") ;; esac
  done < <(compose config --services)
  if ! compose up -d "${core[@]}"; then
    diagnose_stack
    die "compose up failed. The container logs above say why; after fixing it re-run (finished builds are skipped)."
  fi
  [ "${LITE:-0}" != "1" ] && [ "${#lf[@]}" -gt 0 ] || return 0
  log "Starting the Langfuse monitoring stack (optional: a slow start does not stop the deploy)"
  if ! compose up -d "${lf[@]}"; then
    diagnose_stack
    warn "Langfuse is not healthy yet — the product is up without it. It keeps starting in the background; check: docker logs darex-langfuse-server"
  fi
}
