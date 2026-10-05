#!/usr/bin/env bash
# Checks check_port_ownership (deploy/lib.sh) against stubbed compose / ss / docker:
# a clean Darex stack passes, and every kind of clash with another project is refused.
# Run: bash tests/deploy-port-guard.sh
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fail=0

run_case() { # name expected(pass|fail) ports_json listeners docker_ps [extra env...]
  local name="$1" expect="$2" ports="$3" listen="$4" dps="$5"; shift 5
  local out rc
  out="$(
    log() { :; }; info() { :; }; warn() { :; }
    die() { printf 'DIE: %s\n' "$*" >&2; exit 1; }
    set -a; . "$ROOT/deploy/ports.conf"; set +a
    # shellcheck source=deploy/lib.sh
    . "$ROOT/deploy/lib.sh"
    # The deploy scripts source .env after lib.sh, so its overrides win; do the same here.
    for kv in "$@"; do export "$kv"; done
    compose() { printf '%s' "$ports"; }
    ss() { local p="${*: -1}"; p="${p##*:}"; for l in $listen; do [ "$l" = "$p" ] && echo "LISTEN 0 4096 127.0.0.1:$p 0.0.0.0:*"; done; return 0; }
    docker() { printf '%b' "$dps"; }
    check_port_ownership
  )" 2>&1; rc=$?
  if { [ "$expect" = pass ] && [ $rc -eq 0 ]; } || { [ "$expect" = fail ] && [ $rc -ne 0 ]; }; then
    echo "ok   - $name"
  else
    echo "FAIL - $name (rc=$rc, wanted $expect)"; echo "$out" | sed 's/^/       /'; fail=1
  fi
}

svc() { # name port -> compose-config JSON fragment
  printf '"%s":{"ports":[{"published":"%s","target":80}]}' "$1" "$2"
}
cfg() { local IFS=,; printf '{"services":{%s}}' "$*"; }

GOOD="$(cfg "$(svc frontend 13100)" "$(svc dashboard 13000)" "$(svc postgres 15432)")"

run_case "clean stack, ports free"                      pass "$GOOD" ""                    ""
run_case "our own containers hold the ports (redeploy)" pass "$GOOD" "13100 13000 15432"   'darex-frontend\t127.0.0.1:13100->3100/tcp\ndarex-dashboard\t127.0.0.1:13000->3000/tcp\ndarex-postgres\t127.0.0.1:15432->5432/tcp\n'
run_case "port below Darex's range"                     fail "$(cfg "$(svc dashboard 3000)")" "" ""
run_case "port above Darex's range (mtip's 47xxx)"      fail "$(cfg "$(svc frontend 47033)")" "" ""
run_case "port reserved for another project (openclaw)" fail "$(cfg "$(svc mcp-bridge 18789)")" "" ""
run_case "two Darex services on one port"               fail "$(cfg "$(svc a 13100)" "$(svc b 13100)")" "" ""
run_case "another project's container holds the port"   fail "$GOOD" "13100"               'mtip-frontend\t0.0.0.0:13100->47033/tcp\n'
run_case "a host process holds the port"                fail "$GOOD" "15432"               ''
run_case "substring port is not a false positive"       pass "$GOOD" "3100"                'mtip-x\t127.0.0.1:3100->80/tcp\n'
run_case "range override from .env is honoured"         pass "$(cfg "$(svc a 3000)")" "" "" DAREX_PORT_MIN=1000 DAREX_PORT_MAX=19999

[ $fail -eq 0 ] && echo "all port guard cases passed" || { echo "port guard cases FAILED"; exit 1; }
