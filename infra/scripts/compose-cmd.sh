#!/usr/bin/env bash
# Darex compose wrapper — kernel first, then unmerged snippets, then overlays.
# Callers: pnpm infra:*, start.sh, deploy/deploy.sh.
#
# Usage:
#   infra/scripts/compose-cmd.sh up -d
#   infra/scripts/compose-cmd.sh --overlay deploy/docker-compose.prod.yml up -d
#
# Does not weaken phase 0. Does not replace infra/docker-compose.yml.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
KERNEL="$ROOT/infra/docker-compose.yml"
SNIPPET_DIR="$ROOT/infra/compose-snippets"

FILES=(-f "$KERNEL")
OVERLAYS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --overlay)
      [ $# -ge 2 ] || { echo "compose-cmd.sh: --overlay needs a path" >&2; exit 1; }
      OVERLAYS+=(-f "$2")
      shift 2
      ;;
    *)
      break
      ;;
  esac
done

if [ -d "$SNIPPET_DIR" ]; then
  # Sorted so WS-12.yml always precedes WS-23.yml. Ignore README / .gitkeep.
  shopt -s nullglob
  snippets=("$SNIPPET_DIR"/*.yml "$SNIPPET_DIR"/*.yaml)
  if [ ${#snippets[@]} -gt 0 ]; then
    IFS=$'\n' snippets_sorted=($(printf '%s\n' "${snippets[@]}" | sort))
    unset IFS
    for f in "${snippets_sorted[@]}"; do
      FILES+=(-f "$f")
    done
  fi
  shopt -u nullglob
fi

FILES+=("${OVERLAYS[@]+"${OVERLAYS[@]}"}")

ENV_FILE=()
if [ -f "$ROOT/.env" ]; then
  ENV_FILE=(--env-file "$ROOT/.env")
fi

if docker compose version >/dev/null 2>&1; then
  exec docker compose "${ENV_FILE[@]+"${ENV_FILE[@]}"}" "${FILES[@]+"${FILES[@]}"}" "$@"
fi
exec docker-compose "${ENV_FILE[@]+"${ENV_FILE[@]}"}" "${FILES[@]+"${FILES[@]}"}" "$@"
