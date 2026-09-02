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

# The env file that sits NEXT TO the compose file wins.
#
# This looked only at "$ROOT/.env" and both files exist: a stale root .env from
# 16 August whose OPENROUTER_API_KEY is an empty placeholder, and infra/.env
# from 31 August holding the real 73-character key. Every compose command run
# through this wrapper therefore declared the model key as empty.
#
# Nothing broke, because the running containers were created when a different
# environment was in effect and kept their values in memory. check-config-drift
# reported it — "declared len 0, running len 73" — and the next `up -d` or any
# rollback would have recreated LiteLLM with no OpenRouter key at all, so every
# model call would fail at the moment somebody was deploying.
#
# An empty placeholder outranking a real value is the same failure that once
# put two OPENROUTER_API_KEY lines in one file and let the blank one win. The
# rule that avoids it: the env beside the compose file is the env for that
# compose file, and a file further away never silently substitutes for it.
ENV_FILE=()
if [ -f "$ROOT/infra/.env" ]; then
  ENV_FILE=(--env-file "$ROOT/infra/.env")
elif [ -f "$ROOT/.env" ]; then
  ENV_FILE=(--env-file "$ROOT/.env")
fi

if docker compose version >/dev/null 2>&1; then
  exec docker compose "${ENV_FILE[@]+"${ENV_FILE[@]}"}" "${FILES[@]+"${FILES[@]}"}" "$@"
fi
exec docker-compose "${ENV_FILE[@]+"${ENV_FILE[@]}"}" "${FILES[@]+"${FILES[@]}"}" "$@"
