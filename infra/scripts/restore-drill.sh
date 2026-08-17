#!/usr/bin/env bash
# Darex backup restore drill (I5). Default is dry-run.
#
#   bash infra/scripts/restore-drill.sh
#   bash infra/scripts/restore-drill.sh --execute
#
# Dry-run: pg_dump --schema-only against darex-postgres and print the restore
# plan. --execute restores into a throwaway database darex_restore_drill,
# checks darex_app can connect, then drops it.
# Never writes to BUILD_STATE.md. Date the run in infra/scripts/restore-drill.md.
# Does not replace Postgres. Does not commit dump files.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DRY_RUN=1
CONTAINER="${RESTORE_DRILL_CONTAINER:-darex-postgres}"
SUPERUSER="${RESTORE_DRILL_SUPERUSER:-darex}"
APP_USER="${RESTORE_DRILL_APP_USER:-darex_app}"
SRC_DB="${RESTORE_DRILL_DB:-darex}"
DRILL_DB="darex_restore_drill"
DUMP_DIR="${TMPDIR:-/tmp}/darex-restore-drill-$$"

for arg in "$@"; do
  case "$arg" in
    --execute) DRY_RUN=0 ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help)
      sed -n '2,14p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown flag: $arg" >&2
      exit 1
      ;;
  esac
done

log() { printf 'restore-drill: %s\n' "$*"; }
die() { printf 'restore-drill ERROR: %s\n' "$*" >&2; exit 1; }

docker inspect --format='{{.State.Status}}' "$CONTAINER" >/dev/null 2>&1 \
  || die "container $CONTAINER is not running — start compose first"

status="$(docker inspect --format='{{.State.Status}}' "$CONTAINER")"
[ "$status" = "running" ] || die "$CONTAINER state=$status (not running)"

mkdir -p "$DUMP_DIR"
trap 'rm -rf "$DUMP_DIR"' EXIT

log "dumping schema of $SRC_DB from $CONTAINER (superuser $SUPERUSER)"
if ! docker exec "$CONTAINER" pg_dump -U "$SUPERUSER" -d "$SRC_DB" --schema-only --no-owner \
  > "$DUMP_DIR/schema.sql" 2>"$DUMP_DIR/stderr.txt"; then
  cat "$DUMP_DIR/stderr.txt" >&2
  die "pg_dump --schema-only failed (honest fail — not a green skip)"
fi

bytes="$(wc -c < "$DUMP_DIR/schema.sql" | tr -d ' ')"
[ "$bytes" -gt 100 ] || die "schema dump too small ($bytes bytes) — refusing to call this a backup"

log "schema dump ok ($bytes bytes)"
log "plan:"
log "  1. CREATE DATABASE $DRILL_DB"
log "  2. pg_dump $SRC_DB | psql $DRILL_DB (as $SUPERUSER)"
log "  3. psql -U $APP_USER -d $DRILL_DB -c 'SELECT current_user'"
log "  4. DROP DATABASE $DRILL_DB"
log "  5. date the run in infra/scripts/restore-drill.md (not BUILD_STATE.md)"

if [ "$DRY_RUN" -eq 1 ]; then
  log "DRY-RUN complete. Re-run with --execute to restore into $DRILL_DB and drop it."
  exit 0
fi

log "EXECUTE: creating throwaway $DRILL_DB"
docker exec "$CONTAINER" psql -U "$SUPERUSER" -d postgres -v ON_ERROR_STOP=1 \
  -c "DROP DATABASE IF EXISTS $DRILL_DB;" \
  -c "CREATE DATABASE $DRILL_DB OWNER $SUPERUSER;"

log "EXECUTE: restoring dump into $DRILL_DB"
if ! docker exec "$CONTAINER" pg_dump -U "$SUPERUSER" -d "$SRC_DB" --no-owner \
  | docker exec -i "$CONTAINER" psql -U "$SUPERUSER" -d "$DRILL_DB" -v ON_ERROR_STOP=1 >/dev/null; then
  docker exec "$CONTAINER" psql -U "$SUPERUSER" -d postgres -c "DROP DATABASE IF EXISTS $DRILL_DB;" || true
  die "restore into $DRILL_DB failed"
fi

log "EXECUTE: $APP_USER must be able to connect"
who="$(docker exec "$CONTAINER" psql -U "$APP_USER" -d "$DRILL_DB" -Atc "SELECT current_user")"
[ "$who" = "$APP_USER" ] || die "expected current_user=$APP_USER, got '$who'"

log "EXECUTE: dropping $DRILL_DB"
docker exec "$CONTAINER" psql -U "$SUPERUSER" -d postgres -c "DROP DATABASE IF EXISTS $DRILL_DB;"

log "EXECUTE complete. Append the date to $ROOT/infra/scripts/restore-drill.md"
