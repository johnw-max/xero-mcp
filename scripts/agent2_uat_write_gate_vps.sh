#!/usr/bin/env bash
set -euo pipefail

readonly RELEASE_DIR="/opt/xero-accounting-mcp-demo-0.3.0-20260810.1"
readonly EXPECTED_IMAGE_REF="xero-accounting-mcp-demo:0.3.0-xero-pilot-20260810.1"
readonly EXPECTED_VERSION="0.3.0"
readonly EXPECTED_TOOL_COUNT="44"
readonly EXPECTED_TOOLSET_HASH="d2ac8c01f7a68182e3fd88edd4e5f294dd16a8f7c0fb96260f55f47a4e290224"
readonly EXPECTED_PUBLIC_BASE_URL="https://mcp.jiayuanwang.xyz"
readonly EXPECTED_RESOURCE="${EXPECTED_PUBLIC_BASE_URL}/mcp"
readonly EXPECTED_LOOPBACK_BASE_URL="http://127.0.0.1:18004"
readonly TEST_TENANT_ID="7c3cc738-eef0-4d4e-83f8-d528390e1e61"
readonly EXPECTED_CLIENT_ID="agent2-xero-bd0796db041ee01e"
readonly BASELINE_FILE="/tmp/xero-agent2-uat-write-gate-0.3.0-20260810.1.baseline"
readonly LOCK_FILE="/run/lock/xero-agent2-uat-write-gate-0.3.0-20260810.1.lock"
readonly AUTOCLOSE_UNIT="xero-write-gate-autoclose-030-20260810-1"
readonly AUTOCLOSE_DELAY="15m"
readonly RETRY_DELAY="15s"
readonly RETRY_WINDOW="15min"
readonly RETRY_START_LIMIT_BURST="4"
readonly BOOT_FAILSAFE_UNIT="xero-write-gate-boot-close-030-20260810-1.service"
readonly BOOT_FAILSAFE_SCRIPT="/usr/local/sbin/xero-agent2-uat-write-gate-030-20260810-1"
readonly BOOT_FAILSAFE_UNIT_PATH="/etc/systemd/system/${BOOT_FAILSAFE_UNIT}"
readonly BOOT_FAILSAFE_WANTS_LINK="/etc/systemd/system/nginx.service.wants/${BOOT_FAILSAFE_UNIT}"
readonly LEGACY_BOOT_FAILSAFE_REQUIRES_LINK="/etc/systemd/system/nginx.service.requires/${BOOT_FAILSAFE_UNIT}"
readonly MAIN_COMPOSE_FILE="deploy/docker-compose/compose.host-nginx.vps.yaml"
readonly GREEN_COMPOSE_FILE="deploy/docker-compose/compose.host-nginx.green.vps.yaml"
readonly GREEN_PROJECT_NAME="xero-accounting-mcp-green-030"
readonly ENV_FILE="deploy/.env.vps"

GATE_MAY_BE_OPEN=0
ENV_TEMP_FILE=""
UNIT_TEMP_FILE=""
BOOT_DEPENDENCY_SNAPSHOT_VALID=0
BOOT_QB_ID=""
BOOT_QB_IMAGE=""
BOOT_QB_STARTED=""
BOOT_PG_ID=""
BOOT_PG_IMAGE=""
BOOT_PG_STARTED=""

audit() {
  printf '%s=%s\n' "$1" "$2"
}

fail() {
  audit "ERROR" "$1" >&2
  return 1
}

cd -- "$RELEASE_DIR"

main_compose() {
  docker compose \
    --project-directory . \
    --env-file "$ENV_FILE" \
    -f "$MAIN_COMPOSE_FILE" \
    "$@"
}

green_compose() {
  docker compose \
    --project-name "$GREEN_PROJECT_NAME" \
    --project-directory . \
    --env-file "$ENV_FILE" \
    -f "$GREEN_COMPOSE_FILE" \
    "$@"
}

recreate_xero() {
  local write_enabled="$1"
  local restart_policy="$2"
  case "$restart_policy" in
    no|unless-stopped) ;;
    *) fail "INVALID_XERO_RESTART_POLICY" ;;
  esac
  XERO_RESTART_POLICY="$restart_policy" XERO_WRITE_ENABLED="$write_enabled" green_compose up -d \
    --no-deps \
    --no-build \
    --force-recreate \
    --wait \
    --wait-timeout 120 \
    accounting-mcp-green >/dev/null
  verify_xero_restart_policy "$restart_policy"
}

env_key_count() {
  local key="$1"
  awk -F= -v key="$key" '$1 == key { count += 1 } END { print count + 0 }' "$ENV_FILE"
}

env_value() {
  local key="$1"
  awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$ENV_FILE"
}

require_env_exact() {
  local key="$1"
  local expected="$2"
  test "$(env_key_count "$key")" -eq 1 || fail "${key}_COUNT_NOT_ONE"
  test "$(env_value "$key")" = "$expected" || fail "${key}_UNEXPECTED"
}

normalize_write_flag_false() {
  local env_dir env_base matching_count exact_false_count
  test -f "$ENV_FILE" || fail "ENV_FILE_MISSING"
  test ! -L "$ENV_FILE" || fail "ENV_FILE_MUST_NOT_BE_SYMLINK"
  test "$(stat -c '%a' "$ENV_FILE")" = "600" || fail "ENV_FILE_MODE_NOT_600"

  matching_count="$(awk '/^[[:space:]]*XERO_WRITE_ENABLED[[:space:]]*=/{ count += 1 } END { print count + 0 }' "$ENV_FILE")"
  exact_false_count="$(awk '$0 == "XERO_WRITE_ENABLED=false" { count += 1 } END { print count + 0 }' "$ENV_FILE")"
  if test "$matching_count" -eq 1 && test "$exact_false_count" -eq 1; then
    audit "ENV_WRITE_DEFAULT" "ALREADY_FALSE"
    return 0
  fi

  env_dir="$(dirname -- "$ENV_FILE")"
  env_base="$(basename -- "$ENV_FILE")"
  ENV_TEMP_FILE="$(mktemp "${env_dir}/.${env_base}.xero-write.XXXXXX")"
  if ! {
    awk '!/^[[:space:]]*XERO_WRITE_ENABLED[[:space:]]*=/' "$ENV_FILE" >"$ENV_TEMP_FILE" &&
      printf '\nXERO_WRITE_ENABLED=false\n' >>"$ENV_TEMP_FILE" &&
      chown --reference="$ENV_FILE" "$ENV_TEMP_FILE" &&
      chmod 600 "$ENV_TEMP_FILE"
  }; then
    fail "ENV_WRITE_NORMALIZATION_FAILED"
    return 1
  fi

  mv -f -- "$ENV_TEMP_FILE" "$ENV_FILE"
  ENV_TEMP_FILE=""
  require_env_exact "XERO_WRITE_ENABLED" "false"
  audit "ENV_WRITE_DEFAULT" "NORMALIZED_FALSE_ATOMICALLY"
}

render_boot_failsafe_unit() {
  local script_sha256
  script_sha256="$(sha256sum "$BOOT_FAILSAFE_SCRIPT" | awk '{print $1}')"
  cat <<EOF
[Unit]
Description=Force the Xero Agent2 UAT write gate closed before the public edge starts
Requires=docker.service
After=docker.service
Before=nginx.service
StartLimitIntervalSec=${RETRY_WINDOW}
StartLimitBurst=${RETRY_START_LIMIT_BURST}

[Service]
Type=oneshot
Environment=BOOT_FAILSAFE_SCRIPT_SHA256=${script_sha256}
ExecStart=${BOOT_FAILSAFE_SCRIPT} boot-close
Restart=on-failure
RestartSec=${RETRY_DELAY}
RemainAfterExit=yes
TimeoutStartSec=180

[Install]
WantedBy=nginx.service
EOF
}

require_boot_failsafe_script() {
  local resolved_script
  test -f "$BOOT_FAILSAFE_SCRIPT" || fail "BOOT_FAILSAFE_SCRIPT_MISSING"
  test ! -L "$BOOT_FAILSAFE_SCRIPT" || fail "BOOT_FAILSAFE_SCRIPT_MUST_NOT_BE_SYMLINK"
  test "$(stat -c '%u:%g:%a' "$BOOT_FAILSAFE_SCRIPT")" = "0:0:700" ||
    fail "BOOT_FAILSAFE_SCRIPT_OWNER_OR_MODE_INVALID"
  resolved_script="$(readlink -f -- "$0")"
  test "$resolved_script" = "$BOOT_FAILSAFE_SCRIPT" || fail "RUN_FROM_PINNED_BOOT_FAILSAFE_SCRIPT"
}

systemd_property() {
  local unit="$1" property="$2"
  systemctl show "$unit" --property="$property" --value
}

verify_bounded_retry_policy() {
  local unit="$1" label="$2"
  test "$(systemd_property "$unit" Restart)" = "on-failure" ||
    fail "${label}_RESTART_NOT_ON_FAILURE"
  test "$(systemd_property "$unit" RestartUSec)" = "$RETRY_DELAY" ||
    fail "${label}_RESTART_DELAY_MISMATCH"
  test "$(systemd_property "$unit" StartLimitIntervalUSec)" = "$RETRY_WINDOW" ||
    fail "${label}_START_LIMIT_WINDOW_MISMATCH"
  test "$(systemd_property "$unit" StartLimitBurst)" = "$RETRY_START_LIMIT_BURST" ||
    fail "${label}_START_LIMIT_BURST_MISMATCH"
  audit "${label}_RETRY" "ON_FAILURE_MAX_${RETRY_START_LIMIT_BURST}_STARTS_DELAY_${RETRY_DELAY}_WINDOW_${RETRY_WINDOW}"
}

verify_boot_failsafe() {
  local expected_hash installed_hash nginx_wants
  require_boot_failsafe_script
  test -f "$BOOT_FAILSAFE_UNIT_PATH" || fail "BOOT_FAILSAFE_UNIT_MISSING"
  test ! -L "$BOOT_FAILSAFE_UNIT_PATH" || fail "BOOT_FAILSAFE_UNIT_MUST_NOT_BE_SYMLINK"
  test "$(stat -c '%u:%g:%a' "$BOOT_FAILSAFE_UNIT_PATH")" = "0:0:644" ||
    fail "BOOT_FAILSAFE_UNIT_OWNER_OR_MODE_INVALID"
  expected_hash="$(render_boot_failsafe_unit | sha256sum | awk '{print $1}')"
  installed_hash="$(sha256sum "$BOOT_FAILSAFE_UNIT_PATH" | awk '{print $1}')"
  test "$installed_hash" = "$expected_hash" || fail "BOOT_FAILSAFE_UNIT_CONTENT_MISMATCH"
  test "$(systemctl show "$BOOT_FAILSAFE_UNIT" --property=LoadState --value)" = "loaded" ||
    fail "BOOT_FAILSAFE_UNIT_NOT_LOADED"
  systemctl is-enabled --quiet "$BOOT_FAILSAFE_UNIT" || fail "BOOT_FAILSAFE_UNIT_NOT_ENABLED"
  test -L "$BOOT_FAILSAFE_WANTS_LINK" || fail "BOOT_FAILSAFE_NGINX_WANTS_LINK_MISSING"
  test "$(readlink -f -- "$BOOT_FAILSAFE_WANTS_LINK")" = "$BOOT_FAILSAFE_UNIT_PATH" ||
    fail "BOOT_FAILSAFE_NGINX_WANTS_LINK_INVALID"
  nginx_wants="$(systemctl show nginx.service --property=Wants --value)"
  printf '%s\n' "$nginx_wants" | tr ' ' '\n' | grep -Fxq "$BOOT_FAILSAFE_UNIT" ||
    fail "BOOT_FAILSAFE_NOT_WANTED_BY_NGINX"
  verify_bounded_retry_policy "$BOOT_FAILSAFE_UNIT" "BOOT_FAILSAFE"
  audit "BOOT_FAILSAFE" "INSTALLED_ENABLED_WANTED_BY_NGINX_NON_BLOCKING"
}

verify_boot_failsafe_activation() {
  systemctl is-active --quiet "$BOOT_FAILSAFE_UNIT" || fail "BOOT_FAILSAFE_UNIT_NOT_ACTIVE"
  test "$(systemctl show "$BOOT_FAILSAFE_UNIT" --property=Result --value)" = "success" ||
    fail "BOOT_FAILSAFE_UNIT_LAST_RESULT_NOT_SUCCESS"
  test "$(systemctl show "$BOOT_FAILSAFE_UNIT" --property=ExecMainStatus --value)" = "0" ||
    fail "BOOT_FAILSAFE_UNIT_LAST_EXIT_NOT_ZERO"
  audit "BOOT_FAILSAFE_ACTIVATION" "PASS"
}

remove_legacy_required_link() {
  if test -L "$LEGACY_BOOT_FAILSAFE_REQUIRES_LINK"; then
    test "$(readlink -f -- "$LEGACY_BOOT_FAILSAFE_REQUIRES_LINK")" = "$BOOT_FAILSAFE_UNIT_PATH" ||
      fail "LEGACY_BOOT_FAILSAFE_REQUIRES_LINK_POINTS_ELSEWHERE"
    rm -f -- "$LEGACY_BOOT_FAILSAFE_REQUIRES_LINK"
    audit "LEGACY_BOOT_FAILSAFE_REQUIRES_LINK" "REMOVED"
  elif test -e "$LEGACY_BOOT_FAILSAFE_REQUIRES_LINK"; then
    fail "LEGACY_BOOT_FAILSAFE_REQUIRES_LINK_NOT_SYMLINK"
  fi
}

ensure_boot_failsafe() {
  local install_state
  test "$(id -u)" -eq 0 || fail "BOOT_FAILSAFE_REQUIRES_ROOT"
  command -v systemctl >/dev/null 2>&1 || fail "SYSTEMCTL_MISSING"
  test "$(systemctl show docker.service --property=LoadState --value)" = "loaded" ||
    fail "DOCKER_SYSTEMD_UNIT_NOT_LOADED"
  test "$(systemctl show nginx.service --property=LoadState --value)" = "loaded" ||
    fail "NGINX_SYSTEMD_UNIT_NOT_LOADED"
  require_boot_failsafe_script

  UNIT_TEMP_FILE="$(mktemp "/etc/systemd/system/.${BOOT_FAILSAFE_UNIT}.XXXXXX")"
  render_boot_failsafe_unit >"$UNIT_TEMP_FILE"
  chown root:root "$UNIT_TEMP_FILE"
  chmod 644 "$UNIT_TEMP_FILE"
  install_state="UPDATED"
  if test -f "$BOOT_FAILSAFE_UNIT_PATH" && cmp -s "$UNIT_TEMP_FILE" "$BOOT_FAILSAFE_UNIT_PATH"; then
    rm -f -- "$UNIT_TEMP_FILE"
    UNIT_TEMP_FILE=""
    install_state="VERIFIED"
  else
    systemctl stop "$BOOT_FAILSAFE_UNIT" >/dev/null 2>&1 || true
    mv -f -- "$UNIT_TEMP_FILE" "$BOOT_FAILSAFE_UNIT_PATH"
    UNIT_TEMP_FILE=""
  fi

  systemctl daemon-reload
  remove_legacy_required_link
  systemctl enable "$BOOT_FAILSAFE_UNIT" >/dev/null
  verify_boot_failsafe
  audit "BOOT_FAILSAFE_INSTALL" "$install_state"
}

install_boot_failsafe() {
  ensure_boot_failsafe
  audit "BOOT_FAILSAFE_INSTALL_COMMAND" "PASS"
}

health_check() {
  local health ready
  health="$(curl -fsS --max-time 15 "${EXPECTED_PUBLIC_BASE_URL}/healthz")"
  ready="$(curl -fsS --max-time 15 "${EXPECTED_PUBLIC_BASE_URL}/readyz")"
  printf '%s' "$health" | grep -Fq '"status":"ok"' || fail "HEALTH_STATUS_NOT_OK"
  printf '%s' "$health" | grep -Fq "\"version\":\"${EXPECTED_VERSION}\"" || fail "HEALTH_VERSION_MISMATCH"
  printf '%s' "$health" | grep -Fq "\"toolCount\":${EXPECTED_TOOL_COUNT}" || fail "HEALTH_TOOL_COUNT_MISMATCH"
  printf '%s' "$health" | grep -Fq "\"toolsetHash\":\"${EXPECTED_TOOLSET_HASH}\"" || fail "HEALTH_TOOLSET_HASH_MISMATCH"
  printf '%s' "$ready" | grep -Fq '"status":"ready"' || fail "READINESS_STATUS_NOT_READY"
  printf '%s' "$ready" | grep -Fq "\"version\":\"${EXPECTED_VERSION}\"" || fail "READINESS_VERSION_MISMATCH"
}

loopback_health_check() {
  local health ready
  health="$(curl -fsS --max-time 15 -H 'Host: mcp.jiayuanwang.xyz' "${EXPECTED_LOOPBACK_BASE_URL}/healthz")"
  ready="$(curl -fsS --max-time 15 -H 'Host: mcp.jiayuanwang.xyz' "${EXPECTED_LOOPBACK_BASE_URL}/readyz")"
  printf '%s' "$health" | grep -Fq '"status":"ok"' || fail "LOOPBACK_HEALTH_STATUS_NOT_OK"
  printf '%s' "$health" | grep -Fq "\"version\":\"${EXPECTED_VERSION}\"" ||
    fail "LOOPBACK_HEALTH_VERSION_MISMATCH"
  printf '%s' "$health" | grep -Fq "\"toolCount\":${EXPECTED_TOOL_COUNT}" ||
    fail "LOOPBACK_HEALTH_TOOL_COUNT_MISMATCH"
  printf '%s' "$health" | grep -Fq "\"toolsetHash\":\"${EXPECTED_TOOLSET_HASH}\"" ||
    fail "LOOPBACK_HEALTH_TOOLSET_HASH_MISMATCH"
  printf '%s' "$ready" | grep -Fq '"status":"ready"' || fail "LOOPBACK_READINESS_STATUS_NOT_READY"
  printf '%s' "$ready" | grep -Fq "\"version\":\"${EXPECTED_VERSION}\"" ||
    fail "LOOPBACK_READINESS_VERSION_MISMATCH"
}

binding_check() {
  local result
  result="$(main_compose exec -T postgres sh -eu -c \
    'exec psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At \
      -v test_tenant_id="$1" -v expected_client_id="$2" -v expected_resource="$3"' \
    sh "$TEST_TENANT_ID" "$EXPECTED_CLIENT_ID" "$EXPECTED_RESOURCE" <<'SQL'
WITH active_binding AS (
  SELECT
    i.installation_id,
    i.workspace_id,
    i.agent_id,
    i.oauth_client_id,
    b.binding_id,
    c.connection_id,
    c.authorization_id,
    c.tenant_id,
    c.tenant_name,
    a.granted_scopes AS xero_scopes,
    f.granted_scopes AS mcp_scopes,
    f.resource,
    f.audience
  FROM oauth_installations i
  JOIN agent_connection_bindings b
    ON b.oauth_installation_id = i.installation_id
  JOIN provider_connections c
    ON c.connection_id = b.connection_id
  JOIN provider_authorizations a
    ON a.authorization_id = c.authorization_id
   AND a.workspace_id = i.workspace_id
  JOIN mcp_refresh_token_families f
    ON f.oauth_installation_id = i.installation_id
   AND f.binding_id = b.binding_id
   AND f.connection_id = c.connection_id
  WHERE i.installation_status = 'ACTIVE'
    AND b.binding_status = 'ACTIVE'
    AND c.connection_status = 'ACTIVE'
    AND a.authorization_status = 'ACTIVE'
    AND f.family_status = 'ACTIVE'
)
SELECT CASE WHEN (
  count(*) = 1
  AND count(*) FILTER (
    WHERE tenant_id = :'test_tenant_id'
      AND lower(tenant_name) = 'zcloak'
      AND workspace_id = 'personal-poc'
      AND oauth_client_id = :'expected_client_id'
      AND agent_id = 'host-client:' || oauth_client_id
      AND mcp_scopes @> ARRAY['xero.read','xero.draft.write']::text[]
      AND xero_scopes @> ARRAY['accounting.invoices']::text[]
      AND resource = :'expected_resource'
      AND audience = :'expected_resource'
  ) = 1
  AND (SELECT count(*) FROM oauth_installations
       WHERE installation_status = 'ACTIVE') = 1
  AND (SELECT count(*) FROM agent_connection_bindings
       WHERE binding_status = 'ACTIVE') = 1
  AND NOT EXISTS (
    SELECT 1
    FROM provider_connections other_connection
    WHERE other_connection.connection_status = 'ACTIVE'
      AND NOT EXISTS (
        SELECT 1
        FROM active_binding allowed_binding
        WHERE allowed_binding.authorization_id = other_connection.authorization_id
      )
  )
  AND (SELECT count(*) FROM provider_authorizations
       WHERE authorization_status = 'ACTIVE') = 1
  AND (SELECT count(*) FROM mcp_refresh_token_families
       WHERE family_status = 'ACTIVE') = 1
) THEN 'PASS' ELSE 'FAIL' END
FROM active_binding;
SQL
)"
  test "$result" = "PASS" || fail "EXACT_ONE_BINDING_FAILED"
}

deployment_check() {
  local app_id actual_image_id expected_image_id configured_image
  local working_dir config_files state health

  test "$(pwd -P)" = "$RELEASE_DIR" || fail "RELEASE_DIR_MISMATCH"
  require_env_exact "APP_IMAGE" "$EXPECTED_IMAGE_REF"
  require_env_exact "PUBLIC_BASE_URL" "$EXPECTED_PUBLIC_BASE_URL"
  require_env_exact "XERO_ALLOWED_TENANT_ID" "$TEST_TENANT_ID"
  main_compose config --quiet
  green_compose config --quiet

  app_id="$(green_compose ps -q accounting-mcp-green)"
  test -n "$app_id" || fail "XERO_CONTAINER_MISSING"
  configured_image="$(docker inspect -f '{{.Config.Image}}' "$app_id")"
  test "$configured_image" = "$EXPECTED_IMAGE_REF" || fail "XERO_IMAGE_REF_MISMATCH"
  actual_image_id="$(docker inspect -f '{{.Image}}' "$app_id")"
  expected_image_id="$(docker image inspect -f '{{.Id}}' "$EXPECTED_IMAGE_REF")"
  test "$actual_image_id" = "$expected_image_id" || fail "XERO_IMAGE_ID_MISMATCH"

  working_dir="$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' "$app_id")"
  test "$working_dir" = "$RELEASE_DIR" || fail "XERO_CONTAINER_RELEASE_LABEL_MISMATCH"
  config_files="$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project.config_files" }}' "$app_id")"
  case ",${config_files}," in
    *",${RELEASE_DIR}/${GREEN_COMPOSE_FILE},"*) ;;
    *) fail "XERO_CONTAINER_COMPOSE_LABEL_MISMATCH" ;;
  esac

  state="$(docker inspect -f '{{.State.Status}}' "$app_id")"
  health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$app_id")"
  test "$state" = "running" || fail "XERO_CONTAINER_NOT_RUNNING"
  test "$health" = "healthy" || fail "XERO_CONTAINER_NOT_HEALTHY"
  green_compose exec -T accounting-mcp-green sh -eu -c \
    'test "$PUBLIC_BASE_URL" = "https://mcp.jiayuanwang.xyz"
     test "$MCP_OAUTH_BROKER_ENABLED" = "true"'
}

xero_container_id() {
  local app_id
  app_id="$(green_compose ps -q accounting-mcp-green)"
  test -n "$app_id" || fail "XERO_CONTAINER_MISSING_FOR_RESTART_POLICY"
  printf '%s' "$app_id"
}

verify_xero_restart_policy() {
  local expected_policy="$1" app_id actual_policy
  app_id="$(xero_container_id)"
  actual_policy="$(docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' "$app_id")"
  test "$actual_policy" = "$expected_policy" || fail "XERO_RESTART_POLICY_${actual_policy}_EXPECTED_${expected_policy}"
}

write_baseline() {
  local app_id qb_id pg_id env_hash tmp
  app_id="$(green_compose ps -q accounting-mcp-green)"
  qb_id="$(main_compose ps -q quickbooks-mcp)"
  pg_id="$(main_compose ps -q postgres)"
  test -n "$app_id" || fail "BASELINE_XERO_CONTAINER_MISSING"
  test -n "$qb_id" || fail "BASELINE_QUICKBOOKS_CONTAINER_MISSING"
  test -n "$pg_id" || fail "BASELINE_POSTGRES_CONTAINER_MISSING"
  env_hash="$(sha256sum "$ENV_FILE" | awk '{print $1}')"
  tmp="$(mktemp "${BASELINE_FILE}.XXXXXX")"
  chmod 600 "$tmp"
  printf 'ENV_HASH=%s\nAPP_IMAGE=%s\nQB_ID=%s\nQB_IMAGE=%s\nQB_STARTED=%s\nPG_ID=%s\nPG_IMAGE=%s\nPG_STARTED=%s\n' \
    "$env_hash" \
    "$(docker inspect -f '{{.Image}}' "$app_id")" \
    "$qb_id" \
    "$(docker inspect -f '{{.Image}}' "$qb_id")" \
    "$(docker inspect -f '{{.State.StartedAt}}' "$qb_id")" \
    "$pg_id" \
    "$(docker inspect -f '{{.Image}}' "$pg_id")" \
    "$(docker inspect -f '{{.State.StartedAt}}' "$pg_id")" >"$tmp"
  mv -f -- "$tmp" "$BASELINE_FILE"
  chmod 600 "$BASELINE_FILE"
}

capture_boot_dependency_snapshot() {
  BOOT_DEPENDENCY_SNAPSHOT_VALID=0
  BOOT_QB_ID="$(main_compose ps -a -q quickbooks-mcp 2>/dev/null || true)"
  BOOT_PG_ID="$(main_compose ps -a -q postgres 2>/dev/null || true)"
  if test -z "$BOOT_QB_ID" || test -z "$BOOT_PG_ID"; then
    audit "BOOT_DEPENDENCY_SNAPSHOT" "INCOMPLETE"
    return 0
  fi
  BOOT_QB_IMAGE="$(docker inspect -f '{{.Image}}' "$BOOT_QB_ID" 2>/dev/null || true)"
  BOOT_QB_STARTED="$(docker inspect -f '{{.State.StartedAt}}' "$BOOT_QB_ID" 2>/dev/null || true)"
  BOOT_PG_IMAGE="$(docker inspect -f '{{.Image}}' "$BOOT_PG_ID" 2>/dev/null || true)"
  BOOT_PG_STARTED="$(docker inspect -f '{{.State.StartedAt}}' "$BOOT_PG_ID" 2>/dev/null || true)"
  if test -z "$BOOT_QB_IMAGE" || test -z "$BOOT_QB_STARTED" ||
    test -z "$BOOT_PG_IMAGE" || test -z "$BOOT_PG_STARTED"; then
    audit "BOOT_DEPENDENCY_SNAPSHOT" "INCOMPLETE"
    return 0
  fi
  BOOT_DEPENDENCY_SNAPSHOT_VALID=1
  audit "BOOT_DEPENDENCY_SNAPSHOT" "PASS"
}

verify_boot_dependency_continuity() {
  test "$BOOT_DEPENDENCY_SNAPSHOT_VALID" -eq 1 || fail "BOOT_DEPENDENCY_SNAPSHOT_INVALID"
  test "$(main_compose ps -a -q quickbooks-mcp)" = "$BOOT_QB_ID" || fail "BOOT_QUICKBOOKS_CONTAINER_CHANGED"
  test "$(docker inspect -f '{{.Image}}' "$BOOT_QB_ID")" = "$BOOT_QB_IMAGE" ||
    fail "BOOT_QUICKBOOKS_IMAGE_CHANGED"
  test "$(docker inspect -f '{{.State.StartedAt}}' "$BOOT_QB_ID")" = "$BOOT_QB_STARTED" ||
    fail "BOOT_QUICKBOOKS_RESTARTED"
  test "$(main_compose ps -a -q postgres)" = "$BOOT_PG_ID" || fail "BOOT_POSTGRES_CONTAINER_CHANGED"
  test "$(docker inspect -f '{{.Image}}' "$BOOT_PG_ID")" = "$BOOT_PG_IMAGE" ||
    fail "BOOT_POSTGRES_IMAGE_CHANGED"
  test "$(docker inspect -f '{{.State.StartedAt}}' "$BOOT_PG_ID")" = "$BOOT_PG_STARTED" ||
    fail "BOOT_POSTGRES_RESTARTED"
}

read_baseline_value() {
  local key="$1"
  sed -n "s/^${key}=//p" "$BASELINE_FILE"
}

verify_continuity() {
  local app_id qb_id pg_id
  test -f "$BASELINE_FILE" || fail "BASELINE_FILE_MISSING"
  test ! -L "$BASELINE_FILE" || fail "BASELINE_FILE_MUST_NOT_BE_SYMLINK"
  app_id="$(green_compose ps -q accounting-mcp-green)"
  qb_id="$(main_compose ps -q quickbooks-mcp)"
  pg_id="$(main_compose ps -q postgres)"
  test -n "$app_id" || fail "CONTINUITY_XERO_CONTAINER_MISSING"
  test -n "$qb_id" || fail "CONTINUITY_QUICKBOOKS_CONTAINER_MISSING"
  test -n "$pg_id" || fail "CONTINUITY_POSTGRES_CONTAINER_MISSING"
  test "$(docker inspect -f '{{.Image}}' "$app_id")" = "$(read_baseline_value APP_IMAGE)" || fail "CONTINUITY_XERO_IMAGE_CHANGED"
  test "$qb_id" = "$(read_baseline_value QB_ID)" || fail "CONTINUITY_QUICKBOOKS_CONTAINER_CHANGED"
  test "$(docker inspect -f '{{.Image}}' "$qb_id")" = "$(read_baseline_value QB_IMAGE)" || fail "CONTINUITY_QUICKBOOKS_IMAGE_CHANGED"
  test "$(docker inspect -f '{{.State.StartedAt}}' "$qb_id")" = "$(read_baseline_value QB_STARTED)" || fail "CONTINUITY_QUICKBOOKS_RESTARTED"
  test "$pg_id" = "$(read_baseline_value PG_ID)" || fail "CONTINUITY_POSTGRES_CONTAINER_CHANGED"
  test "$(docker inspect -f '{{.Image}}' "$pg_id")" = "$(read_baseline_value PG_IMAGE)" || fail "CONTINUITY_POSTGRES_IMAGE_CHANGED"
  test "$(docker inspect -f '{{.State.StartedAt}}' "$pg_id")" = "$(read_baseline_value PG_STARTED)" || fail "CONTINUITY_POSTGRES_RESTARTED"
  test "$(sha256sum "$ENV_FILE" | awk '{print $1}')" = "$(read_baseline_value ENV_HASH)" || fail "CONTINUITY_ENV_CHANGED"
}

preflight() {
  verify_boot_failsafe
  verify_boot_failsafe_activation
  normalize_write_flag_false
  deployment_check
  green_compose exec -T accounting-mcp-green sh -eu -c 'test "$XERO_WRITE_ENABLED" = "false"' || fail "WRITE_GATE_NOT_CLOSED_AT_PREFLIGHT"
  verify_xero_restart_policy "unless-stopped"
  binding_check
  write_baseline
  health_check
  audit "PREFLIGHT" "PASS"
}

schedule_autoclose() {
  local docker_path
  docker_path="$(command -v docker)"
  test -n "$docker_path" || fail "DOCKER_BINARY_MISSING"
  systemctl stop "${AUTOCLOSE_UNIT}.timer" "${AUTOCLOSE_UNIT}.service" >/dev/null 2>&1 || true
  systemctl reset-failed "${AUTOCLOSE_UNIT}.timer" "${AUTOCLOSE_UNIT}.service" >/dev/null 2>&1 || true
  systemd-run \
    --unit="$AUTOCLOSE_UNIT" \
    --description="Close the Xero 0.3.0 Agent2 UAT write gate" \
    --on-active="$AUTOCLOSE_DELAY" \
    --timer-property=AccuracySec=1s \
    --property=Type=oneshot \
    --property=Restart=on-failure \
    --property=RestartSec="$RETRY_DELAY" \
    --property=StartLimitIntervalSec="$RETRY_WINDOW" \
    --property=StartLimitBurst="$RETRY_START_LIMIT_BURST" \
    --property=TimeoutStartSec=150s \
    --setenv=XERO_WRITE_ENABLED=false \
    --setenv=XERO_RESTART_POLICY=unless-stopped \
    "$docker_path" compose \
      --project-name "$GREEN_PROJECT_NAME" \
      --project-directory "$RELEASE_DIR" \
      --env-file "${RELEASE_DIR}/${ENV_FILE}" \
      -f "${RELEASE_DIR}/${GREEN_COMPOSE_FILE}" \
      up -d \
      --no-deps \
      --no-build \
      --force-recreate \
      --wait \
      --wait-timeout 120 \
      accounting-mcp-green >/dev/null
  verify_autoclose_schedule
}

verify_autoclose_schedule() {
  local triggers restart_count last_result
  test "$(systemd_property "${AUTOCLOSE_UNIT}.timer" LoadState)" = "loaded" ||
    fail "AUTOCLOSE_TIMER_NOT_LOADED"
  test "$(systemd_property "${AUTOCLOSE_UNIT}.service" LoadState)" = "loaded" ||
    fail "AUTOCLOSE_SERVICE_NOT_LOADED"
  test "$(systemd_property "${AUTOCLOSE_UNIT}.service" Type)" = "oneshot" ||
    fail "AUTOCLOSE_SERVICE_NOT_ONESHOT"
  test "$(systemd_property "${AUTOCLOSE_UNIT}.service" Restart)" = "on-failure" ||
    fail "AUTOCLOSE_SERVICE_RESTART_NOT_ON_FAILURE"
  test "$(systemd_property "${AUTOCLOSE_UNIT}.service" RestartUSec)" = "$RETRY_DELAY" ||
    fail "AUTOCLOSE_SERVICE_RESTART_DELAY_MISMATCH"
  test "$(systemd_property "${AUTOCLOSE_UNIT}.service" StartLimitIntervalUSec)" = "$RETRY_WINDOW" ||
    fail "AUTOCLOSE_SERVICE_START_LIMIT_WINDOW_MISMATCH"
  test "$(systemd_property "${AUTOCLOSE_UNIT}.service" StartLimitBurst)" = "$RETRY_START_LIMIT_BURST" ||
    fail "AUTOCLOSE_SERVICE_START_LIMIT_BURST_MISMATCH"
  triggers="$(systemd_property "${AUTOCLOSE_UNIT}.timer" Triggers)"
  printf '%s\n' "$triggers" | tr ' ' '\n' | grep -Fxq "${AUTOCLOSE_UNIT}.service" ||
    fail "AUTOCLOSE_TIMER_TRIGGER_MISMATCH"
  restart_count="$(systemd_property "${AUTOCLOSE_UNIT}.service" NRestarts)"
  case "$restart_count" in
    ''|*[!0-9]*) fail "AUTOCLOSE_SERVICE_RESTART_COUNT_INVALID" ;;
  esac
  last_result="$(systemd_property "${AUTOCLOSE_UNIT}.service" Result)"
  systemctl is-active --quiet "${AUTOCLOSE_UNIT}.timer" || fail "AUTOCLOSE_TIMER_NOT_ACTIVE"
  audit "AUTOCLOSE_TIMER" "ACTIVE_${AUTOCLOSE_DELAY}_TRIGGERS_SERVICE"
  audit "AUTOCLOSE_SERVICE" "LOADED_ONESHOT_RESULT_${last_result}"
  audit "AUTOCLOSE_RETRY" "ON_FAILURE_MAX_${RETRY_START_LIMIT_BURST}_STARTS_DELAY_${RETRY_DELAY}_WINDOW_${RETRY_WINDOW}_RESTARTS_${restart_count}"
}

stop_autoclose() {
  systemctl stop "${AUTOCLOSE_UNIT}.timer" "${AUTOCLOSE_UNIT}.service" >/dev/null 2>&1 || true
}

restore_closed_runtime() {
  env XERO_RESTART_POLICY=unless-stopped XERO_WRITE_ENABLED=false \
    docker compose \
      --project-name "$GREEN_PROJECT_NAME" \
      --project-directory "$RELEASE_DIR" \
      --env-file "${RELEASE_DIR}/${ENV_FILE}" \
      -f "${RELEASE_DIR}/${GREEN_COMPOSE_FILE}" \
      up -d \
      --no-deps \
      --no-build \
      --force-recreate \
      --wait \
      --wait-timeout 120 \
      accounting-mcp-green >/dev/null
  green_compose exec -T accounting-mcp-green sh -eu -c 'test "$XERO_WRITE_ENABLED" = "false"'
  verify_xero_restart_policy "unless-stopped"
}

on_exit() {
  local rc="$?"
  trap - EXIT
  if test -n "$ENV_TEMP_FILE"; then
    rm -f -- "$ENV_TEMP_FILE"
    ENV_TEMP_FILE=""
  fi
  if test -n "$UNIT_TEMP_FILE"; then
    rm -f -- "$UNIT_TEMP_FILE"
    UNIT_TEMP_FILE=""
  fi
  if test "$rc" -ne 0 && test "$GATE_MAY_BE_OPEN" -eq 1; then
    audit "FAILURE_CLOSE_ATTEMPT" "STARTED" >&2
    if restore_closed_runtime; then
      GATE_MAY_BE_OPEN=0
      stop_autoclose
      audit "FAILURE_CLOSE_ATTEMPT" "PASS" >&2
    else
      audit "FAILURE_CLOSE_ATTEMPT" "FAILED_TIMER_REMAINS_FALLBACK" >&2
    fi
  fi
  exit "$rc"
}

trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

exec 9>"$LOCK_FILE"
flock -n 9 || fail "ANOTHER_WRITE_GATE_COMMAND_IS_RUNNING"

open_gate() {
  preflight
  schedule_autoclose
  GATE_MAY_BE_OPEN=1
  recreate_xero "true" "no"
  green_compose exec -T accounting-mcp-green sh -eu -c \
    'test "$MCP_OAUTH_BROKER_ENABLED" = "true"
     test "$XERO_WRITE_ENABLED" = "true"
     test "$XERO_ALLOWED_TENANT_ID" = "7c3cc738-eef0-4d4e-83f8-d528390e1e61"'
  deployment_check
  verify_xero_restart_policy "no"
  verify_continuity
  binding_check
  health_check
  audit "WRITE_GATE" "OPEN"
  audit "BINDING" "PASS"
  audit "AUTOCLOSE" "ACTIVE"
  audit "RELEASE" "0.3.0-20260810.1"
  audit "RESOURCE" "$EXPECTED_RESOURCE"
  audit "XERO_IMAGE" "PINNED"
  audit "QUICKBOOKS_CONTINUITY" "PASS"
  audit "POSTGRES_CONTINUITY" "PASS"
  audit "HEALTH" "PASS"
}

boot_close_gate() {
  normalize_write_flag_false
  capture_boot_dependency_snapshot
  GATE_MAY_BE_OPEN=1
  recreate_xero "false" "unless-stopped"
  green_compose exec -T accounting-mcp-green sh -eu -c \
    'test "$MCP_OAUTH_BROKER_ENABLED" = "true"
     test "$XERO_WRITE_ENABLED" = "false"
     test "$XERO_ALLOWED_TENANT_ID" = "7c3cc738-eef0-4d4e-83f8-d528390e1e61"'
  GATE_MAY_BE_OPEN=0
  stop_autoclose
  deployment_check
  verify_xero_restart_policy "unless-stopped"
  verify_boot_dependency_continuity
  loopback_health_check
  audit "BOOT_WRITE_GATE" "CLOSED"
  audit "RELEASE" "0.3.0-20260810.1"
  audit "RESOURCE" "$EXPECTED_RESOURCE"
  audit "XERO_IMAGE" "PINNED"
  audit "QUICKBOOKS_CONTINUITY" "PASS"
  audit "POSTGRES_CONTINUITY" "PASS"
  audit "LOOPBACK_HEALTH" "PASS"
}

close_gate() {
  normalize_write_flag_false
  deployment_check
  if test ! -f "$BASELINE_FILE"; then
    write_baseline
  fi
  GATE_MAY_BE_OPEN=1
  recreate_xero "false" "unless-stopped"
  green_compose exec -T accounting-mcp-green sh -eu -c 'test "$XERO_WRITE_ENABLED" = "false"'
  GATE_MAY_BE_OPEN=0
  stop_autoclose
  deployment_check
  verify_xero_restart_policy "unless-stopped"
  verify_continuity
  binding_check
  health_check
  audit "WRITE_GATE" "CLOSED"
  audit "BINDING" "PASS"
  audit "RELEASE" "0.3.0-20260810.1"
  audit "RESOURCE" "$EXPECTED_RESOURCE"
  audit "XERO_IMAGE" "PINNED"
  audit "QUICKBOOKS_CONTINUITY" "PASS"
  audit "POSTGRES_CONTINUITY" "PASS"
  audit "HEALTH" "PASS"
}

status_gate() {
  verify_boot_failsafe
  verify_boot_failsafe_activation
  deployment_check
  binding_check
  health_check
  if green_compose exec -T accounting-mcp-green sh -eu -c 'test "$XERO_WRITE_ENABLED" = "true"'; then
    verify_autoclose_schedule
    verify_xero_restart_policy "no"
    audit "WRITE_GATE" "OPEN"
    audit "AUTOCLOSE" "ACTIVE"
  else
    green_compose exec -T accounting-mcp-green sh -eu -c 'test "$XERO_WRITE_ENABLED" = "false"' || fail "WRITE_GATE_VALUE_INVALID"
    verify_xero_restart_policy "unless-stopped"
    audit "WRITE_GATE" "CLOSED"
  fi
  audit "BINDING" "PASS"
  audit "RELEASE" "0.3.0-20260810.1"
  audit "RESOURCE" "$EXPECTED_RESOURCE"
  audit "XERO_IMAGE" "PINNED"
  audit "HEALTH" "PASS"
}

case "${1:-}" in
  install-failsafe) install_boot_failsafe ;;
  preflight) preflight ;;
  open) open_gate ;;
  close) close_gate ;;
  status) status_gate ;;
  boot-close) boot_close_gate ;;
  *)
    printf 'usage: %s {install-failsafe|preflight|open|close|status}\n' "$0" >&2
    exit 2
    ;;
esac
