#!/bin/sh
set -eu

readonly SITE_FILE="${XERO_NGINX_SITE_FILE:-/etc/nginx/sites-available/mcp.jiayuanwang.xyz}"
readonly PUBLIC_BASE_URL="https://mcp.jiayuanwang.xyz"
readonly PUBLIC_HOST="mcp.jiayuanwang.xyz"
readonly BLUE_PORT="18002"
readonly GREEN_PORT="18004"
readonly BLUE_VERSION="0.2.13"
readonly GREEN_VERSION="0.4.0-rc.1"
readonly GREEN_TOOL_COUNT="30"
readonly GREEN_TOOLSET_HASH="ed6667e843ea916ad672ad260d0d7705df75ad4632c181e4e554250b82b076e5"
readonly PUBLIC_SETTLE_ATTEMPTS="3"
readonly PUBLIC_SETTLE_SLEEP_SECONDS="1"
readonly PUBLIC_SETTLE_CURL_MAX_TIME_SECONDS="1"
readonly LOCK_FILE="/run/lock/xero-mcp-upstream-switch.lock"
readonly BACKUP_DIR="/var/backups/xero-mcp-nginx"
readonly DOCKER_CLI="/usr/bin/docker"
PATH=/usr/bin:/bin
DOCKER_HOST=unix:///var/run/docker.sock
export PATH DOCKER_HOST
unset DOCKER_CONTEXT DOCKER_CONFIG BUILDX_BUILDER BUILDKIT_HOST

TEMP_FILE=""

audit() {
  printf '%s=%s\n' "$1" "$2"
}

fail() {
  audit "ERROR" "$1" >&2
  exit 1
}

cleanup() {
  if test -n "$TEMP_FILE"; then
    rm -f -- "$TEMP_FILE"
  fi
}
trap cleanup EXIT HUP INT TERM

command -v awk >/dev/null 2>&1 || fail "AWK_MISSING"
command -v curl >/dev/null 2>&1 || fail "CURL_MISSING"
test -x "$DOCKER_CLI" || fail "DOCKER_MISSING"
command -v flock >/dev/null 2>&1 || fail "FLOCK_MISSING"
command -v nginx >/dev/null 2>&1 || fail "NGINX_MISSING"
command -v sleep >/dev/null 2>&1 || fail "SLEEP_MISSING"
command -v systemctl >/dev/null 2>&1 || fail "SYSTEMCTL_MISSING"

test -f "$SITE_FILE" || fail "SITE_FILE_MISSING"
test ! -L "$SITE_FILE" || fail "SITE_FILE_MUST_NOT_BE_SYMLINK"

load_green_release_environment() {
  test "$#" = "1" || fail "RELEASE_ENV_OVERRIDE_FORBIDDEN"
  admitted_identity=$(/usr/bin/node scripts/release/production-deployment-admission.mjs --format fields) \
    || fail "PRODUCTION_DEPLOYMENT_ADMISSION_FAILED"
  IFS='|' read -r APP_IMAGE accepted_manifest_digest XERO_APPROVED_BUILD_IDENTITY_HASH \
    XERO_APPROVED_ACCEPTANCE_SOURCE_SHA256 XERO_APPROVED_SOURCE_ARCHIVE_SHA256 \
    XERO_APPROVED_CONTROL_CATALOG_SHA256 XERO_ADMITTED_GOVERNANCE_TRUST_BUNDLE_SHA256 \
    XERO_ADMITTED_GOVERNANCE_RECEIPTS_SHA256 XERO_ADMITTED_GOVERNANCE_STATUS_SHA256 \
    XERO_ADMITTED_AUTHORITY_REVISION XERO_ADMITTED_STANDING_DELEGATIONS_CONFIG_SHA256 \
    XERO_ADMITTED_WRITE_ENABLED XERO_ADMITTED_FIRM_GOVERNANCE_REQUIRED \
    XERO_ADMITTED_EXPECTED_AUTHORITY_SNAPSHOT_SHA256 \
    XERO_ADMITTED_EXPECTED_FIRM_GOVERNANCE_AGGREGATE_SHA256 <<EOF
$admitted_identity
EOF
  test -n "$APP_IMAGE" \
    && test -n "$accepted_manifest_digest" \
    && test -n "$XERO_APPROVED_BUILD_IDENTITY_HASH" \
    && test -n "$XERO_APPROVED_ACCEPTANCE_SOURCE_SHA256" \
    && test -n "$XERO_APPROVED_SOURCE_ARCHIVE_SHA256" \
    && test -n "$XERO_APPROVED_CONTROL_CATALOG_SHA256" \
    && test -n "$XERO_ADMITTED_GOVERNANCE_TRUST_BUNDLE_SHA256" \
    && test -n "$XERO_ADMITTED_GOVERNANCE_RECEIPTS_SHA256" \
    && test -n "$XERO_ADMITTED_GOVERNANCE_STATUS_SHA256" \
    && test -n "$XERO_ADMITTED_AUTHORITY_REVISION" \
    && test -n "$XERO_ADMITTED_STANDING_DELEGATIONS_CONFIG_SHA256" \
    && test -n "$XERO_ADMITTED_WRITE_ENABLED" \
    && test -n "$XERO_ADMITTED_FIRM_GOVERNANCE_REQUIRED" \
    && test -n "$XERO_ADMITTED_EXPECTED_AUTHORITY_SNAPSHOT_SHA256" \
    && test -n "$XERO_ADMITTED_EXPECTED_FIRM_GOVERNANCE_AGGREGATE_SHA256" \
    || fail "PRODUCTION_DEPLOYMENT_ADMISSION_FIELDS_INVALID"
}

verify_green_image_identity() {
  case "${APP_IMAGE:-}" in
    *@sha256:[0-9a-f][0-9a-f]*) ;;
    *) fail "APP_IMAGE_MUST_USE_IMMUTABLE_REPO_DIGEST" ;;
  esac
  case "$APP_IMAGE" in
    *@"$accepted_manifest_digest") ;;
    *) return 1 ;;
  esac
  green_container_ids=$("$DOCKER_CLI" ps \
    --filter "label=com.docker.compose.service=accounting-mcp-green" \
    --filter "publish=${GREEN_PORT}" \
    --format '{{.ID}}') || return 1
  test "$(printf '%s\n' "$green_container_ids" | sed '/^$/d' | wc -l | tr -d ' ')" = "1" || return 1
  green_container_id=$(printf '%s\n' "$green_container_ids" | sed '/^$/d')
  running_image_id=$("$DOCKER_CLI" inspect --format '{{.Image}}' "$green_container_id") || return 1
  approved_image_id=$("$DOCKER_CLI" image inspect --format '{{.Id}}' "$APP_IMAGE") || return 1
  test "$running_image_id" = "$approved_image_id" || return 1
  repo_digests=$("$DOCKER_CLI" image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$APP_IMAGE") || return 1
  printf '%s\n' "$repo_digests" | grep -Fx "$APP_IMAGE" >/dev/null || return 1
  actual_build_hash=$("$DOCKER_CLI" image inspect --format '{{index .Config.Labels "io.zcloak.xero.build-identity-hash"}}' "$APP_IMAGE") || return 1
  actual_source_hash=$("$DOCKER_CLI" image inspect --format '{{index .Config.Labels "io.zcloak.xero.acceptance-source-sha256"}}' "$APP_IMAGE") || return 1
  actual_archive_hash=$("$DOCKER_CLI" image inspect --format '{{index .Config.Labels "io.zcloak.xero.source-archive-sha256"}}' "$APP_IMAGE") || return 1
  test "$actual_build_hash" = "$XERO_APPROVED_BUILD_IDENTITY_HASH" || return 1
  test "$actual_source_hash" = "$XERO_APPROVED_ACCEPTANCE_SOURCE_SHA256" || return 1
  test "$actual_archive_hash" = "$XERO_APPROVED_SOURCE_ARCHIVE_SHA256" || return 1
  actual_control_catalog_hash=$("$DOCKER_CLI" image inspect --format '{{index .Config.Labels "io.zcloak.xero.approved-control-catalog-sha256"}}' "$APP_IMAGE") || return 1
  test "$actual_control_catalog_hash" = "$XERO_APPROVED_CONTROL_CATALOG_SHA256" || return 1
}

exec 9>"$LOCK_FILE"
flock -n 9 || fail "ANOTHER_UPSTREAM_SWITCH_IS_RUNNING"

upstream_port() {
  upstream_name=$1
  awk -v upstream_name="$upstream_name" '
    $0 == "upstream " upstream_name " {" { inside = 1; next }
    inside && $0 == "}" { inside = 0 }
    inside && $0 ~ /^[[:space:]]*server 127[.]0[.]0[.]1:[0-9]+;[[:space:]]*$/ {
      value = $0
      sub(/^.*:/, "", value)
      sub(/;.*/, "", value)
      print value
    }
  ' "$SITE_FILE"
}

current_xero_port() {
  ports=$(upstream_port "xero_accounting_mcp_demo")
  test "$(printf '%s\n' "$ports" | sed '/^$/d' | wc -l | tr -d ' ')" -eq 1 || fail "XERO_UPSTREAM_NOT_EXACTLY_ONE"
  case "$ports" in
    "$BLUE_PORT"|"$GREEN_PORT") printf '%s' "$ports" ;;
    *) fail "XERO_UPSTREAM_PORT_UNEXPECTED" ;;
  esac
}

verify_blue_break_glass_container_read_only() {
  test -x "$DOCKER_CLI" || return 1
  blue_container_ids=$("$DOCKER_CLI" ps \
    --filter "label=com.docker.compose.service=accounting-mcp" \
    --filter "publish=${BLUE_PORT}" \
    --format '{{.ID}}') || return 1
  blue_container_count=$(printf '%s\n' "$blue_container_ids" | sed '/^$/d' | wc -l | tr -d ' ')
  test "$blue_container_count" = "1" || return 1
  blue_container_id=$(printf '%s\n' "$blue_container_ids" | sed '/^$/d')

  blue_container_running=$("$DOCKER_CLI" inspect --format '{{.State.Running}}' "$blue_container_id") || return 1
  test "$blue_container_running" = "true" || return 1
  blue_container_bindings=$("$DOCKER_CLI" inspect --format \
    '{{range $port, $bindings := .NetworkSettings.Ports}}{{range $bindings}}{{printf "%s|%s|%s\n" $port .HostIp .HostPort}}{{end}}{{end}}' \
    "$blue_container_id") || return 1
  test "$blue_container_bindings" = "3000/tcp|127.0.0.1|${BLUE_PORT}" || return 1
  blue_container_environment=$("$DOCKER_CLI" inspect --format \
    '{{range .Config.Env}}{{println .}}{{end}}' \
    "$blue_container_id") || return 1
  blue_write_setting=$(printf '%s\n' "$blue_container_environment" | awk -F= '$1 == "XERO_WRITE_ENABLED" { print }')
  test "$blue_write_setting" = "XERO_WRITE_ENABLED=false" || return 1

  BLUE_BREAK_GLASS_CONTAINER_ID=$blue_container_id
}

check_blue_readiness_response() {
  ready_status=$1
  ready_body=$2
  case "${ready_status}:${ready_body}" in
    "200:{\"status\":\"ready\",\"version\":\"${BLUE_VERSION}\"}") return 0 ;;
    "503:{\"status\":\"not_ready\",\"version\":\"${BLUE_VERSION}\"}")
      test "${ALLOW_BLUE_FORWARD_SCHEMA_NOT_READY:-false}" = "true" || return 1
      verify_blue_break_glass_container_read_only || return 1
      BLUE_BREAK_GLASS_USED=true
      ;;
    *) return 1 ;;
  esac
}

fetch_blue_http_response() {
  response_url=$1
  response_max_time=$2
  shift 2
  blue_response=$(curl -sS --max-time "$response_max_time" "$@" -w '\n%{http_code}' "$response_url") || return 1
  BLUE_HTTP_STATUS=$(printf '%s\n' "$blue_response" | tail -n 1)
  BLUE_HTTP_BODY=$(printf '%s\n' "$blue_response" | sed '$d')
}

fetch_blue_readiness() {
  ready_url=$1
  response_max_time=$2
  shift 2
  fetch_blue_http_response "$ready_url" "$response_max_time" "$@" || return 1
  BLUE_READY_HTTP_STATUS=$BLUE_HTTP_STATUS
  BLUE_READY_BODY=$BLUE_HTTP_BODY
  check_blue_readiness_response "$BLUE_READY_HTTP_STATUS" "$BLUE_READY_BODY"
}

audit_blue_rollback_warning() {
  target_port=$1
  if test "$target_port" = "$BLUE_PORT" \
    && test "${BLUE_BREAK_GLASS_USED:-false}" = "true"; then
    audit "WARNING" "BLUE_FORWARD_SCHEMA_NOT_READY_BREAK_GLASS"
    audit "BLUE_BREAK_GLASS_READ_ONLY_VERIFIED" "true"
    audit "BLUE_BREAK_GLASS_CONTAINER_ID" "$BLUE_BREAK_GLASS_CONTAINER_ID"
  fi
}

check_loopback() {
  target_port=$1
  case "$target_port" in
    "$GREEN_PORT")
      health=$(curl -fsS --max-time 15 -H "Host: ${PUBLIC_HOST}" "http://127.0.0.1:${target_port}/healthz")
      printf '%s' "$health" | grep -Fq '"status":"ok"' || fail "TARGET_HEALTH_NOT_OK"
      ready=$(curl -fsS --max-time 15 -H "Host: ${PUBLIC_HOST}" "http://127.0.0.1:${target_port}/readyz")
      printf '%s' "$ready" | grep -Fq '"status":"ready"' || fail "TARGET_READINESS_NOT_READY"
      printf '%s' "$ready" | grep -Fq '"activeAccountingCaseRecoveryProjection":{"status":"COMPATIBLE"' \
        || fail "TARGET_ACTIVE_RECOVERY_PROJECTION_NOT_COMPATIBLE"
      printf '%s' "$ready" | grep -Fq "\"version\":\"${GREEN_VERSION}\"" || fail "GREEN_READY_VERSION_MISMATCH"
      printf '%s' "$ready" | grep -Fq "\"toolsetHash\":\"${GREEN_TOOLSET_HASH}\"" || fail "GREEN_READY_TOOLSET_HASH_MISMATCH"
      printf '%s' "$ready" | grep -Fq "\"buildIdentityHash\":\"${XERO_APPROVED_BUILD_IDENTITY_HASH}\"" || fail "GREEN_READY_BUILD_IDENTITY_MISMATCH"
      printf '%s' "$ready" | grep -Fq "\"acceptanceSourceSha256\":\"${XERO_APPROVED_ACCEPTANCE_SOURCE_SHA256}\"" || fail "GREEN_READY_SOURCE_IDENTITY_MISMATCH"
      printf '%s' "$ready" | grep -Fq "\"sourceArchiveSha256\":\"${XERO_APPROVED_SOURCE_ARCHIVE_SHA256}\"" || fail "GREEN_READY_ARCHIVE_IDENTITY_MISMATCH"
      printf '%s' "$ready" | grep -Fq "\"approvedControlCatalogSha256\":\"${XERO_APPROVED_CONTROL_CATALOG_SHA256}\"" || fail "GREEN_READY_CONTROL_CATALOG_MISMATCH"
      printf '%s' "$ready" | /usr/bin/node deploy/scripts/governance-cutover-contract.mjs \
        "$XERO_ADMITTED_GOVERNANCE_TRUST_BUNDLE_SHA256" \
        "$XERO_ADMITTED_GOVERNANCE_RECEIPTS_SHA256" \
        "$XERO_ADMITTED_GOVERNANCE_STATUS_SHA256" \
        "$XERO_ADMITTED_AUTHORITY_REVISION" \
        "$XERO_ADMITTED_STANDING_DELEGATIONS_CONFIG_SHA256" \
        "$XERO_ADMITTED_WRITE_ENABLED" \
        "$XERO_ADMITTED_FIRM_GOVERNANCE_REQUIRED" \
        "$XERO_ADMITTED_EXPECTED_AUTHORITY_SNAPSHOT_SHA256" \
        "$XERO_ADMITTED_EXPECTED_FIRM_GOVERNANCE_AGGREGATE_SHA256" \
        || fail "GREEN_READY_GOVERNANCE_ADMISSION_MISMATCH"
      printf '%s' "$health" | grep -Fq "\"version\":\"${GREEN_VERSION}\"" || fail "GREEN_VERSION_MISMATCH"
      printf '%s' "$health" | grep -Fq "\"toolCount\":${GREEN_TOOL_COUNT}" || fail "GREEN_TOOL_COUNT_MISMATCH"
      printf '%s' "$health" | grep -Fq "\"toolsetHash\":\"${GREEN_TOOLSET_HASH}\"" || fail "GREEN_TOOLSET_HASH_MISMATCH"
      printf '%s' "$health" | grep -Fq "\"buildIdentityHash\":\"${XERO_APPROVED_BUILD_IDENTITY_HASH}\"" || fail "GREEN_BUILD_IDENTITY_MISMATCH"
      printf '%s' "$health" | grep -Fq "\"approvedControlCatalogSha256\":\"${XERO_APPROVED_CONTROL_CATALOG_SHA256}\"" || fail "GREEN_CONTROL_CATALOG_MISMATCH"
      ;;
    "$BLUE_PORT")
      fetch_blue_http_response \
        "http://127.0.0.1:${target_port}/healthz" \
        15 \
        -H "Host: ${PUBLIC_HOST}" || fail "TARGET_HEALTH_NOT_OK"
      test "$BLUE_HTTP_STATUS" = "200" || fail "TARGET_HEALTH_NOT_OK"
      health=$BLUE_HTTP_BODY
      printf '%s' "$health" | grep -Fq '"status":"ok"' || fail "TARGET_HEALTH_NOT_OK"
      printf '%s' "$health" | grep -Fq "\"version\":\"${BLUE_VERSION}\"" || fail "BLUE_VERSION_MISMATCH"
      fetch_blue_readiness \
        "http://127.0.0.1:${target_port}/readyz" \
        15 \
        -H "Host: ${PUBLIC_HOST}" || fail "TARGET_READINESS_NOT_READY"
      ;;
    *) fail "TARGET_PORT_UNEXPECTED" ;;
  esac
}

check_public() {
  target_port=$1
  response_max_time=${2:-15}
  case "$target_port" in
    "$GREEN_PORT")
      health=$(curl -fsS --max-time "$response_max_time" "${PUBLIC_BASE_URL}/healthz") || return 1
      printf '%s' "$health" | grep -Fq '"status":"ok"' || return 1
      ready=$(curl -fsS --max-time "$response_max_time" "${PUBLIC_BASE_URL}/readyz") || return 1
      printf '%s' "$ready" | grep -Fq '"status":"ready"' || return 1
      printf '%s' "$ready" | grep -Fq '"activeAccountingCaseRecoveryProjection":{"status":"COMPATIBLE"' \
        || return 1
      printf '%s' "$ready" | grep -Fq "\"version\":\"${GREEN_VERSION}\"" || return 1
      printf '%s' "$ready" | grep -Fq "\"toolsetHash\":\"${GREEN_TOOLSET_HASH}\"" || return 1
      printf '%s' "$ready" | grep -Fq "\"buildIdentityHash\":\"${XERO_APPROVED_BUILD_IDENTITY_HASH}\"" || return 1
      printf '%s' "$ready" | grep -Fq "\"acceptanceSourceSha256\":\"${XERO_APPROVED_ACCEPTANCE_SOURCE_SHA256}\"" || return 1
      printf '%s' "$ready" | grep -Fq "\"sourceArchiveSha256\":\"${XERO_APPROVED_SOURCE_ARCHIVE_SHA256}\"" || return 1
      printf '%s' "$ready" | grep -Fq "\"approvedControlCatalogSha256\":\"${XERO_APPROVED_CONTROL_CATALOG_SHA256}\"" || return 1
      printf '%s' "$ready" | /usr/bin/node deploy/scripts/governance-cutover-contract.mjs \
        "$XERO_ADMITTED_GOVERNANCE_TRUST_BUNDLE_SHA256" \
        "$XERO_ADMITTED_GOVERNANCE_RECEIPTS_SHA256" \
        "$XERO_ADMITTED_GOVERNANCE_STATUS_SHA256" \
        "$XERO_ADMITTED_AUTHORITY_REVISION" \
        "$XERO_ADMITTED_STANDING_DELEGATIONS_CONFIG_SHA256" \
        "$XERO_ADMITTED_WRITE_ENABLED" \
        "$XERO_ADMITTED_FIRM_GOVERNANCE_REQUIRED" \
        "$XERO_ADMITTED_EXPECTED_AUTHORITY_SNAPSHOT_SHA256" \
        "$XERO_ADMITTED_EXPECTED_FIRM_GOVERNANCE_AGGREGATE_SHA256" \
        || return 1
      printf '%s' "$health" | grep -Fq "\"version\":\"${GREEN_VERSION}\"" || return 1
      printf '%s' "$health" | grep -Fq "\"toolCount\":${GREEN_TOOL_COUNT}" || return 1
      printf '%s' "$health" | grep -Fq "\"toolsetHash\":\"${GREEN_TOOLSET_HASH}\"" || return 1
      printf '%s' "$health" | grep -Fq "\"buildIdentityHash\":\"${XERO_APPROVED_BUILD_IDENTITY_HASH}\"" || return 1
      printf '%s' "$health" | grep -Fq "\"approvedControlCatalogSha256\":\"${XERO_APPROVED_CONTROL_CATALOG_SHA256}\"" || return 1
      ;;
    "$BLUE_PORT")
      fetch_blue_http_response "${PUBLIC_BASE_URL}/healthz" "$response_max_time" || return 1
      test "$BLUE_HTTP_STATUS" = "200" || return 1
      health=$BLUE_HTTP_BODY
      printf '%s' "$health" | grep -Fq '"status":"ok"' || return 1
      printf '%s' "$health" | grep -Fq "\"version\":\"${BLUE_VERSION}\"" || return 1
      fetch_blue_readiness "${PUBLIC_BASE_URL}/readyz" "$response_max_time" || return 1
      ;;
    *) return 1 ;;
  esac
}

settle_public_after_reload() {
  target_port=$1
  settle_attempt=1
  while test "$settle_attempt" -le "$PUBLIC_SETTLE_ATTEMPTS"; do
    PUBLIC_SETTLE_XERO_OK=false
    if check_public "$target_port" "$PUBLIC_SETTLE_CURL_MAX_TIME_SECONDS"; then
      PUBLIC_SETTLE_XERO_OK=true
    fi
    if test "$PUBLIC_SETTLE_XERO_OK" = "true"; then
      return 0
    fi
    test "$settle_attempt" -lt "$PUBLIC_SETTLE_ATTEMPTS" || return 1
    sleep "$PUBLIC_SETTLE_SLEEP_SECONDS"
    settle_attempt=$((settle_attempt + 1))
  done
  return 1
}

render_target_site() {
  target_port=$1
  awk -v target_port="$target_port" '
    $0 == "upstream xero_accounting_mcp_demo {" { inside = 1 }
    inside && $0 ~ /^[[:space:]]*server 127[.]0[.]0[.]1:(18002|18004);[[:space:]]*$/ {
      sub(/127[.]0[.]0[.]1:(18002|18004);/, "127.0.0.1:" target_port ";")
      replaced += 1
    }
    { print }
    inside && $0 == "}" { inside = 0 }
    END { if (replaced != 1) exit 42 }
  ' "$SITE_FILE"
}

restore_site() {
  backup_file=$1
  expected_xero_port=$2
  TEMP_FILE=$(mktemp "$(dirname -- "$SITE_FILE")/.mcp.jiayuanwang.xyz.restore.XXXXXX") || return 1
  cp --preserve=mode,ownership,timestamps -- "$backup_file" "$TEMP_FILE" || return 1
  mv -f -- "$TEMP_FILE" "$SITE_FILE" || return 1
  TEMP_FILE=""
  # Prove the restored config and graceful reload. Do not require the original
  # public readiness here: a pre-020 blue may be in the explicit 503 break-glass
  # state, and treating that known state as restore failure would be misleading.
  restored_xero_ports=$(upstream_port "xero_accounting_mcp_demo") || return 1
  test "$restored_xero_ports" = "$expected_xero_port" || return 1
  nginx -t || return 1
  systemctl reload nginx || return 1
}

switch_to() {
  target_port=$1
  target_label=$2
  current_port=$(current_xero_port)
  if test "$target_port" = "$GREEN_PORT"; then
    verify_green_image_identity || fail "GREEN_IMAGE_IDENTITY_MISMATCH"
  fi
  check_loopback "$target_port"

  if test "$current_port" = "$target_port"; then
    check_public "$target_port" || fail "PUBLIC_CHECK_FAILED_WITH_TARGET_ALREADY_ACTIVE"
    audit_blue_rollback_warning "$target_port"
    audit "XERO_UPSTREAM" "$target_label"
    audit "CHANGED" "false"
    return 0
  fi

  install -d -o root -g root -m 0700 "$BACKUP_DIR"
  timestamp=$(date -u +%Y%m%dT%H%M%SZ)
  backup_file="${BACKUP_DIR}/mcp.jiayuanwang.xyz.${timestamp}.from-${current_port}"
  cp --preserve=mode,ownership,timestamps -- "$SITE_FILE" "$backup_file"
  chmod 0600 "$backup_file"

  TEMP_FILE=$(mktemp "$(dirname -- "$SITE_FILE")/.mcp.jiayuanwang.xyz.switch.XXXXXX")
  render_target_site "$target_port" >"$TEMP_FILE" || fail "SITE_RENDER_FAILED"
  chown --reference="$SITE_FILE" "$TEMP_FILE"
  chmod --reference="$SITE_FILE" "$TEMP_FILE"
  mv -f -- "$TEMP_FILE" "$SITE_FILE"
  TEMP_FILE=""

  if ! nginx -t; then
    if restore_site "$backup_file" "$current_port"; then
      fail "NGINX_CONFIG_REJECTED_AND_RESTORED"
    fi
    fail "NGINX_CONFIG_REJECTED_AND_UPSTREAM_RESTORE_FAILED"
  fi
  if ! systemctl reload nginx; then
    if restore_site "$backup_file" "$current_port"; then
      fail "NGINX_RELOAD_FAILED_AND_UPSTREAM_RESTORED"
    fi
    fail "NGINX_RELOAD_FAILED_AND_UPSTREAM_RESTORE_FAILED"
  fi

  if ! settle_public_after_reload "$target_port"; then
    if restore_site "$backup_file" "$current_port"; then
      fail "PUBLIC_CHECK_FAILED_AND_UPSTREAM_RESTORED"
    fi
    fail "PUBLIC_CHECK_FAILED_AND_UPSTREAM_RESTORE_FAILED"
  fi
  test "$(current_xero_port)" = "$target_port" || fail "POST_SWITCH_PORT_MISMATCH"
  audit_blue_rollback_warning "$target_port"
  audit "XERO_UPSTREAM" "$target_label"
  audit "CHANGED" "true"
  audit "BACKUP" "$backup_file"
}

case "${1:-}" in
  status)
    case "$(current_xero_port)" in
      "$BLUE_PORT") audit "XERO_UPSTREAM" "BLUE_18002" ;;
      "$GREEN_PORT") audit "XERO_UPSTREAM" "GREEN_18004" ;;
    esac
    ;;
  green)
    load_green_release_environment "$@"
    switch_to "$GREEN_PORT" "GREEN_18004"
    ;;
  blue) switch_to "$BLUE_PORT" "BLUE_18002" ;;
  *)
    printf 'usage: %s {status|blue|green}\n' "$0" >&2
    exit 2
    ;;
esac
