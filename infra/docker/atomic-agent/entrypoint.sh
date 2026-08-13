#!/usr/bin/env sh
set -e

export ATOMIC_AGENT_STATE_DIR="${ATOMIC_AGENT_STATE_DIR:-/data}"
echo "[atomic-agent] state dir: ${ATOMIC_AGENT_STATE_DIR}"

mkdir -p /work/skills
if [ -d /app/custom-skills ]; then
  cp -a /app/custom-skills/. /work/skills/ || true
fi

node /app/render-config.mjs

exec node /app/dist/cli/index.js "$@"
