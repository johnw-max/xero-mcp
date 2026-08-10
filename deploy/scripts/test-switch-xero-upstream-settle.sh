#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
UPSTREAM_SWITCH="${1:-${SCRIPT_DIR}/switch-xero-upstream.sh}"

fail() {
  printf 'switch settle test failed: %s\n' "$1" >&2
  exit 1
}

read_count() {
  count_file=$1
  if test -f "$count_file"; then
    cat "$count_file"
  else
    printf '0'
  fi
}

assert_count() {
  count_file=$1
  expected=$2
  label=$3
  actual=$(read_count "$count_file")
  test "$actual" = "$expected" || fail "${label}: expected ${expected}, got ${actual}"
}

assert_contains() {
  file=$1
  expected=$2
  grep -F -- "$expected" "$file" >/dev/null || fail "missing '${expected}' in ${file}"
}

assert_not_contains() {
  file=$1
  forbidden=$2
  if grep -F -- "$forbidden" "$file" >/dev/null; then
    fail "unexpected '${forbidden}' in ${file}"
  fi
}

test -f "$UPSTREAM_SWITCH" || fail "missing upstream switch script"

TEST_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/xero-switch-settle.XXXXXX")
trap 'rm -rf -- "$TEST_ROOT"' EXIT HUP INT TERM
TEST_BIN="${TEST_ROOT}/bin"
mkdir -p "$TEST_BIN"

cat >"${TEST_BIN}/flock" <<'EOF'
#!/bin/sh
exit 0
EOF

cat >"${TEST_BIN}/nginx" <<'EOF'
#!/bin/sh
test "${1:-}" = "-t" || exit 64
count_file="${SWITCH_TEST_STATE_DIR:?}/nginx-test-count"
count=0
test ! -f "$count_file" || count=$(cat "$count_file")
printf '%s\n' "$((count + 1))" >"$count_file"
EOF

cat >"${TEST_BIN}/systemctl" <<'EOF'
#!/bin/sh
test "${1:-}" = "reload" && test "${2:-}" = "nginx" || exit 64
count_file="${SWITCH_TEST_STATE_DIR:?}/reload-count"
count=0
test ! -f "$count_file" || count=$(cat "$count_file")
printf '%s\n' "$((count + 1))" >"$count_file"
EOF

cat >"${TEST_BIN}/curl" <<'EOF'
#!/bin/sh
url=
max_time=
while test "$#" -gt 0; do
  case "$1" in
    --max-time) shift; max_time=${1:?} ;;
    http://*|https://*) url=$1 ;;
  esac
  shift
done

next_count() {
  name=$1
  count_file="${SWITCH_TEST_STATE_DIR:?}/${name}"
  count=0
  test ! -f "$count_file" || count=$(cat "$count_file")
  count=$((count + 1))
  printf '%s\n' "$count" >"$count_file"
  printf '%s' "$count"
}

case "$url" in
  http://127.0.0.1:18004/healthz)
    test "$max_time" = "15" || exit 67
    printf '%s' '{"status":"ok","version":"0.3.0","toolCount":43,"toolsetHash":"a76bf853dc4bc71bf33e5b42f936fbcc9d6593d67d23e40dedccc4d1e2ae5d65"}'
    ;;
  http://127.0.0.1:18004/readyz)
    test "$max_time" = "15" || exit 67
    printf '%s' '{"status":"ready","version":"0.3.0"}'
    ;;
  */quickbooks/healthz)
    count=$(next_count quickbooks-health-count)
    if test "$count" -eq 1; then
      test "$max_time" = "15" || exit 67
    else
      test "$max_time" = "1" || exit 67
    fi
    printf '%s' '{"status":"ok","provider":"quickbooks-online"}'
    ;;
  */quickbooks/readyz)
    count=$(next_count quickbooks-ready-count)
    if test "$count" -eq 1; then
      test "$max_time" = "15" || exit 67
    else
      test "$max_time" = "1" || exit 67
    fi
    if test "${SWITCH_PUBLIC_MODE:?}" = "quickbooks_always_wrong" \
      && test "$count" -gt 1; then
      printf '%s' '{"status":"not_ready"}'
    else
      printf '%s' '{"status":"ready"}'
    fi
    ;;
  https://*/healthz)
    count=$(next_count xero-public-health-count)
    if test "${SWITCH_PUBLIC_MODE:?}" = "target_ready"; then
      test "$max_time" = "15" || exit 67
    else
      test "$max_time" = "1" || exit 67
    fi
    case "${SWITCH_PUBLIC_MODE:?}" in
      stale_then_target)
        if test "$count" -eq 1; then
          printf '%s' '{"status":"ok","version":"0.2.13","toolCount":15}'
        else
          printf '%s' '{"status":"ok","version":"0.3.0","toolCount":43,"toolsetHash":"a76bf853dc4bc71bf33e5b42f936fbcc9d6593d67d23e40dedccc4d1e2ae5d65"}'
        fi
        ;;
      target_always_wrong)
        printf '%s' '{"status":"ok","version":"0.2.13","toolCount":15}'
        ;;
      target_ready|quickbooks_always_wrong)
        printf '%s' '{"status":"ok","version":"0.3.0","toolCount":43,"toolsetHash":"a76bf853dc4bc71bf33e5b42f936fbcc9d6593d67d23e40dedccc4d1e2ae5d65"}'
        ;;
      *) exit 65 ;;
    esac
    ;;
  https://*/readyz)
    count=$(next_count xero-public-ready-count)
    if test "${SWITCH_PUBLIC_MODE:?}" = "target_ready"; then
      test "$max_time" = "15" || exit 67
    else
      test "$max_time" = "1" || exit 67
    fi
    case "${SWITCH_PUBLIC_MODE:?}" in
      stale_then_target)
        if test "$count" -eq 1; then
          printf '%s' '{"status":"ready","version":"0.2.13"}'
        else
          printf '%s' '{"status":"ready","version":"0.3.0"}'
        fi
        ;;
      target_always_wrong)
        printf '%s' '{"status":"ready","version":"0.2.13"}'
        ;;
      target_ready|quickbooks_always_wrong)
        printf '%s' '{"status":"ready","version":"0.3.0"}'
        ;;
      *) exit 65 ;;
    esac
    ;;
  *) exit 66 ;;
esac
EOF

cat >"${TEST_BIN}/sleep" <<'EOF'
#!/bin/sh
test "$#" -eq 1 || exit 64
case "${1:-}" in
  1) ;;
  *) exit 65 ;;
esac
count_file="${SWITCH_TEST_STATE_DIR:?}/sleep-count"
count=0
test ! -f "$count_file" || count=$(cat "$count_file")
printf '%s\n' "$((count + 1))" >"$count_file"
EOF

cat >"${TEST_BIN}/install" <<'EOF'
#!/bin/sh
for argument do target=$argument; done
mkdir -p "$target"
EOF

cat >"${TEST_BIN}/cp" <<'EOF'
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

cat >"${TEST_BIN}/chown" <<'EOF'
#!/bin/sh
exit 0
EOF

cat >"${TEST_BIN}/chmod" <<'EOF'
#!/bin/sh
case "${1:-}" in
  --reference=*) /bin/chmod 600 "$2" ;;
  *) /bin/chmod "$@" ;;
esac
EOF

cat >"${TEST_BIN}/mv" <<'EOF'
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

chmod 700 "${TEST_BIN}"/*

prepare_case() {
  case_name=$1
  initial_port=$2
  CASE_DIR="${TEST_ROOT}/${case_name}"
  CASE_SITE="${CASE_DIR}/mcp.jiayuanwang.xyz"
  CASE_SCRIPT="${CASE_DIR}/switch-xero-upstream.sh"
  CASE_OUTPUT="${CASE_DIR}/output"
  mkdir -p "$CASE_DIR"
  cat >"$CASE_SITE" <<EOF
upstream xero_accounting_mcp_demo {
    server 127.0.0.1:${initial_port};
}
upstream quickbooks_accounting_mcp_demo {
    server 127.0.0.1:18003;
}
EOF
  sed \
    -e "s|^readonly LOCK_FILE=.*|readonly LOCK_FILE=\"${CASE_DIR}/switch.lock\"|" \
    -e "s|^readonly BACKUP_DIR=.*|readonly BACKUP_DIR=\"${CASE_DIR}/backups\"|" \
    "$UPSTREAM_SWITCH" >"$CASE_SCRIPT"
  chmod 700 "$CASE_SCRIPT"
}

run_green() {
  mode=$1
  env \
    PATH="${TEST_BIN}:/usr/bin:/bin:/usr/sbin:/sbin" \
    SWITCH_TEST_STATE_DIR="$CASE_DIR" \
    SWITCH_PUBLIC_MODE="$mode" \
    XERO_NGINX_SITE_FILE="$CASE_SITE" \
    "$CASE_SCRIPT" green >"$CASE_OUTPUT" 2>&1
}

# A graceful reload may briefly serve the old blue worker. The switch must
# settle on the exact green contract instead of restoring a healthy release.
prepare_case stale_then_target 18002
run_green stale_then_target || fail "stale-then-target switch did not settle"
assert_contains "$CASE_SITE" "server 127.0.0.1:18004;"
assert_not_contains "$CASE_SITE" "server 127.0.0.1:18002;"
assert_contains "$CASE_OUTPUT" "XERO_UPSTREAM=GREEN_18004"
assert_contains "$CASE_OUTPUT" "CHANGED=true"
assert_count "${CASE_DIR}/xero-public-health-count" 2 "stale-then-target Xero health attempts"
assert_count "${CASE_DIR}/xero-public-ready-count" 2 "stale-then-target Xero ready attempts"
assert_count "${CASE_DIR}/quickbooks-health-count" 3 "stale-then-target QuickBooks health checks"
assert_count "${CASE_DIR}/quickbooks-ready-count" 3 "stale-then-target QuickBooks ready checks"
assert_count "${CASE_DIR}/sleep-count" 1 "stale-then-target settle sleeps"

# A target that never reaches the exact contract must remain bounded and restore
# the original site through the existing audited recovery path.
prepare_case target_always_wrong 18002
if run_green target_always_wrong; then
  fail "permanently wrong public target unexpectedly succeeded"
fi
assert_contains "$CASE_SITE" "server 127.0.0.1:18002;"
assert_not_contains "$CASE_SITE" "server 127.0.0.1:18004;"
assert_contains "$CASE_OUTPUT" "ERROR=PUBLIC_CHECK_FAILED_AND_UPSTREAM_RESTORED"
assert_count "${CASE_DIR}/xero-public-health-count" 3 "bounded Xero health attempts"
assert_count "${CASE_DIR}/xero-public-ready-count" 3 "bounded Xero ready attempts"
assert_count "${CASE_DIR}/quickbooks-health-count" 4 "QuickBooks checked on every failed target attempt"
assert_count "${CASE_DIR}/quickbooks-ready-count" 4 "QuickBooks ready checked on every failed target attempt"
assert_count "${CASE_DIR}/sleep-count" 2 "bounded settle sleeps"
assert_count "${CASE_DIR}/reload-count" 2 "target failure reload plus restore reload"

# QuickBooks is part of every settled snapshot. A continuously invalid
# QuickBooks result must retain its dedicated restore outcome.
prepare_case quickbooks_always_wrong 18002
if run_green quickbooks_always_wrong; then
  fail "permanently wrong QuickBooks public result unexpectedly succeeded"
fi
assert_contains "$CASE_SITE" "server 127.0.0.1:18002;"
assert_contains "$CASE_OUTPUT" "ERROR=QUICKBOOKS_PUBLIC_CHECK_FAILED_AND_UPSTREAM_RESTORED"
assert_count "${CASE_DIR}/xero-public-health-count" 3 "QuickBooks-failure Xero health attempts"
assert_count "${CASE_DIR}/xero-public-ready-count" 3 "QuickBooks-failure Xero ready attempts"
assert_count "${CASE_DIR}/quickbooks-health-count" 4 "bounded QuickBooks health attempts"
assert_count "${CASE_DIR}/quickbooks-ready-count" 4 "bounded QuickBooks ready attempts"
assert_count "${CASE_DIR}/sleep-count" 2 "QuickBooks-failure settle sleeps"

# Already-active has no reload race: retain the existing one-shot verification,
# emit CHANGED=false, and never add settle sleeps or a reload.
prepare_case already_active 18004
run_green target_ready || fail "already-active exact target was rejected"
assert_contains "$CASE_OUTPUT" "XERO_UPSTREAM=GREEN_18004"
assert_contains "$CASE_OUTPUT" "CHANGED=false"
assert_count "${CASE_DIR}/xero-public-health-count" 1 "already-active Xero health checks"
assert_count "${CASE_DIR}/xero-public-ready-count" 1 "already-active Xero ready checks"
assert_count "${CASE_DIR}/quickbooks-health-count" 1 "already-active QuickBooks health checks"
assert_count "${CASE_DIR}/quickbooks-ready-count" 1 "already-active QuickBooks ready checks"
assert_count "${CASE_DIR}/sleep-count" 0 "already-active settle sleeps"
assert_count "${CASE_DIR}/reload-count" 0 "already-active reloads"

printf '%s\n' "upstream switch public settle tests passed"
