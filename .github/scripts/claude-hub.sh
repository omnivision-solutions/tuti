#!/usr/bin/env bash
# The Claude hub's address and credentials in CI: what to mask in logs, and what never to publish.
#
#   claude-hub.sh names          The hub's host and network name from CLIPROXY_URL, one per line.
#   claude-hub.sh check FILE...  Fails if a file contains CLAUDE_CODE_OAUTH_TOKEN, CLIPROXY_API_KEY
#                                or one of those names (any case), or can't be read.
#
# A short host name (no dot) is left out: it would match ordinary words ("hub" in "github").
# The values go to grep in a file, never on a command line other processes could read.
set -euo pipefail

names() {
  local host=${CLIPROXY_URL:-}
  host=${host#*://}; host=${host%%/*}; host=${host##*@}
  case $host in
    \[*\]*) host=${host#\[}; echo "${host%%\]*}"; return ;; # IPv6: the address is specific enough
  esac
  host=${host%%:*}
  case $host in *.*) ;; *) return 0 ;; esac
  echo "$host"
  case $host in *[!0-9.]*.*.*) echo "${host#*.}" ;; esac # a name's domain; an IPv4 address has none
}

check() {
  local status=0
  never=$(mktemp)
  trap 'rm -f "$never"' EXIT
  { printf '%s\n' "${CLAUDE_CODE_OAUTH_TOKEN:-}" "${CLIPROXY_API_KEY:-}"; names; } | awk NF > "$never"
  [ -s "$never" ] || return 0
  grep -qiFf "$never" -- "$@" || status=$?
  [ "$status" -eq 1 ] # 0 is a match, 2 an error: both fail
}

case ${1:-} in
  names) names ;;
  check) shift; [ $# -gt 0 ] && check "$@" ;;
  *) echo "usage: claude-hub.sh names | check FILE..." >&2; exit 2 ;;
esac
