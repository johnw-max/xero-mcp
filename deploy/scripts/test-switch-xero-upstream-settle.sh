#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
SWITCH_SCRIPT="$ROOT_DIR/deploy/scripts/switch-xero-upstream.sh"

sh -n "$SWITCH_SCRIPT"

grep -F 'PUBLIC_SETTLE_ATTEMPTS="3"' "$SWITCH_SCRIPT" >/dev/null
grep -F 'PUBLIC_SETTLE_SLEEP_SECONDS="1"' "$SWITCH_SCRIPT" >/dev/null
grep -F 'PUBLIC_SETTLE_CURL_MAX_TIME_SECONDS="1"' "$SWITCH_SCRIPT" >/dev/null
grep -F 'PUBLIC_CHECK_FAILED_AND_UPSTREAM_RESTORED' "$SWITCH_SCRIPT" >/dev/null
grep -F 'PUBLIC_CHECK_FAILED_AND_UPSTREAM_RESTORE_FAILED' "$SWITCH_SCRIPT" >/dev/null

if grep -Ei 'quickbooks|intuit' "$SWITCH_SCRIPT" >/dev/null; then
  printf 'switch script still contains excluded provider coupling\n' >&2
  exit 1
fi

printf 'xero upstream switch static contract passed\n'
