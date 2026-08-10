#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
DEPLOY_DIR=$(CDPATH= cd -- "${SCRIPT_DIR}/.." && pwd)
PROJECT_DIR=$(CDPATH= cd -- "${DEPLOY_DIR}/.." && pwd)
COMPOSE_FILE="${DEPLOY_DIR}/docker-compose/compose.vps.yaml"
HOST_COMPOSE_FILE="${DEPLOY_DIR}/docker-compose/compose.host-nginx.vps.yaml"
GREEN_COMPOSE_FILE="${DEPLOY_DIR}/docker-compose/compose.host-nginx.green.vps.yaml"
UPSTREAM_SWITCH="${DEPLOY_DIR}/scripts/switch-xero-upstream.sh"
UPSTREAM_SETTLE_TEST="${DEPLOY_DIR}/scripts/test-switch-xero-upstream-settle.sh"
EXAMPLE_ENV="${DEPLOY_DIR}/env.vps.example"
RUNBOOK="${DEPLOY_DIR}/HETZNER-HOST-NGINX-RUNBOOK.md"
ALTERNATIVE_RUNBOOK="${DEPLOY_DIR}/HETZNER_RUNBOOK.md"
HOST_NGINX_SITE="${DEPLOY_DIR}/host-nginx/mcp.jiayuanwang.xyz"
HOST_NGINX_BOOTSTRAP="${HOST_NGINX_SITE}.bootstrap"
UAT_WRITE_GATE="${PROJECT_DIR}/scripts/agent2_uat_write_gate_vps.sh"
DATABASE_PREFLIGHT="${PROJECT_DIR}/scripts/preflight_xero_duplicate_guards.sql"

require_text() {
  file=$1
  text=$2
  if ! grep -F -- "${text}" "${file}" >/dev/null; then
    echo "missing required text '${text}' in ${file}" >&2
    exit 1
  fi
}

forbid_text() {
  file=$1
  text=$2
  if grep -F -- "${text}" "${file}" >/dev/null; then
    echo "forbidden text '${text}' found in ${file}" >&2
    exit 1
  fi
}

require_text "${DEPLOY_DIR}/Dockerfile" "USER 10001:10001"
require_text "${PROJECT_DIR}/.gitignore" "deploy/.env.vps"
require_text "${EXAMPLE_ENV}" "APP_IMAGE=xero-accounting-mcp-demo:0.3.0-xero-pilot-20260810.1"
require_text "${EXAMPLE_ENV}" "QUICKBOOKS_APP_IMAGE=xero-accounting-mcp-demo:0.2.12-quickbooks-20260806"
require_text "${EXAMPLE_ENV}" "MCP_PUBLIC_HOST=mcp.jiayuanwang.xyz"
require_text "${EXAMPLE_ENV}" "PUBLIC_BASE_URL=https://mcp.jiayuanwang.xyz"
require_text "${EXAMPLE_ENV}" "GREEN_APP_LOOPBACK_PORT=18004"
require_text "${EXAMPLE_ENV}" "EXISTING_EGRESS_NETWORK=xero-accounting-mcp-demo_egress"
require_text "${EXAMPLE_ENV}" "EXISTING_DATA_NETWORK=xero-accounting-mcp-demo_data"
require_text "${EXAMPLE_ENV}" "MCP_ALLOWED_HOSTS=mcp.jiayuanwang.xyz"
require_text "${EXAMPLE_ENV}" "MCP_ALLOWED_ORIGINS=https://agent2.zcloak.ai,https://mcp.jiayuanwang.xyz"
require_text "${EXAMPLE_ENV}" 'redirect_uris":["https://agent2.zcloak.ai/api/mcp/accounting-mcp/oauth/callback"]'
require_text "${EXAMPLE_ENV}" "MCP_OAUTH_BROKER_ENABLED=true"
require_text "${EXAMPLE_ENV}" "PERSONAL_POC_ONLY=true"
require_text "${EXAMPLE_ENV}" "OAUTH_MISSING_RESOURCE_COMPAT_CLIENT_IDS=REPLACE_WITH_AGENT2_OAUTH_CLIENT_ID"
require_text "${EXAMPLE_ENV}" "accounting.reports.trialbalance.read"
require_text "${EXAMPLE_ENV}" "accounting.invoices.read accounting.invoices"
require_text "${EXAMPLE_ENV}" "accounting.payments.read"
require_text "${EXAMPLE_ENV}" "QUICKBOOKS_PUBLIC_BASE_URL=https://mcp.jiayuanwang.xyz"
require_text "${EXAMPLE_ENV}" "QUICKBOOKS_MCP_ALLOWED_HOSTS=mcp.jiayuanwang.xyz"
require_text "${EXAMPLE_ENV}" "QUICKBOOKS_MCP_ALLOWED_ORIGINS=https://agent2.zcloak.ai,https://mcp.jiayuanwang.xyz"
require_text "${PROJECT_DIR}/config/.env.example" "accounting.invoices.read accounting.invoices"
require_text "${PROJECT_DIR}/config/.env.example" "accounting.payments.read"
require_text "${PROJECT_DIR}/migrations/002_ephemeral_cleanup_index.sql" "review_csrf_session_idx"
require_text "${PROJECT_DIR}/migrations/003_provider_connection_tenant_shortcode.sql" "tenant_short_code"
require_text "${PROJECT_DIR}/migrations/004_durable_audit_intent.sql" "tool_audit_logs_in_progress_idx"
require_text "${PROJECT_DIR}/migrations/005_oauth_identity_foundation.sql" "oauth_installations"
require_text "${PROJECT_DIR}/migrations/006_oauth_broker_flow_lifecycle.sql" "oauth_broker_flows_v2_lifecycle_check"
require_text "${PROJECT_DIR}/migrations/008_xero_source_evidence_type.sql" "posting_requests_source_evidence_type_check"
require_text "${PROJECT_DIR}/src/scripts/verifyPostgresEphemeralCleanup.ts" "cleanupAdvisoryLockKey = \"2026080401\""
require_text "${PROJECT_DIR}/src/scripts/verifyPostgresAuditContinuity.ts" "postgres-audit-continuity"
require_text "${PROJECT_DIR}/tests/contract/expected-tools.json" "xero_get_trial_balance"
require_text "${PROJECT_DIR}/tests/contract/expected-tools.json" "xero_list_credit_notes"
require_text "${PROJECT_DIR}/tests/contract/expected-tools.json" "xero_list_payments"
require_text "${DATABASE_PREFLIGHT}" "BEGIN TRANSACTION READ ONLY;"
require_text "${DATABASE_PREFLIGHT}" "mcp_refresh_token_families"
require_text "${DATABASE_PREFLIGHT}" "family_status = 'ACTIVE'"
require_text "${DATABASE_PREFLIGHT}" "refresh_family_preflight_safe"
require_text "${DATABASE_PREFLIGHT}" "migration 019"
require_text "${DATABASE_PREFLIGHT}" "Migration 020 exact-legacy-index preflight"
require_text "${DATABASE_PREFLIGHT}" "GROUP BY actor_id, tenant_id, request_id, create_operation"
require_text "${DATABASE_PREFLIGHT}" "GROUP BY tenant_id, source_sha256"
require_text "${DATABASE_PREFLIGHT}" "GROUP BY tenant_id, contact_id, normalized_reference"
require_text "${DATABASE_PREFLIGHT}" "xero_migration_020_preflight_safe"
require_text "${DATABASE_PREFLIGHT}" "Do not deploy migration 020"
require_text "${PROJECT_DIR}/migrations/020_xero_runtime_readiness_compatibility.sql" "posting_requests_actor_tenant_request_create_v030_unique_idx"
require_text "${PROJECT_DIR}/migrations/020_xero_runtime_readiness_compatibility.sql" "posting_requests_active_source_v030_unique_idx"
require_text "${PROJECT_DIR}/migrations/020_xero_runtime_readiness_compatibility.sql" "posting_requests_active_supplier_ref_v030_unique_idx"
require_text "${PROJECT_DIR}/migrations/020_xero_runtime_readiness_compatibility.sql" "posting_requests_tenant_active_supplier_ref_v030_unique_idx"
require_text "${PROJECT_DIR}/migrations/020_xero_runtime_readiness_compatibility.sql" "exact migration 016 source indexes"
require_text "${PROJECT_DIR}/migrations/020_xero_runtime_readiness_compatibility.sql" "index_meta.indisready"
require_text "${PROJECT_DIR}/migrations/020_xero_runtime_readiness_compatibility.sql" "ERRCODE = 'object_not_in_prerequisite_state'"
forbid_text "${DATABASE_PREFLIGHT}" "DELETE FROM"
forbid_text "${DATABASE_PREFLIGHT}" "UPDATE "
forbid_text "${DATABASE_PREFLIGHT}" "INSERT INTO"
forbid_text "${PROJECT_DIR}/tests/contract/expected-tools.json" "xero_authorise_supplier_bill"
forbid_text "${PROJECT_DIR}/config/tool-allowlist.json" "xero_authorise_supplier_bill"
require_text "${COMPOSE_FILE}" "read_only: true"
require_text "${COMPOSE_FILE}" "no-new-privileges:true"
require_text "${COMPOSE_FILE}" "cap_drop:"
require_text "${COMPOSE_FILE}" "internal: true"
require_text "${DEPLOY_DIR}/nginx/00-security.conf" '"$request_method $uri $server_protocol"'
require_text "${DEPLOY_DIR}/nginx/default.conf.template" "return 444;"
require_text "${COMPOSE_FILE}" "NGINX_ENVSUBST_OUTPUT_DIR: /tmp/nginx/conf.d"
require_text "${DEPLOY_DIR}/nginx/nginx.conf" "client_body_temp_path /tmp/client_temp;"
require_text "${HOST_COMPOSE_FILE}" "host_ip: 127.0.0.1"
require_text "${HOST_COMPOSE_FILE}" "quickbooks-mcp:"
require_text "${HOST_COMPOSE_FILE}" 'image: ${QUICKBOOKS_APP_IMAGE:-xero-accounting-mcp-demo:local}'
require_text "${HOST_COMPOSE_FILE}" 'published: ${QUICKBOOKS_LOOPBACK_PORT:-18003}'
require_text "${HOST_COMPOSE_FILE}" "MCP_OAUTH_BROKER_ENABLED:"
require_text "${HOST_COMPOSE_FILE}" "QUICKBOOKS_MCP_OAUTH_ENABLED:"
require_text "${COMPOSE_FILE}" "MCP_OAUTH_BROKER_ENABLED:"
require_text "${HOST_COMPOSE_FILE}" "OAUTH_MISSING_RESOURCE_COMPAT_CLIENT_IDS:"
require_text "${COMPOSE_FILE}" "OAUTH_MISSING_RESOURCE_COMPAT_CLIENT_IDS:"
require_text "${RUNBOOK}" 'QUICKBOOKS_APP_IMAGE=xero-accounting-mcp-demo:0.2.12-quickbooks-20260806'
require_text "${RUNBOOK}" 'APP_IMAGE=xero-accounting-mcp-demo:0.3.0-xero-pilot-20260810.1'
require_text "${RUNBOOK}" '/opt/xero-accounting-mcp-demo-0.3.0-20260810.1'
require_text "${RUNBOOK}" 'compose.host-nginx.green.vps.yaml'
require_text "${RUNBOOK}" '127.0.0.1:18004'
require_text "${RUNBOOK}" 'switch-xero-upstream.sh green'
require_text "${RUNBOOK}" 'switch-xero-upstream.sh blue'
require_text "${RUNBOOK}" "--format '{{json .Config.Cmd}}'"
require_text "${RUNBOOK}" "'[\"npm\",\"run\",\"start\"]'"
require_text "${RUNBOOK}" '不能承诺严格零中断'
require_text "${RUNBOOK}" '016_xero_document_type_duplicate_guards.sql'
require_text "${RUNBOOK}" '020_xero_runtime_readiness_compatibility.sql'
require_text "${RUNBOOK}" '临时兼容约束'
require_text "${RUNBOOK}" 'lock_timeout = 5s'
require_text "${RUNBOOK}" 'toolCount=44'
require_text "${RUNBOOK}" 'd2ac8c01f7a68182e3fd88edd4e5f294dd16a8f7c0fb96260f55f47a4e290224'
require_text "${ALTERNATIVE_RUNBOOK}" 'compose.host-nginx.green.vps.yaml'
require_text "${ALTERNATIVE_RUNBOOK}" '127.0.0.1:18004'
forbid_text "${ALTERNATIVE_RUNBOOK}" '只把新 App 绑定到 `127.0.0.1:18002`'
require_text "${PROJECT_DIR}/package.json" '"test:http:required": "TEST_HTTP_LOOPBACK=true vitest run tests/http-oauth-edge.test.ts"'
require_text "${PROJECT_DIR}/package.json" '"version": "0.3.0"'
require_text "${PROJECT_DIR}/src/xeroRelease.ts" 'export const XERO_RELEASE_VERSION = "0.3.0";'
command -v node >/dev/null 2>&1 || {
  echo "node is required to verify the Xero release tool contract" >&2
  exit 1
}
TOOL_CONTRACT=$(node -e '
  const crypto = require("node:crypto");
  const fs = require("node:fs");
  const tools = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const digest = crypto.createHash("sha256").update(JSON.stringify(tools)).digest("hex");
  process.stdout.write(`${tools.length} ${digest}`);
' "${PROJECT_DIR}/tests/contract/expected-tools.json")
test "${TOOL_CONTRACT}" = "44 d2ac8c01f7a68182e3fd88edd4e5f294dd16a8f7c0fb96260f55f47a4e290224" || {
  echo "unexpected Xero 0.3.0 tool contract: ${TOOL_CONTRACT}" >&2
  exit 1
}
test -f "${GREEN_COMPOSE_FILE}" || {
  echo "missing green deployment compose: ${GREEN_COMPOSE_FILE}" >&2
  exit 1
}
require_text "${GREEN_COMPOSE_FILE}" "accounting-mcp-green:"
require_text "${GREEN_COMPOSE_FILE}" 'restart: "${XERO_RESTART_POLICY:-unless-stopped}"'
require_text "${GREEN_COMPOSE_FILE}" 'published: ${GREEN_APP_LOOPBACK_PORT:-18004}'
require_text "${GREEN_COMPOSE_FILE}" 'name: ${EXISTING_EGRESS_NETWORK:-xero-accounting-mcp-demo_egress}'
require_text "${GREEN_COMPOSE_FILE}" 'name: ${EXISTING_DATA_NETWORK:-xero-accounting-mcp-demo_data}'
forbid_text "${GREEN_COMPOSE_FILE}" "quickbooks-mcp:"
forbid_text "${GREEN_COMPOSE_FILE}" "postgres:"
forbid_text "${GREEN_COMPOSE_FILE}" "nginx:"
forbid_text "${GREEN_COMPOSE_FILE}" "stock-mcp:"
forbid_text "${GREEN_COMPOSE_FILE}" "trade:"
test -f "${UPSTREAM_SWITCH}" || {
  echo "missing Xero upstream switch helper: ${UPSTREAM_SWITCH}" >&2
  exit 1
}
test -f "${UPSTREAM_SETTLE_TEST}" || {
  echo "missing Xero upstream settle test: ${UPSTREAM_SETTLE_TEST}" >&2
  exit 1
}
require_text "${UPSTREAM_SWITCH}" 'readonly BLUE_PORT="18002"'
require_text "${UPSTREAM_SWITCH}" 'readonly GREEN_PORT="18004"'
require_text "${UPSTREAM_SWITCH}" 'readonly PUBLIC_SETTLE_ATTEMPTS="3"'
require_text "${UPSTREAM_SWITCH}" 'readonly PUBLIC_SETTLE_SLEEP_SECONDS="1"'
require_text "${UPSTREAM_SWITCH}" 'readonly PUBLIC_SETTLE_CURL_MAX_TIME_SECONDS="1"'
require_text "${UPSTREAM_SWITCH}" 'settle_public_after_reload'
require_text "${UPSTREAM_SWITCH}" 'readonly BLUE_VERSION="0.2.13"'
require_text "${UPSTREAM_SWITCH}" '"503:{\"status\":\"not_ready\",\"version\":\"${BLUE_VERSION}\"}"'
require_text "${UPSTREAM_SWITCH}" 'ALLOW_BLUE_FORWARD_SCHEMA_NOT_READY:-false'
require_text "${UPSTREAM_SWITCH}" 'verify_blue_break_glass_container_read_only'
require_text "${UPSTREAM_SWITCH}" 'XERO_WRITE_ENABLED=false'
require_text "${UPSTREAM_SWITCH}" 'audit "WARNING" "BLUE_FORWARD_SCHEMA_NOT_READY_BREAK_GLASS"'
require_text "${UPSTREAM_SWITCH}" 'nginx -t'
require_text "${UPSTREAM_SWITCH}" 'systemctl reload nginx'
require_text "${UPSTREAM_SWITCH}" 'usage: %s {status|green|blue}'
require_text "${UPSTREAM_SWITCH}" 'check_quickbooks_public'
require_text "${UPSTREAM_SWITCH}" 'QUICKBOOKS_PUBLIC_PREFLIGHT_FAILED'
require_text "${UPSTREAM_SWITCH}" 'QUICKBOOKS_PUBLIC_CHECK_FAILED_AND_UPSTREAM_RESTORED'
require_text "${UPSTREAM_SWITCH}" 'QUICKBOOKS_PUBLIC_CHECK_FAILED_AND_UPSTREAM_RESTORE_FAILED'
require_text "${UPSTREAM_SWITCH}" 'PUBLIC_CHECK_FAILED_AND_UPSTREAM_RESTORE_FAILED'
require_text "${UPSTREAM_SWITCH}" 'NGINX_CONFIG_REJECTED_AND_UPSTREAM_RESTORE_FAILED'
require_text "${UPSTREAM_SWITCH}" 'NGINX_RELOAD_FAILED_AND_UPSTREAM_RESTORED'
require_text "${UPSTREAM_SWITCH}" 'NGINX_RELOAD_FAILED_AND_UPSTREAM_RESTORE_FAILED'
require_text "${RUNBOOK}" 'ERROR=NGINX_RELOAD_FAILED_AND_UPSTREAM_RESTORED'
require_text "${RUNBOOK}" 'WARNING=BLUE_FORWARD_SCHEMA_NOT_READY_BREAK_GLASS'
require_text "${RUNBOOK}" 'ALLOW_BLUE_FORWARD_SCHEMA_NOT_READY=true'
require_text "${RUNBOOK}" 'migration 020 成功后常规回滚必须拿到 200 ready'
require_text "${RUNBOOK}" '任何其他状态码、字段、版本或 body 都 fail-closed'
require_text "${RUNBOOK}" '配置等待上限为 14 秒'
require_text "${RUNBOOK}" '目标已经 active 时不发生 reload'
require_text "${RUNBOOK}" 'npm run test:http:required'
forbid_text "${RUNBOOK}" 'build --pull quickbooks-mcp'
forbid_text "${RUNBOOK}" 'run --rm --no-deps quickbooks-mcp npm run migrate'
forbid_text "${RUNBOOK}" 'up -d --no-build quickbooks-mcp'
forbid_text "${RUNBOOK}" 'up -d postgres'
forbid_text "${RUNBOOK}" 'ufw allow'
forbid_text "${RUNBOOK}" 'iptables '
forbid_text "${RUNBOOK}" 'systemctl restart ssh'
require_text "${RUNBOOK}" 'XERO_WRITE_ENABLED=false'
require_text "${RUNBOOK}" 'AUTOCLOSE_DELAY="15m"'
require_text "${RUNBOOK}" 'XERO_ALLOWED_TENANT_ID=7c3cc738-eef0-4d4e-83f8-d528390e1e61'
require_text "${RUNBOOK}" "http://127.0.0.1:18003/healthz"
require_text "${HOST_NGINX_SITE}" "server_name mcp.jiayuanwang.xyz;"
require_text "${HOST_NGINX_SITE}" "return 308 https://mcp.jiayuanwang.xyz\$request_uri;"
require_text "${HOST_NGINX_SITE}" "ssl_certificate /etc/letsencrypt/live/mcp.jiayuanwang.xyz/fullchain.pem;"
require_text "${HOST_NGINX_SITE}" "access_log /var/log/nginx/mcp.jiayuanwang.xyz.access.log xero_mcp_redacted;"
require_text "${HOST_NGINX_SITE}" "server 127.0.0.1:18002;"
require_text "${HOST_NGINX_SITE}" "server 127.0.0.1:18003;"
require_text "${HOST_NGINX_SITE}" '"$request_method $uri $server_protocol"'
require_text "${HOST_NGINX_SITE}" "form-action 'self' https://agent2.zcloak.ai/api/mcp/accounting-mcp/oauth/callback"
require_text "${HOST_NGINX_SITE}" 'map "$arg_client_id:$arg_code_challenge_method" $xero_authorize_pkce_suffix {'
require_text "${HOST_NGINX_SITE}" '"agent2-xero-bd0796db041ee01e:" "&code_challenge_method=S256";'
require_text "${HOST_NGINX_SITE}" 'set $xero_authorize_upstream_args "$args$xero_authorize_pkce_suffix";'
require_text "${HOST_NGINX_SITE}" 'proxy_pass http://xero_accounting_mcp_demo/authorize?$xero_authorize_upstream_args;'
require_text "${HOST_NGINX_SITE}" "location = /authorize"
require_text "${HOST_NGINX_SITE}" "location = /token"
require_text "${HOST_NGINX_SITE}" "location = /revoke"
require_text "${HOST_NGINX_SITE}" "location = /.well-known/oauth-protected-resource/mcp"
require_text "${HOST_NGINX_SITE}" "location = /oauth/xero/callback"
require_text "${HOST_NGINX_SITE}" "location = /oauth/xero/select"
require_text "${HOST_NGINX_SITE}" "location = /xero/organisation-switch"
require_text "${HOST_NGINX_SITE}" "location = /quickbooks/mcp"
require_text "${HOST_NGINX_SITE}" "location = /.well-known/oauth-protected-resource/quickbooks/mcp"
require_text "${HOST_NGINX_SITE}" "location = /.well-known/oauth-authorization-server/quickbooks"
require_text "${HOST_NGINX_SITE}" "location = /.well-known/oauth-authorization-server/quickbooks/oauth"
require_text "${HOST_NGINX_SITE}" "location = /quickbooks/oauth/revoke"
require_text "${HOST_NGINX_SITE}" "location = /quickbooks/oauth/authorize"
require_text "${HOST_NGINX_SITE}" "location = /quickbooks/oauth/token"
require_text "${HOST_NGINX_SITE}" "location = /oauth/quickbooks/callback"
require_text "${HOST_NGINX_BOOTSTRAP}" "server_name mcp.jiayuanwang.xyz;"
require_text "${HOST_NGINX_BOOTSTRAP}" "root /var/www/xero-mcp-certbot;"
require_text "${DEPLOY_DIR}/nginx/default.conf.template" "location = /authorize"
require_text "${DEPLOY_DIR}/nginx/default.conf.template" "location = /token"
require_text "${DEPLOY_DIR}/nginx/default.conf.template" "location = /revoke"
require_text "${DEPLOY_DIR}/nginx/default.conf.template" "location = /.well-known/oauth-protected-resource/mcp"
require_text "${DEPLOY_DIR}/nginx/default.conf.template" "location = /oauth/xero/callback"
require_text "${DEPLOY_DIR}/nginx/default.conf.template" "location = /oauth/xero/select"
require_text "${DEPLOY_DIR}/nginx/default.conf.template" "location = /xero/organisation-switch"
require_text "${DEPLOY_DIR}/nginx/default.conf.template" "form-action 'self' https://agent2.zcloak.ai/api/mcp/accounting-mcp/oauth/callback"
forbid_text "${HOST_NGINX_SITE}" "location = /connect/xero"
forbid_text "${DEPLOY_DIR}/nginx/default.conf.template" "location = /connect/xero"
forbid_text "${HOST_NGINX_SITE}" "/operator/session"
forbid_text "${HOST_NGINX_SITE}" "/oauth/xero/start"
forbid_text "${DEPLOY_DIR}/nginx/default.conf.template" "/operator/session"
forbid_text "${DEPLOY_DIR}/nginx/default.conf.template" "/oauth/xero/start"

require_text "${UAT_WRITE_GATE}" 'readonly RELEASE_DIR="/opt/xero-accounting-mcp-demo-0.3.0-20260810.1"'
require_text "${UAT_WRITE_GATE}" 'readonly EXPECTED_IMAGE_REF="xero-accounting-mcp-demo:0.3.0-xero-pilot-20260810.1"'
require_text "${UAT_WRITE_GATE}" 'readonly EXPECTED_VERSION="0.3.0"'
require_text "${UAT_WRITE_GATE}" 'readonly EXPECTED_TOOL_COUNT="44"'
require_text "${UAT_WRITE_GATE}" 'readonly EXPECTED_TOOLSET_HASH="d2ac8c01f7a68182e3fd88edd4e5f294dd16a8f7c0fb96260f55f47a4e290224"'
require_text "${UAT_WRITE_GATE}" 'readonly EXPECTED_LOOPBACK_BASE_URL="http://127.0.0.1:18004"'
require_text "${UAT_WRITE_GATE}" 'readonly GREEN_PROJECT_NAME="xero-accounting-mcp-green-030"'
require_text "${UAT_WRITE_GATE}" 'readonly GREEN_COMPOSE_FILE="deploy/docker-compose/compose.host-nginx.green.vps.yaml"'
require_text "${UAT_WRITE_GATE}" 'readonly AUTOCLOSE_UNIT="xero-write-gate-autoclose-030-20260810-1"'
require_text "${UAT_WRITE_GATE}" 'readonly BOOT_FAILSAFE_UNIT="xero-write-gate-boot-close-030-20260810-1.service"'
require_text "${UAT_WRITE_GATE}" 'readonly BOOT_FAILSAFE_SCRIPT="/usr/local/sbin/xero-agent2-uat-write-gate-030-20260810-1"'
require_text "${UAT_WRITE_GATE}" 'readonly BOOT_FAILSAFE_WANTS_LINK="/etc/systemd/system/nginx.service.wants/${BOOT_FAILSAFE_UNIT}"'
require_text "${UAT_WRITE_GATE}" 'readonly LEGACY_BOOT_FAILSAFE_REQUIRES_LINK="/etc/systemd/system/nginx.service.requires/${BOOT_FAILSAFE_UNIT}"'
require_text "${UAT_WRITE_GATE}" 'readonly AUTOCLOSE_DELAY="15m"'
require_text "${UAT_WRITE_GATE}" 'readonly RETRY_DELAY="15s"'
require_text "${UAT_WRITE_GATE}" 'readonly RETRY_WINDOW="15min"'
require_text "${UAT_WRITE_GATE}" 'readonly RETRY_START_LIMIT_BURST="4"'
require_text "${UAT_WRITE_GATE}" 'readonly TEST_TENANT_ID="7c3cc738-eef0-4d4e-83f8-d528390e1e61"'
require_text "${UAT_WRITE_GATE}" 'green_compose up -d'
require_text "${UAT_WRITE_GATE}" 'accounting-mcp-green'
require_text "${UAT_WRITE_GATE}" "Before=nginx.service"
require_text "${UAT_WRITE_GATE}" "After=docker.service"
require_text "${UAT_WRITE_GATE}" 'StartLimitIntervalSec=${RETRY_WINDOW}'
require_text "${UAT_WRITE_GATE}" 'StartLimitBurst=${RETRY_START_LIMIT_BURST}'
require_text "${UAT_WRITE_GATE}" 'Restart=on-failure'
require_text "${UAT_WRITE_GATE}" 'RestartSec=${RETRY_DELAY}'
require_text "${UAT_WRITE_GATE}" "WantedBy=nginx.service"
forbid_text "${UAT_WRITE_GATE}" "RequiredBy=nginx.service"
require_text "${UAT_WRITE_GATE}" 'Environment=BOOT_FAILSAFE_SCRIPT_SHA256=${script_sha256}'
require_text "${UAT_WRITE_GATE}" 'ExecStart=${BOOT_FAILSAFE_SCRIPT} boot-close'
require_text "${UAT_WRITE_GATE}" 'systemctl is-enabled --quiet "$BOOT_FAILSAFE_UNIT"'
require_text "${UAT_WRITE_GATE}" 'systemctl is-active --quiet "$BOOT_FAILSAFE_UNIT"'
require_text "${UAT_WRITE_GATE}" 'XERO_RESTART_POLICY="$restart_policy" XERO_WRITE_ENABLED="$write_enabled" green_compose up -d'
require_text "${UAT_WRITE_GATE}" 'recreate_xero "true" "no"'
require_text "${UAT_WRITE_GATE}" 'recreate_xero "false" "unless-stopped"'
require_text "${UAT_WRITE_GATE}" '--property=Restart=on-failure'
require_text "${UAT_WRITE_GATE}" '--property=RestartSec="$RETRY_DELAY"'
require_text "${UAT_WRITE_GATE}" '--property=StartLimitIntervalSec="$RETRY_WINDOW"'
require_text "${UAT_WRITE_GATE}" '--property=StartLimitBurst="$RETRY_START_LIMIT_BURST"'
require_text "${UAT_WRITE_GATE}" '--setenv=XERO_RESTART_POLICY=unless-stopped'
require_text "${UAT_WRITE_GATE}" 'verify_autoclose_schedule'
require_text "${UAT_WRITE_GATE}" 'AUTOCLOSE_SERVICE_RESTART_NOT_ON_FAILURE'
require_text "${UAT_WRITE_GATE}" 'AUTOCLOSE_SERVICE_START_LIMIT_BURST_MISMATCH'
require_text "${UAT_WRITE_GATE}" 'AUTOCLOSE_TIMER_TRIGGER_MISMATCH'
require_text "${UAT_WRITE_GATE}" 'audit "AUTOCLOSE_RETRY"'
forbid_text "${UAT_WRITE_GATE}" 'docker update --restart='
require_text "${UAT_WRITE_GATE}" 'verify_xero_restart_policy "no"'
require_text "${UAT_WRITE_GATE}" 'verify_xero_restart_policy "unless-stopped"'
require_text "${UAT_WRITE_GATE}" 'remove_legacy_required_link'
require_text "${UAT_WRITE_GATE}" 'LEGACY_BOOT_FAILSAFE_REQUIRES_LINK_POINTS_ELSEWHERE'
require_text "${UAT_WRITE_GATE}" 'install-failsafe) install_boot_failsafe ;;'
require_text "${UAT_WRITE_GATE}" 'preflight) preflight ;;'
require_text "${UAT_WRITE_GATE}" 'boot-close) boot_close_gate ;;'
require_text "${UAT_WRITE_GATE}" 'usage: %s {install-failsafe|preflight|open|close|status}'
require_text "${UAT_WRITE_GATE}" 'AND a.workspace_id = i.workspace_id'
require_text "${UAT_WRITE_GATE}" 'allowed_binding.authorization_id = other_connection.authorization_id'
forbid_text "${UAT_WRITE_GATE}" 'other_connection.authorization_id NOT IN ('
forbid_text "${UAT_WRITE_GATE}" "(SELECT count(*) FROM provider_connections"
forbid_text "${UAT_WRITE_GATE}" "0.2.13"
forbid_text "${UAT_WRITE_GATE}" 'main_compose up'
forbid_text "${UAT_WRITE_GATE}" 'main_compose down'
forbid_text "${UAT_WRITE_GATE}" 'main_compose restart'
forbid_text "${UAT_WRITE_GATE}" 'main_compose stop'
forbid_text "${UAT_WRITE_GATE}" 'main_compose rm'
forbid_text "${UAT_WRITE_GATE}" 'docker compose down'

sh -n "${SCRIPT_DIR}/verify-static.sh"
sh -n "${SCRIPT_DIR}/install-renewed-cert.sh"
sh -n "${UPSTREAM_SWITCH}"
sh -n "${UPSTREAM_SETTLE_TEST}"
sh -n "${DEPLOY_DIR}/host-nginx/certbot-deploy-hook.sh"
bash -n "${UAT_WRITE_GATE}"

sh "${UPSTREAM_SETTLE_TEST}" "${UPSTREAM_SWITCH}"

# Exercise the public switch command with a failed first Nginx reload. The
# fixture runs a copied script against a temporary site and command shims; it
# must exit non-zero, restore the blue site on disk, and reload that restored
# configuration once. No host Nginx or Docker resource is touched.
SWITCH_RELOAD_TEST_DIR=$(mktemp -d "${TMPDIR:-/tmp}/xero-switch-reload.XXXXXX")
SWITCH_RELOAD_TEST_BIN="${SWITCH_RELOAD_TEST_DIR}/bin"
SWITCH_RELOAD_TEST_SITE="${SWITCH_RELOAD_TEST_DIR}/mcp.jiayuanwang.xyz"
SWITCH_RELOAD_TEST_SCRIPT="${SWITCH_RELOAD_TEST_DIR}/switch-xero-upstream.sh"
SWITCH_RELOAD_TEST_OUTPUT="${SWITCH_RELOAD_TEST_DIR}/output"
mkdir -p "${SWITCH_RELOAD_TEST_BIN}"

cat >"${SWITCH_RELOAD_TEST_SITE}" <<'EOF'
upstream xero_accounting_mcp_demo {
    server 127.0.0.1:18002;
}
upstream quickbooks_accounting_mcp_demo {
    server 127.0.0.1:18003;
}
EOF

sed \
  -e "s|^readonly LOCK_FILE=.*|readonly LOCK_FILE=\"${SWITCH_RELOAD_TEST_DIR}/switch.lock\"|" \
  -e "s|^readonly BACKUP_DIR=.*|readonly BACKUP_DIR=\"${SWITCH_RELOAD_TEST_DIR}/backups\"|" \
  "${UPSTREAM_SWITCH}" >"${SWITCH_RELOAD_TEST_SCRIPT}"
chmod 700 "${SWITCH_RELOAD_TEST_SCRIPT}"

cat >"${SWITCH_RELOAD_TEST_BIN}/flock" <<'EOF'
#!/bin/sh
exit 0
EOF
cat >"${SWITCH_RELOAD_TEST_BIN}/nginx" <<'EOF'
#!/bin/sh
test "${1:-}" = "-t"
count_file="${SWITCH_TEST_STATE_DIR:?}/nginx-test-count"
count=0
test ! -f "$count_file" || count=$(cat "$count_file")
count=$((count + 1))
printf '%s\n' "$count" >"$count_file"
EOF
cat >"${SWITCH_RELOAD_TEST_BIN}/systemctl" <<'EOF'
#!/bin/sh
test "${1:-}" = "reload" && test "${2:-}" = "nginx" || exit 64
count_file="${SWITCH_TEST_STATE_DIR:?}/reload-count"
count=0
test ! -f "$count_file" || count=$(cat "$count_file")
count=$((count + 1))
printf '%s\n' "$count" >"$count_file"
test "$count" -ne 1
EOF
cat >"${SWITCH_RELOAD_TEST_BIN}/curl" <<'EOF'
#!/bin/sh
for argument do url=$argument; done
case "$url" in
  */quickbooks/healthz) printf '%s' '{"status":"ok","provider":"quickbooks-online"}' ;;
  */quickbooks/readyz) printf '%s' '{"status":"ready"}' ;;
  *:18004/healthz|*/healthz)
    printf '%s' '{"status":"ok","version":"0.3.0","toolCount":44,"toolsetHash":"d2ac8c01f7a68182e3fd88edd4e5f294dd16a8f7c0fb96260f55f47a4e290224"}'
    ;;
  *:18004/readyz|*/readyz) printf '%s' '{"status":"ready","version":"0.3.0"}' ;;
  *) exit 65 ;;
esac
EOF
cat >"${SWITCH_RELOAD_TEST_BIN}/install" <<'EOF'
#!/bin/sh
for argument do target=$argument; done
mkdir -p "$target"
EOF
cat >"${SWITCH_RELOAD_TEST_BIN}/cp" <<'EOF'
#!/bin/sh
source_path=
target_path=
for argument do
  case "$argument" in
    --|--preserve=*) ;;
    *)
      if test -z "$source_path"; then source_path=$argument; else target_path=$argument; fi
      ;;
  esac
done
/bin/cp "$source_path" "$target_path"
EOF
cat >"${SWITCH_RELOAD_TEST_BIN}/chown" <<'EOF'
#!/bin/sh
exit 0
EOF
cat >"${SWITCH_RELOAD_TEST_BIN}/chmod" <<'EOF'
#!/bin/sh
case "${1:-}" in
  --reference=*) /bin/chmod 600 "$2" ;;
  *) /bin/chmod "$@" ;;
esac
EOF
cat >"${SWITCH_RELOAD_TEST_BIN}/mv" <<'EOF'
#!/bin/sh
source_path=
target_path=
for argument do
  case "$argument" in
    -f|--) ;;
    *)
      if test -z "$source_path"; then source_path=$argument; else target_path=$argument; fi
      ;;
  esac
done
/bin/mv -f "$source_path" "$target_path"
EOF
chmod 700 "${SWITCH_RELOAD_TEST_BIN}"/*

if env \
  PATH="${SWITCH_RELOAD_TEST_BIN}:/usr/bin:/bin:/usr/sbin:/sbin" \
  SWITCH_TEST_STATE_DIR="${SWITCH_RELOAD_TEST_DIR}" \
  XERO_NGINX_SITE_FILE="${SWITCH_RELOAD_TEST_SITE}" \
  "${SWITCH_RELOAD_TEST_SCRIPT}" green >"${SWITCH_RELOAD_TEST_OUTPUT}" 2>&1; then
  echo "upstream switch unexpectedly succeeded after an injected Nginx reload failure" >&2
  rm -rf "${SWITCH_RELOAD_TEST_DIR}"
  exit 1
fi
require_text "${SWITCH_RELOAD_TEST_SITE}" "server 127.0.0.1:18002;"
forbid_text "${SWITCH_RELOAD_TEST_SITE}" "server 127.0.0.1:18004;"
require_text "${SWITCH_RELOAD_TEST_OUTPUT}" "ERROR=NGINX_RELOAD_FAILED_AND_UPSTREAM_RESTORED"
test "$(cat "${SWITCH_RELOAD_TEST_DIR}/reload-count")" = "2" || {
  echo "reload failure injection did not attempt exactly one restored-config reload" >&2
  rm -rf "${SWITCH_RELOAD_TEST_DIR}"
  exit 1
}
test "$(cat "${SWITCH_RELOAD_TEST_DIR}/nginx-test-count")" = "2" || {
  echo "reload failure injection did not validate both target and restored Nginx configurations" >&2
  rm -rf "${SWITCH_RELOAD_TEST_DIR}"
  exit 1
}
rm -rf "${SWITCH_RELOAD_TEST_DIR}"

# Exercise the explicit forward-schema emergency rollback path. Normal blue
# rollback requires 200 ready after migration 020. The exact known 0.2.13 503 is
# accepted only with explicit break-glass plus live-container read-only proof;
# QuickBooks remains a mandatory preflight/postflight check.
SWITCH_BLUE_COMPAT_TEST_DIR=$(mktemp -d "${TMPDIR:-/tmp}/xero-switch-blue-compat.XXXXXX")
SWITCH_BLUE_COMPAT_TEST_BIN="${SWITCH_BLUE_COMPAT_TEST_DIR}/bin"
SWITCH_BLUE_COMPAT_TEST_SITE="${SWITCH_BLUE_COMPAT_TEST_DIR}/mcp.jiayuanwang.xyz"
SWITCH_BLUE_COMPAT_TEST_SCRIPT="${SWITCH_BLUE_COMPAT_TEST_DIR}/switch-xero-upstream.sh"
SWITCH_BLUE_COMPAT_TEST_OUTPUT="${SWITCH_BLUE_COMPAT_TEST_DIR}/output"
mkdir -p "${SWITCH_BLUE_COMPAT_TEST_BIN}"

cat >"${SWITCH_BLUE_COMPAT_TEST_SITE}" <<'EOF'
upstream xero_accounting_mcp_demo {
    server 127.0.0.1:18004;
}
upstream quickbooks_accounting_mcp_demo {
    server 127.0.0.1:18003;
}
EOF

sed \
  -e "s|^readonly LOCK_FILE=.*|readonly LOCK_FILE=\"${SWITCH_BLUE_COMPAT_TEST_DIR}/switch.lock\"|" \
  -e "s|^readonly BACKUP_DIR=.*|readonly BACKUP_DIR=\"${SWITCH_BLUE_COMPAT_TEST_DIR}/backups\"|" \
  "${UPSTREAM_SWITCH}" >"${SWITCH_BLUE_COMPAT_TEST_SCRIPT}"
chmod 700 "${SWITCH_BLUE_COMPAT_TEST_SCRIPT}"

cat >"${SWITCH_BLUE_COMPAT_TEST_BIN}/flock" <<'EOF'
#!/bin/sh
exit 0
EOF
cat >"${SWITCH_BLUE_COMPAT_TEST_BIN}/nginx" <<'EOF'
#!/bin/sh
test "${1:-}" = "-t" || exit 64
count_file="${SWITCH_TEST_STATE_DIR:?}/nginx-test-count-blue-compat"
count=0
test ! -f "$count_file" || count=$(cat "$count_file")
count=$((count + 1))
printf '%s\n' "$count" >"$count_file"
case ",${SWITCH_NGINX_FAIL_TESTS:-}," in
  *,"$count",*) exit 1 ;;
esac
EOF
cat >"${SWITCH_BLUE_COMPAT_TEST_BIN}/systemctl" <<'EOF'
#!/bin/sh
test "${1:-}" = "reload" && test "${2:-}" = "nginx" || exit 64
count_file="${SWITCH_TEST_STATE_DIR:?}/systemctl-reload-count-blue-compat"
count=0
test ! -f "$count_file" || count=$(cat "$count_file")
count=$((count + 1))
printf '%s\n' "$count" >"$count_file"
case ",${SWITCH_SYSTEMCTL_FAIL_RELOADS:-}," in
  *,"$count",*) exit 1 ;;
esac
EOF
cat >"${SWITCH_BLUE_COMPAT_TEST_BIN}/curl" <<'EOF'
#!/bin/sh
fail_on_http=false
output_file=
write_out=
url=
while test "$#" -gt 0; do
  case "$1" in
    -f|-*f*) fail_on_http=true ;;
    -o|--output) shift; output_file=${1:?} ;;
    -w|--write-out) shift; write_out=${1:?} ;;
    http://*|https://*) url=$1 ;;
  esac
  shift
done

case "$url" in
  */quickbooks/healthz)
    count_file="${SWITCH_TEST_STATE_DIR:?}/quickbooks-health-count"
    count=0
    test ! -f "$count_file" || count=$(cat "$count_file")
    printf '%s\n' "$((count + 1))" >"$count_file"
    status=${SWITCH_QB_HEALTH_STATUS:-200}
    body=${SWITCH_QB_HEALTH_BODY:-'{"status":"ok","provider":"quickbooks-online"}'}
    ;;
  */quickbooks/readyz)
    count_file="${SWITCH_TEST_STATE_DIR:?}/quickbooks-ready-count"
    count=0
    test ! -f "$count_file" || count=$(cat "$count_file")
    printf '%s\n' "$((count + 1))" >"$count_file"
    status=${SWITCH_QB_READY_STATUS:-200}
    body=${SWITCH_QB_READY_BODY:-'{"status":"ready"}'}
    case ",${SWITCH_QB_READY_FAIL_CALLS:-}," in
      *,"$((count + 1))",*)
        status=503
        body='{"status":"not_ready"}'
        ;;
    esac
    ;;
  *:18004/healthz)
    status=200
    body='{"status":"ok","version":"0.3.0","toolCount":44,"toolsetHash":"d2ac8c01f7a68182e3fd88edd4e5f294dd16a8f7c0fb96260f55f47a4e290224"}'
    ;;
  *:18004/readyz)
    status=${SWITCH_GREEN_READY_STATUS:-200}
    body=${SWITCH_GREEN_READY_BODY:-'{"status":"ready","version":"0.3.0"}'}
    ;;
  *:18002/healthz|*/healthz)
    status=${SWITCH_BLUE_HEALTH_STATUS:-200}
    body="{\"status\":\"ok\",\"version\":\"${SWITCH_BLUE_HEALTH_VERSION:-0.2.13}\",\"toolCount\":15}"
    ;;
  *:18002/readyz)
    status=${SWITCH_BLUE_LOOPBACK_READY_STATUS:-${SWITCH_BLUE_READY_STATUS:-503}}
    body=${SWITCH_BLUE_LOOPBACK_READY_BODY:-${SWITCH_BLUE_READY_BODY:-'{"status":"not_ready","version":"0.2.13"}'}}
    ;;
  */readyz)
    status=${SWITCH_BLUE_PUBLIC_READY_STATUS:-${SWITCH_BLUE_READY_STATUS:-503}}
    body=${SWITCH_BLUE_PUBLIC_READY_BODY:-${SWITCH_BLUE_READY_BODY:-'{"status":"not_ready","version":"0.2.13"}'}}
    ;;
  *) exit 65 ;;
esac

if test "$fail_on_http" = true && test "$status" -ge 400; then
  exit 22
fi
if test -n "$output_file"; then
  printf '%s' "$body" >"$output_file"
else
  printf '%s' "$body"
fi
case "$write_out" in
  '') ;;
  '%{http_code}') printf '%s' "$status" ;;
  '\n%{http_code}') printf '\n%s' "$status" ;;
  *) exit 66 ;;
esac
EOF
cat >"${SWITCH_BLUE_COMPAT_TEST_BIN}/install" <<'EOF'
#!/bin/sh
for argument do target=$argument; done
mkdir -p "$target"
EOF
cat >"${SWITCH_BLUE_COMPAT_TEST_BIN}/cp" <<'EOF'
#!/bin/sh
source_path=
target_path=
for argument do
  case "$argument" in
    --|--preserve=*) ;;
    *)
      if test -z "$source_path"; then source_path=$argument; else target_path=$argument; fi
      ;;
  esac
done
/bin/cp "$source_path" "$target_path"
EOF
cat >"${SWITCH_BLUE_COMPAT_TEST_BIN}/chown" <<'EOF'
#!/bin/sh
exit 0
EOF
cat >"${SWITCH_BLUE_COMPAT_TEST_BIN}/chmod" <<'EOF'
#!/bin/sh
case "${1:-}" in
  --reference=*) /bin/chmod 600 "$2" ;;
  *) /bin/chmod "$@" ;;
esac
EOF
cat >"${SWITCH_BLUE_COMPAT_TEST_BIN}/mv" <<'EOF'
#!/bin/sh
source_path=
target_path=
for argument do
  case "$argument" in
    -f|--) ;;
    *)
      if test -z "$source_path"; then source_path=$argument; else target_path=$argument; fi
      ;;
  esac
done
/bin/mv -f "$source_path" "$target_path"
EOF
chmod 700 "${SWITCH_BLUE_COMPAT_TEST_BIN}"/*

# A 503 is never part of the normal rollback path. Without an explicit
# break-glass opt-in it must fail before changing the active upstream.
if env \
  PATH="${SWITCH_BLUE_COMPAT_TEST_BIN}:/usr/bin:/bin:/usr/sbin:/sbin" \
  SWITCH_TEST_STATE_DIR="${SWITCH_BLUE_COMPAT_TEST_DIR}" \
  XERO_NGINX_SITE_FILE="${SWITCH_BLUE_COMPAT_TEST_SITE}" \
  "${SWITCH_BLUE_COMPAT_TEST_SCRIPT}" blue >/dev/null 2>&1; then
  echo "blue rollback accepted 503 not_ready without break-glass opt-in" >&2
  rm -rf "${SWITCH_BLUE_COMPAT_TEST_DIR}"
  exit 1
fi
require_text "${SWITCH_BLUE_COMPAT_TEST_SITE}" "server 127.0.0.1:18004;"
forbid_text "${SWITCH_BLUE_COMPAT_TEST_SITE}" "server 127.0.0.1:18002;"

# Opt-in alone is insufficient: the live blue container and its exact loopback
# binding/write-disabled environment must be proven or the script fails closed.
cat >"${SWITCH_BLUE_COMPAT_TEST_BIN}/docker" <<'EOF'
#!/bin/sh
exit 127
EOF
chmod 700 "${SWITCH_BLUE_COMPAT_TEST_BIN}/docker"
if env \
  PATH="${SWITCH_BLUE_COMPAT_TEST_BIN}:/usr/bin:/bin:/usr/sbin:/sbin" \
  SWITCH_TEST_STATE_DIR="${SWITCH_BLUE_COMPAT_TEST_DIR}" \
  ALLOW_BLUE_FORWARD_SCHEMA_NOT_READY=true \
  XERO_NGINX_SITE_FILE="${SWITCH_BLUE_COMPAT_TEST_SITE}" \
  "${SWITCH_BLUE_COMPAT_TEST_SCRIPT}" blue >/dev/null 2>&1; then
  echo "blue break-glass rollback succeeded without proving its container is read-only" >&2
  rm -rf "${SWITCH_BLUE_COMPAT_TEST_DIR}"
  exit 1
fi
require_text "${SWITCH_BLUE_COMPAT_TEST_SITE}" "server 127.0.0.1:18004;"
forbid_text "${SWITCH_BLUE_COMPAT_TEST_SITE}" "server 127.0.0.1:18002;"

cat >"${SWITCH_BLUE_COMPAT_TEST_BIN}/docker" <<'EOF'
#!/bin/sh
command_name=${1:-}
shift || true
case "$command_name" in
  ps)
    case " $* " in
      *' --filter label=com.docker.compose.service=accounting-mcp '*) ;;
      *) exit 71 ;;
    esac
    case " $* " in
      *' --filter publish=18002 '*) ;;
      *) exit 72 ;;
    esac
    count_file="${SWITCH_TEST_STATE_DIR:?}/docker-ps-count"
    count=0
    test ! -f "$count_file" || count=$(cat "$count_file")
    printf '%s\n' "$((count + 1))" >"$count_file"
    printf '%s\n' "${SWITCH_BLUE_CONTAINER_IDS:-blue-container-id}"
    ;;
  inspect)
    format=
    container_id=
    while test "$#" -gt 0; do
      case "$1" in
        --format) shift; format=${1:?} ;;
        *) container_id=$1 ;;
      esac
      shift
    done
    test "$container_id" = "blue-container-id" || exit 73
    case "$format" in
      *'.State.Running'*) printf '%s' "${SWITCH_BLUE_CONTAINER_RUNNING:-true}" ;;
      *'.NetworkSettings.Ports'*)
        printf '%s' "${SWITCH_BLUE_CONTAINER_BINDINGS:-3000/tcp|127.0.0.1|18002}"
        ;;
      *'.Config.Env'*)
        printf '%s\n' 'NODE_ENV=production'
        if test "${SWITCH_BLUE_CONTAINER_WRITE_SETTING:-false}" != "missing"; then
          printf 'XERO_WRITE_ENABLED=%s\n' "${SWITCH_BLUE_CONTAINER_WRITE_SETTING:-false}"
        fi
        ;;
      *) exit 74 ;;
    esac
    ;;
  *) exit 70 ;;
esac
EOF
chmod 700 "${SWITCH_BLUE_COMPAT_TEST_BIN}/docker"

if env \
  PATH="${SWITCH_BLUE_COMPAT_TEST_BIN}:/usr/bin:/bin:/usr/sbin:/sbin" \
  SWITCH_TEST_STATE_DIR="${SWITCH_BLUE_COMPAT_TEST_DIR}" \
  ALLOW_BLUE_FORWARD_SCHEMA_NOT_READY=true \
  SWITCH_BLUE_CONTAINER_WRITE_SETTING=true \
  XERO_NGINX_SITE_FILE="${SWITCH_BLUE_COMPAT_TEST_SITE}" \
  "${SWITCH_BLUE_COMPAT_TEST_SCRIPT}" blue >/dev/null 2>&1; then
  echo "blue break-glass rollback accepted XERO_WRITE_ENABLED=true" >&2
  rm -rf "${SWITCH_BLUE_COMPAT_TEST_DIR}"
  exit 1
fi
if env \
  PATH="${SWITCH_BLUE_COMPAT_TEST_BIN}:/usr/bin:/bin:/usr/sbin:/sbin" \
  SWITCH_TEST_STATE_DIR="${SWITCH_BLUE_COMPAT_TEST_DIR}" \
  ALLOW_BLUE_FORWARD_SCHEMA_NOT_READY=true \
  SWITCH_BLUE_CONTAINER_BINDINGS='3000/tcp|0.0.0.0|18002' \
  XERO_NGINX_SITE_FILE="${SWITCH_BLUE_COMPAT_TEST_SITE}" \
  "${SWITCH_BLUE_COMPAT_TEST_SCRIPT}" blue >/dev/null 2>&1; then
  echo "blue break-glass rollback accepted a non-loopback 18002 binding" >&2
  rm -rf "${SWITCH_BLUE_COMPAT_TEST_DIR}"
  exit 1
fi
if env \
  PATH="${SWITCH_BLUE_COMPAT_TEST_BIN}:/usr/bin:/bin:/usr/sbin:/sbin" \
  SWITCH_TEST_STATE_DIR="${SWITCH_BLUE_COMPAT_TEST_DIR}" \
  ALLOW_BLUE_FORWARD_SCHEMA_NOT_READY=true \
  SWITCH_BLUE_CONTAINER_IDS="$(printf 'blue-container-id\nsecond-container-id')" \
  XERO_NGINX_SITE_FILE="${SWITCH_BLUE_COMPAT_TEST_SITE}" \
  "${SWITCH_BLUE_COMPAT_TEST_SCRIPT}" blue >/dev/null 2>&1; then
  echo "blue break-glass rollback accepted ambiguous 18002 container ownership" >&2
  rm -rf "${SWITCH_BLUE_COMPAT_TEST_DIR}"
  exit 1
fi

# Every post-mutation restore path must report success only if the saved site
# validates, reloads, and contains the original upstream. These injections make
# the target config restore itself fail at each audited call site.
SWITCH_BLUE_NGINX_RESTORE_FAILURE_OUTPUT="${SWITCH_BLUE_COMPAT_TEST_DIR}/nginx-restore-failure-output"
if env \
  PATH="${SWITCH_BLUE_COMPAT_TEST_BIN}:/usr/bin:/bin:/usr/sbin:/sbin" \
  SWITCH_TEST_STATE_DIR="${SWITCH_BLUE_COMPAT_TEST_DIR}" \
  ALLOW_BLUE_FORWARD_SCHEMA_NOT_READY=true \
  SWITCH_NGINX_FAIL_TESTS=1,2 \
  XERO_NGINX_SITE_FILE="${SWITCH_BLUE_COMPAT_TEST_SITE}" \
  "${SWITCH_BLUE_COMPAT_TEST_SCRIPT}" blue >"${SWITCH_BLUE_NGINX_RESTORE_FAILURE_OUTPUT}" 2>&1; then
  echo "blue switch succeeded after target and restored Nginx configs were rejected" >&2
  rm -rf "${SWITCH_BLUE_COMPAT_TEST_DIR}"
  exit 1
fi
require_text "${SWITCH_BLUE_NGINX_RESTORE_FAILURE_OUTPUT}" "ERROR=NGINX_CONFIG_REJECTED_AND_UPSTREAM_RESTORE_FAILED"
require_text "${SWITCH_BLUE_COMPAT_TEST_SITE}" "server 127.0.0.1:18004;"
rm -f \
  "${SWITCH_BLUE_COMPAT_TEST_DIR}/docker-ps-count" \
  "${SWITCH_BLUE_COMPAT_TEST_DIR}/nginx-test-count-blue-compat" \
  "${SWITCH_BLUE_COMPAT_TEST_DIR}/quickbooks-health-count" \
  "${SWITCH_BLUE_COMPAT_TEST_DIR}/quickbooks-ready-count" \
  "${SWITCH_BLUE_COMPAT_TEST_DIR}/systemctl-reload-count-blue-compat"

SWITCH_BLUE_NGINX_RESTORE_SUCCESS_OUTPUT="${SWITCH_BLUE_COMPAT_TEST_DIR}/nginx-restore-success-output"
if env \
  PATH="${SWITCH_BLUE_COMPAT_TEST_BIN}:/usr/bin:/bin:/usr/sbin:/sbin" \
  SWITCH_TEST_STATE_DIR="${SWITCH_BLUE_COMPAT_TEST_DIR}" \
  ALLOW_BLUE_FORWARD_SCHEMA_NOT_READY=true \
  SWITCH_NGINX_FAIL_TESTS=1 \
  XERO_NGINX_SITE_FILE="${SWITCH_BLUE_COMPAT_TEST_SITE}" \
  "${SWITCH_BLUE_COMPAT_TEST_SCRIPT}" blue >"${SWITCH_BLUE_NGINX_RESTORE_SUCCESS_OUTPUT}" 2>&1; then
  echo "blue switch unexpectedly succeeded after its target Nginx config was rejected" >&2
  rm -rf "${SWITCH_BLUE_COMPAT_TEST_DIR}"
  exit 1
fi
require_text "${SWITCH_BLUE_NGINX_RESTORE_SUCCESS_OUTPUT}" "ERROR=NGINX_CONFIG_REJECTED_AND_RESTORED"
require_text "${SWITCH_BLUE_COMPAT_TEST_SITE}" "server 127.0.0.1:18004;"
rm -f \
  "${SWITCH_BLUE_COMPAT_TEST_DIR}/docker-ps-count" \
  "${SWITCH_BLUE_COMPAT_TEST_DIR}/nginx-test-count-blue-compat" \
  "${SWITCH_BLUE_COMPAT_TEST_DIR}/quickbooks-health-count" \
  "${SWITCH_BLUE_COMPAT_TEST_DIR}/quickbooks-ready-count" \
  "${SWITCH_BLUE_COMPAT_TEST_DIR}/systemctl-reload-count-blue-compat"

SWITCH_BLUE_PUBLIC_RESTORE_FAILURE_OUTPUT="${SWITCH_BLUE_COMPAT_TEST_DIR}/public-restore-failure-output"
if env \
  PATH="${SWITCH_BLUE_COMPAT_TEST_BIN}:/usr/bin:/bin:/usr/sbin:/sbin" \
  SWITCH_TEST_STATE_DIR="${SWITCH_BLUE_COMPAT_TEST_DIR}" \
  ALLOW_BLUE_FORWARD_SCHEMA_NOT_READY=true \
  SWITCH_BLUE_PUBLIC_READY_BODY='{"status":"not_ready","version":"0.2.13","extra":true}' \
  SWITCH_SYSTEMCTL_FAIL_RELOADS=2 \
  XERO_NGINX_SITE_FILE="${SWITCH_BLUE_COMPAT_TEST_SITE}" \
  "${SWITCH_BLUE_COMPAT_TEST_SCRIPT}" blue >"${SWITCH_BLUE_PUBLIC_RESTORE_FAILURE_OUTPUT}" 2>&1; then
  echo "blue switch succeeded after its public-check restore reload failed" >&2
  rm -rf "${SWITCH_BLUE_COMPAT_TEST_DIR}"
  exit 1
fi
require_text "${SWITCH_BLUE_PUBLIC_RESTORE_FAILURE_OUTPUT}" "ERROR=PUBLIC_CHECK_FAILED_AND_UPSTREAM_RESTORE_FAILED"
require_text "${SWITCH_BLUE_COMPAT_TEST_SITE}" "server 127.0.0.1:18004;"
rm -f \
  "${SWITCH_BLUE_COMPAT_TEST_DIR}/docker-ps-count" \
  "${SWITCH_BLUE_COMPAT_TEST_DIR}/nginx-test-count-blue-compat" \
  "${SWITCH_BLUE_COMPAT_TEST_DIR}/quickbooks-health-count" \
  "${SWITCH_BLUE_COMPAT_TEST_DIR}/quickbooks-ready-count" \
  "${SWITCH_BLUE_COMPAT_TEST_DIR}/systemctl-reload-count-blue-compat"

SWITCH_BLUE_QB_RESTORE_FAILURE_OUTPUT="${SWITCH_BLUE_COMPAT_TEST_DIR}/quickbooks-restore-failure-output"
if env \
  PATH="${SWITCH_BLUE_COMPAT_TEST_BIN}:/usr/bin:/bin:/usr/sbin:/sbin" \
  SWITCH_TEST_STATE_DIR="${SWITCH_BLUE_COMPAT_TEST_DIR}" \
  ALLOW_BLUE_FORWARD_SCHEMA_NOT_READY=true \
  SWITCH_QB_READY_FAIL_CALLS=2,3,4 \
  SWITCH_SYSTEMCTL_FAIL_RELOADS=2 \
  XERO_NGINX_SITE_FILE="${SWITCH_BLUE_COMPAT_TEST_SITE}" \
  "${SWITCH_BLUE_COMPAT_TEST_SCRIPT}" blue >"${SWITCH_BLUE_QB_RESTORE_FAILURE_OUTPUT}" 2>&1; then
  echo "blue switch succeeded after its QuickBooks-check restore reload failed" >&2
  rm -rf "${SWITCH_BLUE_COMPAT_TEST_DIR}"
  exit 1
fi
require_text "${SWITCH_BLUE_QB_RESTORE_FAILURE_OUTPUT}" "ERROR=QUICKBOOKS_PUBLIC_CHECK_FAILED_AND_UPSTREAM_RESTORE_FAILED"
require_text "${SWITCH_BLUE_COMPAT_TEST_SITE}" "server 127.0.0.1:18004;"
rm -f \
  "${SWITCH_BLUE_COMPAT_TEST_DIR}/docker-ps-count" \
  "${SWITCH_BLUE_COMPAT_TEST_DIR}/nginx-test-count-blue-compat" \
  "${SWITCH_BLUE_COMPAT_TEST_DIR}/quickbooks-health-count" \
  "${SWITCH_BLUE_COMPAT_TEST_DIR}/quickbooks-ready-count" \
  "${SWITCH_BLUE_COMPAT_TEST_DIR}/systemctl-reload-count-blue-compat"

SWITCH_BLUE_QB_RESTORE_SUCCESS_OUTPUT="${SWITCH_BLUE_COMPAT_TEST_DIR}/quickbooks-restore-success-output"
if env \
  PATH="${SWITCH_BLUE_COMPAT_TEST_BIN}:/usr/bin:/bin:/usr/sbin:/sbin" \
  SWITCH_TEST_STATE_DIR="${SWITCH_BLUE_COMPAT_TEST_DIR}" \
  ALLOW_BLUE_FORWARD_SCHEMA_NOT_READY=true \
  SWITCH_QB_READY_FAIL_CALLS=2,3,4 \
  XERO_NGINX_SITE_FILE="${SWITCH_BLUE_COMPAT_TEST_SITE}" \
  "${SWITCH_BLUE_COMPAT_TEST_SCRIPT}" blue >"${SWITCH_BLUE_QB_RESTORE_SUCCESS_OUTPUT}" 2>&1; then
  echo "blue switch unexpectedly succeeded after its QuickBooks post-check failed" >&2
  rm -rf "${SWITCH_BLUE_COMPAT_TEST_DIR}"
  exit 1
fi
require_text "${SWITCH_BLUE_QB_RESTORE_SUCCESS_OUTPUT}" "ERROR=QUICKBOOKS_PUBLIC_CHECK_FAILED_AND_UPSTREAM_RESTORED"
require_text "${SWITCH_BLUE_COMPAT_TEST_SITE}" "server 127.0.0.1:18004;"
rm -f \
  "${SWITCH_BLUE_COMPAT_TEST_DIR}/docker-ps-count" \
  "${SWITCH_BLUE_COMPAT_TEST_DIR}/nginx-test-count-blue-compat" \
  "${SWITCH_BLUE_COMPAT_TEST_DIR}/quickbooks-health-count" \
  "${SWITCH_BLUE_COMPAT_TEST_DIR}/quickbooks-ready-count" \
  "${SWITCH_BLUE_COMPAT_TEST_DIR}/systemctl-reload-count-blue-compat"

# A public response that differs from the accepted loopback response must fail
# after switching and atomically restore the original green site.
SWITCH_BLUE_PUBLIC_FAILURE_OUTPUT="${SWITCH_BLUE_COMPAT_TEST_DIR}/public-failure-output"
if env \
  PATH="${SWITCH_BLUE_COMPAT_TEST_BIN}:/usr/bin:/bin:/usr/sbin:/sbin" \
  SWITCH_TEST_STATE_DIR="${SWITCH_BLUE_COMPAT_TEST_DIR}" \
  ALLOW_BLUE_FORWARD_SCHEMA_NOT_READY=true \
  SWITCH_BLUE_PUBLIC_READY_BODY='{"status":"not_ready","version":"0.2.13","extra":true}' \
  XERO_NGINX_SITE_FILE="${SWITCH_BLUE_COMPAT_TEST_SITE}" \
  "${SWITCH_BLUE_COMPAT_TEST_SCRIPT}" blue >"${SWITCH_BLUE_PUBLIC_FAILURE_OUTPUT}" 2>&1; then
  echo "blue rollback accepted a non-exact public 503 readiness body" >&2
  rm -rf "${SWITCH_BLUE_COMPAT_TEST_DIR}"
  exit 1
fi
require_text "${SWITCH_BLUE_PUBLIC_FAILURE_OUTPUT}" "ERROR=PUBLIC_CHECK_FAILED_AND_UPSTREAM_RESTORED"
require_text "${SWITCH_BLUE_COMPAT_TEST_SITE}" "server 127.0.0.1:18004;"
forbid_text "${SWITCH_BLUE_COMPAT_TEST_SITE}" "server 127.0.0.1:18002;"
rm -f \
  "${SWITCH_BLUE_COMPAT_TEST_DIR}/docker-ps-count" \
  "${SWITCH_BLUE_COMPAT_TEST_DIR}/nginx-test-count-blue-compat" \
  "${SWITCH_BLUE_COMPAT_TEST_DIR}/quickbooks-health-count" \
  "${SWITCH_BLUE_COMPAT_TEST_DIR}/quickbooks-ready-count" \
  "${SWITCH_BLUE_COMPAT_TEST_DIR}/systemctl-reload-count-blue-compat"

if ! env \
  PATH="${SWITCH_BLUE_COMPAT_TEST_BIN}:/usr/bin:/bin:/usr/sbin:/sbin" \
  SWITCH_TEST_STATE_DIR="${SWITCH_BLUE_COMPAT_TEST_DIR}" \
  ALLOW_BLUE_FORWARD_SCHEMA_NOT_READY=true \
  XERO_NGINX_SITE_FILE="${SWITCH_BLUE_COMPAT_TEST_SITE}" \
  "${SWITCH_BLUE_COMPAT_TEST_SCRIPT}" blue >"${SWITCH_BLUE_COMPAT_TEST_OUTPUT}" 2>&1; then
  echo "forward-schema blue emergency rollback rejected the exact allowed 0.2.13 readiness response" >&2
  cat "${SWITCH_BLUE_COMPAT_TEST_OUTPUT}" >&2
  rm -rf "${SWITCH_BLUE_COMPAT_TEST_DIR}"
  exit 1
fi
require_text "${SWITCH_BLUE_COMPAT_TEST_SITE}" "server 127.0.0.1:18002;"
forbid_text "${SWITCH_BLUE_COMPAT_TEST_SITE}" "server 127.0.0.1:18004;"
require_text "${SWITCH_BLUE_COMPAT_TEST_OUTPUT}" "WARNING=BLUE_FORWARD_SCHEMA_NOT_READY_BREAK_GLASS"
require_text "${SWITCH_BLUE_COMPAT_TEST_OUTPUT}" "BLUE_BREAK_GLASS_READ_ONLY_VERIFIED=true"
require_text "${SWITCH_BLUE_COMPAT_TEST_OUTPUT}" "XERO_UPSTREAM=BLUE_18002"
require_text "${SWITCH_BLUE_COMPAT_TEST_OUTPUT}" "CHANGED=true"
test "$(cat "${SWITCH_BLUE_COMPAT_TEST_DIR}/docker-ps-count")" = "2" || {
  echo "blue break-glass did not verify the live 18002 container before and after switching" >&2
  rm -rf "${SWITCH_BLUE_COMPAT_TEST_DIR}"
  exit 1
}
test "$(cat "${SWITCH_BLUE_COMPAT_TEST_DIR}/quickbooks-health-count")" = "2" || {
  echo "forward-schema blue rollback did not check QuickBooks health both before and after switching" >&2
  rm -rf "${SWITCH_BLUE_COMPAT_TEST_DIR}"
  exit 1
}
test "$(cat "${SWITCH_BLUE_COMPAT_TEST_DIR}/quickbooks-ready-count")" = "2" || {
  echo "forward-schema blue rollback did not check QuickBooks readiness both before and after switching" >&2
  rm -rf "${SWITCH_BLUE_COMPAT_TEST_DIR}"
  exit 1
}

SWITCH_BLUE_NORMAL_READY_OUTPUT="${SWITCH_BLUE_COMPAT_TEST_DIR}/normal-ready-output"
if ! env \
  PATH="${SWITCH_BLUE_COMPAT_TEST_BIN}:/usr/bin:/bin:/usr/sbin:/sbin" \
  SWITCH_TEST_STATE_DIR="${SWITCH_BLUE_COMPAT_TEST_DIR}" \
  SWITCH_BLUE_READY_STATUS=200 \
  SWITCH_BLUE_READY_BODY='{"status":"ready","version":"0.2.13"}' \
  XERO_NGINX_SITE_FILE="${SWITCH_BLUE_COMPAT_TEST_SITE}" \
  "${SWITCH_BLUE_COMPAT_TEST_SCRIPT}" blue >"${SWITCH_BLUE_NORMAL_READY_OUTPUT}" 2>&1; then
  echo "blue rollback rejected the exact normal 0.2.13 readiness response" >&2
  rm -rf "${SWITCH_BLUE_COMPAT_TEST_DIR}"
  exit 1
fi
forbid_text "${SWITCH_BLUE_NORMAL_READY_OUTPUT}" "WARNING=BLUE_FORWARD_SCHEMA_NOT_READY_BREAK_GLASS"
require_text "${SWITCH_BLUE_NORMAL_READY_OUTPUT}" "CHANGED=false"

# The compatibility response is exact and blue-only. Wrong HTTP/body/version,
# a green 503, or a failed QuickBooks preflight must all remain fail-closed.
if env \
  PATH="${SWITCH_BLUE_COMPAT_TEST_BIN}:/usr/bin:/bin:/usr/sbin:/sbin" \
  SWITCH_TEST_STATE_DIR="${SWITCH_BLUE_COMPAT_TEST_DIR}" \
  SWITCH_BLUE_READY_STATUS=200 \
  XERO_NGINX_SITE_FILE="${SWITCH_BLUE_COMPAT_TEST_SITE}" \
  "${SWITCH_BLUE_COMPAT_TEST_SCRIPT}" blue >/dev/null 2>&1; then
  echo "blue rollback accepted not_ready with HTTP 200" >&2
  rm -rf "${SWITCH_BLUE_COMPAT_TEST_DIR}"
  exit 1
fi
if env \
  PATH="${SWITCH_BLUE_COMPAT_TEST_BIN}:/usr/bin:/bin:/usr/sbin:/sbin" \
  SWITCH_TEST_STATE_DIR="${SWITCH_BLUE_COMPAT_TEST_DIR}" \
  SWITCH_BLUE_READY_BODY='{"status":"not_ready","version":"0.2.13","extra":true}' \
  XERO_NGINX_SITE_FILE="${SWITCH_BLUE_COMPAT_TEST_SITE}" \
  "${SWITCH_BLUE_COMPAT_TEST_SCRIPT}" blue >/dev/null 2>&1; then
  echo "blue rollback accepted a non-exact 503 readiness body" >&2
  rm -rf "${SWITCH_BLUE_COMPAT_TEST_DIR}"
  exit 1
fi
if env \
  PATH="${SWITCH_BLUE_COMPAT_TEST_BIN}:/usr/bin:/bin:/usr/sbin:/sbin" \
  SWITCH_TEST_STATE_DIR="${SWITCH_BLUE_COMPAT_TEST_DIR}" \
  SWITCH_BLUE_HEALTH_VERSION=0.2.12 \
  XERO_NGINX_SITE_FILE="${SWITCH_BLUE_COMPAT_TEST_SITE}" \
  "${SWITCH_BLUE_COMPAT_TEST_SCRIPT}" blue >/dev/null 2>&1; then
  echo "blue rollback accepted the wrong health version" >&2
  rm -rf "${SWITCH_BLUE_COMPAT_TEST_DIR}"
  exit 1
fi
if env \
  PATH="${SWITCH_BLUE_COMPAT_TEST_BIN}:/usr/bin:/bin:/usr/sbin:/sbin" \
  SWITCH_TEST_STATE_DIR="${SWITCH_BLUE_COMPAT_TEST_DIR}" \
  SWITCH_BLUE_HEALTH_STATUS=201 \
  XERO_NGINX_SITE_FILE="${SWITCH_BLUE_COMPAT_TEST_SITE}" \
  "${SWITCH_BLUE_COMPAT_TEST_SCRIPT}" blue >/dev/null 2>&1; then
  echo "blue rollback accepted health with HTTP 201" >&2
  rm -rf "${SWITCH_BLUE_COMPAT_TEST_DIR}"
  exit 1
fi
if env \
  PATH="${SWITCH_BLUE_COMPAT_TEST_BIN}:/usr/bin:/bin:/usr/sbin:/sbin" \
  SWITCH_TEST_STATE_DIR="${SWITCH_BLUE_COMPAT_TEST_DIR}" \
  SWITCH_GREEN_READY_STATUS=503 \
  SWITCH_GREEN_READY_BODY='{"status":"not_ready","version":"0.3.0"}' \
  XERO_NGINX_SITE_FILE="${SWITCH_BLUE_COMPAT_TEST_SITE}" \
  "${SWITCH_BLUE_COMPAT_TEST_SCRIPT}" green >/dev/null 2>&1; then
  echo "green switch accepted a 503 readiness response" >&2
  rm -rf "${SWITCH_BLUE_COMPAT_TEST_DIR}"
  exit 1
fi
SWITCH_BLUE_QB_FAILURE_OUTPUT="${SWITCH_BLUE_COMPAT_TEST_DIR}/quickbooks-failure-output"
if env \
  PATH="${SWITCH_BLUE_COMPAT_TEST_BIN}:/usr/bin:/bin:/usr/sbin:/sbin" \
  SWITCH_TEST_STATE_DIR="${SWITCH_BLUE_COMPAT_TEST_DIR}" \
  SWITCH_QB_READY_STATUS=503 \
  SWITCH_QB_READY_BODY='{"status":"not_ready"}' \
  SWITCH_BLUE_READY_STATUS=200 \
  SWITCH_BLUE_READY_BODY='{"status":"ready","version":"0.2.13"}' \
  XERO_NGINX_SITE_FILE="${SWITCH_BLUE_COMPAT_TEST_SITE}" \
  "${SWITCH_BLUE_COMPAT_TEST_SCRIPT}" blue >"${SWITCH_BLUE_QB_FAILURE_OUTPUT}" 2>&1; then
  echo "blue rollback succeeded despite a failed QuickBooks preflight" >&2
  rm -rf "${SWITCH_BLUE_COMPAT_TEST_DIR}"
  exit 1
fi
require_text "${SWITCH_BLUE_QB_FAILURE_OUTPUT}" "ERROR=QUICKBOOKS_PUBLIC_PREFLIGHT_FAILED"
rm -rf "${SWITCH_BLUE_COMPAT_TEST_DIR}"

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  RENDERED_COMPOSE=$(mktemp "${TMPDIR:-/tmp}/xero-compose.XXXXXX")
  RENDERED_HOST_COMPOSE=$(mktemp "${TMPDIR:-/tmp}/xero-host-compose.XXXXXX")
  RENDERED_GREEN_COMPOSE=$(mktemp "${TMPDIR:-/tmp}/xero-green-compose.XXXXXX")
  RENDERED_GREEN_COMPOSE_JSON=$(mktemp "${TMPDIR:-/tmp}/xero-green-compose-json.XXXXXX")
  GREEN_RELEASE_GUARD_TEST_DIR=$(mktemp -d "${TMPDIR:-/tmp}/xero-green-guard.XXXXXX")
  trap 'rm -f "${RENDERED_COMPOSE}" "${RENDERED_HOST_COMPOSE}" "${RENDERED_GREEN_COMPOSE}" "${RENDERED_GREEN_COMPOSE_JSON}"; rm -rf "${GREEN_RELEASE_GUARD_TEST_DIR}"' EXIT HUP INT TERM
  docker compose \
    --project-directory "${PROJECT_DIR}" \
    --env-file "${EXAMPLE_ENV}" \
    -f "${COMPOSE_FILE}" \
    config >"${RENDERED_COMPOSE}"

  require_text "${RENDERED_COMPOSE}" "context: ${PROJECT_DIR}"
  require_text "${RENDERED_COMPOSE}" "source: ${DEPLOY_DIR}/nginx"
  require_text "${RENDERED_COMPOSE}" "internal: true"

  if grep -F 'published: "3000"' "${RENDERED_COMPOSE}" >/dev/null \
    || grep -F 'published: "5432"' "${RENDERED_COMPOSE}" >/dev/null; then
    echo "application or database port is unexpectedly published" >&2
    exit 1
  fi

  docker compose \
    --project-directory "${PROJECT_DIR}" \
    --env-file "${EXAMPLE_ENV}" \
    -f "${HOST_COMPOSE_FILE}" \
    config >"${RENDERED_HOST_COMPOSE}"

  require_text "${RENDERED_HOST_COMPOSE}" "context: ${PROJECT_DIR}"
  require_text "${RENDERED_HOST_COMPOSE}" "host_ip: 127.0.0.1"
  require_text "${RENDERED_HOST_COMPOSE}" "image: xero-accounting-mcp-demo:0.3.0-xero-pilot-20260810.1"
  require_text "${RENDERED_HOST_COMPOSE}" "image: xero-accounting-mcp-demo:0.2.12-quickbooks-20260806"
  require_text "${RENDERED_HOST_COMPOSE}" 'published: "18002"'
  require_text "${RENDERED_HOST_COMPOSE}" 'published: "18003"'
  require_text "${RENDERED_HOST_COMPOSE}" "internal: true"

  if grep -F 'published: "80"' "${RENDERED_HOST_COMPOSE}" >/dev/null \
    || grep -F 'published: "443"' "${RENDERED_HOST_COMPOSE}" >/dev/null \
    || grep -F 'published: "5432"' "${RENDERED_HOST_COMPOSE}" >/dev/null \
    || grep -F 'nginx:' "${RENDERED_HOST_COMPOSE}" >/dev/null; then
    echo "host-nginx Compose unexpectedly publishes edge/database ports or defines nginx" >&2
    exit 1
  fi

  docker compose \
    --project-name xero-accounting-mcp-green-030 \
    --project-directory "${PROJECT_DIR}" \
    --env-file "${EXAMPLE_ENV}" \
    -f "${GREEN_COMPOSE_FILE}" \
    config >"${RENDERED_GREEN_COMPOSE}"

  if env MCP_OAUTH_BROKER_ENABLED= PERSONAL_POC_ONLY=true docker compose \
    --project-name xero-accounting-mcp-green-030 \
    --project-directory "${PROJECT_DIR}" \
    --env-file "${EXAMPLE_ENV}" \
    -f "${GREEN_COMPOSE_FILE}" \
    config >/dev/null 2>&1; then
    echo "green Compose accepted a missing MCP_OAUTH_BROKER_ENABLED" >&2
    exit 1
  fi

  if env MCP_OAUTH_BROKER_ENABLED=true PERSONAL_POC_ONLY= docker compose \
    --project-name xero-accounting-mcp-green-030 \
    --project-directory "${PROJECT_DIR}" \
    --env-file "${EXAMPLE_ENV}" \
    -f "${GREEN_COMPOSE_FILE}" \
    config >/dev/null 2>&1; then
    echo "green Compose accepted a missing PERSONAL_POC_ONLY" >&2
    exit 1
  fi

  docker compose \
    --project-name xero-accounting-mcp-green-030 \
    --project-directory "${PROJECT_DIR}" \
    --env-file "${EXAMPLE_ENV}" \
    -f "${GREEN_COMPOSE_FILE}" \
    config --format json >"${RENDERED_GREEN_COMPOSE_JSON}"

  GREEN_RELEASE_GUARD=$(node -e '
    const fs = require("node:fs");
    const compose = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const service = compose.services?.["accounting-mcp-green"];
    const entrypoint = service?.entrypoint;
    if (!Array.isArray(entrypoint) || entrypoint.length < 3) process.exit(1);
    const expectedCommand = ["npm", "run", "start"];
    if (JSON.stringify(service.command) !== JSON.stringify(expectedCommand)) {
      console.error(`green Compose command must be ${JSON.stringify(expectedCommand)}; got ${JSON.stringify(service.command)}`);
      process.exit(1);
    }
    // Compose preserves the escaped dollars in `config`; the runtime passes
    // single dollars to /bin/sh. Normalize that boundary for this local guard test.
    process.stdout.write(entrypoint[2].replace(/\$\$/g, "$"));
  ' "${RENDERED_GREEN_COMPOSE_JSON}") || {
    echo "green Compose is missing its startup release guard" >&2
    exit 1
  }

  mkdir -p "${GREEN_RELEASE_GUARD_TEST_DIR}/bin"
  cat >"${GREEN_RELEASE_GUARD_TEST_DIR}/bin/npm" <<'EOF'
#!/bin/sh
printf '%s\n' "$@" >"${GREEN_RELEASE_GUARD_EXECUTION:?}"
EOF
  chmod 700 "${GREEN_RELEASE_GUARD_TEST_DIR}/bin/npm"
  GREEN_RELEASE_GUARD_EXECUTION="${GREEN_RELEASE_GUARD_TEST_DIR}/executed-command"

  if env MCP_OAUTH_BROKER_ENABLED=false PERSONAL_POC_ONLY=true \
    PATH="${GREEN_RELEASE_GUARD_TEST_DIR}/bin:/usr/bin:/bin" \
    GREEN_RELEASE_GUARD_EXECUTION="${GREEN_RELEASE_GUARD_EXECUTION}" \
    /bin/sh -ec "${GREEN_RELEASE_GUARD}" xero-green-release-guard npm run start \
    >/dev/null 2>&1; then
    echo "green startup guard accepted MCP_OAUTH_BROKER_ENABLED=false" >&2
    exit 1
  fi
  test ! -e "${GREEN_RELEASE_GUARD_EXECUTION}" || {
    echo "green startup guard executed the application with MCP_OAUTH_BROKER_ENABLED=false" >&2
    exit 1
  }

  if env MCP_OAUTH_BROKER_ENABLED=true PERSONAL_POC_ONLY=false \
    PATH="${GREEN_RELEASE_GUARD_TEST_DIR}/bin:/usr/bin:/bin" \
    GREEN_RELEASE_GUARD_EXECUTION="${GREEN_RELEASE_GUARD_EXECUTION}" \
    /bin/sh -ec "${GREEN_RELEASE_GUARD}" xero-green-release-guard npm run start \
    >/dev/null 2>&1; then
    echo "green startup guard accepted PERSONAL_POC_ONLY=false" >&2
    exit 1
  fi
  test ! -e "${GREEN_RELEASE_GUARD_EXECUTION}" || {
    echo "green startup guard executed the application with PERSONAL_POC_ONLY=false" >&2
    exit 1
  }

  env MCP_OAUTH_BROKER_ENABLED=true PERSONAL_POC_ONLY=true \
    PATH="${GREEN_RELEASE_GUARD_TEST_DIR}/bin:/usr/bin:/bin" \
    GREEN_RELEASE_GUARD_EXECUTION="${GREEN_RELEASE_GUARD_EXECUTION}" \
    /bin/sh -ec "${GREEN_RELEASE_GUARD}" xero-green-release-guard npm run start
  test "$(cat "${GREEN_RELEASE_GUARD_EXECUTION}")" = "$(printf 'run\nstart')" || {
    echo "green startup guard did not exec the rendered npm run start command" >&2
    exit 1
  }

  require_text "${RENDERED_GREEN_COMPOSE}" "name: xero-accounting-mcp-green-030"
  require_text "${RENDERED_GREEN_COMPOSE}" "accounting-mcp-green:"
  require_text "${RENDERED_GREEN_COMPOSE}" "image: xero-accounting-mcp-demo:0.3.0-xero-pilot-20260810.1"
  require_text "${RENDERED_GREEN_COMPOSE}" 'host_ip: 127.0.0.1'
  require_text "${RENDERED_GREEN_COMPOSE}" 'published: "18004"'
  require_text "${RENDERED_GREEN_COMPOSE}" 'MCP_OAUTH_BROKER_ENABLED: "true"'
  require_text "${RENDERED_GREEN_COMPOSE}" 'PERSONAL_POC_ONLY: "true"'
  require_text "${RENDERED_GREEN_COMPOSE}" 'XERO_WRITE_ENABLED: "false"'
  require_text "${RENDERED_GREEN_COMPOSE}" "name: xero-accounting-mcp-demo_egress"
  require_text "${RENDERED_GREEN_COMPOSE}" "name: xero-accounting-mcp-demo_data"

  if grep -Eq '^  (quickbooks-mcp|postgres|nginx|stock-mcp|trade):[[:space:]]*$' "${RENDERED_GREEN_COMPOSE}" \
    || grep -F 'published: "18003"' "${RENDERED_GREEN_COMPOSE}" >/dev/null \
    || grep -F 'published: "18001"' "${RENDERED_GREEN_COMPOSE}" >/dev/null; then
    echo "green Compose unexpectedly defines or publishes a non-Xero service" >&2
    exit 1
  fi
else
  echo "docker compose is required; rendered deployment validation was not run" >&2
  exit 1
fi

echo "deployment assets passed static validation"
