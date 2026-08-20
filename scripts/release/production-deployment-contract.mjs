import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const PRODUCTION_COMPOSE_PATHS = Object.freeze([
  "deploy/docker-compose/compose.vps.yaml",
  "deploy/docker-compose/compose.host-nginx.vps.yaml",
  "deploy/docker-compose/compose.host-nginx.green.vps.yaml",
]);

export const PRODUCTION_RUNBOOK_PATHS = Object.freeze([
  "deploy/HETZNER_RUNBOOK.md",
  "deploy/HETZNER-HOST-NGINX-RUNBOOK.md",
]);

export const DEV_COMPOSE_PATH = "deploy/docker-compose/compose.dev.yaml";
export const PRODUCTION_ADMISSION_WRAPPER_PATH = "deploy/scripts/admit-and-compose.sh";
export const PRODUCTION_CUTOVER_PATH = "deploy/scripts/switch-xero-upstream.sh";
export const PRODUCTION_ADMISSION_VERIFIER_PATH = "scripts/release/production-deployment-admission.mjs";

function requireText(text, pattern, errorCode) {
  if (!pattern.test(text)) throw new Error(errorCode);
}

export function assertProductionComposeContract(path, content) {
  const text = content.toString("utf8");
  if (/^\s*build:/mu.test(text)) throw new Error(`PRODUCTION_COMPOSE_BUILD_FORBIDDEN:${path}`);
  const imageLines = [...text.matchAll(/^\s*image:\s*(\S.*)$/gmu)].map((match) => match[1].trim());
  if (imageLines.length === 0) throw new Error(`PRODUCTION_COMPOSE_IMAGE_MISSING:${path}`);
  for (const image of imageLines) {
    const literalDigest = /^[^\s@$]+(?:\/[^\s@$]+)*(?::[^\s@]+)?@sha256:[a-f0-9]{64}$/u.test(image);
    const requiredAppDigest = /^\$\{APP_IMAGE:\?[^}]*repo@sha256[^}]*\}$/u.test(image);
    if (!literalDigest && !requiredAppDigest) {
      throw new Error(`PRODUCTION_COMPOSE_IMAGE_NOT_IMMUTABLE:${path}:${image}`);
    }
  }
  requireText(
    text,
    /APP_IMAGE must be an immutable repo@sha256 digest/u,
    `PRODUCTION_COMPOSE_APP_DIGEST_GUARD_MISSING:${path}`,
  );
  requireText(
    text,
    /^\s*NODE_ENV:\s*production\s*$/mu,
    `PRODUCTION_COMPOSE_NODE_ENV_INVALID:${path}`,
  );
  if (/XERO_ACCOUNTING_CASE_BUSINESS_AUTHORITIES_JSON/u.test(text)) {
    throw new Error(`PRODUCTION_COMPOSE_CANDIDATE_GOVERNANCE_FORBIDDEN:${path}`);
  }
  if (/xero-governance|XERO_GOVERNANCE_|XERO_STANDING_DELEGATIONS_|XERO_EXPECTED_AUTHORITY_|XERO_AUTHORITY_REVISION/u.test(text)) {
    throw new Error(`PRODUCTION_COMPOSE_LEGACY_GOVERNANCE_FORBIDDEN:${path}`);
  }
  return true;
}

export function assertDevComposeContract(path, content) {
  const text = content.toString("utf8");
  requireText(text, /^# DEV-ONLY rebuild path\./mu, `DEV_COMPOSE_MARKER_MISSING:${path}`);
  requireText(text, /^\s*build:\s*$/mu, `DEV_COMPOSE_BUILD_MISSING:${path}`);
  requireText(text, /^\s*NODE_ENV:\s*development\s*$/mu, `DEV_COMPOSE_NODE_ENV_INVALID:${path}`);
  requireText(text, /^\s*XERO_WRITE_ENABLED:\s*["']false["']\s*$/mu, `DEV_COMPOSE_WRITE_GATE_INVALID:${path}`);
  if (/^\s*NODE_ENV:\s*production\s*$/mu.test(text)) throw new Error(`DEV_COMPOSE_PRODUCTION_FORBIDDEN:${path}`);
  return true;
}

export function assertProductionRunbookContract(path, content) {
  const text = content.toString("utf8");
  const logical = text.replaceAll(/\\\r?\n[ \t]*/gu, " ");
  if (/^[ \t]*(?:sudo\s+)?docker\s+(?:compose\s+)?build\b/mu.test(logical) ||
      /^[ \t]*(?:sudo\s+)?docker\s+compose\b[^\n]*(?:^|\s)build(?:\s|$)/mu.test(logical)) {
    throw new Error(`PRODUCTION_RUNBOOK_BUILD_COMMAND_FORBIDDEN:${path}`);
  }
  for (const line of logical.split(/\r?\n/u)) {
    if (!/^\s*(?:sudo\s+)?docker\s+compose\b/u.test(line)) continue;
    if (/\s(?:up|run)\s/u.test(line)) {
      throw new Error(`PRODUCTION_RUNBOOK_DIRECT_MUTATION_FORBIDDEN:${path}`);
    }
    if (line.includes(DEV_COMPOSE_PATH)) throw new Error(`PRODUCTION_RUNBOOK_DEV_COMPOSE_FORBIDDEN:${path}`);
  }
  requireText(
    text,
    /sudo deploy\/scripts\/admit-and-compose\.sh/u,
    `PRODUCTION_RUNBOOK_ADMISSION_COMMAND_MISSING:${path}`,
  );
  requireText(
    text,
    /\/srv\/xero-accounting-mcp\/release/u,
    `PRODUCTION_RUNBOOK_FIXED_ARTIFACT_ROOT_MISSING:${path}`,
  );
  requireText(
    text,
    /\/etc\/xero-accounting-mcp\/release\.env/u,
    `PRODUCTION_RUNBOOK_FIXED_ENV_ROOT_MISSING:${path}`,
  );
  return true;
}

export function assertProductionAdmissionWrapperContract(path, content) {
  const text = content.toString("utf8");
  const admission = text.indexOf("/usr/bin/node scripts/release/production-deployment-admission.mjs");
  const dispatch = text.indexOf('case "${1:-}" in');
  if (admission < 0 || dispatch < 0 || admission > dispatch) {
    throw new Error(`PRODUCTION_ADMISSION_WRAPPER_ORDER_INVALID:${path}`);
  }
  requireText(text, /readonly DOCKER_CLI="\/usr\/bin\/docker"/u, `PRODUCTION_ADMISSION_DOCKER_NOT_PINNED:${path}`);
  requireText(text, /readonly ENV_FILE="\/etc\/xero-accounting-mcp\/release\.env"/u, `PRODUCTION_ADMISSION_ENV_NOT_PINNED:${path}`);
  if (/\bdocker\s+(?:compose\s+)?build\b/u.test(text)) throw new Error(`PRODUCTION_ADMISSION_BUILD_FORBIDDEN:${path}`);
  for (const line of text.replaceAll(/\\\r?\n[ \t]*/gu, " ").split(/\r?\n/u)) {
    if (/exec "\$DOCKER_CLI" compose\b/u.test(line) && /\s(?:up|run)\s/u.test(line) &&
        !/\s--no-build(?:\s|$)/u.test(line)) {
      throw new Error(`PRODUCTION_ADMISSION_NO_BUILD_FLAG_MISSING:${path}`);
    }
  }
  return true;
}

export function assertProductionCutoverContract(path, content) {
  const text = content.toString("utf8");
  requireText(text, /\/usr\/bin\/node scripts\/release\/production-deployment-admission\.mjs --format fields/u,
    `PRODUCTION_CUTOVER_ADMISSION_MISSING:${path}`);
  requireText(text, /RELEASE_ENV_OVERRIDE_FORBIDDEN/u, `PRODUCTION_CUTOVER_ENV_OVERRIDE_ALLOWED:${path}`);
  requireText(
    text,
    /activeAccountingCaseRecoveryProjection[^\n]*COMPATIBLE/u,
    `PRODUCTION_CUTOVER_ACTIVE_RECOVERY_PROJECTION_GUARD_MISSING:${path}`,
  );
  if (/release_env_value|verify-accepted-oci-release\.mjs/u.test(text)) {
    throw new Error(`PRODUCTION_CUTOVER_PATH_REREAD_FORBIDDEN:${path}`);
  }
  requireText(text, /XERO_ADMITTED_WRITE_ENABLED/u, `PRODUCTION_CUTOVER_WRITE_GATE_MISSING:${path}`);
  return true;
}

export function assertProductionAdmissionVerifierContract(path, content) {
  const text = content.toString("utf8");
  for (const required of [
    "O_NOFOLLOW",
    "PRODUCTION_RELEASE_ENV_PATH",
    "PRODUCTION_RELEASE_ARTIFACT_ROOT",
    "assertDirectoryChainUnchanged",
    "result.writeEnabled",
    "PRODUCTION_APP_IMAGE_NOT_ACCEPTED_OCI_MANIFEST",
    "assertPulledProductionImageIdentity",
  ]) requireText(text, new RegExp(required.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"),
    `PRODUCTION_ADMISSION_VERIFIER_GUARD_MISSING:${path}:${required}`);
  return true;
}

export function assertProductionDeploymentArtifactMap(files) {
  for (const path of PRODUCTION_COMPOSE_PATHS) {
    const content = files.get(path);
    if (!content) throw new Error(`PRODUCTION_COMPOSE_MISSING:${path}`);
    assertProductionComposeContract(path, content);
  }
  const dev = files.get(DEV_COMPOSE_PATH);
  if (!dev) throw new Error(`DEV_COMPOSE_MISSING:${DEV_COMPOSE_PATH}`);
  assertDevComposeContract(DEV_COMPOSE_PATH, dev);
  for (const path of PRODUCTION_RUNBOOK_PATHS) {
    const content = files.get(path);
    if (!content) throw new Error(`PRODUCTION_RUNBOOK_MISSING:${path}`);
    assertProductionRunbookContract(path, content);
  }
  const wrapper = files.get(PRODUCTION_ADMISSION_WRAPPER_PATH);
  if (!wrapper) throw new Error(`PRODUCTION_ADMISSION_WRAPPER_MISSING:${PRODUCTION_ADMISSION_WRAPPER_PATH}`);
  assertProductionAdmissionWrapperContract(PRODUCTION_ADMISSION_WRAPPER_PATH, wrapper);
  const cutover = files.get(PRODUCTION_CUTOVER_PATH);
  if (!cutover) throw new Error(`PRODUCTION_CUTOVER_MISSING:${PRODUCTION_CUTOVER_PATH}`);
  assertProductionCutoverContract(PRODUCTION_CUTOVER_PATH, cutover);
  const verifier = files.get(PRODUCTION_ADMISSION_VERIFIER_PATH);
  if (!verifier) throw new Error(`PRODUCTION_ADMISSION_VERIFIER_MISSING:${PRODUCTION_ADMISSION_VERIFIER_PATH}`);
  assertProductionAdmissionVerifierContract(PRODUCTION_ADMISSION_VERIFIER_PATH, verifier);
  return true;
}

export async function verifyProductionDeploymentSource(repoRoot) {
  const paths = [
    ...PRODUCTION_COMPOSE_PATHS,
    DEV_COMPOSE_PATH,
    ...PRODUCTION_RUNBOOK_PATHS,
    PRODUCTION_ADMISSION_WRAPPER_PATH,
    PRODUCTION_CUTOVER_PATH,
    PRODUCTION_ADMISSION_VERIFIER_PATH,
  ];
  const contents = await Promise.all(paths.map((path) => readFile(resolve(repoRoot, path))));
  return assertProductionDeploymentArtifactMap(new Map(paths.map((path, index) => [path, contents[index]])));
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (entry === import.meta.url) {
  verifyProductionDeploymentSource(resolve(process.argv[2] ?? "."))
    .then(() => process.stdout.write('{"status":"PASS","contract":"PRODUCTION_DEPLOYMENT_IMMUTABILITY"}\n'))
    .catch((error) => {
      process.stderr.write(`${JSON.stringify({
        status: "FAIL",
        error: error instanceof Error ? error.message : String(error),
      })}\n`);
      process.exitCode = 1;
    });
}
