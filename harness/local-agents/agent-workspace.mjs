import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { access, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * These are the files mounted by the current accounting Agent deployment
 * candidate.  The files themselves remain owned by the Skill package; this
 * harness only reads their final bytes and composes an ephemeral AGENTS.md.
 */
export const AGENT_BUNDLE_SOURCES = Object.freeze([
  "agent-skills/accounting-double-entry-skills-2026-08-10/agent-config/accounting-agent-instructions.md",
  "agent-skills/accounting-double-entry-skills-2026-08-10/agent-config/capability-contract.md",
  "agent-skills/accounting-double-entry-skills-2026-08-10/agent-config/connector-profiles/xero.md",
  "agent-skills/accounting-double-entry-skills-2026-08-10/accounting-agent/skills/execute-approved-accounting-entry/SKILL.md",
  "agent-skills/accounting-double-entry-skills-2026-08-10/accounting-agent/skills/execute-approved-accounting-entry/references/capability-routing.md",
  "agent-skills/accounting-double-entry-skills-2026-08-10/accounting-agent/skills/prepare-balanced-accounting-entry/SKILL.md",
  "agent-skills/accounting-double-entry-skills-2026-08-10/accounting-agent/skills/prepare-balanced-accounting-entry/references/double-entry-control-model.md",
]);

export const AGENT_INSTRUCTION_SOURCES = Object.freeze(AGENT_BUNDLE_SOURCES.slice(0, 3));
// A bound on the instruction bundle this harness assembles for the local agent -
// not a production limit; nothing in src/ constrains the mounted skill docs.
//
// It did its job: at 32_768 the three docs came to 32_788 and stopped the
// evidence run, which is how anyone noticed they had grown at all. The 20 bytes
// were a new tool being documented as the public surface went from 29 to 30, so
// the honest answer was not to delete a true sentence to fit a round number.
//
// Raised once, deliberately, with the reasoning recorded. Hitting it again is a
// prompt to ask whether these docs have bloated - the agent reads every byte of
// them before it does anything - not to raise it again by reflex.
export const AGENT_PROJECT_DOC_BYTE_LIMIT = 40_960;
export const AGENT_SKILL_MOUNTS = Object.freeze([
  Object.freeze({
    root: ".agents/skills/execute-approved-accounting-entry",
    files: Object.freeze([
      Object.freeze({ path: "SKILL.md", source_path: AGENT_BUNDLE_SOURCES[3] }),
      Object.freeze({ path: "references/capability-routing.md", source_path: AGENT_BUNDLE_SOURCES[4] }),
    ]),
  }),
  Object.freeze({
    root: ".agents/skills/prepare-balanced-accounting-entry",
    files: Object.freeze([
      Object.freeze({ path: "SKILL.md", source_path: AGENT_BUNDLE_SOURCES[5] }),
      Object.freeze({ path: "references/double-entry-control-model.md", source_path: AGENT_BUNDLE_SOURCES[6] }),
    ]),
  }),
]);

const AGENT_SKILL_READ_COMMAND_PROGRAMS = new Set(["cat", "head", "sed", "tail"]);
const AGENT_SKILL_MOUNT_FILE_PATHS = new Set(
  AGENT_SKILL_MOUNTS.flatMap((mount) => mount.files.map((file) => `${mount.root}/${file.path}`)),
);

function tokenizeReadOnlyCommand(command) {
  if (typeof command !== "string" || command.trim() === "" || /[\r\n\\;|&><`$(){}]/u.test(command)) {
    throw new Error("SKILL_COMMAND_INVALID");
  }
  const tokens = [];
  let token = "";
  let quote;
  for (const character of command.trim()) {
    if (quote) {
      if (character === quote) {
        quote = undefined;
      } else {
        token += character;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
    } else if (/\s/u.test(character)) {
      if (token) {
        tokens.push(token);
        token = "";
      }
    } else {
      token += character;
    }
  }
  if (quote) throw new Error("SKILL_COMMAND_INVALID");
  if (token) tokens.push(token);
  return tokens;
}

function normalizedTempWorkspaceRoot(root) {
  if (typeof root !== "string" || root.length === 0 || root !== resolve(root)) {
    throw new Error("SKILL_COMMAND_INVALID");
  }
  const candidate = resolve(root);
  const systemTemp = resolve(realpathSync(tmpdir()));
  if (basename(candidate).startsWith("xero-local-agent-workspace-") !== true ||
      !candidate.startsWith(`${systemTemp}${sep}`)) {
    throw new Error("SKILL_COMMAND_INVALID");
  }
  try {
    return resolve(realpathSync(candidate));
  } catch {
    return candidate;
  }
}

function assertMountedSkillPaths(paths, { wrapped } = {}) {
  if (paths.length === 0) throw new Error("SKILL_COMMAND_INVALID");
  const absolutePaths = paths.filter((path) => isAbsolute(path));
  if (absolutePaths.length > 0 && (!wrapped || absolutePaths.length !== paths.length)) {
    throw new Error("SKILL_COMMAND_INVALID");
  }
  let workspaceRoot;
  const normalizedPaths = paths.map((path) => {
    if (!isAbsolute(path)) {
      if (!AGENT_SKILL_MOUNT_FILE_PATHS.has(path) || workspaceRoot) throw new Error("SKILL_COMMAND_INVALID");
      return path;
    }
    const marker = "/.agents/skills/";
    const markerIndex = path.indexOf(marker);
    if (markerIndex <= 0) throw new Error("SKILL_COMMAND_INVALID");
    const root = normalizedTempWorkspaceRoot(path.slice(0, markerIndex));
    const suffix = path.slice(markerIndex + 1);
    if (!AGENT_SKILL_MOUNT_FILE_PATHS.has(suffix)) throw new Error("SKILL_COMMAND_INVALID");
    if (workspaceRoot && workspaceRoot !== root) throw new Error("SKILL_COMMAND_INVALID");
    workspaceRoot = root;
    return suffix;
  });
  return { paths: normalizedPaths, workspaceRoot };
}

function unwrapSkillReadCommand(command) {
  const trimmed = typeof command === "string" ? command.trim() : command;
  const wrapped = typeof trimmed === "string"
    ? /^\/bin\/zsh -lc "([^"\r\n]*)"$/u.exec(trimmed)
    : undefined;
  if (wrapped) return { command: wrapped[1], wrapped: true };
  if (typeof trimmed !== "string" || trimmed.startsWith("/") || /(?:^|\s)-lc(?:\s|$)/u.test(trimmed)) {
    throw new Error("SKILL_COMMAND_INVALID");
  }
  return { command: trimmed, wrapped: false };
}

/**
 * Return the mounted Skill/reference paths read by one deliberately narrow
 * command.  This is a policy parser, not a shell: metacharacters, wrappers,
 * absolute paths, traversal, globs, and every write-capable command fail.
 */
export function skillReadPathsFromCommand(command) {
  const unwrapped = unwrapSkillReadCommand(command);
  const tokens = tokenizeReadOnlyCommand(unwrapped.command);
  const [program, ...arguments_] = tokens;
  if (!AGENT_SKILL_READ_COMMAND_PROGRAMS.has(program)) throw new Error("SKILL_COMMAND_INVALID");
  if (program === "cat") {
    const paths = arguments_[0] === "--" ? arguments_.slice(1) : arguments_;
    return assertMountedSkillPaths(paths, unwrapped).paths;
  }
  if (program === "sed") {
    if (arguments_[0] !== "-n" || !/^\d+(?:,\d+)?p$/u.test(arguments_[1] ?? "")) {
      throw new Error("SKILL_COMMAND_INVALID");
    }
    const paths = arguments_.slice(2);
    return assertMountedSkillPaths(paths[0] === "--" ? paths.slice(1) : paths, unwrapped).paths;
  }
  let index = 0;
  while (index < arguments_.length && arguments_[index] !== "--") {
    const argument = arguments_[index];
    if (argument === "-n") {
      if (!/^\d+$/u.test(arguments_[index + 1] ?? "")) throw new Error("SKILL_COMMAND_INVALID");
      index += 2;
    } else if (/^-\d+$/u.test(argument) || /^--lines=\d+$/u.test(argument)) {
      index += 1;
    } else {
      break;
    }
  }
  if (arguments_[index] === "--") index += 1;
  return assertMountedSkillPaths(arguments_.slice(index), unwrapped).paths;
}

function skillReadCommandDetails(command) {
  const unwrapped = unwrapSkillReadCommand(command);
  const tokens = tokenizeReadOnlyCommand(unwrapped.command);
  const [program, ...arguments_] = tokens;
  if (!AGENT_SKILL_READ_COMMAND_PROGRAMS.has(program)) throw new Error("SKILL_COMMAND_INVALID");
  let paths;
  if (program === "cat") {
    paths = arguments_[0] === "--" ? arguments_.slice(1) : arguments_;
  } else if (program === "sed") {
    if (arguments_[0] !== "-n" || !/^\d+(?:,\d+)?p$/u.test(arguments_[1] ?? "")) {
      throw new Error("SKILL_COMMAND_INVALID");
    }
    paths = arguments_.slice(2);
    if (paths[0] === "--") paths = paths.slice(1);
  } else {
    let index = 0;
    while (index < arguments_.length && arguments_[index] !== "--") {
      const argument = arguments_[index];
      if (argument === "-n") {
        if (!/^\d+$/u.test(arguments_[index + 1] ?? "")) throw new Error("SKILL_COMMAND_INVALID");
        index += 2;
      } else if (/^-\d+$/u.test(argument) || /^--lines=\d+$/u.test(argument)) {
        index += 1;
      } else {
        break;
      }
    }
    if (arguments_[index] === "--") index += 1;
    paths = arguments_.slice(index);
  }
  return { ...assertMountedSkillPaths(paths, unwrapped), command: command };
}

/**
 * Validate raw Codex command events.  Commands are allowed only before the
 * first business MCP call and every completed command must successfully read
 * mounted Skill/reference files from the temporary workspace.
 */
export function assertAgentSkillReadCommandEvents(events, {
  errorPrefix = "LOCAL_AGENT",
  expectedWorkspaceRoot,
} = {}) {
  const fail = (code) => { throw new Error(`${errorPrefix}_${code}`); };
  if (!Array.isArray(events)) fail("SKILL_COMMAND_INVALID");
  const safeDiscoveryTools = new Set(["list_mcp_resources", "list_mcp_resource_templates"]);
  const commandStates = new Map();
  let businessStarted = false;
  let observedWorkspaceRoot;
  const expectedRoot = expectedWorkspaceRoot === undefined
    ? undefined
    : normalizedTempWorkspaceRoot(resolve(expectedWorkspaceRoot));
  for (const event of events) {
    const item = event?.item;
    if (item?.type === "mcp_tool_call") {
      const tool = typeof item.tool === "string" ? item.tool : item.name;
      if (typeof tool === "string" && !safeDiscoveryTools.has(tool)) businessStarted = true;
      continue;
    }
    if (item?.type !== "command_execution") continue;
    if (businessStarted) fail("SKILL_COMMAND_AFTER_BUSINESS");
    if (typeof item.id !== "string" || item.id.length === 0) fail("SKILL_COMMAND_INVALID");
    let details;
    try {
      details = skillReadCommandDetails(item.command);
    } catch {
      fail("SKILL_COMMAND_INVALID");
    }
    if (details.workspaceRoot) {
      if (observedWorkspaceRoot && observedWorkspaceRoot !== details.workspaceRoot) {
        fail("SKILL_COMMAND_ROOT_DRIFT");
      }
      if (expectedRoot && expectedRoot !== details.workspaceRoot) fail("SKILL_COMMAND_ROOT_INVALID");
      observedWorkspaceRoot = details.workspaceRoot;
    }
    const previous = commandStates.get(item.id);
    if (previous && JSON.stringify(previous.command) !== JSON.stringify(item.command)) {
      fail("SKILL_COMMAND_INVALID");
    }
    const completed = event?.type === "item.completed";
    if (completed) {
      if (item.status !== "completed" || item.exit_code !== 0 || item.error) fail("SKILL_COMMAND_FAILED");
    } else if (event?.type !== "item.started" ||
      (item.status !== undefined && !["started", "in_progress"].includes(item.status))) {
      fail("SKILL_COMMAND_INVALID");
    }
    commandStates.set(item.id, {
      command: item.command,
      paths: details.paths,
      completed: previous?.completed || completed,
    });
  }
  if ([...commandStates.values()].some((state) => !state.completed)) fail("SKILL_COMMAND_INCOMPLETE");
  return Object.freeze({
    command_count: commandStates.size,
    paths: [...new Set([...commandStates.values()].flatMap((state) => state.paths))],
    workspace_root: observedWorkspaceRoot,
  });
}

// The MCP backend retains the reviewed 29-tool surface. This execution Agent
// receives only the typed Case vertical slice, using Codex's native per-server
// enabled_tools filter. Agent2 must mount the same profile for comparable UAT.
export const ACCOUNTING_CASE_AGENT_ENABLED_TOOLS = Object.freeze([
  "xero_pin_current_organisation",
  "xero_get_organisation",
  "xero_prepare_accounting_case",
  "xero_execute_accounting_case",
  "xero_get_accounting_case_status",
]);

/**
 * The schema source set is intentionally explicit.  The hash is not a claim
 * that source text is a runtime schema; it is a deployment identity for the
 * code that produces the 29-tool MCP surface and its input schemas.
 */
export const TOOL_SCHEMA_SOURCES = Object.freeze([
  "config/tool-allowlist.json",
  "src/mcp/toolNames.ts",
  "src/mcp/createServer.ts",
  "src/mcp/xeroToolCapabilityContract.ts",
  "src/mcp/xeroAccountingCaseBusinessIntake.ts",
  "src/domain/accountingCaseSchemas.ts",
  "src/domain/schemas.ts",
  "src/domain/extendedReadSchemas.ts",
  "src/domain/xeroQuotePurchaseOrderDraft.ts",
  "src/domain/xeroControlledMutationSchemas.ts",
  "src/domain/xeroCreditNoteManualJournalDraft.ts",
  "src/domain/xeroContactItemMutationSchemas.ts",
]);

const sha256 = (content) => createHash("sha256").update(content).digest("hex");

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.entries(value)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`)
    .join(",")}}`;
}

function containedPath(repoRoot, path, label) {
  const root = resolve(repoRoot);
  const candidate = resolve(root, path);
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    throw new Error(`${label}_PATH_ESCAPES_REPOSITORY`);
  }
  return candidate;
}

async function readRegularFile(repoRoot, path, label) {
  const absolute = containedPath(repoRoot, path, label);
  const metadata = await lstat(absolute);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label}_MUST_BE_REGULAR_FILE:${path}`);
  }
  return readFile(absolute);
}

function sourceEntry(path, content) {
  return Object.freeze({
    path,
    sha256: sha256(content),
    bytes: content.length,
  });
}

/**
 * Compose source bytes without normalizing, trimming, or rewriting them.
 * Delimiters are the only bytes added by the harness.
 */
export function composeAgentInstructions(sourceEntries) {
  return Buffer.concat(sourceEntries.flatMap(({ path, content }, index) => [
    Buffer.from(`\n<!-- DEPLOYMENT SOURCE ${index + 1}: ${path} -->\n`, "utf8"),
    content,
  ]));
}

export async function loadAgentBundleSources(repoRoot) {
  const entries = [];
  for (const path of AGENT_BUNDLE_SOURCES) {
    const content = await readRegularFile(repoRoot, path, "AGENT_BUNDLE_SOURCE");
    entries.push({ path, content, ...sourceEntry(path, content) });
  }
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const instructionEntries = AGENT_INSTRUCTION_SOURCES.map((path) => byPath.get(path));
  if (instructionEntries.some((entry) => !entry)) throw new Error("AGENT_INSTRUCTION_SOURCE_MISSING");
  const combined = composeAgentInstructions(instructionEntries);
  if (combined.length > AGENT_PROJECT_DOC_BYTE_LIMIT) {
    throw new Error(`AGENT_PROJECT_DOC_TOO_LARGE:${combined.length}`);
  }
  const skillMounts = AGENT_SKILL_MOUNTS.map((skillMount) => ({
    root: skillMount.root,
    files: skillMount.files.map((mount) => {
      const source = byPath.get(mount.source_path);
      if (!source) throw new Error(`AGENT_SKILL_SOURCE_MISSING:${mount.source_path}`);
      return { ...mount, content: source.content, sha256: source.sha256, bytes: source.bytes };
    }),
  }));
  return {
    sources: entries.map(({ path, sha256: digest, bytes }) => ({ path, sha256: digest, bytes })),
    content: combined,
    agents: {
      path: "AGENTS.md",
      sha256: sha256(combined),
      bytes: combined.length,
      byte_limit: AGENT_PROJECT_DOC_BYTE_LIMIT,
    },
    skills: skillMounts.map((mount) => ({
      root: mount.root,
      files: mount.files.map(({ content: _content, ...file }) => file),
    })),
    skillMounts,
  };
}

export async function createAgentWorkspace(repoRoot) {
  const bundle = await loadAgentBundleSources(repoRoot);
  const root = await mkdtemp(join(tmpdir(), "xero-local-agent-workspace-"));
  const agentsPath = join(root, "AGENTS.md");
  try {
    await writeFile(agentsPath, bundle.content, { mode: 0o600, flag: "wx" });
    for (const mount of bundle.skillMounts) {
      for (const file of mount.files) {
        const target = join(root, mount.root, file.path);
        await mkdir(resolve(target, ".."), { recursive: true });
        await writeFile(target, file.content, { mode: 0o600, flag: "wx" });
      }
    }
    return {
      root,
      agentsPath,
      bundle,
      async dispose() {
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function schemaSourceEntries(repoRoot) {
  const entries = [];
  for (const path of TOOL_SCHEMA_SOURCES) {
    const content = await readRegularFile(repoRoot, path, "TOOL_SCHEMA_SOURCE");
    entries.push(sourceEntry(path, content));
  }
  return entries;
}

export async function buildToolContractEvidence(repoRoot) {
  const allowlistPath = TOOL_SCHEMA_SOURCES[0];
  const allowlistContent = await readRegularFile(repoRoot, allowlistPath, "TOOL_ALLOWLIST");
  let parsed;
  try {
    parsed = JSON.parse(allowlistContent.toString("utf8"));
  } catch {
    throw new Error("TOOL_ALLOWLIST_INVALID_JSON");
  }
  if (!Array.isArray(parsed?.tools) || parsed.tools.length !== 29 ||
      parsed.tools.some((tool) => typeof tool !== "string" || !tool)) {
    throw new Error("TOOL_ALLOWLIST_MUST_CONTAIN_29_TOOLS");
  }
  const schemaSources = await schemaSourceEntries(repoRoot);
  const schemaManifest = { tools: parsed.tools, sources: schemaSources };
  const schemaManifestBytes = Buffer.from(stableStringify(schemaManifest), "utf8");
  return {
    tool_count: parsed.tools.length,
    tools: [...parsed.tools],
    allowlist: {
      path: allowlistPath,
      sha256: sha256(allowlistContent),
      bytes: allowlistContent.length,
    },
    schema: {
      sha256: sha256(schemaManifestBytes),
      bytes: schemaManifestBytes.length,
      source_files: schemaSources,
    },
    agent_profile: {
      profile_id: "xero-accounting-case-write-v1",
      enabled_tools: [...ACCOUNTING_CASE_AGENT_ENABLED_TOOLS],
      backend_tool_count: parsed.tools.length,
    },
  };
}

function assertDigest(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${label}_INVALID_SHA256`);
  }
}

/** Re-read every recorded source and fail closed on any byte or order drift. */
export async function verifyAgentBundleEvidence(repoRoot, recorded) {
  if (!recorded || !Array.isArray(recorded.sources) || recorded.sources.length !== AGENT_BUNDLE_SOURCES.length) {
    throw new Error("AGENT_BUNDLE_EVIDENCE_SOURCES_INVALID");
  }
  const expectedPaths = JSON.stringify(AGENT_BUNDLE_SOURCES);
  if (JSON.stringify(recorded.sources.map((source) => source?.path)) !== expectedPaths) {
    throw new Error("AGENT_BUNDLE_EVIDENCE_SOURCE_ORDER_INVALID");
  }
  const loaded = await loadAgentBundleSources(repoRoot);
  for (const [index, expected] of loaded.sources.entries()) {
    const actual = recorded.sources[index];
    if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes) {
      throw new Error(`AGENT_BUNDLE_SOURCE_DRIFT:${expected.path}`);
    }
  }
  assertDigest(recorded.agents?.sha256, "AGENT_BUNDLE_COMBINED");
  if (recorded.agents.path !== "AGENTS.md" || recorded.agents.bytes !== loaded.agents.bytes ||
      recorded.agents.byte_limit !== loaded.agents.byte_limit ||
      recorded.agents.sha256 !== loaded.agents.sha256) {
    throw new Error("AGENT_BUNDLE_COMBINED_DRIFT");
  }
  if (stableStringify(recorded.skills) !== stableStringify(loaded.skills)) {
    throw new Error("AGENT_SKILL_MOUNT_DRIFT");
  }
  const toolContract = await buildToolContractEvidence(repoRoot);
  if (stableStringify(recorded.tool_contract) !== stableStringify(toolContract)) {
    throw new Error("AGENT_TOOL_CONTRACT_DRIFT");
  }
  return { bundle: loaded, toolContract };
}

/** Synchronous twin used by the release gate's raw-artifact replay verifier. */
export function verifyAgentBundleEvidenceSync(repoRoot, recorded) {
  if (!recorded || !Array.isArray(recorded.sources) || recorded.sources.length !== AGENT_BUNDLE_SOURCES.length) {
    throw new Error("AGENT_BUNDLE_EVIDENCE_SOURCES_INVALID");
  }
  if (JSON.stringify(recorded.sources.map((source) => source?.path)) !== JSON.stringify(AGENT_BUNDLE_SOURCES)) {
    throw new Error("AGENT_BUNDLE_EVIDENCE_SOURCE_ORDER_INVALID");
  }
  const entries = AGENT_BUNDLE_SOURCES.map((path) => {
    const absolute = containedPath(repoRoot, path, "AGENT_BUNDLE_SOURCE");
    const metadata = lstatSync(absolute);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`AGENT_BUNDLE_SOURCE_MUST_BE_REGULAR_FILE:${path}`);
    }
    const content = readFileSync(absolute);
    return { path, content, ...sourceEntry(path, content) };
  });
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const combined = composeAgentInstructions(AGENT_INSTRUCTION_SOURCES.map((path) => byPath.get(path)));
  if (combined.length > AGENT_PROJECT_DOC_BYTE_LIMIT) throw new Error(`AGENT_PROJECT_DOC_TOO_LARGE:${combined.length}`);
  const sources = entries.map(({ path, sha256: digest, bytes }) => ({ path, sha256: digest, bytes }));
  for (const [index, expected] of sources.entries()) {
    const actual = recorded.sources[index];
    if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes) {
      throw new Error(`AGENT_BUNDLE_SOURCE_DRIFT:${expected.path}`);
    }
  }
  assertDigest(recorded.agents?.sha256, "AGENT_BUNDLE_COMBINED");
  if (recorded.agents.path !== "AGENTS.md" || recorded.agents.bytes !== combined.length ||
      recorded.agents.byte_limit !== AGENT_PROJECT_DOC_BYTE_LIMIT ||
      recorded.agents.sha256 !== sha256(combined)) {
    throw new Error("AGENT_BUNDLE_COMBINED_DRIFT");
  }
  const expectedSkills = AGENT_SKILL_MOUNTS.map((skillMount) => ({
    root: skillMount.root,
    files: skillMount.files.map((mount) => {
      const source = byPath.get(mount.source_path);
      return { ...mount, sha256: source.sha256, bytes: source.bytes };
    }),
  }));
  if (stableStringify(recorded.skills) !== stableStringify(expectedSkills)) {
    throw new Error("AGENT_SKILL_MOUNT_DRIFT");
  }
  const allowlistContent = readFileSync(containedPath(repoRoot, TOOL_SCHEMA_SOURCES[0], "TOOL_ALLOWLIST"));
  const parsed = JSON.parse(allowlistContent.toString("utf8"));
  const schemaSources = TOOL_SCHEMA_SOURCES.map((path) => {
    const content = readFileSync(containedPath(repoRoot, path, "TOOL_SCHEMA_SOURCE"));
    return sourceEntry(path, content);
  });
  const schemaManifestBytes = Buffer.from(stableStringify({ tools: parsed.tools, sources: schemaSources }), "utf8");
  const expectedToolContract = {
    tool_count: parsed.tools.length,
    tools: [...parsed.tools],
    allowlist: { path: TOOL_SCHEMA_SOURCES[0], sha256: sha256(allowlistContent), bytes: allowlistContent.length },
    schema: { sha256: sha256(schemaManifestBytes), bytes: schemaManifestBytes.length, source_files: schemaSources },
    agent_profile: {
      profile_id: "xero-accounting-case-write-v1",
      enabled_tools: [...ACCOUNTING_CASE_AGENT_ENABLED_TOOLS],
      backend_tool_count: parsed.tools.length,
    },
  };
  if (stableStringify(recorded.tool_contract) !== stableStringify(expectedToolContract)) {
    throw new Error("AGENT_TOOL_CONTRACT_DRIFT");
  }
  return {
    sources,
    agents: {
      path: "AGENTS.md",
      sha256: sha256(combined),
      bytes: combined.length,
      byte_limit: AGENT_PROJECT_DOC_BYTE_LIMIT,
    },
    skills: expectedSkills,
    toolContract: expectedToolContract,
  };
}

export function runtimeConfiguration(env = process.env) {
  const model = (env.LOCAL_AGENT_MODEL || "gpt-5.6-luna").trim();
  const effort = (env.LOCAL_AGENT_EFFORT || "xhigh").trim().toLowerCase();
  if (!/^[A-Za-z0-9._:-]{1,120}$/u.test(model)) throw new Error("LOCAL_AGENT_MODEL_INVALID");
  if (!/^(?:low|medium|high|xhigh)$/u.test(effort)) throw new Error("LOCAL_AGENT_EFFORT_INVALID");
  return Object.freeze({ model, effort });
}

export function sourcePathRelative(repoRoot, path) {
  return relative(resolve(repoRoot), resolve(repoRoot, path));
}

export const AGENT_BUNDLE_CLEANUP = "AUTOMATIC_EPHEMERAL_WORKSPACE_CLEANUP";
