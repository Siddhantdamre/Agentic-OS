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

# Counts are taken either side of the dump, because the source is a LIVE
# database. pg_dump reads one repeatable-read snapshot taken at some instant
# during the run, so the restored copy can only be compared to a RANGE.
#
# Asserting equality against the source read afterwards is wrong, and it was:
# the first version of this check failed with "messages: source 1420, restored
# 1421" while the verification suite was writing in another terminal. Nothing
# was broken. A drill that cries wolf on a busy database gets run only on idle
# ones, which are exactly the ones whose restores never mattered.
count_of() { docker exec "$CONTAINER" psql -U "$SUPERUSER" -d "$1" -Atc "SELECT COUNT(*) FROM $2"; }

pre_orgs="$(count_of "$SRC_DB" orgs)"
pre_msgs="$(count_of "$SRC_DB" messages)"

log "EXECUTE: restoring dump into $DRILL_DB"
if ! docker exec "$CONTAINER" pg_dump -U "$SUPERUSER" -d "$SRC_DB" --no-owner \
  | docker exec -i "$CONTAINER" psql -U "$SUPERUSER" -d "$DRILL_DB" -v ON_ERROR_STOP=1 >/dev/null; then
  docker exec "$CONTAINER" psql -U "$SUPERUSER" -d postgres -c "DROP DATABASE IF EXISTS $DRILL_DB;" || true
  die "restore into $DRILL_DB failed"
fi

post_orgs="$(count_of "$SRC_DB" orgs)"
post_msgs="$(count_of "$SRC_DB" messages)"

log "EXECUTE: $APP_USER must be able to connect"
who="$(docker exec "$CONTAINER" psql -U "$APP_USER" -d "$DRILL_DB" -Atc "SELECT current_user")"
[ "$who" = "$APP_USER" ] || die "expected current_user=$APP_USER, got '$who'"

# Connecting is not restoring.
#
# Everything above this point would pass against an EMPTY database:
# ON_ERROR_STOP catches a dump that fails outright, and `SELECT current_user`
# proves only that the role can log in. A drill that cannot tell a good restore
# from an empty one is a ritual, and the day it matters is the day you find out.
drill_fail() {
  docker exec "$CONTAINER" psql -U "$SUPERUSER" -d postgres -c "DROP DATABASE IF EXISTS $DRILL_DB;" >/dev/null 2>&1 || true
  die "$1"
}

log "EXECUTE: the restored copy must contain the data, not just the schema"

# The restored count must land inside the window the source occupied while the
# dump ran. Outside it means the dump lost rows (below) or invented them
# (above) — either is a broken backup. Inside it is the only correct answer on
# a live database, and it still fails hard on an empty restore.
in_window() { # name low high actual
  if [ "$4" -lt "$2" ] || [ "$4" -gt "$3" ]; then
    drill_fail "$1: restored $4 is outside the source window [$2..$3] observed across the dump"
  fi
}

[ "$pre_orgs" -gt 0 ] 2>/dev/null \
  || drill_fail "source has zero orgs — this drill would prove nothing"

dst_orgs="$(count_of "$DRILL_DB" orgs)"
in_window orgs "$pre_orgs" "$post_orgs" "$dst_orgs"
log "  orgs restored $dst_orgs (source $pre_orgs..$post_orgs during dump)"

dst_msgs="$(count_of "$DRILL_DB" messages)"
in_window messages "$pre_msgs" "$post_msgs" "$dst_msgs"
log "  messages restored $dst_msgs (source $pre_msgs..$post_msgs during dump)"

# The part that actually matters. Row security is a property of the schema and
# it can be lost in a dump/restore — a policy that fails to apply, a FORCE flag
# that does not carry. Restoring into a state where every tenant can read every
# other tenant is a worse outcome than losing the backup, because it looks like
# success.
log "EXECUTE: the tenant wall must have survived the restore"
rls_q="SELECT COUNT(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relrowsecurity AND c.relforcerowsecurity"
src_rls="$(docker exec "$CONTAINER" psql -U "$SUPERUSER" -d "$SRC_DB" -Atc "$rls_q")"
dst_rls="$(docker exec "$CONTAINER" psql -U "$SUPERUSER" -d "$DRILL_DB" -Atc "$rls_q")"
[ "$src_rls" = "$dst_rls" ] \
  || drill_fail "FORCE RLS tables: source $src_rls, restored $dst_rls — the restore lost tenant isolation"
log "  FORCE RLS tables $src_rls -> $dst_rls"

# And prove it BEHAVES, not merely that the flags are set: with no tenant
# context, the app role must see nothing at all.
leak="$(docker exec "$CONTAINER" psql -U "$APP_USER" -d "$DRILL_DB" -Atc "SELECT COUNT(*) FROM orgs")"
[ "$leak" = "0" ] \
  || drill_fail "the app role read $leak orgs from the restored copy with no tenant context"
log "  app role reads 0 orgs without tenant context — isolation holds"

log "EXECUTE: dropping $DRILL_DB"
docker exec "$CONTAINER" psql -U "$SUPERUSER" -d postgres -c "DROP DATABASE IF EXISTS $DRILL_DB;"

log "EXECUTE complete. Append the date to $ROOT/infra/scripts/restore-drill.md"
