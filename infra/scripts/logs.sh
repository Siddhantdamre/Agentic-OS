#!/usr/bin/env bash
# Darex log viewer (operator tool). One service at a time, last 100 lines by
# default, optional live follow.
#
#   bash infra/scripts/logs.sh                     menu
#   bash infra/scripts/logs.sh <service>           last 100 lines
#   bash infra/scripts/logs.sh <service> -f        last 100, then live
#   bash infra/scripts/logs.sh <service> -e        only errors/warnings (last 500 scanned)
#   bash infra/scripts/logs.sh all [-f]            every service interleaved, [name] prefixed
#   bash infra/scripts/logs.sh list                running services
#   -n N sets the line count (default 100). <service> is the short name
#   (worker, dashboard, hindsight, cognee ...) or the full darex-* name.
#
# Logs can contain customer text. Operator eyes only: never paste or surface
# them to customers.
set -u

LINES_DEFAULT=100

containers() { docker ps --format '{{.Names}}' | grep '^darex-' | sort; }
short() { echo "${1#darex-}"; }

resolve() { # short or full name -> container name
  local n="$1"
  case "$n" in darex-*) ;; *) n="darex-$n" ;; esac
  docker inspect -f '{{.Name}}' "$n" >/dev/null 2>&1 || { echo "no such container: $1 (try: logs.sh list)" >&2; return 1; }
  echo "$n"
}

ERR_RE='error|warn|fail|exception|fatal|panic|traceback|timeout|refused|denied|oom|unhealthy'

show() { # container mode(last|live|errors) lines
  local c="$1" mode="$2" n="$3"
  echo "== $(short "$c")  ($mode, $n lines)"
  case "$mode" in
    last) docker logs --timestamps --tail "$n" "$c" 2>&1 ;;
    live) docker logs --timestamps --tail "$n" -f "$c" 2>&1 ;;
    errors) docker logs --timestamps --tail 500 "$c" 2>&1 | grep -i -E "$ERR_RE" | tail -n "$n" ;;
  esac
}

all_live() { # tail N per service then follow, prefixed
  local n="$1" c
  trap 'kill $(jobs -p) 2>/dev/null; exit 0' INT TERM
  for c in $(containers); do
    # sed -u (GNU) is not on macOS; line-buffered awk does the prefixing.
    docker logs --timestamps --tail "$n" -f "$c" 2>&1 | awk -v p="[$(short "$c")]" '{print p, $0; fflush()}' &
  done
  wait
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

menu() {
  while true; do
    local items=() c
    for c in $(containers); do items+=("$(short "$c")"); done
    items+=("ALL services (live)")
    echo; echo "=== Darex logs ==="
    pick "service" "${items[@]}" || return
    local svc="$CHOICE"
    if [ "$svc" = "ALL services (live)" ]; then
      echo "live, all services (Ctrl-C to stop)"; ( all_live "$LINES_DEFAULT" ); continue
    fi
    pick "view $svc" "last $LINES_DEFAULT lines" "live (last $LINES_DEFAULT, then follow; Ctrl-C to stop)" "errors and warnings only" || continue
    case "$CHOICE" in
      last*) show "$(resolve "$svc")" last "$LINES_DEFAULT" | ${PAGER:-less -SRFX} ;;
      live*) ( trap 'exit 0' INT; show "$(resolve "$svc")" live "$LINES_DEFAULT" ) ;;
      errors*) show "$(resolve "$svc")" errors "$LINES_DEFAULT" | ${PAGER:-less -SRFX} ;;
    esac
  done
}

[ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ] && { sed -n 2,15p "$0"; exit 0; }
[ -z "${1:-}" ] && { menu; exit 0; }
[ "$1" = "list" ] && { containers | while read -r c; do echo "$(short "$c")"; done; exit 0; }

target="$1"; shift
mode=last; n="$LINES_DEFAULT"
while [ $# -gt 0 ]; do
  case "$1" in
    -f|--follow) mode=live ;;
    -e|--errors) mode=errors ;;
    -n) shift; n="${1:-}"; case "$n" in ''|*[!0-9]*) echo "-n needs a number" >&2; exit 2 ;; esac ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

if [ "$target" = "all" ]; then
  [ "$mode" = live ] && { all_live "$n"; exit 0; }
  for c in $(containers); do show "$c" "$mode" "$n"; echo; done
else
  c="$(resolve "$target")" || exit 1
  [ "$mode" = live ] && trap 'exit 0' INT
  show "$c" "$mode" "$n"
fi
