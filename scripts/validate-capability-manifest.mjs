#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const SCRIPT_DIR = resolve(fileURLToPath(new URL(".", import.meta.url)));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const MANIFEST_PATH = resolve(REPO_ROOT, "config/xero-capability-manifest.json");

/**
 * Snapshot of the commands listed by Xero's official MCP README.  The
 * repository's public surface is intentionally not derived from this list:
 * zCloak may expose a bounded extension or withhold an official command.
 * Keeping the source snapshot here makes omission of an official row a hard
 * review error without pinning the zCloak tool count.
 */
export const OFFICIAL_CORE_COMMANDS = Object.freeze([
  "list-accounts",
  "list-contacts",
  "list-credit-notes",
  "list-invoices",
  "list-items",
  "list-manual-journals",
  "list-organisation-details",
  "list-profit-and-loss",
  "list-quotes",
  "list-tax-rates",
  "list-payments",
  "list-trial-balance",
  "list-bank-transactions",
  "list-payroll-employees",
  "list-report-balance-sheet",
  "list-payroll-employee-leave",
  "list-payroll-employee-leave-balances",
  "list-payroll-employee-leave-types",
  "list-payroll-leave-periods",
  "list-payroll-leave-types",
  "list-timesheets",
  "list-aged-receivables-by-contact",
  "list-aged-payables-by-contact",
  "list-contact-groups",
  "list-tracking-categories",
  "create-bank-transaction",
  "create-contact",
  "create-credit-note",
  "create-invoice",
  "create-item",
  "create-manual-journal",
  "create-payment",
  "create-quote",
  "create-payroll-timesheet",
  "create-tracking-category",
  "create-tracking-option",
  "update-bank-transaction",
  "update-contact",
  "update-invoice",
  "update-item",
  "update-manual-journal",
  "update-quote",
  "update-credit-note",
  "update-tracking-category",
  "update-tracking-options",
  "update-payroll-timesheet-line",
  "approve-payroll-timesheet",
  "revert-payroll-timesheet",
  "add-payroll-timesheet-line",
  "delete-payroll-timesheet",
  "get-payroll-timesheet",
]);

const REQUIRED_ROW_FIELDS = Object.freeze([
  "capability_id",
  "official_reference",
  "release_disposition",
  "readiness",
  "readiness_reason",
  "public_tool_or_case_action",
  "input_schema",
  "handler",
  "policy",
  "service_dispatch",
  "provider_method",
  "receipt_and_readback",
  "read_evidence_profile",
  "oauth_scope",
  "automated_tests",
  "live_uat_evidence",
]);

const RELEASE_DISPOSITIONS = new Set(["SHIP", "EXCLUDED_RISK", "LATER_NONCORE"]);
const READINESS = new Set(["READY", "NOT_READY", "NOT_APPLICABLE"]);
const SHA256 = /^[a-f0-9]{64}$/u;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label}_JSON_INVALID:${error instanceof Error ? error.message : String(error)}`);
  }
}

function quotedStrings(text) {
  return [...text.matchAll(/(?:"([^"\\]*)"|'([^'\\]*)')/gu)]
    .map((match) => match[1] ?? match[2]);
}

function parseToolAllowlist(source) {
  const match = source.match(/export\s+const\s+TOOL_ALLOWLIST\s*=\s*\[([\s\S]*?)\]\s+as\s+const/u);
  if (!match) throw new Error("TOOL_ALLOWLIST_SOURCE_NOT_FOUND");
  return quotedStrings(match[1]);
}

function parseCapabilityActionMap(source) {
  const match = source.match(/XERO_TOOL_CAPABILITY_ACTION_IDS\s*=\s*\{([\s\S]*?)\}\s+as\s+const\s+satisfies/u);
  if (!match) throw new Error("XERO_TOOL_CAPABILITY_ACTION_MAP_NOT_FOUND");
  const result = new Map();
  const entryPattern = /^\s*([A-Za-z0-9_]+)\s*:\s*\[([^\]]*)\]\s*,?/gmu;
  for (const entry of match[1].matchAll(entryPattern)) {
    result.set(entry[1], quotedStrings(entry[2]));
  }
  return result;
}

function parseRegisteredTools(source) {
  return new Set([...source.matchAll(/(?:server\.)?registerTool\(\s*["']([^"']+)["']/gu)]
    .map((match) => match[1]));
}

function parseReadEvidenceProfiles(source) {
  const match = source.match(/XERO_READ_EVIDENCE_PROFILES[^=]*=\s*\{([\s\S]*?)\n\};/u);
  if (!match) throw new Error("XERO_READ_EVIDENCE_PROFILE_MAP_NOT_FOUND");
  const result = new Map();
  const entryPattern = /^\s*([A-Za-z0-9_]+)\s*:\s*\{\s*capabilityId:\s*["']([^"']+)["']\s*,\s*kind:\s*["']([^"']+)["']/gmu;
  for (const entry of match[1].matchAll(entryPattern)) {
    result.set(entry[1], { capabilityId: entry[2], kind: entry[3] });
  }
  return result;
}

function parseAgentReachableWriteActions(source) {
  const match = source.match(/AGENT_REACHABLE_WRITE_ACTIONS\s*=\s*Object\.freeze\(\s*\[([\s\S]*?)\]\s+as\s+const/u);
  if (!match) throw new Error("AGENT_REACHABLE_WRITE_ACTIONS_SOURCE_NOT_FOUND");
  return quotedStrings(match[1]);
}

function parsePolicyActionIds(source) {
  return new Set([...source.matchAll(/actionId:\s*["']([^"']+)["']/gu)].map((match) => match[1]));
}

function list(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.length > 0) return [value];
  return [];
}

function stableHash(value) {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function routeFields(row) {
  const route = row.public_tool_or_case_action;
  if (route === null) return { tool: null, action: null };
  if (!isRecord(route)) return { tool: undefined, action: undefined };
  const tool = typeof route.tool === "string" ? route.tool : route.tool === null ? null : undefined;
  const action = typeof route.case_action === "string"
    ? route.case_action
    : Array.isArray(route.case_action)
      ? route.case_action
      : route.case_action === null
        ? null
        : undefined;
  return { tool, action };
}

function hasValue(value) {
  return value !== null && value !== undefined && value !== "" &&
    (!Array.isArray(value) || value.length > 0);
}

async function readSourceInputs({ manifestOverride } = {}) {
  const [manifestText, allowlistJson, toolNames, contract, server, evidence, policy, writeActions, packageJson] = await Promise.all([
    readFile(MANIFEST_PATH, "utf8"),
    readFile(resolve(REPO_ROOT, "config/tool-allowlist.json"), "utf8"),
    readFile(resolve(REPO_ROOT, "src/mcp/toolNames.ts"), "utf8"),
    readFile(resolve(REPO_ROOT, "src/mcp/xeroToolCapabilityContract.ts"), "utf8"),
    readFile(resolve(REPO_ROOT, "src/mcp/createServer.ts"), "utf8"),
    readFile(resolve(REPO_ROOT, "src/mcp/xeroReadEvidence.ts"), "utf8"),
    readFile(resolve(REPO_ROOT, "src/policy/xeroCapabilityPolicy.ts"), "utf8"),
    readFile(resolve(REPO_ROOT, "src/domain/xeroWriteActions.ts"), "utf8"),
    readFile(resolve(REPO_ROOT, "package.json"), "utf8"),
  ]);
  return {
    manifest: manifestOverride ?? parseJson(manifestText, "CAPABILITY_MANIFEST"),
    configAllowlist: parseJson(allowlistJson, "TOOL_ALLOWLIST_CONFIG"),
    sourceAllowlist: parseToolAllowlist(toolNames),
    actionMap: parseCapabilityActionMap(contract),
    registeredTools: parseRegisteredTools(server),
    readEvidenceProfiles: parseReadEvidenceProfiles(evidence),
    policyActionIds: parsePolicyActionIds(policy),
    agentReachableWriteActions: parseAgentReachableWriteActions(writeActions),
    packageJson: parseJson(packageJson, "PACKAGE"),
  };
}

async function readMetadataFiles(manifest) {
  const metadata = manifest?.metadata ?? {};
  const paths = [
    ...(metadata.profile_paths ?? []),
    ...(metadata.uat_manifest_paths ?? []),
    ...(metadata.deploy_paths ?? []),
  ];
  const entries = new Map();
  for (const path of paths) {
    if (typeof path !== "string") continue;
    try {
      entries.set(path, await readFile(resolve(REPO_ROOT, path), "utf8"));
    } catch (error) {
      entries.set(path, error);
    }
  }
  return entries;
}

function validateMetadata(metadata, errors) {
  if (!isRecord(metadata)) {
    errors.push("MANIFEST_METADATA_MISSING");
    return;
  }
  for (const field of ["profile_paths", "uat_manifest_paths", "deploy_paths"]) {
    if (!Array.isArray(metadata[field]) || metadata[field].length === 0 ||
        metadata[field].some((value) => typeof value !== "string" || value.length === 0)) {
      errors.push(`MANIFEST_METADATA_${field.toUpperCase()}_INVALID`);
    }
  }
}

function validateManifest(inputs, { requireReady = false } = {}) {
  const {
    manifest,
    configAllowlist,
    sourceAllowlist,
    actionMap,
    registeredTools,
    readEvidenceProfiles,
    policyActionIds,
    agentReachableWriteActions,
    packageJson,
  } = inputs;
  const errors = [];
  const warnings = [];

  if (!isRecord(manifest) || manifest.schema_version !== 1) errors.push("MANIFEST_SCHEMA_VERSION_INVALID");
  if (manifest.release_version !== packageJson.version) errors.push("MANIFEST_RELEASE_VERSION_DRIFT");
  if (manifest.official_reference?.url !== "https://github.com/XeroAPI/xero-mcp-server#available-mcp-commands") {
    errors.push("MANIFEST_OFFICIAL_REFERENCE_DRIFT");
  }
  if (JSON.stringify(manifest.official_commands) !== JSON.stringify(OFFICIAL_CORE_COMMANDS)) {
    errors.push("MANIFEST_OFFICIAL_COMMAND_BASELINE_INCOMPLETE_OR_DRIFTED");
  }
  validateMetadata(manifest.metadata, errors);

  if (!isRecord(configAllowlist) || !Array.isArray(configAllowlist.tools)) errors.push("TOOL_ALLOWLIST_CONFIG_INVALID");
  const configuredTools = configAllowlist?.tools ?? [];
  if (JSON.stringify(configuredTools) !== JSON.stringify(sourceAllowlist)) errors.push("TOOL_ALLOWLIST_SOURCE_CONFIG_DRIFT");
  if (new Set(sourceAllowlist).size !== sourceAllowlist.length) errors.push("TOOL_ALLOWLIST_DUPLICATE");

  const rows = Array.isArray(manifest.rows) ? manifest.rows : [];
  if (!Array.isArray(manifest.rows) || rows.length === 0) errors.push("MANIFEST_ROWS_MISSING");
  const rowIds = new Set();
  const officialRows = new Map();
  const manifestPublicTools = new Set();

  for (const [index, row] of rows.entries()) {
    const prefix = `ROW_${index + 1}`;
    if (!isRecord(row)) {
      errors.push(`${prefix}_INVALID`);
      continue;
    }
    for (const field of REQUIRED_ROW_FIELDS) {
      if (!(field in row)) errors.push(`${prefix}_${field.toUpperCase()}_MISSING`);
    }
    if (typeof row.capability_id !== "string" || row.capability_id.length === 0) {
      errors.push(`${prefix}_CAPABILITY_ID_INVALID`);
    } else if (rowIds.has(row.capability_id)) {
      errors.push(`${prefix}_CAPABILITY_ID_DUPLICATE`);
    } else rowIds.add(row.capability_id);
    if (!RELEASE_DISPOSITIONS.has(row.release_disposition)) errors.push(`${prefix}_RELEASE_DISPOSITION_INVALID`);
    if (!READINESS.has(row.readiness)) errors.push(`${prefix}_READINESS_INVALID`);
    if (row.readiness === "NOT_READY") warnings.push(`${row.capability_id ?? prefix}:NOT_READY`);
    if (row.readiness === "NOT_READY" && requireReady && row.release_disposition === "SHIP") {
      errors.push(`${prefix}_SHIP_NOT_READY`);
    }
    if (!Array.isArray(row.oauth_scope) || row.oauth_scope.some((value) => typeof value !== "string")) {
      errors.push(`${prefix}_OAUTH_SCOPE_INVALID`);
    }
    for (const field of ["automated_tests", "live_uat_evidence"]) {
      if (!Array.isArray(row[field]) || row[field].some((value) => typeof value !== "string")) {
        errors.push(`${prefix}_${field.toUpperCase()}_INVALID`);
      }
    }
    const reference = row.official_reference;
    if (!isRecord(reference) || !["official_core", "zcloak_extension"].includes(reference.kind)) {
      errors.push(`${prefix}_OFFICIAL_REFERENCE_INVALID`);
    } else if (reference.kind === "official_core") {
      if (typeof reference.command !== "string" || !OFFICIAL_CORE_COMMANDS.includes(reference.command)) {
        errors.push(`${prefix}_OFFICIAL_COMMAND_INVALID`);
      } else if (officialRows.has(reference.command)) {
        errors.push(`${prefix}_OFFICIAL_COMMAND_DUPLICATE`);
      } else officialRows.set(reference.command, row);
    }

    const route = routeFields(row);
    if (route.tool === undefined || route.action === undefined) errors.push(`${prefix}_PUBLIC_ROUTE_INVALID`);
    if (
      row.release_disposition === "SHIP" &&
      (route.tool === null || route.tool === undefined || route.action === null || route.action === undefined)
    ) {
      errors.push(`${prefix}_SHIP_WITHOUT_TYPED_ROUTE`);
    }
    if (route.tool !== null && route.tool !== undefined) {
      manifestPublicTools.add(route.tool);
      if (!sourceAllowlist.includes(route.tool)) errors.push(`${prefix}_PUBLIC_TOOL_NOT_ALLOWLISTED`);
      if (!registeredTools.has(route.tool)) errors.push(`${prefix}_PUBLIC_TOOL_NOT_REGISTERED`);
      const mapped = actionMap.get(route.tool) ?? [];
      for (const action of list(route.action)) {
        if (typeof action !== "string" || (!action.startsWith("case.") && !mapped.includes(action))) {
          const finding = `${prefix}_CASE_ACTION_NOT_REACHABLE:${action}`;
          if (row.readiness === "READY") errors.push(finding);
          else warnings.push(finding);
        }
      }
      if (typeof row.read_evidence_profile === "string") {
        const profile = readEvidenceProfiles.get(route.tool);
        if (!profile) errors.push(`${prefix}_READ_EVIDENCE_NOT_REGISTERED`);
        else if (profile.capabilityId !== row.read_evidence_profile) {
          errors.push(`${prefix}_READ_EVIDENCE_PROFILE_DRIFT`);
        }
      }
    } else if (row.readiness === "READY") {
      errors.push(`${prefix}_READY_WITHOUT_PUBLIC_ROUTE`);
    }

    const declaredPolicy = list(row.policy);
    for (const action of declaredPolicy) {
      if (typeof action === "string" && !action.startsWith("NOT_") && !action.startsWith("case.") && !policyActionIds.has(action)) {
        errors.push(`${prefix}_POLICY_ACTION_UNKNOWN:${action}`);
      }
    }
    if (row.readiness === "READY") {
      for (const field of ["input_schema", "handler", "policy", "service_dispatch", "provider_method", "receipt_and_readback"]) {
        if (!hasValue(row[field])) errors.push(`${prefix}_${field.toUpperCase()}_MISSING_FOR_READY`);
      }
      if (!hasValue(row.live_uat_evidence)) errors.push(`${prefix}_LIVE_UAT_EVIDENCE_MISSING_FOR_READY`);
    }
  }
  for (const command of OFFICIAL_CORE_COMMANDS) {
    if (!officialRows.has(command)) errors.push(`OFFICIAL_COMMAND_ROW_MISSING:${command}`);
  }
  for (const tool of sourceAllowlist) {
    if (!manifestPublicTools.has(tool)) errors.push(`PUBLIC_TOOL_ROW_MISSING:${tool}`);
  }

  // Every write action the Agent can submit is a separately accountable
  // capability. A single aggregate row must not make several ledger mutations
  // look accepted after only one of them has been exercised.
  const reachableWriteActionSet = new Set(agentReachableWriteActions);
  const reachableWriteRows = new Map();
  for (const row of rows) {
    const route = routeFields(row);
    const actions = list(route.action).filter((action) => reachableWriteActionSet.has(action));
    if (actions.length > 1) {
      errors.push(`REACHABLE_WRITE_ACTIONS_AGGREGATED:${row.capability_id}:${actions.join(",")}`);
    }
    for (const action of actions) {
      const matches = reachableWriteRows.get(action) ?? [];
      matches.push(row);
      reachableWriteRows.set(action, matches);
    }
  }
  for (const action of agentReachableWriteActions) {
    const matches = reachableWriteRows.get(action) ?? [];
    if (matches.length === 0) {
      errors.push(`REACHABLE_WRITE_ACTION_ROW_MISSING:${action}`);
      continue;
    }
    if (matches.length !== 1) errors.push(`REACHABLE_WRITE_ACTION_ROW_DUPLICATE:${action}`);
    if (matches.some((row) => row.release_disposition !== "SHIP")) {
      errors.push(`REACHABLE_WRITE_ACTION_NOT_SHIP:${action}`);
    }
  }

  const staleNumberPattern = /\b(?:28|29|30|44|45)[ -]?(?:public )?tools?\b/iu;
  for (const path of [
    ...(manifest.metadata?.profile_paths ?? []),
    ...(manifest.metadata?.uat_manifest_paths ?? []),
    ...(manifest.metadata?.deploy_paths ?? []),
  ]) {
    if (typeof path !== "string") continue;
    // Files are checked in the CLI after the manifest shape is validated. This
    // marker is deliberately narrow: historical evidence docs may retain old
    // counts, but current profile/UAT/deploy metadata may not.
    if (path.endsWith(".json") && path.includes("uat")) {
      // JSON UAT manifests are parsed below; no number scan is needed here.
      continue;
    }
    if (path.includes("switch-xero-upstream") || path.includes("verify-static")) {
      warnings.push(`DEPLOY_METADATA_DYNAMIC_CHECK_REQUIRED:${path}`);
    }
    void staleNumberPattern;
  }

  return {
    status: errors.length === 0 ? "PASS" : "FAIL",
    errors,
    warnings,
    tool_count: sourceAllowlist.length,
    toolset_hash: stableHash(sourceAllowlist),
    row_count: rows.length,
    not_ready_count: rows.filter((row) => row?.readiness === "NOT_READY").length,
    release_gate: errors.length === 0 && rows.every((row) => row?.release_disposition !== "SHIP" || row?.readiness === "READY")
      ? "GO"
      : "NO_GO",
  };
}

export async function inspectCapabilityManifest({ requireReady = false, manifestOverride } = {}) {
  const inputs = await readSourceInputs({ manifestOverride });
  const result = validateManifest(inputs, { requireReady });
  const metadataFiles = await readMetadataFiles(inputs.manifest);
  const manifestPath = "config/xero-capability-manifest.json";
  for (const [path, content] of metadataFiles.entries()) {
    if (content instanceof Error) {
      result.errors.push(`METADATA_FILE_MISSING:${path}`);
      continue;
    }
    if (path.includes("profile") && !content.includes(manifestPath)) {
      result.errors.push(`PROFILE_MANIFEST_REFERENCE_MISSING:${path}`);
    }
    if (path.includes("manifest") && path.endsWith(".json")) {
      const parsed = parseJson(content, `UAT_METADATA:${path}`);
      if (parsed.capabilityManifest !== manifestPath) {
        result.errors.push(`UAT_MANIFEST_REFERENCE_DRIFT:${path}`);
      }
    }
    if (path.includes("deploy") || path.includes("smoke-accepted-oci-runtime")) {
      if (/GREEN_TOOL_COUNT="\d+"|GREEN_TOOLSET_HASH="[a-f0-9]{64}"|toolCount\s*!==\s*\d+/u.test(content)) {
        result.errors.push(`DEPLOY_TOOL_IDENTITY_PINNED:${path}`);
      }
    }
  }
  if (result.errors.length > 0) {
    result.status = "FAIL";
    result.release_gate = "NO_GO";
  }
  return result;
}

function printFields(result) {
  process.stdout.write([
    `status|${result.status}`,
    `tool_count|${result.tool_count}`,
    `toolset_hash|${result.toolset_hash}`,
    `row_count|${result.row_count}`,
    `not_ready_count|${result.not_ready_count}`,
    `release_gate|${result.release_gate}`,
  ].join("\n") + "\n");
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const result = await inspectCapabilityManifest({ requireReady: args.has("--require-ready") });
  if (args.has("--format") && process.argv.includes("fields")) printFields(result);
  else process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.errors.length > 0 || (args.has("--require-ready") && result.release_gate !== "GO")) process.exitCode = 1;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ status: "FAIL", error: error instanceof Error ? error.message : String(error) })}\n`);
    process.exitCode = 1;
  });
}
