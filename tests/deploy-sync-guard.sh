#!/usr/bin/env bash
# Checks require_in_sync (deploy/lib.sh) with real git repos: a server checkout must match origin/<branch>;
# commits made on the box (including merge commits) are refused unless ALLOW_LOCAL_COMMITS=1.
# Run: bash tests/deploy-sync-guard.sh
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export ROOT
fail=0
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t

git init -q --bare "$WORK/origin.git"
git clone -q "$WORK/origin.git" "$WORK/dev" 2>/dev/null
( cd "$WORK/dev" && git checkout -q -b main && echo one > f && git add f && git commit -q -m one && git push -q origin main )
git clone -q -b main "$WORK/origin.git" "$WORK/server"

warn() { echo "warn: $*" >> "$WORK/out"; }
die()  { echo "DIE: $*" >> "$WORK/out"; exit 1; }
# shellcheck source=deploy/lib.sh
. "$ROOT/deploy/lib.sh"

check() { # name expected(0|1) [VAR=value ...]
  local name="$1" expect="$2" rc kv; shift 2
  : > "$WORK/out"
  ( for kv in "$@"; do export "$kv"; done; require_in_sync "$WORK/server" main )
  rc=$?
  if [ "$rc" = "$expect" ]; then echo "ok   - $name"; else echo "FAIL - $name (rc=$rc, wanted $expect)"; sed 's/^/       /' "$WORK/out"; fail=1; fi
}

check "checkout equals origin/main" 0

( cd "$WORK/dev" && echo two >> f && git commit -qam two && git push -q origin main )
git -C "$WORK/server" fetch -q origin
check "checkout is behind origin (a fast-forward will fix it)" 0

git -C "$WORK/server" merge -q --ff-only origin/main
echo local > "$WORK/server/g" && git -C "$WORK/server" add g && git -C "$WORK/server" commit -q -m "edit made on the server"
check "a commit made on the server is refused" 1
grep -q "edit made on the server" "$WORK/out" && echo "ok   -   ...it names the commit" || { echo "FAIL -   ...it names the commit"; fail=1; }
grep -q "reset --hard origin/main" "$WORK/out" && echo "ok   -   ...it says how to recover" || { echo "FAIL -   ...it says how to recover"; fail=1; }
check "ALLOW_LOCAL_COMMITS=1 deploys it anyway, with a warning" 0 ALLOW_LOCAL_COMMITS=1
grep -q "^warn:" "$WORK/out" && echo "ok   -   ...and warns" || { echo "FAIL -   ...and warns"; fail=1; }

# A merge commit from `git pull` on a diverged branch is also local history
git -C "$WORK/server" reset -q --hard origin/main
( cd "$WORK/dev" && echo three >> f && git commit -qam three && git push -q origin main )
echo other > "$WORK/server/h" && git -C "$WORK/server" add h && git -C "$WORK/server" commit -q -m "server side"
git -C "$WORK/server" -c pull.rebase=false pull -q --no-edit origin main >/dev/null 2>&1
check "a merge commit from git pull on the server is refused" 1

git -C "$WORK/server" reset -q --hard origin/main
check "after reset --hard origin/main it is clean again" 0

[ $fail -eq 0 ] && echo "all sync guard cases passed" || { echo "sync guard cases FAILED"; exit 1; }
