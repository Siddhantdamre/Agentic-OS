#!/usr/bin/env bash
# Checks pull_prebuilt / registry_prefix / prebuilt_sha (deploy/lib.sh) against a stubbed docker, git
# and sleep: a pre-built image is pulled and tagged, and every other outcome falls back to a local
# build without hanging. Run: bash tests/deploy-prebuilt.sh
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export ROOT
fail=0
SHA=0123456789abcdef0123456789abcdef01234567
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
LOG="$WORK/log"; COUNT="$WORK/count"; RESULTS="$WORK/results"

# Stubs live at top level (not inside $(...)): they record to $LOG, and the pull outcomes come from
# $RESULTS (one word per call, the last repeats), counted in $COUNT because each call is a subshell.
info() { echo "info: $*" >> "$LOG"; }
warn() { echo "warn: $*" >> "$LOG"; }
sleep() { echo "sleep ${1:-}" >> "$LOG"; }
git() {
  if [ "${1:-}" = "-C" ]; then shift 2; fi
  case "$*" in
    "remote get-url origin") echo "git@github.com:DarexAI-AI-Startup/Agentic-Os-SaaS.git" ;;
    "rev-parse HEAD") echo "${FAKE_HEAD:-}" ;;
    "rev-parse origin/main") echo "${FAKE_MAIN:-}" ;;
  esac
}
docker() {
  local n r
  if [ "${1:-}" = "tag" ]; then echo "tag ${2:-} ${3:-}" >> "$LOG"; return 0; fi
  [ "${1:-}" = "pull" ] || return 0
  n="$(cat "$COUNT")"; echo $((n + 1)) > "$COUNT"
  r="$(awk -v n="$((n + 1))" '{ w[NR]=$1 } END { print (n <= NR ? w[n] : w[NR]) }' "$RESULTS")"
  echo "pull ${!#}" >> "$LOG"
  if [ "$r" = ok ]; then echo "sha256:abc"; return 0; fi
  if [ "$r" = notfound ]; then echo "Error response from daemon: manifest unknown"; return 1; fi
  if [ "$r" = denied ]; then echo "Error response from daemon: denied: permission_denied"; return 1; fi
  echo "Error: network is unreachable"; return 1
}
# shellcheck source=deploy/lib.sh
. "$ROOT/deploy/lib.sh"

# run_case name expected(0|1) results service sha [VAR=value ...]
run_case() {
  local name="$1" expect="$2" results="$3" svc="$4" sha="$5" rc kv; shift 5
  : > "$LOG"; echo 0 > "$COUNT"; printf '%s\n' $results > "$RESULTS"
  ( for kv in "$@"; do export "$kv"; done; pull_prebuilt "$svc" "darex-$svc:local" "$sha" ) > /dev/null 2>&1
  rc=$?
  if [ "$rc" = "$expect" ]; then echo "ok   - $name"; else echo "FAIL - $name (rc=$rc, wanted $expect)"; sed 's/^/       /' "$LOG"; fail=1; fi
}
has()   { grep -qF -- "$1" "$LOG" && echo "ok   -   ...$2" || { echo "FAIL -   ...$2"; sed 's/^/       /' "$LOG"; fail=1; }; }
hasnt() { grep -qF -- "$1" "$LOG" && { echo "FAIL -   ...$2"; sed 's/^/       /' "$LOG"; fail=1; } || echo "ok   -   ...$2"; }

run_case "pulled, then tagged as the local image name" 0 "ok" dashboard "$SHA"
has "pull ghcr.io/darexai-ai-startup/darex-dashboard:$SHA" "registry derived from the git origin, lowercased"
has "tag ghcr.io/darexai-ai-startup/darex-dashboard:$SHA darex-dashboard:local" "tagged to the compose image name"

run_case "not allowed to pull: stops at once and says to log in" 1 "denied" worker "$SHA" DEPLOY_WAIT_IMAGES_MIN=12
has "docker login ghcr.io" "tells the operator how to log in"
hasnt "sleep" "does not wait"

run_case "CI not finished yet: waits, then pulls" 0 "notfound notfound ok" dashboard "$SHA"
has "sleep 30" "waited between tries"
has "tag ghcr.io" "and pulled once the image appeared"

run_case "CI never publishes: gives up after the wait and builds locally" 1 "notfound" sandbox "$SHA" DEPLOY_WAIT_IMAGES_MIN=1
has "Building locally" "says it is building locally"

run_case "no wait configured: one try, then local build" 1 "notfound" inbox "$SHA" DEPLOY_WAIT_IMAGES_MIN=0
hasnt "sleep" "no waiting"

run_case "unexpected pull error: local build" 1 "boom" dashboard "$SHA"
has "Building locally" "falls back"

run_case "mcp-bridge is built on the server, never pulled" 1 "ok" mcp-bridge "$SHA"
hasnt "pull " "no pull attempted"

run_case "DEPLOY_PREBUILT=0 disables pulling" 1 "ok" dashboard "$SHA" DEPLOY_PREBUILT=0
hasnt "pull " "no pull attempted"

run_case "no commit to match (not on origin/main): local build" 1 "ok" dashboard ""
hasnt "pull " "no pull attempted"

run_case "explicit DEPLOY_REGISTRY wins" 0 "ok" dashboard "$SHA" DEPLOY_REGISTRY=ghcr.io/other
has "pull ghcr.io/other/darex-dashboard:$SHA" "uses the override"

# prebuilt_sha: only HEAD == origin/main counts
got="$(FAKE_HEAD=$SHA FAKE_MAIN=$SHA prebuilt_sha)"
[ "$got" = "$SHA" ] && echo "ok   - prebuilt_sha: HEAD is origin/main" || { echo "FAIL - prebuilt_sha same: '$got'"; fail=1; }
got="$(FAKE_HEAD=$SHA FAKE_MAIN=fedcba9876543210fedcba9876543210fedcba98 prebuilt_sha)"
[ -z "$got" ] && echo "ok   - prebuilt_sha: local commits give nothing" || { echo "FAIL - prebuilt_sha differ: '$got'"; fail=1; }

[ $fail -eq 0 ] && echo "all pre-built image cases passed" || { echo "pre-built image cases FAILED"; exit 1; }
