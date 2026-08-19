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
    fail "$file still contains excluded current-release text: $value"
  fi
}

test -f package.json || fail "package.json is missing"
test -f deploy/env.vps.example || fail "deploy/env.vps.example is missing"
test -f deploy/host-nginx/mcp.jiayuanwang.xyz || fail "host Nginx site is missing"

node -e 'JSON.parse(require("node:fs").readFileSync("package.json", "utf8"))' \
  || fail "package.json is invalid"
node scripts/release/production-deployment-contract.mjs . \
  || fail "production deployment immutability contract failed"
node -e 'JSON.parse(require("node:fs").readFileSync("agent-skills/accounting-double-entry-skills-2026-08-10/tests/connector-capability-cases.json", "utf8"))' \
  || fail "connector capability cases are invalid JSON"
for json_file in \
  harness/manifests/contract-v1.json \
  harness/manifests/p0-suite.json \
  harness/scenarios/accounting-case-deterministic.p0.json \
  harness/scenarios/accounting-case-agent2.p0.json \
  harness/scenarios/accounting-case-browser.p0.json \
  harness/remote-agents/manifests/agent2-xero-v040rc-accounting-case-uat.template.json
do
  node -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))' "$json_file" \
    || fail "$json_file is invalid JSON"
done
node -e 'const fs=require("node:fs"); const p=JSON.parse(fs.readFileSync("package.json","utf8")); if(p.version!=="0.4.0-rc.1") process.exit(1)' \
  || fail "package version is not the reviewed 0.4.0-rc.1 candidate"
node -e 'const fs=require("node:fs"),crypto=require("node:crypto"); const allow=JSON.parse(fs.readFileSync("config/tool-allowlist.json","utf8")).tools; const expected=JSON.parse(fs.readFileSync("tests/contract/expected-tools.json","utf8")); const required=["xero_prepare_accounting_case","xero_execute_accounting_case","xero_get_accounting_case_status"]; const legacy=allow.filter((name)=>/^(?:xero_prepare_(?:supplier_bill|sales_invoice|credit_note|manual_journal|quote|purchase_order|contact|item)|xero_create_|xero_update_)/u.test(name)); const hash=crypto.createHash("sha256").update(JSON.stringify(allow)).digest("hex"); if(allow.length!==30 || JSON.stringify(allow)!==JSON.stringify(expected) || required.some((name)=>!allow.includes(name)) || legacy.length || hash!=="ed6667e843ea916ad672ad260d0d7705df75ad4632c181e4e554250b82b076e5") process.exit(1)' \
  || fail "30-tool Accounting Case allowlist or toolset hash drifted"

sh -n deploy/scripts/switch-xero-upstream.sh
sh -n deploy/scripts/admit-and-compose.sh
node --check scripts/release/production-deployment-admission.mjs
node --check deploy/scripts/governance-cutover-contract.mjs
grep -Fq 'readonly GREEN_VERSION="0.4.0-rc.1"' deploy/scripts/switch-xero-upstream.sh
grep -Fq 'readonly GREEN_TOOL_COUNT="28"' deploy/scripts/switch-xero-upstream.sh
grep -Fq 'readonly GREEN_TOOLSET_HASH="ed6667e843ea916ad672ad260d0d7705df75ad4632c181e4e554250b82b076e5"' deploy/scripts/switch-xero-upstream.sh
for required_identity_guard in \
  'APP_IMAGE_MUST_USE_IMMUTABLE_REPO_DIGEST' \
  'GREEN_IMAGE_IDENTITY_MISMATCH' \
  'io.zcloak.xero.build-identity-hash' \
  'XERO_APPROVED_ACCEPTANCE_SOURCE_SHA256' \
  'XERO_APPROVED_SOURCE_ARCHIVE_SHA256' \
  'PRODUCTION_DEPLOYMENT_ADMISSION_FAILED' \
  '/usr/bin/node scripts/release/production-deployment-admission.mjs --format fields' \
  'accepted_manifest_digest' \
  'XERO_ADMITTED_GOVERNANCE_TRUST_BUNDLE_SHA256' \
  'XERO_ADMITTED_GOVERNANCE_RECEIPTS_SHA256' \
  'XERO_ADMITTED_GOVERNANCE_STATUS_SHA256' \
  'deploy/scripts/governance-cutover-contract.mjs'
do
  grep -Fq "$required_identity_guard" deploy/scripts/switch-xero-upstream.sh \
    || fail "cutover is missing OCI identity guard: $required_identity_guard"
done
grep -Fq 'node:22.22.3-alpine3.23@sha256:968df39aedcea65eeb078fb336ed7191baf48f972b4479711397108be0966920' deploy/Dockerfile \
  || fail "Dockerfile base image is not pinned by digest"
grep -Fq 'XERO_BUILD_IDENTITY_JSON' deploy/Dockerfile \
  || fail "Dockerfile does not embed the approved build identity"
grep -Fq 'verify-accepted-build-context.mjs' deploy/Dockerfile \
  || fail "Dockerfile does not verify accepted source bytes before build"
if grep -Eq '^[[:space:]]*#[[:space:]]*syntax=' deploy/Dockerfile; then
  fail "Dockerfile selects a mutable external syntax frontend"
fi
grep -Fq 'build-accepted-oci-image.mjs' scripts/release/local-acceptance-gate-lib.mjs \
  || fail "local Gate does not build an accepted OCI artifact"
grep -Fq 'smoke-accepted-oci-runtime.mjs' scripts/release/local-acceptance-gate-lib.mjs \
  || fail "local Gate does not start and verify the accepted OCI artifact"
if grep -Eq '^[[:space:]]*docker build([[:space:]]|$)' deploy/HETZNER-HOST-NGINX-RUNBOOK.md; then
  fail "runbook rebuilds the Gate-accepted OCI artifact"
fi
grep -Fq 'APP_IMAGE=REPLACE_WITH_REGISTRY_REPOSITORY@sha256:' deploy/env.vps.example \
  || fail "deployment example does not require an immutable app image digest"
bash -n scripts/agent2_uat_write_gate_vps.sh

for current_release_file in \
  README.md \
  docs/XERO-MCP-CURRENT-CAPABILITIES-ZH.md \
  harness/manifests/contract-v1.json \
  harness/manifests/personas.json \
  harness/manifests/oracle-policy.json \
  harness/manifests/claim-guardrails.json \
  harness/manifests/expected-reds.json \
  harness/manifests/p0-suite.json \
  harness/scenarios/accounting-case-deterministic.p0.json \
  harness/scenarios/accounting-case-agent2.p0.json \
  harness/scenarios/accounting-case-browser.p0.json \
  harness/runners/run-contract.ts \
  harness/runners/run-p0-accounting-case.ts \
  harness/runners/run-p0-readonly.ts \
  harness/remote-agents/manifests/live-readonly.template.json \
  harness/remote-agents/manifests/mock-write-no-retry.json \
  harness/remote-agents/manifests/agent2-xero-v040rc-accounting-case-uat.template.json
do
  forbid_text "$current_release_file" "confirmation_phrase"
  forbid_text "$current_release_file" "user_confirmation"
done

require_text docs/XERO-MCP-CURRENT-CAPABILITIES-ZH.md '当前候选：`0.4.0-rc.1` / 30 个公共工具 / Accounting Case / Standing Delegation'
require_text docs/XERO-MCP-CURRENT-CAPABILITIES-ZH.md '尚未部署，Agent2 与 Work 的 0.4 写入验收尚未执行'
forbid_text docs/XERO-MCP-CURRENT-CAPABILITIES-ZH.md '用户输入当前提案的一次性确认句'
forbid_text docs/XERO-MCP-CURRENT-CAPABILITIES-ZH.md '补齐 Host 级签名确认'

node -e 'const fs=require("node:fs"); const suite=JSON.parse(fs.readFileSync("harness/manifests/p0-suite.json","utf8")); const current=["harness/scenarios/accounting-case-deterministic.p0.json","harness/scenarios/accounting-case-agent2.p0.json","harness/scenarios/accounting-case-browser.p0.json"]; if(JSON.stringify(suite.scenario_manifests)!==JSON.stringify(current)) process.exit(1)' \
  || fail "P0 suite does not point exclusively to the three current Accounting Case manifests"
require_text harness/remote-agents/manifests/agent2-xero-v040rc-accounting-case-uat.template.json '"releaseContract": "0.4.0-rc.1 / 28 public tools / Standing Delegation"'
require_text harness/remote-agents/manifests/agent2-production-current-readonly-2026-08-06.json '"lifecycle": "HISTORICAL_0_3_READONLY_EVIDENCE_ONLY"'
require_text harness/remote-agents/manifests/agent2-xero-v030-business-readonly-prepare-first-2026-08-08.json '"lifecycle": "HISTORICAL_0_3_EVIDENCE_ONLY"'
require_text scripts/agent2_uat_write_gate_vps.sh 'HISTORICAL 0.3.1 UAT SCRIPT ONLY'

require_text deploy/env.vps.example "MCP_OAUTH_BROKER_ENABLED=true"
require_text deploy/env.vps.example "PERSONAL_POC_ONLY=true"
require_text deploy/env.vps.example "SHARED_TEST_USERS=true"
require_text deploy/env.vps.example "HOST_OAUTH_CLIENTS_JSON="
require_text deploy/env.vps.example "OAUTH_MANUAL_RETURN_CLIENT_IDS="
require_text deploy/env.vps.example "XERO_WRITE_ENABLED=false"
require_text deploy/env.vps.example "XERO_AUTHORITY_REVISION=1"
require_text deploy/env.vps.example "XERO_TARGET_SESSION_REQUIRED=true"
require_text deploy/env.vps.example "XERO_TARGET_SESSION_TTL_SECONDS=1800"

require_text deploy/docker-compose/compose.host-nginx.vps.yaml 'SHARED_TEST_USERS: ${SHARED_TEST_USERS:-false}'
require_text deploy/docker-compose/compose.host-nginx.green.vps.yaml 'SHARED_TEST_USERS: ${SHARED_TEST_USERS:-false}'
for oauth_compose_file in \
  deploy/docker-compose/compose.host-nginx.green.vps.yaml \
  deploy/docker-compose/compose.host-nginx.vps.yaml \
  deploy/docker-compose/compose.vps.yaml
do
  require_text "$oauth_compose_file" 'OAUTH_MISSING_RESOURCE_COMPAT_CLIENT_IDS: ${OAUTH_MISSING_RESOURCE_COMPAT_CLIENT_IDS:-}'
  require_text "$oauth_compose_file" 'OAUTH_MANUAL_RETURN_CLIENT_IDS: ${OAUTH_MANUAL_RETURN_CLIENT_IDS:-}'
done
require_text deploy/docker-compose/compose.host-nginx.vps.yaml 'XERO_TARGET_SESSION_REQUIRED: ${XERO_TARGET_SESSION_REQUIRED:-true}'
require_text deploy/docker-compose/compose.host-nginx.green.vps.yaml 'XERO_TARGET_SESSION_REQUIRED: ${XERO_TARGET_SESSION_REQUIRED:-true}'
require_text deploy/docker-compose/compose.vps.yaml 'XERO_TARGET_SESSION_REQUIRED: ${XERO_TARGET_SESSION_REQUIRED:-true}'
node -e '
  const fs = require("node:fs");
  const manifest = JSON.parse(fs.readFileSync("src/db/required-migrations.json", "utf8"));
  const migrations = manifest.requiredMigrations;
  const sorted = Array.isArray(migrations) ? [...migrations].sort((a, b) => a.localeCompare(b, "en")) : [];
  if (manifest.schemaVersion !== 1 || !Array.isArray(migrations) || migrations.length === 0 ||
      migrations.some((migration) => typeof migration !== "string" || !/^\d{3}_[a-z0-9_]+\.sql$/u.test(migration)) ||
      new Set(migrations).size !== migrations.length || migrations.some((migration, index) => migration !== sorted[index])) {
    process.exit(1);
  }
  const missing = migrations.filter((migration) => !fs.existsSync(`migrations/${migration}`));
  if (missing.length > 0) process.exit(1);
' || fail "required migration manifest is invalid or a required migration is missing"
require_text src/db/migrate.ts 'assertRequiredMigrationsPresent(files)'
require_text src/db/postgresRepository.ts 'FROM unnest($1::text[]) AS required(version)'
require_text scripts/release/release-bundle-lib.mjs '...REQUIRED_MIGRATION_RELEASE_FILES'
require_text src/xeroRelease.ts 'requiredMigration: REQUIRED_MIGRATION_HEAD'
require_text src/xeroRelease.ts 'ledgerAuthoritySnapshot: LEDGER_AUTHORITY_SNAPSHOT_SCHEMA_VERSION'
require_text src/server.ts 'authoritySnapshotResolver: new RepositoryLedgerAuthoritySnapshotResolver(repository)'
require_text src/db/postgresRepository.ts 'SELECT pg_advisory_xact_lock($1::integer, hashtext($2)::integer)'
require_text src/http/app.ts 'authoritySnapshotRevision: evidence.authoritySnapshotRevision'
require_text src/http/app.ts 'standingDelegationsConfigSha256: config.xeroStandingDelegationsConfigSha256 ?? null'
require_text src/http/app.ts 'config.xeroWriteEnabled && evidence.authorityWriteKillSwitchEnabled === true'
require_text src/xeroRelease.ts 'accountingCaseReadbackValidator: ACCOUNTING_CASE_READBACK_VALIDATOR_VERSION'
require_text src/xeroRelease.ts 'xeroNativeRouteContract: XERO_NATIVE_ROUTE_CONTRACT_VERSION'
require_text src/xeroRelease.ts 'xeroContactIdentityContract: XERO_CONTACT_IDENTITY_CONTRACT_VERSION'
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

# A provider/mapper test that never loads a real captured Xero response is the
# same echo-back test double this repo has already shipped five production
# defects from. Require every file in these two families to cite the fixture
# module, so a new test cannot be added - or an existing one gutted back down
# to hand-built bodies - without also removing this line.
# Excluding a test file from the default suite is allowed - the review subsystem
# is a diagnostic, not a release gate - but it may not be a way to make a failure
# disappear. Every test file excluded in vitest.config.ts must be named by the
# npm script that still runs it, so dropping one silently is not possible.
node -e 'const fs=require("node:fs"); const cfg=fs.readFileSync("vitest.config.ts","utf8"); const pkg=JSON.parse(fs.readFileSync("package.json","utf8")); const block=cfg.slice(cfg.indexOf("exclude: [")); const excluded=[...block.slice(0, block.indexOf("]")).matchAll(/"([^"]*\.test\.ts)"/g)].map((m)=>m[1]); const scripts=Object.values(pkg.scripts||{}).join(" "); const orphan=excluded.filter((file)=>!scripts.includes(file)); if(excluded.length===0||orphan.length) { console.error("excluded but unrun: "+orphan.join(",")); process.exit(1); }' \
  || fail "a test file excluded from the default suite is not run by any npm script"

for fixture_wired_test in tests/xero-*-primitives.test.ts tests/provider-*.test.ts
do
  require_text "$fixture_wired_test" "xero-provider-responses"
done

printf 'static verification passed: Xero-only repository, strict target sessions, and shared-test OAuth configuration\n'
