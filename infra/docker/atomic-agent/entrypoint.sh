#!/usr/bin/env sh
set -e

export ATOMIC_AGENT_STATE_DIR="${ATOMIC_AGENT_STATE_DIR:-/data}"
echo "[atomic-agent] state dir: ${ATOMIC_AGENT_STATE_DIR}"

node /app/render-config.mjs

exec node /app/dist/cli/index.js "$@"
