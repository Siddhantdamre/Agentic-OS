#!/usr/bin/env bash
# Shared by deploy.sh and redeploy.sh (sourced, never run). Runs the calling script in the
# background so closing the terminal or losing the SSH connection does not stop a deploy.
#
#   detach_dispatch <script> <args...>  start the script detached and follow its log, or
#                                       return so the caller runs inline (see conditions below)
#   detach_follow                       stream the log until the run ends, exit with its code
#
# Callers set before calling: ROOT, FOREGROUND, DO_LOGS, NO_DETACH (1 for read-only modes) and
# define log/info/warn/die. State lives outside the repo, shared by both scripts so only one
# deploy runs at a time:  $DEPLOY_STATE_DIR (default ~/.local/state/darex-deploy)
#   run.log  output of the last run     run.pid  pid of the running wrapper
#   run.exit exit code of the last run
#
# Runs inline (no background) when: --foreground, CI is set, the run is read-only, it is
# already the detached child, the first run needs to ask questions (no .env and no DOMAIN or
# OPENROUTER_API_KEY), or sudo would ask for a password (a background run cannot answer it).

DEPLOY_STATE_DIR="${DEPLOY_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/darex-deploy}"
RUN_LOG="$DEPLOY_STATE_DIR/run.log"
RUN_PID="$DEPLOY_STATE_DIR/run.pid"
RUN_EXIT="$DEPLOY_STATE_DIR/run.exit"

# True while a detached run is alive. The args check guards against a stale pid file whose pid
# was reused by an unrelated process after a reboot.
detach_running() {
  local pid
  pid="$(cat "$RUN_PID" 2>/dev/null || true)"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && ps -o args= -p "$pid" 2>/dev/null | grep -q deploy
}

detach_follow() {
  [ -f "$RUN_LOG" ] || die "No deploy log yet ($RUN_LOG). Start one with ./deploy/deploy.sh"
  tail -n +1 -f "$RUN_LOG" &
  local tailpid=$!
  # Closing the terminal ends this follower only; the run itself keeps going.
  while detach_running; do sleep 2; done
  sleep 1
  kill "$tailpid" 2>/dev/null || true
  wait "$tailpid" 2>/dev/null || true
  [ -f "$RUN_EXIT" ] || die "The run ended without an exit code (killed?). Log: $RUN_LOG"
  exit "$(cat "$RUN_EXIT")"
}

detach_start() {
  local script="$1"; shift
  mkdir -p "$DEPLOY_STATE_DIR"
  detach_running && die "A deploy is already running (pid $(cat "$RUN_PID")). Follow it: deploy/$(basename "$script") --logs"
  rm -f "$RUN_EXIT" "$RUN_PID"
  : > "$RUN_LOG"
  local starter=""; command -v setsid >/dev/null 2>&1 && starter="setsid"
  # setsid puts the run in its own session, nohup ignores the hangup; the wrapper records its
  # own pid first and the exit code last.
  # shellcheck disable=SC2086
  DEPLOY_DETACHED=1 RUN_PID="$RUN_PID" RUN_EXIT="$RUN_EXIT" \
    $starter nohup bash -c 'echo $$ > "$RUN_PID"; bash "$@"; echo $? > "$RUN_EXIT"' _ "$script" "$@" \
    > "$RUN_LOG" 2>&1 < /dev/null &
  for _ in $(seq 1 50); do [ -s "$RUN_PID" ] && break; sleep 0.1; done
  [ -s "$RUN_PID" ] || die "The background run did not start. Log: $RUN_LOG"
  printf '\n==> Running in the background (pid %s). You can close this terminal.\n' "$(cat "$RUN_PID")"
  printf '    Follow it later: deploy/%s --logs     Log: %s\n\n' "$(basename "$script")" "$RUN_LOG"
}

detach_dispatch() {
  if [ "${DO_LOGS:-0}" -eq 1 ]; then detach_follow; fi
  [ "${NO_DETACH:-0}" -eq 0 ] && [ "${FOREGROUND:-0}" -eq 0 ] \
    && [ -z "${DEPLOY_DETACHED:-}" ] && [ -z "${CI:-}" ] || return 0
  if [ ! -f "$ROOT/.env" ] && { [ -z "${DOMAIN:-}" ] || [ -z "${OPENROUTER_API_KEY:-}" ]; }; then
    return 0
  fi
  if [ "$(id -u)" -ne 0 ] && ! sudo -n true 2>/dev/null; then
    warn "sudo asks for a password, so this run stays in the foreground (keep the terminal open)."
    return 0
  fi
  detach_start "$@"
  detach_follow
}
