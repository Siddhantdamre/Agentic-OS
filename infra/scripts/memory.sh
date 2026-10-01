#!/usr/bin/env bash
# Darex memory viewer (operator tool, READ-ONLY): what every org remembers,
# across all three memory stores.
#
#   bash infra/scripts/memory.sh               overview of every org
#   bash infra/scripts/memory.sh <org-uuid>    one org in detail (recent rows + facts)
#
# Stores: Postgres memory tables (org/employee/entity/conversation/edges/
# facts), Hindsight (bank org_<uuid>), Cognee (dataset org_<uuid>).
# Superuser access: sees all orgs. Operator eyes only; customers get the
# org-scoped Data & Memory page in the dashboard instead.
set -u

PG_CONTAINER="${PG_CONTAINER:-darex-postgres}"
HS_CONTAINER="${HS_CONTAINER:-darex-hindsight}"
COGNEE_CONTAINER="${COGNEE_CONTAINER:-darex-cognee}"
RECENT="${RECENT:-8}"

pg() { docker exec -e PGOPTIONS='-c default_transaction_read_only=on' "$PG_CONTAINER" psql -U darex -d darex "$@"; }

hs() { # path -> JSON; silent failure (empty output) so one dead store does not hide the rest
  docker exec "$HS_CONTAINER" python3 -c '
import os, sys, urllib.request
h = {"Authorization": "Bearer " + os.environ.get("HINDSIGHT_API_TENANT_API_KEY", "")}
try:
    sys.stdout.write(urllib.request.urlopen(urllib.request.Request("http://localhost:8888" + sys.argv[1], headers=h), timeout=30).read().decode())
except Exception:
    sys.exit(1)' "$1" 2>/dev/null
}

cognee() { # path
  docker exec "$COGNEE_CONTAINER" python3 -c '
import sys, urllib.request
try:
    sys.stdout.write(urllib.request.urlopen("http://localhost:8000" + sys.argv[1], timeout=20).read().decode())
except Exception:
    sys.exit(1)' "$1" 2>/dev/null
}

uuid_ok() { case "$1" in [0-9a-fA-F]*-*-*-*-*) case "$1" in *[!0-9a-fA-F-]*) return 1 ;; esac; [ "${#1}" -eq 36 ] ;; *) return 1 ;; esac; }

overview() {
  echo "=== Postgres memory tables, per org ==="
  pg -c "
    select o.name, o.slug, o.id,
      (select count(*) from org_memory m where m.org_id = o.id)          as org_mem,
      (select count(*) from employee_memory m where m.org_id = o.id)     as emp_mem,
      (select count(*) from entity_memory m where m.org_id = o.id)       as entity_mem,
      (select count(*) from conversation_memory m where m.org_id = o.id) as conv_mem,
      (select count(*) from memory_edges m where m.org_id = o.id)        as edges,
      (select count(*) from facts m where m.org_id = o.id)               as facts
    from orgs o order by o.created_at"

  echo; echo "=== Hindsight banks (extracted facts, one bank per org) ==="
  local banks; banks="$(hs /v1/default/banks | python3 -c '
import sys, json
for b in json.load(sys.stdin).get("banks", []): print(b.get("bank_id"))' 2>/dev/null)"
  if [ -z "$banks" ]; then
    hs /v1/default/banks >/dev/null && echo "(no banks yet: nothing retained)" || echo "!! Hindsight not reachable (is darex-hindsight healthy?)"
  else
    local b
    for b in $banks; do
      hs "/v1/default/banks/$b/stats" | python3 -c '
import sys, json
d = json.load(sys.stdin); print("%-50s memories=%s documents=%s observations=%s pending_ops=%s" % (sys.argv[1], d.get("total_nodes"), d.get("total_documents"), d.get("total_observations"), d.get("pending_operations")))' "$b"
    done
  fi

  echo; echo "=== Cognee datasets (knowledge graph, one per org) ==="
  cognee /api/v1/datasets | python3 -c '
import sys, json
try:
    ds = json.load(sys.stdin)
except Exception:
    print("!! Cognee not reachable (is darex-cognee healthy?)"); sys.exit(0)
if not ds: print("(no datasets yet)")
for d in ds: print("%-50s created %s" % (d.get("name"), d.get("createdAt")))'
  echo; echo "Detail for one org: bash infra/scripts/memory.sh <org-uuid>"
}

detail() {
  local org="$1"
  uuid_ok "$org" || { echo "not a uuid: $org" >&2; exit 2; }
  pg -At -c "select 'org: ' || name || ' (' || slug || ', plan ' || plan || ')' from orgs where id = '$org'" | grep . || { echo "no such org" >&2; exit 1; }
  local t
  for t in org_memory employee_memory entity_memory conversation_memory; do
    echo; echo "=== $t (newest $RECENT) ==="
    pg -c "select left(id::text, 8) as id, updated_at, left(coalesce(title, kind, ''), 40) as label, left(coalesce(body, content, ''), 90) as text
           from $t where org_id = '$org' order by updated_at desc limit $RECENT" 2>/dev/null \
      || pg -c "select * from $t where org_id = '$org' limit $RECENT"
  done
  echo; echo "=== facts (newest $RECENT) ==="
  pg -c "select * from facts where org_id = '$org' order by 1 limit $RECENT" 2>&1 | cut -c1-200
  echo; echo "=== Hindsight bank org_$org ==="
  hs "/v1/default/banks/org_$org/memories/list?limit=$RECENT&offset=0" | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    print("(no bank, or Hindsight not reachable)"); sys.exit(0)
for m in d.get("items", []): print("  [%s] %s" % (m.get("fact_type") or m.get("type") or "?", (m.get("text") or "")[:150]))
print("  (%s total)" % d.get("total"))'
}

case "${1:-}" in
  "") overview ;;
  -h|--help|help) sed -n 2,11p "$0" ;;
  *) detail "$1" ;;
esac
