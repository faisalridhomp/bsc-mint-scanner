#!/usr/bin/env bash
# BSC free-mint chain watch (hook wrapper).
# The node scanner does the block fetching + candidate detection and prints
# one JSON line: {"decision":"wake"|"silent","reason":"...","payload":{...}}.
# This wrapper turns it into exactly one silent() or wake() call.
set -euo pipefail
source "$HATCH_HOOK_RUNTIME"

DRY=0
if [ "${HATCH_HOOK_DRY_RUN:-0}" = "1" ]; then DRY=1; fi
export FREE_MINT_WATCH_DRY="$DRY"

result=$(/usr/bin/node "$HOME/hooks/scripts/free_mint_watch_scan.js" 2>/tmp/fmw_scan_err.txt) || {
  err=$(head -c 300 /tmp/fmw_scan_err.txt 2>/dev/null || true)
  log "scan_error" "$(printf '%s' "$err" | /usr/bin/jq -Rs '{error: .}')"
  silent "scanner error" '{}'
  exit 0
}

decision=$(printf '%s' "$result" | /usr/bin/jq -r '.decision // "silent"')
reason=$(printf '%s' "$result" | /usr/bin/jq -r '.reason // "no result"')
payload=$(printf '%s' "$result" | /usr/bin/jq -c '.payload // {}')

if [ "$decision" = "wake" ]; then
  log "candidates" "$payload"
  wake "$reason" "$payload"
else
  silent "$reason" "$payload"
fi
exit 0
