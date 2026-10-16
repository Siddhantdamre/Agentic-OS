#!/usr/bin/env bash
# Darex database browser (operator tool, READ-ONLY).
#
#   bash infra/scripts/database.sh                 menu: Postgres / Hindsight / Redis
#   bash infra/scripts/database.sh pg              list Postgres databases
#   bash infra/scripts/database.sh pg <db>         list tables in a database (with row counts)
#   bash infra/scripts/database.sh pg <db> <table> show the first rows (LIMIT=50 env to change)
#   bash infra/scripts/database.sh sql <db> "<query>"
#   bash infra/scripts/database.sh hindsight [bank]   memory banks, or one bank's facts
#   bash infra/scripts/database.sh redis [key]        keys, or one key's value
#
# Runs as the Postgres superuser inside the containers, so it sees EVERY org
# (RLS does not apply). Never expose this script or its output to customers;
# the customer-facing view is the dashboard's org-scoped Data & Memory page.
# Every Postgres session is forced read-only.
set -u

PG_CONTAINER="${PG_CONTAINER:-darex-postgres}"
PG_USER="${PG_USER:-darex}"
HS_CONTAINER="${HS_CONTAINER:-darex-hindsight}"
REDIS_CONTAINER="${REDIS_CONTAINER:-darex-redis}"
LIMIT="${LIMIT:-50}"
ARGS=()

need() { docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null | grep -q true || { echo "container $1 is not running" >&2; return 1; }; }

pager() { if [ -t 1 ]; then ${PAGER:-less -SRFX}; else cat; fi; }

# psql inside the container, forced read-only. Extra args pass through.
pg() {
  docker exec -e PGOPTIONS='-c default_transaction_read_only=on' "$PG_CONTAINER" psql -U "$PG_USER" "$@"
}

# Identifier safety: databases/tables come from the catalog, but the CLI args
# do not, so reject anything that is not a plain (schema.)name before it is
# interpolated into SQL.
ident() { case "$1" in *[!A-Za-z0-9_.]*|"") echo "bad name: $1" >&2; return 1 ;; esac; }

pg_dbs() {
  pg -d postgres -Atc "select datname from pg_database where not datistemplate order by 1"
}

pg_tables() { # db -> "schema.table<TAB>~rows"
  pg -d "$1" -AtF $'\t' -c "
    select schemaname||'.'||relname, n_live_tup
      from pg_stat_user_tables order by schemaname, relname"
}

pg_show_tables() {
  ident "$1" || return 1
  echo "== tables in $1 (row counts are estimates; pick one to see exact count + rows)"
  pg -d "$1" -c "
    select schemaname as schema, relname as table, n_live_tup as approx_rows
      from pg_stat_user_tables order by schemaname, relname" | pager
}

pg_show_rows() { # db table [expanded]
  ident "$1" && ident "$2" || return 1
  local tbl="$2"; case "$tbl" in *.*) ;; *) tbl="public.$tbl" ;; esac
  local schema="${tbl%%.*}" name="${tbl#*.}"
  echo "== $1 / $tbl"
  pg -d "$1" -c "select count(*) as exact_rows from \"$schema\".\"$name\"" | sed -n 3p | sed 's/^/   rows:/'
  pg -d "$1" -c "\\d \"$schema\".\"$name\"" | pager
  pg -d "$1" ${3:+-x} -c "select * from \"$schema\".\"$name\" limit $LIMIT" | pager
}

pg_sql() { # db query
  ident "$1" || return 1
  pg -d "$1" -c "$2" | pager
}

# Numbered menu. bash `select` redraws on an empty Enter, so "Enter = back"
# needs our own loop. Sets CHOICE; returns 1 on Enter / q / EOF.
pick() { # prompt items...
  local prompt="$1"; shift
  CHOICE=""
  [ "$#" -eq 0 ] && { echo "(nothing to pick)"; return 1; }
  local i=1 it reply
  for it in "$@"; do printf '%4d) %s\n' "$i" "$it"; i=$((i + 1)); done
  while true; do
    printf '%s (number, Enter = back) > ' "$prompt"
    IFS= read -r reply || return 1
    case "$reply" in ""|q|Q) return 1 ;; esac
    case "$reply" in *[!0-9]*) echo "type a number"; continue ;; esac
    if [ "$reply" -ge 1 ] && [ "$reply" -le "$#" ]; then
      eval "CHOICE=\${$reply}"
      return 0
    fi
    echo "pick 1-$#"
  done
}

list_to_args() { # read lines from stdin into the ARGS array (bash 3.2 has no mapfile)
  ARGS=(); local l
  while IFS= read -r l; do [ -n "$l" ] && ARGS+=("$l"); done
}

menu_pg() {
  need "$PG_CONTAINER" || return
  while true; do
    echo; echo "### Postgres databases (read-only, all orgs)"
    list_to_args < <(pg_dbs)
    pick "database" "${ARGS[@]}" || return
    local db="$CHOICE"
    while true; do
      echo; echo "### $db"
      list_to_args < <(pg_tables "$db" | awk -F'\t' '{printf "%-50s ~%s rows\n",$1,$2}')
      local rows=("${ARGS[@]}")
      local opts=("${rows[@]}" "[run a SQL query]")
      pick "table in $db" "${opts[@]}" || break
      if [ "$CHOICE" = "[run a SQL query]" ]; then
        printf 'SQL (read-only) > '; read -r q
        [ -n "$q" ] && pg_sql "$db" "$q"
      else
        local t="${CHOICE%% *}"
        pg_show_rows "$db" "$t"
        printf 'expanded one-row-per-block view? [y/N] '; read -r x
        [ "$x" = y ] && pg_show_rows "$db" "$t" x
      fi
    done
  done
}

# --- Hindsight: talk to its REST API from inside its own container ---------
hs() { # METHOD path  -> raw JSON on stdout
  need "$HS_CONTAINER" || return 1
  docker exec "$HS_CONTAINER" python3 -c '
import os, sys, json, urllib.request
h = {"Authorization": "Bearer " + os.environ.get("HINDSIGHT_API_TENANT_API_KEY", "")}
r = urllib.request.Request("http://localhost:8888" + sys.argv[2], headers=h, method=sys.argv[1])
try:
    sys.stdout.write(urllib.request.urlopen(r, timeout=30).read().decode())
except urllib.error.HTTPError as e:
    sys.stderr.write("Hindsight HTTP %s %s\n" % (e.code, e.read()[:200].decode())); sys.exit(1)
except Exception as e:
    sys.stderr.write("Hindsight not reachable yet (%s). Is darex-hindsight healthy?\n" % e); sys.exit(1)
' "$1" "$2"
}

hs_banks() { hs GET /v1/default/banks | python3 -c '
import sys, json
for b in json.load(sys.stdin).get("banks", []): print(b.get("bank_id"))'; }

hs_bank() { # bank
  ident "$1" || return 1
  echo "== Hindsight bank $1"
  hs GET "/v1/default/banks/$1/stats" | python3 -c '
import sys, json
d = json.load(sys.stdin)
for k in ("total_nodes","total_documents","total_observations","nodes_by_fact_type","pending_operations","failed_operations","last_memory_write_at"):
    print("  %-22s %s" % (k, d.get(k)))
if d.get("pending_operations"):
    print("  !! pending operations: if these never drain, restart darex-hindsight")'
  echo; echo "-- memories (newest first, max $LIMIT)"
  hs GET "/v1/default/banks/$1/memories/list?limit=$LIMIT&offset=0" | python3 -c '
import sys, json
d = json.load(sys.stdin)
for m in d.get("items", []):
    print("  [%s] %s" % (m.get("fact_type") or m.get("type") or "?", (m.get("text") or "")[:160]))
print("  (%s total)" % d.get("total"))' | pager
  echo; echo "-- documents"
  hs GET "/v1/default/banks/$1/documents" | python3 -c '
import sys, json
for d in json.load(sys.stdin).get("items", []):
    print("  %-40s %s memory units  updated %s" % (d.get("id"), d.get("memory_unit_count"), d.get("updated_at")))' | pager
}

menu_hindsight() {
  need "$HS_CONTAINER" || return
  while true; do
    echo; echo "### Hindsight memory banks (one per org: org_<uuid>)"
    list_to_args < <(hs_banks)
    [ "${#ARGS[@]}" -eq 0 ] && { echo "(no banks yet: nothing retained)"; return; }
    pick "bank" "${ARGS[@]}" || return
    hs_bank "$CHOICE"
  done
}

# --- Redis ------------------------------------------------------------------
rd() { docker exec "$REDIS_CONTAINER" redis-cli "$@"; }

rd_key() {
  case "$1" in *[[:cntrl:]]*|"") echo "bad key" >&2; return 1 ;; esac
  local t; t="$(rd type "$1" | tr -d '\r')"
  echo "== $1  type=$t  ttl=$(rd ttl "$1" | tr -d '\r')s"
  case "$t" in
    string) rd get "$1" ;;
    list) rd lrange "$1" 0 "$((LIMIT - 1))" ;;
    set) rd srandmember "$1" "$LIMIT" ;;
    zset) rd zrange "$1" 0 "$((LIMIT - 1))" withscores ;;
    hash) rd hgetall "$1" ;;
    stream) rd xrevrange "$1" + - count "$LIMIT" ;;
    *) echo "(unsupported type)" ;;
  esac | pager
}

menu_redis() {
  need "$REDIS_CONTAINER" || return
  while true; do
    echo; echo "### Redis (SSE bus + caches), $(rd dbsize | tr -d '\r') keys; showing up to 100"
    list_to_args < <(rd --scan --count 200 | head -100)
    pick "key" "${ARGS[@]}" || return
    rd_key "$CHOICE"
  done
}

main_menu() {
  while true; do
    echo; echo "=== Darex database browser (read-only) ==="
    pick "store" "Postgres (all databases, tables, rows)" "Hindsight (memory banks, facts)" "Redis (keys, values)" || return
    case "$CHOICE" in
      Postgres*) menu_pg ;;
      Hindsight*) menu_hindsight ;;
      Redis*) menu_redis ;;
    esac
  done
}

case "${1:-}" in
  "") main_menu ;;
  pg)
    need "$PG_CONTAINER" || exit 1
    case $# in
      1) pg_dbs ;;
      2) pg_show_tables "$2" ;;
      *) pg_show_rows "$2" "$3" ;;
    esac ;;
  sql) [ $# -ge 3 ] || { echo 'usage: database.sh sql <db> "<query>"' >&2; exit 2; }; need "$PG_CONTAINER" || exit 1; pg_sql "$2" "$3" ;;
  hindsight) if [ $# -ge 2 ]; then hs_bank "$2"; else hs_banks; fi ;;
  redis) if [ $# -ge 2 ]; then rd_key "$2"; else rd --scan --count 200 | head -100; fi ;;
  -h|--help|help) sed -n 2,17p "$0" ;;
  *) echo "unknown command: $1 (try --help)" >&2; exit 2 ;;
esac
