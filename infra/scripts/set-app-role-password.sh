#!/bin/sh
# Runs INSIDE the darex-postgres container (deploy.sh passes it to `sh -c` with PW in the
# environment, so the password never appears in a process list):
#   PW=... docker exec -e PW darex-postgres sh -c "$(cat infra/scripts/set-app-role-password.sh)"
# db/init creates the darex_app role with a fixed dev password, but pgbouncer, the dashboard, the
# worker and mcp-bridge log in with APP_DB_PASSWORD. Nothing else makes the two match, so on a
# fresh database every app connection fails with "password authentication failed".
# Idempotent: run on every deploy. Fails (so the caller retries) until the role exists, which
# covers the window while the image is still running its init scripts.
set -eu
: "${PW:?PW (the new darex_app password) is required}"
psql -qtA -U darex -d darex -v ON_ERROR_STOP=1 \
  -c "SELECT 1 FROM pg_roles WHERE rolname = 'darex_app'" | grep -q 1 \
  || { echo "the darex_app role does not exist yet (db/init has not run, or it was dropped)" >&2; exit 1; }
printf "ALTER ROLE darex_app PASSWORD :'pw';\n" \
  | psql -q -U darex -d darex -v ON_ERROR_STOP=1 -v pw="$PW"
