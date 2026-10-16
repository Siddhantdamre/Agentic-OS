#!/usr/bin/env bash
# Darex status (operator tool): is everything up, is the running code the
# pushed code, where are the UIs, is the VM short of memory.
#
#   bash infra/scripts/status.sh
#
# Sync check: a built service (worker, dashboard, ...) is STALE when a commit
# touching its source paths is newer than the running container. Uncommitted edits are
# reported separately, because the next image build would include them.
set -u
cd "$(dirname "$0")/../.." || exit 1

# container -> source paths that end up in its image (space separated)
paths_for() {
  case "$1" in
    worker) echo "services/workflows packages/shared-types infra/docker/worker" ;;
    dashboard) echo "apps/dashboard services/workflows packages infra/docker/dashboard" ;;
    mcp-bridge) echo "services/workflows packages/shared-types" ;;
    inbox) echo "apps/inbox packages/shared-types" ;;
    *) echo "" ;;
  esac
}

# Docker timestamps are UTC; BSD date would read them as local time without TZ=UTC.
epoch() { TZ=UTC date -j -f '%Y-%m-%dT%H:%M:%S' "${1%%.*}" +%s 2>/dev/null || date -d "${1%%.*}Z" +%s 2>/dev/null || echo 0; }

echo "=== Containers ==="
printf '%-26s %-22s %s\n' SERVICE STATUS CODE-SYNC
for c in $(docker ps -a --format '{{.Names}}' | grep '^darex-' | sort); do
  name="${c#darex-}"
  status="$(docker inspect -f '{{.State.Status}}{{if .State.Health}}/{{.State.Health.Status}}{{end}}' "$c")"
  sync="-"
  p="$(paths_for "$name")"
  if [ -n "$p" ]; then
    img_ts="$(epoch "$(docker inspect -f '{{.Created}}' "$c")")"  # container is recreated on every image rebuild
    # shellcheck disable=SC2086
    commit_ts="$(git log -1 --format=%ct -- $p 2>/dev/null)"
    # shellcheck disable=SC2086
    dirty="$(git status --short -- $p 2>/dev/null | grep -v '^??' | wc -l | tr -d ' ')"
    if [ -n "$commit_ts" ] && [ "$img_ts" -lt "$commit_ts" ]; then sync="STALE: commit newer than container (rebuild)"; else sync="current with commits"; fi
    [ "$dirty" -gt 0 ] && sync="$sync; $dirty uncommitted file(s) in its source"
  fi
  case "$status" in *unhealthy*|*restarting*) mark='!!' ;; *) mark='  ' ;; esac
  # A container that exited 0 is a finished one-shot job (e.g. minio-init), not a failure.
  case "$status" in exited*) [ "$(docker inspect -f '{{.State.ExitCode}}' "$c")" = 0 ] && status="done (exit 0)" || mark='!!' ;; esac
  printf '%s%-24s %-22s %s\n' "$mark" "$name" "$status" "$sync"
done

echo; echo "=== Git ==="
echo "branch $(git rev-parse --abbrev-ref HEAD), HEAD $(git log -1 --format='%h %s' | cut -c1-70)"
git fetch -q origin 2>/dev/null
echo "unpushed commits: $(git rev-list --count '@{u}..HEAD' 2>/dev/null || echo '?')   behind origin: $(git rev-list --count 'HEAD..@{u}' 2>/dev/null || echo '?')"
echo "uncommitted tracked files: $(git status --short | grep -vc '^??')   untracked: $(git status --short | grep -c '^??')"

echo; echo "=== VM memory (Colima) ==="
docker run --rm alpine sh -c 'awk "/MemTotal/{t=\$2}/MemAvailable/{a=\$2}END{printf \"%d MB free of %d MB\n\", a/1024, t/1024; if (a/t < 0.15) print \"!! under 15% free: services may be OOM-killed (Postgres did this once)\"}" /proc/meminfo' 2>/dev/null || echo "(could not read)"

echo; echo "=== Where to look ==="
dash_port="$(docker port darex-dashboard 3000/tcp 2>/dev/null | head -1 | sed 's/.*://')"
cat <<EOF
  Dashboard            http://localhost:${dash_port:-3000}
  Hindsight memory UI  http://localhost:9999   (after: bash infra/scripts/compose-cmd.sh up -d hindsight-ui)
  Temporal UI          http://localhost:8233
  Langfuse (LLM traces) http://localhost:3002
  MinIO console        http://localhost:9091
  Databases            bash infra/scripts/database.sh
  Memory, per org      bash infra/scripts/memory.sh
  Logs                 bash infra/scripts/logs.sh
EOF
