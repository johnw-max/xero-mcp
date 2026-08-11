#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$ROOT_DIR"

fail() {
  printf 'static verification failed: %s\n' "$1" >&2
  exit 1
}

require_text() {
  file=$1
  value=$2
  grep -F -- "$value" "$file" >/dev/null || fail "$file is missing required text: $value"
}

forbid_text() {
  file=$1
  value=$2
  if grep -Fi -- "$value" "$file" >/dev/null; then
    fail "$file still contains excluded provider text: $value"
  fi
}

test -f package.json || fail "package.json is missing"
test -f deploy/env.vps.example || fail "deploy/env.vps.example is missing"
test -f deploy/host-nginx/mcp.jiayuanwang.xyz || fail "host Nginx site is missing"

node -e 'JSON.parse(require("node:fs").readFileSync("package.json", "utf8"))' \
  || fail "package.json is invalid"
node -e 'JSON.parse(require("node:fs").readFileSync("agent-skills/accounting-double-entry-skills-2026-08-10/tests/connector-capability-cases.json", "utf8"))' \
  || fail "connector capability cases are invalid JSON"

sh -n deploy/scripts/switch-xero-upstream.sh
bash -n scripts/agent2_uat_write_gate_vps.sh

require_text deploy/env.vps.example "MCP_OAUTH_BROKER_ENABLED=true"
require_text deploy/env.vps.example "PERSONAL_POC_ONLY=true"
require_text deploy/env.vps.example "SHARED_TEST_USERS=true"
require_text deploy/env.vps.example "HOST_OAUTH_CLIENTS_JSON="
require_text deploy/env.vps.example "XERO_WRITE_ENABLED=false"

require_text deploy/docker-compose/compose.host-nginx.vps.yaml 'SHARED_TEST_USERS: ${SHARED_TEST_USERS:-false}'
require_text deploy/docker-compose/compose.host-nginx.green.vps.yaml 'SHARED_TEST_USERS: ${SHARED_TEST_USERS:-false}'
require_text deploy/host-nginx/mcp.jiayuanwang.xyz "upstream xero_accounting_mcp_demo"
require_text deploy/host-nginx/mcp.jiayuanwang.xyz "location = /mcp"
require_text deploy/host-nginx/mcp.jiayuanwang.xyz "location = /authorize"
require_text deploy/host-nginx/mcp.jiayuanwang.xyz "location = /token"
require_text deploy/host-nginx/mcp.jiayuanwang.xyz "location = /oauth/xero/callback"

for file in \
  package.json \
  deploy/env.vps.example \
  deploy/docker-compose/compose.host-nginx.vps.yaml \
  deploy/docker-compose/compose.host-nginx.green.vps.yaml \
  deploy/host-nginx/mcp.jiayuanwang.xyz \
  deploy/scripts/switch-xero-upstream.sh \
  scripts/agent2_uat_write_gate_vps.sh
do
  forbid_text "$file" "quickbooks"
  forbid_text "$file" "intuit"
done

if find src tests migrations -type f -print | grep -Ei 'quickbooks|intuit' >/dev/null; then
  fail "excluded provider-specific source, test, or migration files remain"
fi

printf 'static verification passed: Xero-only repository and shared-test OAuth configuration\n'
