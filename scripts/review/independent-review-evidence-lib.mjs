import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, posix, relative, resolve, sep } from "node:path";
import { Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { ACCEPTANCE_SOURCE_ROOTS } from "../release/local-acceptance-gate-lib.mjs";

const SUMMARY_FIELDS = Object.freeze([
  "schema_version",
  "evidence_boundary",
  "captured_at",
  "source_fingerprint",
  "review_subject_sha256",
  "review_inputs_sha256",
  "implementation_execution_id",
  "reviewer_execution_id",
  "decision",
  "generator",
  "raw_artifacts",
  "reviewed_requirement_ids",
]);

const GENERATOR_FIELDS = Object.freeze([
  "kind",
  "command",
  "version",
  "executable_path",
  "executable_sha256",
]);

const RAW_ARTIFACT_TYPES = Object.freeze([
  "CODEX_EVENTS_JSONL",
  "CODEX_STDERR",
  "FINAL_VERDICT",
  "INVOCATION",
]);

const INVOCATION_FIELDS = Object.freeze([
  "schema_version",
  "evidence_boundary",
  "started_at",
  "finished_at",
  "exit_code",
  "controller_process_id",
  "reviewer_process_id",
  "implementation_execution_id",
  "traceability_path",
  "requested_requirements",
  "source_fingerprint_before",
  "source_fingerprint_after",
  "review_subject_sha256",
  "review_inputs_before",
  "review_inputs_after",
  "inspection_nonce",
  "inspection_commands",
  "prompt",
  "prompt_sha256",
  "output_schema",
  "codex",
]);

const DISALLOWED_REVIEW_ITEM_TYPES = new Set([
  "file_change",
  "mcp_tool_call",
  "computer_tool_call",
  "web_search",
  "file_search",
  "image_generation",
  "dynamic_tool_call",
  "collab_agent_tool_call",
]);

const REVIEW_INSPECTION_SCRIPT = "scripts/review/emit-review-input-receipt.mjs";
const REVIEW_FALSIFICATION_PROBE_SCRIPT = "scripts/review/emit-review-falsification-probe.mjs";
export const REVIEW_CONTENT_CHUNK_BYTES = 12 * 1024;
export const REVIEW_CONTENT_BATCH_PAYLOAD_JSON_BYTES = 32 * 1024;
export const REVIEW_CONTENT_BATCH_OUTPUT_JSON_BYTES = 64 * 1024;
export const REVIEW_SHARD_MAX_TOTAL_BYTES = 1024 * 1024;
export const REVIEW_SHARD_MAX_FILE_COUNT = 128;
export const REVIEW_SHARD_MAX_BATCH_COUNT = 32;
const execFileAsync = promisify(execFile);
const syntheticSupplementFixtureDocuments = new WeakSet();
const dependencyGraphBySnapshotContext = new WeakMap();
const typescriptParserBySnapshotContext = new WeakMap();
let snapshotDescriptorReadTestHook;
const EXTERNAL_PROCESS_MODULES = new Set([
  "child_process",
  "node:child_process",
]);
const EXTERNAL_PROCESS_WRAPPER_PACKAGES = new Set([
  "child-process-promise",
  "cross-spawn",
  "cross-spawn-with-kill",
  "execa",
  "foreground-child",
  "shelljs",
  "tinyexec",
  "zx",
]);
const REVIEW_UNIVERSE_FIXED_DIRECTORIES = Object.freeze([
  "deploy",
  "migrations",
  "schemas",
  "scripts/release",
  "scripts/review",
  "src",
]);
const REVIEW_UNIVERSE_FIXED_FILES = Object.freeze([
  ".dockerignore",
  ".gitignore",
  "package-lock.json",
  "package.json",
  "scripts/local-acceptance-contract.mjs",
  "scripts/verify-accepted-build-context.mjs",
  "scripts/verify-accepted-oci-release.mjs",
  "tsconfig.build.json",
  "tsconfig.json",
]);
const APPROVED_ACCEPTANCE_SOURCE_ROOTS = Object.freeze([
  ".dockerignore",
  ".gitignore",
  "PRD-XERO-ACCOUNTING-AGENT-MCP.md",
  "README.md",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "tsconfig.build.json",
  "agent-skills",
  "config",
  "deploy",
  "docs",
  "handoff",
  "harness",
  "migrations",
  "schemas",
  "scripts",
  "src",
  "tests",
]);
const REVIEW_ROOT_AUTO_CONFIG_CANDIDATES = Object.freeze([
  "vite.config.js",
  "vite.config.mjs",
  "vite.config.cjs",
  "vite.config.ts",
  "vite.config.mts",
  "vite.config.cts",
  "vitest.config.js",
  "vitest.config.mjs",
  "vitest.config.cjs",
  "vitest.config.ts",
  "vitest.config.mts",
  "vitest.config.cts",
]);
export const INDEPENDENT_REVIEW_HOST_CONTEXT_FILES = Object.freeze({
  live_context: "live-context.json",
  snapshot_directory: "snapshot",
  source_manifest: "source-snapshot.manifest.json",
  source_attestation: "source-snapshot.attestation.json",
  supplemental_manifest: "supplemental-inputs.manifest.json",
  output_directory: "review-output",
});
export const APPROVED_INDEPENDENT_REVIEW_CODEX_PATHS = Object.freeze([
  "/Applications/ChatGPT.app/Contents/Resources/codex",
]);
export const INDEPENDENT_REVIEW_MODEL = "gpt-5.6-sol";
export const INDEPENDENT_REVIEW_REASONING_EFFORT = "xhigh";
export const INDEPENDENT_REVIEW_HOST_CONTEXT_TOKEN_LIMIT = 400_000;
export const INDEPENDENT_REVIEW_CODEX_TEAM_ID = "2DC432GLL2";
export const INDEPENDENT_REVIEW_CODEX_IDENTIFIER = "codex";
export const INDEPENDENT_REVIEW_FIXED_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const INDEPENDENT_REVIEW_ENV_POLICY = Object.freeze({
  schema_version: "1.0",
  inherit_if_present: ["HOME", "TMPDIR", "USER", "LOGNAME"],
  fixed: {
    PATH: INDEPENDENT_REVIEW_FIXED_PATH,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    LC_CTYPE: "C.UTF-8",
    NO_COLOR: "1",
    CODEX_CI: "1",
    SHELL: "/bin/sh",
  },
  rejected_exact: [
    "BASH_ENV", "CODEX_HOME", "ENV", "NODE_OPTIONS", "NODE_PATH", "ZDOTDIR",
    "CDPATH", "GIT_CONFIG", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_EXEC_PATH",
    "IFS", "PROMPT_COMMAND", "SHELLOPTS",
  ],
  rejected_prefixes: ["DYLD_", "LD_"],
});

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function registerIndependentReviewSyntheticSupplementFixture(document) {
  if (process.env.NODE_ENV !== "test" || !isRecord(document)) {
    throw new Error("INDEPENDENT_REVIEW_SYNTHETIC_SUPPLEMENT_FIXTURE_FORBIDDEN");
  }
  syntheticSupplementFixtureDocuments.add(document);
}

export function registerIndependentReviewSnapshotDescriptorReadTestHook(hook) {
  if (process.env.NODE_ENV !== "test" || (hook !== undefined && typeof hook !== "function")) {
    throw new Error("INDEPENDENT_REVIEW_SNAPSHOT_DESCRIPTOR_TEST_HOOK_FORBIDDEN");
  }
  snapshotDescriptorReadTestHook = hook;
}

function isNonEmptyString(value) {
  return typeof value === "string" && /\S/u.test(value);
}

function isSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function exactFields(value, fields, label) {
  if (!isRecord(value)) throw new Error(`${label}: expected an object`);
  const expected = [...fields].sort();
  const actual = Object.keys(value).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: fields differ; expected ${expected.join(",")}; received ${actual.join(",")}`);
  }
}

function assertDateTime(value, label) {
  if (!isNonEmptyString(value) || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label}: expected an ISO date-time string`);
  }
}

export function stableReviewStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableReviewStringify).join(",")}]`;
  const entries = Object.entries(value)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right, "en"));
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stableReviewStringify(child)}`).join(",")}}`;
}

export function reviewSha256(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  return createHash("sha256").update(bytes).digest("hex");
}

export function independentReviewEnvironmentPolicy() {
  const policy = JSON.parse(JSON.stringify(INDEPENDENT_REVIEW_ENV_POLICY));
  return { ...policy, sha256: reviewSha256(stableReviewStringify(policy)) };
}

export function createIndependentReviewSanitizedEnvironment(sourceEnvironment = process.env) {
  if (!isRecord(sourceEnvironment)) throw new Error("INDEPENDENT_REVIEW_ENVIRONMENT_INVALID");
  const forbidden = Object.keys(sourceEnvironment).filter((name) =>
    INDEPENDENT_REVIEW_ENV_POLICY.rejected_exact.includes(name) ||
    INDEPENDENT_REVIEW_ENV_POLICY.rejected_prefixes.some((prefix) => name.startsWith(prefix)));
  if (forbidden.length > 0) {
    throw new Error(`INDEPENDENT_REVIEW_ENVIRONMENT_PRELOAD_REJECTED:${forbidden.sort().join(",")}`);
  }
  const environment = {};
  for (const name of INDEPENDENT_REVIEW_ENV_POLICY.inherit_if_present) {
    if (isNonEmptyString(sourceEnvironment[name])) environment[name] = sourceEnvironment[name];
  }
  Object.assign(environment, INDEPENDENT_REVIEW_ENV_POLICY.fixed);
  return environment;
}

function requirementById(document, requirementId) {
  return Array.isArray(document?.requirements)
    ? document.requirements.find((requirement) => requirement?.requirement_id === requirementId)
    : undefined;
}

/**
 * Status, waiver and closure are workflow state, not review subject matter. The
 * remaining projection binds every risk, control, owner, role, test and cited
 * evidence byte named by the traceability document.
 */
export function createIndependentReviewSubject(document, requirementIds) {
  if (!isRecord(document) || !isNonEmptyString(document.round_id) ||
      !isNonEmptyString(document.evidence_boundary) || !Array.isArray(requirementIds) ||
      requirementIds.length === 0) {
    throw new Error("INDEPENDENT_REVIEW_SUBJECT_INVALID");
  }
  const ids = [...new Set(requirementIds)].sort((left, right) => left.localeCompare(right, "en"));
  if (ids.length !== requirementIds.length) throw new Error("INDEPENDENT_REVIEW_SUBJECT_DUPLICATE_REQUIREMENT");
  const requirements = ids.map((requirementId) => {
    const requirement = requirementById(document, requirementId);
    if (!isRecord(requirement)) throw new Error(`INDEPENDENT_REVIEW_SUBJECT_MISSING:${requirementId}`);
    const { status: _status, waiver: _waiver, closure: _closure, ...subject } = requirement;
    return subject;
  });
  return {
    schema_version: "1.0",
    round_id: document.round_id,
    evidence_boundary: document.evidence_boundary,
    requirements,
  };
}

export function independentReviewSubjectSha256(document, requirementIds) {
  return reviewSha256(stableReviewStringify(createIndependentReviewSubject(document, requirementIds)));
}

function frozenIndependentReviewDocumentIdentity(document, requirementIds) {
  return {
    subject: createIndependentReviewSubject(document, requirementIds),
    control_catalog: document?.control_catalog,
  };
}

function safeReviewRelativePath(path, label) {
  if (!isNonEmptyString(path) || path.includes("\0") || path.includes("\\") ||
      /[\u0000-\u001f\u007f]/u.test(path) || posix.isAbsolute(path) ||
      posix.normalize(path) !== path || path === "." || path === ".." || path.startsWith("../")) {
    throw new Error(`${label}: unsafe repository-relative path ${JSON.stringify(path)}`);
  }
  return path;
}

function isAcceptanceSourcePath(path) {
  return ACCEPTANCE_SOURCE_ROOTS.some((root) => path === root || path.startsWith(`${root}/`));
}

function frozenSourceBytes(sourceSnapshotContext, path, label) {
  if (!(sourceSnapshotContext?.contentByPath instanceof Map) ||
      !(sourceSnapshotContext?.identityByPath instanceof Map)) {
    throw new Error(`${label}:FROZEN_SOURCE_SNAPSHOT_REQUIRED`);
  }
  const safePath = safeReviewRelativePath(path, label);
  const bytes = sourceSnapshotContext.contentByPath.get(safePath);
  const identity = sourceSnapshotContext.identityByPath.get(safePath);
  if (!Buffer.isBuffer(bytes) || !identity || bytes.length !== identity.size_bytes ||
      reviewSha256(bytes) !== identity.sha256) {
    throw new Error(`${label}:FROZEN_SOURCE_BYTES_MISSING:${safePath}`);
  }
  return Buffer.from(bytes);
}

async function optionalStat(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function captureIndependentReviewSnapshotTree(snapshotRoot, relativePath, byPath) {
  const safePath = safeReviewRelativePath(relativePath, "INDEPENDENT_REVIEW_SOURCE_SNAPSHOT");
  const absolute = containedPath(snapshotRoot, safePath, "INDEPENDENT_REVIEW_SOURCE_SNAPSHOT");
  const stat = await optionalStat(absolute);
  if (!stat) return;
  if (stat.isSymbolicLink()) throw new Error(`INDEPENDENT_REVIEW_SOURCE_SNAPSHOT_SYMLINK:${safePath}`);
  if (stat.isFile()) {
    if (byPath.has(safePath)) return;
    const descriptorRead = await readRegularFileFromSingleDescriptor(
      absolute,
      "INDEPENDENT_REVIEW_SOURCE_SNAPSHOT",
    );
    const { content } = descriptorRead;
    byPath.set(safePath, {
      content: Buffer.from(content),
      identity: {
        path: safePath,
        size_bytes: content.length,
        executable: (descriptorRead.mode & 0o111) !== 0,
        sha256: reviewSha256(content),
      },
    });
    return;
  }
  if (!stat.isDirectory()) throw new Error(`INDEPENDENT_REVIEW_SOURCE_SNAPSHOT_UNSUPPORTED:${safePath}`);
  const entries = await readdir(absolute, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (const entry of entries) {
    await captureIndependentReviewSnapshotTree(snapshotRoot, posix.join(safePath, entry.name), byPath);
  }
}

async function captureIndependentReviewInstalledRuntimeTree(runtimeRoot, relativePath, byPath) {
  const pendingFiles = [];
  const walk = async (candidate) => {
    const safePath = safeReviewRelativePath(candidate, "INDEPENDENT_REVIEW_INSTALLED_RUNTIME");
    if (safePath.split("/").includes(".bin")) return;
    const absolute = containedPath(runtimeRoot, safePath, "INDEPENDENT_REVIEW_INSTALLED_RUNTIME");
    const stat = await optionalStat(absolute);
    if (!stat) throw new Error(`INDEPENDENT_REVIEW_INSTALLED_RUNTIME_MISSING:${safePath}`);
    if (stat.isSymbolicLink()) {
      throw new Error(`INDEPENDENT_REVIEW_INSTALLED_RUNTIME_SYMLINK:${safePath}`);
    }
    if (stat.isFile()) {
      pendingFiles.push({ safePath, absolute });
      return;
    }
    if (!stat.isDirectory()) {
      throw new Error(`INDEPENDENT_REVIEW_INSTALLED_RUNTIME_UNSUPPORTED:${safePath}`);
    }
    const entries = await readdir(absolute, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    await Promise.all(entries.map((entry) => walk(posix.join(safePath, entry.name))));
  };
  await walk(relativePath);
  pendingFiles.sort((left, right) => left.safePath.localeCompare(right.safePath, "en"));
  const concurrency = 32;
  for (let index = 0; index < pendingFiles.length; index += concurrency) {
    await Promise.all(pendingFiles.slice(index, index + concurrency).map(async ({ safePath, absolute }) => {
      const descriptor = await readRegularFileFromSingleDescriptor(
        absolute,
        "INDEPENDENT_REVIEW_INSTALLED_RUNTIME",
      );
      byPath.set(safePath, {
        content: Buffer.from(descriptor.content),
        identity: {
          path: safePath,
          size_bytes: descriptor.content.length,
          executable: (descriptor.mode & 0o111) !== 0,
          sha256: reviewSha256(descriptor.content),
        },
      });
    }));
  }
}

async function verifyIndependentReviewHostProtectedSnapshot(boundary, snapshotRoot) {
  const effectiveUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (!Number.isSafeInteger(effectiveUid) || effectiveUid === 0) {
    throw new Error("INDEPENDENT_REVIEW_HOST_SNAPSHOT_UNPRIVILEGED_REVIEWER_REQUIRED");
  }
  const identities = [];
  const assertProtected = async (path, kind) => {
    const stat = await lstat(path);
    if (stat.uid !== 0 || (stat.mode & 0o022) !== 0) {
      throw new Error(`INDEPENDENT_REVIEW_HOST_SNAPSHOT_NOT_ROOT_PROTECTED:${kind}:${path}`);
    }
    return stat;
  };
  const walk = async (path, relativePath = "") => {
    const stat = await assertProtected(path, relativePath || "snapshot-root");
    if (stat.isSymbolicLink()) {
      throw new Error(`INDEPENDENT_REVIEW_HOST_SNAPSHOT_SYMLINK:${relativePath}`);
    }
    if (!stat.isDirectory() && !stat.isFile()) {
      throw new Error(`INDEPENDENT_REVIEW_HOST_SNAPSHOT_UNSUPPORTED:${relativePath}`);
    }
    identities.push({
      path: relativePath || ".",
      kind: stat.isDirectory() ? "DIRECTORY" : "REGULAR_FILE",
      device: stat.dev.toString(),
      inode: stat.ino.toString(),
      uid: stat.uid,
      gid: stat.gid,
      mode: stat.mode & 0o7777,
    });
    if (!stat.isDirectory()) return;
    const entries = await readdir(path, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const childRelative = relativePath ? posix.join(relativePath, entry.name) : entry.name;
      if (childRelative.split("/").includes(".bin")) continue;
      await walk(resolve(path, entry.name), childRelative);
    }
  };
  const boundaryStat = await assertProtected(boundary, "host-boundary");
  if (!boundaryStat.isDirectory()) {
    throw new Error("INDEPENDENT_REVIEW_HOST_BOUNDARY_NOT_DIRECTORY");
  }
  let childPath = boundary;
  let childStat = boundaryStat;
  for (let parent = dirname(childPath); parent !== childPath; parent = dirname(parent)) {
    const parentStat = await lstat(parent);
    const writableByNonRoot = (parentStat.mode & 0o022) !== 0;
    const stickyProtectsRootOwnedChild = (parentStat.mode & 0o1000) !== 0 && childStat.uid === 0;
    if (parentStat.uid !== 0 || (writableByNonRoot && !stickyProtectsRootOwnedChild)) {
      throw new Error(`INDEPENDENT_REVIEW_HOST_BOUNDARY_ANCESTOR_REPLACEABLE:${parent}`);
    }
    childPath = parent;
    childStat = parentStat;
  }
  await walk(snapshotRoot);
  const identity = {
    schema_version: "1.0",
    mechanism: "ROOT_OWNED_NONROOT_READ_ONLY_TREE_WITH_PROTECTED_ANCESTORS_V1",
    boundary,
    snapshot_root: snapshotRoot,
    excluded_runtime_subtree_segment: ".bin",
    entry_count: identities.length,
    entries: identities,
  };
  return {
    ...identity,
    verified: true,
    sha256: reviewSha256(stableReviewStringify(identity)),
  };
}

async function verifyIndependentReviewFixedHostInputs({
  boundary,
  inputPaths,
  allowUnprivilegedTestFixture = false,
}) {
  const effectiveUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (!Number.isSafeInteger(effectiveUid) || effectiveUid === 0) {
    throw new Error("INDEPENDENT_REVIEW_FIXED_HOST_INPUT_UNPRIVILEGED_REVIEWER_REQUIRED");
  }
  const identities = [];
  const contentByName = new Map();
  for (const [name, path] of Object.entries(inputPaths)
    .sort(([left], [right]) => left.localeCompare(right, "en"))) {
    if (dirname(path) !== boundary || await realpath(path) !== path) {
      throw new Error(`INDEPENDENT_REVIEW_FIXED_HOST_INPUT_NOT_PROTECTED:${name}`);
    }
    const descriptor = await readRegularFileFromSingleDescriptor(
      path,
      `INDEPENDENT_REVIEW_FIXED_HOST_INPUT_${name.toUpperCase()}`,
    );
    if ((descriptor.mode & 0o222) !== 0 || (descriptor.mode & 0o111) !== 0 ||
        (!allowUnprivilegedTestFixture && descriptor.uid !== 0)) {
      throw new Error(`INDEPENDENT_REVIEW_FIXED_HOST_INPUT_NOT_PROTECTED:${name}`);
    }
    contentByName.set(name, Buffer.from(descriptor.content));
    identities.push({
      name,
      path,
      device: descriptor.device,
      inode: descriptor.inode,
      uid: descriptor.uid,
      gid: descriptor.gid,
      mode: descriptor.mode & 0o7777,
      size_bytes: descriptor.content.length,
      sha256: reviewSha256(descriptor.content),
    });
  }
  const identity = {
    schema_version: "1.0",
    mechanism: allowUnprivilegedTestFixture
      ? "TEST_ONLY_NONWRITABLE_FIXED_HOST_INPUTS_V1"
      : "ROOT_OWNED_NONWRITABLE_FIXED_HOST_INPUTS_V1",
    boundary,
    entry_count: identities.length,
    entries: identities,
  };
  return {
    ...identity,
    verified: allowUnprivilegedTestFixture !== true,
    sha256: reviewSha256(stableReviewStringify(identity)),
    contentByName,
  };
}

async function verifyIndependentReviewHostOutputBoundary(boundary, outputRoot) {
  const effectiveUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (!Number.isSafeInteger(effectiveUid) || effectiveUid === 0 || dirname(outputRoot) !== boundary) {
    throw new Error("INDEPENDENT_REVIEW_HOST_OUTPUT_BOUNDARY_INVALID");
  }
  const stat = await lstat(outputRoot);
  if (stat.isSymbolicLink() || !stat.isDirectory() || await realpath(outputRoot) !== outputRoot ||
      stat.uid !== effectiveUid || (stat.mode & 0o7777) !== 0o700) {
    throw new Error("INDEPENDENT_REVIEW_HOST_OUTPUT_BOUNDARY_INVALID");
  }
  const identity = {
    schema_version: "1.0",
    mechanism: "REVIEWER_OWNED_PRIVATE_OUTPUT_UNDER_PROTECTED_HOST_BOUNDARY_V1",
    boundary,
    output_root: outputRoot,
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    uid: stat.uid,
    gid: stat.gid,
    mode: stat.mode & 0o7777,
  };
  return {
    ...identity,
    verified: true,
    sha256: reviewSha256(stableReviewStringify(identity)),
  };
}

/**
 * Captures the complete reviewer source trust boundary exactly once. All
 * downstream universe, graph, plan and test identities must reuse this
 * context instead of rereading the candidate worktree or invoking PATH git.
 */
export async function captureIndependentReviewSourceSnapshotContext({
  repoRoot,
  snapshotRoot = repoRoot,
  extraPaths = [],
  immutableSnapshotAttestation,
  supplementalImmutableInputs,
  allowSyntheticSupplementalPathsForTests = false,
}) {
  const syntheticSupplementAllowed = allowSyntheticSupplementalPathsForTests === true &&
    process.env.NODE_ENV === "test";
  if (stableReviewStringify([...ACCEPTANCE_SOURCE_ROOTS]) !==
      stableReviewStringify([...APPROVED_ACCEPTANCE_SOURCE_ROOTS])) {
    throw new Error("INDEPENDENT_REVIEW_ACCEPTANCE_SOURCE_ROOT_CONTRACT_DIVERGED");
  }
  const canonicalRepoRoot = await realpath(repoRoot);
  const canonicalSnapshotRoot = await realpath(snapshotRoot);
  if (canonicalSnapshotRoot !== canonicalRepoRoot && immutableSnapshotAttestation === undefined) {
    throw new Error("INDEPENDENT_REVIEW_IMMUTABLE_SNAPSHOT_ATTESTATION_REQUIRED");
  }
  const roots = [...new Set([
    ...APPROVED_ACCEPTANCE_SOURCE_ROOTS,
    ...REVIEW_ROOT_AUTO_CONFIG_CANDIDATES,
  ].map((path) => safeReviewRelativePath(path, "INDEPENDENT_REVIEW_SOURCE_SNAPSHOT_ROOT")))]
    .sort((left, right) => left.localeCompare(right, "en"));
  const sourceByPath = new Map();
  for (const root of roots) await captureIndependentReviewSnapshotTree(canonicalSnapshotRoot, root, sourceByPath);
  const sourceEntries = [...sourceByPath.values()].map((entry) => entry.identity)
    .sort((left, right) => left.path.localeCompare(right.path, "en"));
  if (sourceEntries.length === 0) throw new Error("INDEPENDENT_REVIEW_SOURCE_SNAPSHOT_EMPTY");
  const sourceIdentity = {
    schema_version: "1.0",
    algorithm: "full-acceptance-source-content-snapshot-v1",
    roots,
    path_count: sourceEntries.length,
    total_bytes: sourceEntries.reduce((sum, entry) => sum + entry.size_bytes, 0),
    entries: sourceEntries,
  };
  const sourceSnapshotSha256 = reviewSha256(stableReviewStringify(sourceIdentity));
  let immutableAttestation;
  if (immutableSnapshotAttestation !== undefined) {
    if (!isRecord(immutableSnapshotAttestation) ||
        immutableSnapshotAttestation.schema_version !== "1.0" ||
        immutableSnapshotAttestation.authority !== "APPROVED_REVIEW_HOST" ||
        !isNonEmptyString(immutableSnapshotAttestation.gate_run_id) ||
        !isNonEmptyString(immutableSnapshotAttestation.live_challenge) ||
        immutableSnapshotAttestation.source_snapshot_sha256 !== sourceSnapshotSha256 ||
        !isNonEmptyString(immutableSnapshotAttestation.snapshot_root) ||
        await realpath(immutableSnapshotAttestation.snapshot_root) !== canonicalSnapshotRoot) {
      throw new Error("INDEPENDENT_REVIEW_IMMUTABLE_SNAPSHOT_ATTESTATION_INVALID");
    }
    immutableAttestation = {
      schema_version: "1.0",
      authority: "APPROVED_REVIEW_HOST",
      gate_run_id: immutableSnapshotAttestation.gate_run_id,
      live_challenge: immutableSnapshotAttestation.live_challenge,
      snapshot_root: canonicalSnapshotRoot,
      source_snapshot_sha256: sourceSnapshotSha256,
    };
  }

  const supplementalPaths = [...new Set(extraPaths.map((path) =>
    safeReviewRelativePath(path, "INDEPENDENT_REVIEW_SUPPLEMENTAL_INPUT")))]
    .sort((left, right) => left.localeCompare(right, "en"));
  for (const path of supplementalPaths) {
    const hostSealedHarnessEvidence = path.startsWith("artifacts/harness-runs/") &&
      immutableAttestation !== undefined && supplementalImmutableInputs !== undefined;
    if ((!path.startsWith("artifacts/ledger-kernel-review/") && !hostSealedHarnessEvidence &&
        !syntheticSupplementAllowed) ||
        isAcceptanceSourcePath(path)) {
      throw new Error(`INDEPENDENT_REVIEW_SUPPLEMENTAL_PATH_FORBIDDEN:${path}`);
    }
  }
  const supplementalByPath = new Map();
  if (supplementalImmutableInputs !== undefined) {
    if (!immutableAttestation || !isRecord(supplementalImmutableInputs) ||
        supplementalImmutableInputs.schema_version !== "1.0" ||
        supplementalImmutableInputs.authority !== "APPROVED_REVIEW_HOST" ||
        supplementalImmutableInputs.gate_run_id !== immutableAttestation.gate_run_id ||
        supplementalImmutableInputs.live_challenge !== immutableAttestation.live_challenge ||
        !(supplementalImmutableInputs.contentByPath instanceof Map) ||
        !Array.isArray(supplementalImmutableInputs.entries)) {
      throw new Error("INDEPENDENT_REVIEW_SUPPLEMENTAL_IMMUTABLE_INPUTS_INVALID");
    }
    const manifestPaths = supplementalImmutableInputs.entries.map((entry) => entry?.path);
    if (stableReviewStringify(manifestPaths) !== stableReviewStringify(supplementalPaths)) {
      throw new Error("INDEPENDENT_REVIEW_SUPPLEMENTAL_EXACT_SET_MISMATCH");
    }
    for (const expected of supplementalImmutableInputs.entries) {
      if (!isRecord(expected) || !supplementalPaths.includes(expected.path) ||
          !Number.isSafeInteger(expected.size_bytes) || expected.size_bytes < 0 ||
          typeof expected.executable !== "boolean" || !isSha256(expected.sha256)) {
        throw new Error("INDEPENDENT_REVIEW_SUPPLEMENTAL_MANIFEST_INVALID");
      }
      const content = supplementalImmutableInputs.contentByPath.get(expected.path);
      if (!Buffer.isBuffer(content) || content.length !== expected.size_bytes ||
          reviewSha256(content) !== expected.sha256) {
        throw new Error(`INDEPENDENT_REVIEW_SUPPLEMENTAL_CONTENT_MISMATCH:${expected.path}`);
      }
      supplementalByPath.set(expected.path, { content: Buffer.from(content), identity: { ...expected } });
    }
  } else {
    for (const path of supplementalPaths) {
      await captureIndependentReviewSnapshotTree(canonicalRepoRoot, path, supplementalByPath);
    }
  }
  const supplementalEntries = [...supplementalByPath.values()].map((entry) => entry.identity)
    .sort((left, right) => left.path.localeCompare(right.path, "en"));
  if (stableReviewStringify(supplementalEntries.map((entry) => entry.path)) !==
      stableReviewStringify(supplementalPaths)) {
    throw new Error("INDEPENDENT_REVIEW_SUPPLEMENTAL_EXACT_SET_MISMATCH");
  }
  const supplementalIdentity = {
    schema_version: "1.0",
    algorithm: "exact-round-artifact-supplement-v1",
    paths: supplementalPaths,
    path_count: supplementalEntries.length,
    total_bytes: supplementalEntries.reduce((sum, entry) => sum + entry.size_bytes, 0),
    entries: supplementalEntries,
  };
  const supplementalInputsSha256 = reviewSha256(stableReviewStringify(supplementalIdentity));
  if (supplementalImmutableInputs !== undefined &&
      supplementalImmutableInputs.supplemental_inputs_sha256 !== supplementalInputsSha256) {
    throw new Error("INDEPENDENT_REVIEW_SUPPLEMENTAL_IDENTITY_MISMATCH");
  }
  const combinedEntries = [...sourceEntries, ...supplementalEntries]
    .sort((left, right) => left.path.localeCompare(right.path, "en"));
  const combinedSha256 = reviewSha256(stableReviewStringify({
    source_snapshot_sha256: sourceSnapshotSha256,
    supplemental_inputs_sha256: supplementalInputsSha256,
  }));
  const combinedByPath = new Map([
    ...[...sourceByPath].map(([path, entry]) => [path, Buffer.from(entry.content)]),
    ...[...supplementalByPath].map(([path, entry]) => [path, Buffer.from(entry.content)]),
  ]);
  const receipt = {
    schema_version: "1.0",
    algorithm: "dual-root-independent-review-context-v1",
    roots,
    path_count: combinedEntries.length,
    total_bytes: combinedEntries.reduce((sum, entry) => sum + entry.size_bytes, 0),
    entries: combinedEntries,
    source_entries: sourceEntries,
    supplemental_entries: supplementalEntries,
    source_snapshot_sha256: sourceSnapshotSha256,
    supplemental_inputs_sha256: supplementalInputsSha256,
    sha256: combinedSha256,
    repo_root: canonicalRepoRoot,
    snapshot_root: canonicalSnapshotRoot,
    externally_immutable: immutableAttestation !== undefined,
    immutable_snapshot_attestation: immutableAttestation,
    contentByPath: combinedByPath,
    identityByPath: new Map(combinedEntries.map((entry) => [entry.path, entry])),
    synthetic_supplement_for_tests: syntheticSupplementAllowed,
  };
  return receipt;
}

function parseIndependentReviewHostJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${label}_INVALID_JSON`);
  }
}

function fixedIndependentReviewHostPath(boundary, name, label) {
  const path = resolve(boundary, name);
  if (relative(boundary, path) !== name || isAbsolute(name) || name.includes("\0")) {
    throw new Error(`${label}_PATH_INVALID`);
  }
  return path;
}

/**
 * Rehydrates one immutable reviewer context from the fixed Gate-owned
 * boundary surrounding live-context.json. No path is selected by the JSON
 * document: the external parent supplies that one file, and every other
 * location has a fixed name beneath the same canonical directory.
 */
export async function loadIndependentReviewLiveSourceSnapshotContext({
  liveContextPath,
  documentRelativePath,
  allowSyntheticSupplementalPathsForTests = false,
}) {
  if (basename(liveContextPath) !== INDEPENDENT_REVIEW_HOST_CONTEXT_FILES.live_context) {
    throw new Error("INDEPENDENT_REVIEW_LIVE_CONTEXT_FIXED_NAME_REQUIRED");
  }
  const canonicalBoundary = await realpath(dirname(liveContextPath));
  const canonicalLiveContextPath = await realpath(liveContextPath);
  if (dirname(canonicalLiveContextPath) !== canonicalBoundary) {
    throw new Error("INDEPENDENT_REVIEW_LIVE_CONTEXT_BOUNDARY_INVALID");
  }
  const snapshotCandidate = fixedIndependentReviewHostPath(
    canonicalBoundary,
    INDEPENDENT_REVIEW_HOST_CONTEXT_FILES.snapshot_directory,
    "INDEPENDENT_REVIEW_HOST_SNAPSHOT",
  );
  const snapshotRoot = await realpath(snapshotCandidate);
  if (relative(canonicalBoundary, snapshotRoot) !==
      INDEPENDENT_REVIEW_HOST_CONTEXT_FILES.snapshot_directory) {
    throw new Error("INDEPENDENT_REVIEW_HOST_SNAPSHOT_BOUNDARY_INVALID");
  }
  const outputRoot = fixedIndependentReviewHostPath(
    canonicalBoundary,
    INDEPENDENT_REVIEW_HOST_CONTEXT_FILES.output_directory,
    "INDEPENDENT_REVIEW_HOST_OUTPUT",
  );
  const syntheticHostFixture = allowSyntheticSupplementalPathsForTests === true &&
    process.env.NODE_ENV === "test";
  const hostSnapshotProtection = syntheticHostFixture
    ? {
        schema_version: "1.0",
        mechanism: "TEST_ONLY_UNVERIFIED_HOST_SNAPSHOT",
        boundary: canonicalBoundary,
        snapshot_root: snapshotRoot,
        verified: false,
        sha256: reviewSha256(stableReviewStringify({
          schema_version: "1.0",
          mechanism: "TEST_ONLY_UNVERIFIED_HOST_SNAPSHOT",
          boundary: canonicalBoundary,
          snapshot_root: snapshotRoot,
        })),
      }
    : await verifyIndependentReviewHostProtectedSnapshot(canonicalBoundary, snapshotRoot);
  const fixedHostInputPaths = Object.freeze({
    live_context: canonicalLiveContextPath,
    source_manifest: fixedIndependentReviewHostPath(
      canonicalBoundary,
      INDEPENDENT_REVIEW_HOST_CONTEXT_FILES.source_manifest,
      "INDEPENDENT_REVIEW_SOURCE_SNAPSHOT_MANIFEST",
    ),
    source_attestation: fixedIndependentReviewHostPath(
      canonicalBoundary,
      INDEPENDENT_REVIEW_HOST_CONTEXT_FILES.source_attestation,
      "INDEPENDENT_REVIEW_SOURCE_SNAPSHOT_ATTESTATION",
    ),
    supplemental_manifest: fixedIndependentReviewHostPath(
      canonicalBoundary,
      INDEPENDENT_REVIEW_HOST_CONTEXT_FILES.supplemental_manifest,
      "INDEPENDENT_REVIEW_SUPPLEMENTAL_MANIFEST",
    ),
  });
  const fixedHostInputProtection = await verifyIndependentReviewFixedHostInputs({
    boundary: canonicalBoundary,
    inputPaths: fixedHostInputPaths,
    allowUnprivilegedTestFixture: syntheticHostFixture,
  });
  const hostOutputBoundaryProtection = await verifyIndependentReviewHostOutputBoundary(
    canonicalBoundary,
    outputRoot,
  );
  const liveContextBytes = fixedHostInputProtection.contentByName.get("live_context");
  const liveContext = parseIndependentReviewHostJson(
    liveContextBytes,
    "INDEPENDENT_REVIEW_LIVE_CONTEXT",
  );
  const requiredLiveDigests = [
    "source_fingerprint_sha256", "source_snapshot_sha256",
    "source_snapshot_manifest_sha256", "source_snapshot_attestation_sha256",
    "supplemental_inputs_sha256", "supplemental_manifest_sha256",
  ];
  if (!isRecord(liveContext) || liveContext.schema_version !== "1.0" ||
      liveContext.mode !== "LOCAL_ACCEPTANCE_GATE_LIVE" ||
      !isNonEmptyString(liveContext.gate_run_id) || !isSha256(liveContext.live_challenge) ||
      requiredLiveDigests.some((field) => !isSha256(liveContext[field]))) {
    throw new Error("INDEPENDENT_REVIEW_LIVE_CONTEXT_IDENTITY_INVALID");
  }
  const readFixedJson = async (name, expectedSha256, label) => {
    const field = Object.entries(INDEPENDENT_REVIEW_HOST_CONTEXT_FILES)
      .find(([, fixedName]) => fixedName === name)?.[0];
    const bytes = fixedHostInputProtection.contentByName.get(field);
    if (!Buffer.isBuffer(bytes)) throw new Error(`${label}_MISSING`);
    if (reviewSha256(bytes) !== expectedSha256) throw new Error(`${label}_HASH_DIVERGED`);
    return { bytes, value: parseIndependentReviewHostJson(bytes, label) };
  };
  const [sourceManifestFile, sourceAttestationFile, supplementalManifestFile] = await Promise.all([
    readFixedJson(
      INDEPENDENT_REVIEW_HOST_CONTEXT_FILES.source_manifest,
      liveContext.source_snapshot_manifest_sha256,
      "INDEPENDENT_REVIEW_SOURCE_SNAPSHOT_MANIFEST",
    ),
    readFixedJson(
      INDEPENDENT_REVIEW_HOST_CONTEXT_FILES.source_attestation,
      liveContext.source_snapshot_attestation_sha256,
      "INDEPENDENT_REVIEW_SOURCE_SNAPSHOT_ATTESTATION",
    ),
    readFixedJson(
      INDEPENDENT_REVIEW_HOST_CONTEXT_FILES.supplemental_manifest,
      liveContext.supplemental_manifest_sha256,
      "INDEPENDENT_REVIEW_SUPPLEMENTAL_MANIFEST",
    ),
  ]);
  const sourceManifest = sourceManifestFile.value;
  exactFields(sourceManifest, [
    "schema_version", "kind", "algorithm", "roots", "path_count", "total_bytes",
    "entries", "source_fingerprint_sha256", "source_snapshot_sha256",
  ], "INDEPENDENT_REVIEW_SOURCE_SNAPSHOT_MANIFEST");
  if (sourceManifest.schema_version !== "1.0" ||
      sourceManifest.kind !== "INDEPENDENT_REVIEW_SOURCE_SNAPSHOT_MANIFEST" ||
      sourceManifest.algorithm !== "full-acceptance-source-content-snapshot-v1" ||
      sourceManifest.source_fingerprint_sha256 !== liveContext.source_fingerprint_sha256 ||
      sourceManifest.source_snapshot_sha256 !== liveContext.source_snapshot_sha256) {
    throw new Error("INDEPENDENT_REVIEW_SOURCE_SNAPSHOT_MANIFEST_INVALID");
  }
  const sourceAttestation = sourceAttestationFile.value;
  exactFields(sourceAttestation, [
    "schema_version", "authority", "gate_run_id", "live_challenge", "snapshot_root",
    "source_snapshot_sha256", "source_snapshot_manifest_sha256",
    "supplemental_inputs_sha256", "supplemental_manifest_sha256",
  ], "INDEPENDENT_REVIEW_SOURCE_SNAPSHOT_ATTESTATION");
  if (sourceAttestation.schema_version !== "1.0" ||
      sourceAttestation.authority !== "APPROVED_REVIEW_HOST" ||
      sourceAttestation.gate_run_id !== liveContext.gate_run_id ||
      sourceAttestation.live_challenge !== liveContext.live_challenge ||
      sourceAttestation.snapshot_root !== INDEPENDENT_REVIEW_HOST_CONTEXT_FILES.snapshot_directory ||
      sourceAttestation.source_snapshot_sha256 !== liveContext.source_snapshot_sha256 ||
      sourceAttestation.source_snapshot_manifest_sha256 !==
        liveContext.source_snapshot_manifest_sha256 ||
      sourceAttestation.supplemental_inputs_sha256 !== liveContext.supplemental_inputs_sha256 ||
      sourceAttestation.supplemental_manifest_sha256 !== liveContext.supplemental_manifest_sha256) {
    throw new Error("INDEPENDENT_REVIEW_SOURCE_SNAPSHOT_ATTESTATION_INVALID");
  }
  const supplementalManifest = supplementalManifestFile.value;
  exactFields(supplementalManifest, [
    "schema_version", "kind", "authority", "gate_run_id", "live_challenge", "snapshot_root",
    "algorithm", "paths", "path_count", "total_bytes", "entries",
    "supplemental_inputs_sha256",
  ], "INDEPENDENT_REVIEW_SUPPLEMENTAL_MANIFEST");
  if (supplementalManifest.schema_version !== "1.0" ||
      supplementalManifest.kind !== "INDEPENDENT_REVIEW_SUPPLEMENTAL_INPUTS_MANIFEST" ||
      supplementalManifest.authority !== "APPROVED_REVIEW_HOST" ||
      supplementalManifest.gate_run_id !== liveContext.gate_run_id ||
      supplementalManifest.live_challenge !== liveContext.live_challenge ||
      supplementalManifest.snapshot_root !== INDEPENDENT_REVIEW_HOST_CONTEXT_FILES.snapshot_directory ||
      supplementalManifest.algorithm !== "exact-round-artifact-supplement-v1" ||
      supplementalManifest.supplemental_inputs_sha256 !== liveContext.supplemental_inputs_sha256 ||
      !Array.isArray(supplementalManifest.paths) || !Array.isArray(supplementalManifest.entries) ||
      stableReviewStringify(supplementalManifest.paths) !== stableReviewStringify(
        supplementalManifest.entries.map((entry) => entry?.path),
      )) {
    throw new Error("INDEPENDENT_REVIEW_SUPPLEMENTAL_MANIFEST_INVALID");
  }
  const expectedRoots = [...new Set([
    ...APPROVED_ACCEPTANCE_SOURCE_ROOTS,
    ...REVIEW_ROOT_AUTO_CONFIG_CANDIDATES,
  ])].sort((left, right) => left.localeCompare(right, "en"));
  if (stableReviewStringify(sourceManifest.roots) !== stableReviewStringify(expectedRoots) ||
      !Array.isArray(sourceManifest.entries)) {
    throw new Error("INDEPENDENT_REVIEW_SOURCE_SNAPSHOT_MANIFEST_INVALID");
  }
  const readManifestEntries = async (entries, kind) => {
    const identities = [];
    const contentByPath = new Map();
    let priorPath = "";
    for (const entry of entries) {
      if (!isRecord(entry) || !isNonEmptyString(entry.path) ||
          !Number.isSafeInteger(entry.size_bytes) || entry.size_bytes < 0 ||
          typeof entry.executable !== "boolean" || !isSha256(entry.sha256)) {
        throw new Error(`INDEPENDENT_REVIEW_${kind}_MANIFEST_INVALID`);
      }
      const safePath = safeReviewRelativePath(entry.path, `INDEPENDENT_REVIEW_${kind}_MANIFEST`);
      if (safePath.localeCompare(priorPath, "en") <= 0) {
        throw new Error(`INDEPENDENT_REVIEW_${kind}_MANIFEST_INVALID`);
      }
      priorPath = safePath;
      const sourceEntry = kind === "SOURCE_SNAPSHOT";
      const syntheticAllowed = allowSyntheticSupplementalPathsForTests === true &&
        process.env.NODE_ENV === "test";
      if (sourceEntry
        ? !isAcceptanceSourcePath(safePath) && !REVIEW_ROOT_AUTO_CONFIG_CANDIDATES.includes(safePath)
        : isAcceptanceSourcePath(safePath) ||
          (!safePath.startsWith("artifacts/ledger-kernel-review/") &&
           !safePath.startsWith("artifacts/harness-runs/") && !syntheticAllowed)) {
        throw new Error(`INDEPENDENT_REVIEW_${kind}_PATH_FORBIDDEN:${safePath}`);
      }
      const absolute = containedPath(snapshotRoot, safePath, `INDEPENDENT_REVIEW_${kind}_MANIFEST`);
      if (await realpath(absolute) !== absolute) {
        throw new Error(`INDEPENDENT_REVIEW_${kind}_SYMLINK:${safePath}`);
      }
      const descriptor = await readRegularFileFromSingleDescriptor(
        absolute,
        `INDEPENDENT_REVIEW_${kind}_CONTENT`,
      );
      if (descriptor.content.length !== entry.size_bytes ||
          reviewSha256(descriptor.content) !== entry.sha256 ||
          ((descriptor.mode & 0o111) !== 0) !== entry.executable) {
        throw new Error(`INDEPENDENT_REVIEW_${kind}_CONTENT_MISMATCH:${safePath}`);
      }
      identities.push({ ...entry, path: safePath });
      contentByPath.set(safePath, Buffer.from(descriptor.content));
    }
    return { identities, contentByPath };
  };
  const [sourceCapture, supplementalCapture] = await Promise.all([
    readManifestEntries(sourceManifest.entries, "SOURCE_SNAPSHOT"),
    readManifestEntries(supplementalManifest.entries, "SUPPLEMENTAL"),
  ]);
  const sourceEntries = sourceCapture.identities;
  const supplementalEntries = supplementalCapture.identities;
  const sourceIdentity = {
    schema_version: "1.0",
    algorithm: "full-acceptance-source-content-snapshot-v1",
    roots: expectedRoots,
    path_count: sourceEntries.length,
    total_bytes: sourceEntries.reduce((sum, entry) => sum + entry.size_bytes, 0),
    entries: sourceEntries,
  };
  const supplementalIdentity = {
    schema_version: "1.0",
    algorithm: "exact-round-artifact-supplement-v1",
    paths: supplementalEntries.map((entry) => entry.path),
    path_count: supplementalEntries.length,
    total_bytes: supplementalEntries.reduce((sum, entry) => sum + entry.size_bytes, 0),
    entries: supplementalEntries,
  };
  if (sourceManifest.path_count !== sourceIdentity.path_count ||
      sourceManifest.total_bytes !== sourceIdentity.total_bytes ||
      reviewSha256(stableReviewStringify(sourceIdentity)) !== liveContext.source_snapshot_sha256 ||
      supplementalManifest.path_count !== supplementalIdentity.path_count ||
      supplementalManifest.total_bytes !== supplementalIdentity.total_bytes ||
      stableReviewStringify(supplementalManifest.paths) !==
        stableReviewStringify(supplementalIdentity.paths) ||
      reviewSha256(stableReviewStringify(supplementalIdentity)) !==
        liveContext.supplemental_inputs_sha256) {
    throw new Error("INDEPENDENT_REVIEW_LIVE_SOURCE_CONTEXT_DIVERGED");
  }
  const immutableSnapshotAttestation = {
    schema_version: "1.0",
    authority: "APPROVED_REVIEW_HOST",
    gate_run_id: liveContext.gate_run_id,
    live_challenge: liveContext.live_challenge,
    snapshot_root: snapshotRoot,
    source_snapshot_sha256: liveContext.source_snapshot_sha256,
  };
  const combinedEntries = [...sourceEntries, ...supplementalEntries]
    .sort((left, right) => left.path.localeCompare(right.path, "en"));
  if (new Set(combinedEntries.map((entry) => entry.path)).size !== combinedEntries.length) {
    throw new Error("INDEPENDENT_REVIEW_LIVE_SOURCE_CONTEXT_PATH_OVERLAP");
  }
  const sourceSnapshotContext = {
    schema_version: "1.0",
    algorithm: "dual-root-independent-review-context-v1",
    roots: expectedRoots,
    path_count: combinedEntries.length,
    total_bytes: combinedEntries.reduce((sum, entry) => sum + entry.size_bytes, 0),
    entries: combinedEntries,
    source_entries: sourceEntries,
    supplemental_entries: supplementalEntries,
    source_snapshot_sha256: liveContext.source_snapshot_sha256,
    supplemental_inputs_sha256: liveContext.supplemental_inputs_sha256,
    sha256: reviewSha256(stableReviewStringify({
      source_snapshot_sha256: liveContext.source_snapshot_sha256,
      supplemental_inputs_sha256: liveContext.supplemental_inputs_sha256,
    })),
    repo_root: snapshotRoot,
    snapshot_root: snapshotRoot,
    externally_immutable: true,
    host_attested_snapshot: true,
    host_snapshot_protection: hostSnapshotProtection,
    host_snapshot_protection_verified: hostSnapshotProtection.verified === true,
    fixed_host_input_paths: fixedHostInputPaths,
    fixed_host_input_protection: {
      ...fixedHostInputProtection,
      contentByName: undefined,
    },
    host_output_boundary_protection: hostOutputBoundaryProtection,
    immutable_snapshot_attestation: immutableSnapshotAttestation,
    contentByPath: new Map([
      ...sourceCapture.contentByPath,
      ...supplementalCapture.contentByPath,
    ]),
    identityByPath: new Map(combinedEntries.map((entry) => [entry.path, entry])),
    synthetic_supplement_for_tests: allowSyntheticSupplementalPathsForTests === true &&
      process.env.NODE_ENV === "test",
  };
  const computedSourceManifest = {
    schema_version: "1.0",
    kind: "INDEPENDENT_REVIEW_SOURCE_SNAPSHOT_MANIFEST",
    algorithm: "full-acceptance-source-content-snapshot-v1",
    roots: sourceSnapshotContext.roots,
    path_count: sourceSnapshotContext.source_entries.length,
    total_bytes: sourceSnapshotContext.source_entries.reduce(
      (sum, entry) => sum + entry.size_bytes, 0,
    ),
    entries: sourceSnapshotContext.source_entries,
    source_fingerprint_sha256: liveContext.source_fingerprint_sha256,
    source_snapshot_sha256: sourceSnapshotContext.source_snapshot_sha256,
  };
  if (stableReviewStringify(computedSourceManifest) !== stableReviewStringify(sourceManifest) ||
      sourceSnapshotContext.source_snapshot_sha256 !== liveContext.source_snapshot_sha256 ||
      sourceSnapshotContext.supplemental_inputs_sha256 !== liveContext.supplemental_inputs_sha256) {
    throw new Error("INDEPENDENT_REVIEW_LIVE_SOURCE_CONTEXT_DIVERGED");
  }
  const safeDocumentPath = safeReviewRelativePath(
    documentRelativePath,
    "INDEPENDENT_REVIEW_LIVE_DOCUMENT",
  );
  const documentBytes = sourceSnapshotContext.contentByPath.get(safeDocumentPath);
  if (!Buffer.isBuffer(documentBytes)) {
    throw new Error("INDEPENDENT_REVIEW_LIVE_DOCUMENT_NOT_IN_FROZEN_CONTEXT");
  }
  const document = parseIndependentReviewHostJson(
    documentBytes,
    "INDEPENDENT_REVIEW_LIVE_DOCUMENT",
  );
  return {
    liveContext,
    liveContextBytes,
    document,
    documentPath: resolve(snapshotRoot, safeDocumentPath),
    repoRoot: snapshotRoot,
    outputRoot,
    sourceSnapshotContext,
    hostContextReceipt: {
      schema_version: "1.0",
      gate_run_id: liveContext.gate_run_id,
      live_challenge_sha256: reviewSha256(liveContext.live_challenge),
      source_snapshot_sha256: sourceSnapshotContext.source_snapshot_sha256,
      source_snapshot_manifest_sha256: reviewSha256(sourceManifestFile.bytes),
      source_snapshot_attestation_sha256: reviewSha256(sourceAttestationFile.bytes),
      supplemental_inputs_sha256: sourceSnapshotContext.supplemental_inputs_sha256,
      supplemental_manifest_sha256: reviewSha256(supplementalManifestFile.bytes),
      host_snapshot_protection_sha256: hostSnapshotProtection.sha256,
      host_snapshot_protection_verified: hostSnapshotProtection.verified === true,
      fixed_host_input_protection_sha256: fixedHostInputProtection.sha256,
      fixed_host_input_protection_verified: fixedHostInputProtection.verified === true,
      host_output_boundary_protection_sha256: hostOutputBoundaryProtection.sha256,
    },
  };
}

export async function assertIndependentReviewSourceSnapshotUnchanged(context) {
  if (!isRecord(context) || !(context.contentByPath instanceof Map) || !isSha256(context.sha256)) {
    throw new Error("INDEPENDENT_REVIEW_SOURCE_SNAPSHOT_CONTEXT_INVALID");
  }
  if (context.externally_immutable) {
    if (context.host_snapshot_protection_verified === true) {
      const currentProtection = await verifyIndependentReviewHostProtectedSnapshot(
        context.host_snapshot_protection.boundary,
        context.snapshot_root,
      );
      if (currentProtection.sha256 !== context.host_snapshot_protection.sha256) {
        throw new Error("INDEPENDENT_REVIEW_HOST_SNAPSHOT_PROTECTION_CHANGED");
      }
    } else if (!(process.env.NODE_ENV === "test" &&
        context.synthetic_supplement_for_tests === true &&
        context.host_snapshot_protection?.mechanism === "TEST_ONLY_UNVERIFIED_HOST_SNAPSHOT")) {
      throw new Error("INDEPENDENT_REVIEW_HOST_SNAPSHOT_PROTECTION_UNVERIFIED");
    }
    const currentFixedInputs = await verifyIndependentReviewFixedHostInputs({
      boundary: context.host_snapshot_protection.boundary,
      inputPaths: context.fixed_host_input_paths,
      allowUnprivilegedTestFixture: context.synthetic_supplement_for_tests === true &&
        process.env.NODE_ENV === "test",
    });
    if (currentFixedInputs.sha256 !== context.fixed_host_input_protection?.sha256) {
      throw new Error("INDEPENDENT_REVIEW_FIXED_HOST_INPUT_CHANGED");
    }
    const currentOutputBoundary = await verifyIndependentReviewHostOutputBoundary(
      context.host_snapshot_protection.boundary,
      context.host_output_boundary_protection?.output_root,
    );
    if (currentOutputBoundary.sha256 !== context.host_output_boundary_protection?.sha256) {
      throw new Error("INDEPENDENT_REVIEW_HOST_OUTPUT_BOUNDARY_CHANGED");
    }
    // The host receipt freezes an exact source path set, not merely the bytes
    // which existed at capture time. Re-enumerate every accepted root and
    // root-level auto-config candidate so a newly added config/module cannot
    // influence disk execution while remaining absent from the manifest.
    const recapturedSource = new Map();
    for (const root of context.roots) {
      await captureIndependentReviewSnapshotTree(context.snapshot_root, root, recapturedSource);
    }
    const recapturedSourceEntries = [...recapturedSource.values()].map((entry) => entry.identity)
      .sort((left, right) => left.path.localeCompare(right.path, "en"));
    if (stableReviewStringify(recapturedSourceEntries) !==
        stableReviewStringify(context.source_entries)) {
      throw new Error("INDEPENDENT_REVIEW_LIVE_SNAPSHOT_EXACT_SOURCE_SET_CHANGED");
    }
    // Supplemental evidence is an exact, read-only manifest set. Reviewer
    // outputs are deliberately not members of this set and therefore cannot
    // become review inputs merely by being written beside the document.
    for (const entry of context.supplemental_entries) {
      const absolute = containedPath(
        context.snapshot_root,
        entry.path,
        "INDEPENDENT_REVIEW_LIVE_SNAPSHOT_RECHECK",
      );
      const descriptor = await readRegularFileFromSingleDescriptor(
        absolute,
        "INDEPENDENT_REVIEW_LIVE_SNAPSHOT_RECHECK",
      );
      if (descriptor.content.length !== entry.size_bytes ||
          reviewSha256(descriptor.content) !== entry.sha256 ||
          ((descriptor.mode & 0o111) !== 0) !== entry.executable) {
        throw new Error(`INDEPENDENT_REVIEW_LIVE_SNAPSHOT_CHANGED:${entry.path}`);
      }
    }
    return;
  }
  const recaptured = await captureIndependentReviewSourceSnapshotContext({
    repoRoot: context.repo_root,
    snapshotRoot: context.snapshot_root,
    extraPaths: context.supplemental_entries.map((entry) => entry.path),
    allowSyntheticSupplementalPathsForTests: context.synthetic_supplement_for_tests === true,
  });
  if (context.synthetic_supplement_for_tests === true && process.env.NODE_ENV === "test") {
    const documentPath = context.supplemental_entries.find((entry) =>
      /(?:^|\/)requirements(?:-traceability)?\.json$/u.test(entry.path))?.path;
    const withoutDocument = (value) => value.supplemental_entries
      .filter((entry) => entry.path !== documentPath)
      .map((entry) => ({ path: entry.path, size_bytes: entry.size_bytes, executable: entry.executable, sha256: entry.sha256 }));
    if (recaptured.source_snapshot_sha256 !== context.source_snapshot_sha256 ||
        stableReviewStringify(withoutDocument(recaptured)) !== stableReviewStringify(withoutDocument(context))) {
      throw new Error("INDEPENDENT_REVIEW_SOURCE_CHANGED_DURING_STANDALONE_CAPTURE");
    }
    return;
  }
  if (recaptured.sha256 !== context.sha256) {
    throw new Error("INDEPENDENT_REVIEW_SOURCE_CHANGED_DURING_STANDALONE_CAPTURE");
  }
}

function addUniverseReason(byPath, path, reason) {
  const safePath = safeReviewRelativePath(path, "INDEPENDENT_REVIEW_UNIVERSE");
  const reasons = byPath.get(safePath) ?? new Set();
  reasons.add(reason);
  byPath.set(safePath, reasons);
}

function allDocumentRequirementIds(document) {
  if (!Array.isArray(document?.requirements)) throw new Error("INDEPENDENT_REVIEW_UNIVERSE_DOCUMENT_INVALID");
  const ids = document.requirements.map((requirement) => requirement?.requirement_id);
  if (ids.length === 0 || ids.some((id) => !isNonEmptyString(id)) || new Set(ids).size !== ids.length) {
    throw new Error("INDEPENDENT_REVIEW_UNIVERSE_DOCUMENT_REQUIREMENTS_INVALID");
  }
  return ids.sort((left, right) => left.localeCompare(right, "en"));
}

function preferredRequirementId(allIds, preferred, fallbackIndex = 0) {
  return allIds.includes(preferred) ? preferred : allIds[Math.min(fallbackIndex, allIds.length - 1)];
}

function addRequirementMapping(mapping, path, requirementId) {
  const values = mapping.get(path) ?? new Set();
  values.add(requirementId);
  mapping.set(path, values);
}

function reviewTypescriptScriptKind(ts, path) {
  if (path.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (path.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.(?:mts|mjs)$/u.test(path)) return ts.ScriptKind.TS;
  if (/\.(?:cts|cjs)$/u.test(path)) return ts.ScriptKind.TS;
  if (path.endsWith(".json")) return ts.ScriptKind.JSON;
  if (path.endsWith(".js")) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

async function frozenReviewTypescriptParser(repoRoot, sourceSnapshotContext) {
  if (sourceSnapshotContext && typescriptParserBySnapshotContext.has(sourceSnapshotContext)) {
    const cached = typescriptParserBySnapshotContext.get(sourceSnapshotContext);
    if (cached.repo_root !== await realpath(repoRoot)) {
      throw new Error("INDEPENDENT_REVIEW_TYPESCRIPT_CONTEXT_ROOT_DIVERGED");
    }
    return cached.typescript;
  }
  const canonicalRoot = await realpath(repoRoot);
  const runtimeRequire = createRequire(resolve(canonicalRoot, "package.json"));
  let modulePath;
  try {
    modulePath = await realpath(runtimeRequire.resolve("typescript"));
  } catch {
    throw new Error("INDEPENDENT_REVIEW_TYPESCRIPT_RUNTIME_REQUIRED");
  }
  const runtimeNodeModules = resolve(canonicalRoot, "node_modules");
  const moduleRelative = relative(runtimeNodeModules, modulePath);
  if (!moduleRelative || moduleRelative === ".." || moduleRelative.startsWith(`..${sep}`) ||
      isAbsolute(moduleRelative)) {
    throw new Error("INDEPENDENT_REVIEW_TYPESCRIPT_RUNTIME_OUTSIDE_FROZEN_ROOT");
  }
  const moduleBytes = await readRegularFileFromSingleDescriptor(
    modulePath,
    "INDEPENDENT_REVIEW_TYPESCRIPT_RUNTIME_MODULE",
  );
  const loaded = await import(`${pathToFileURL(modulePath).href}?sha256=${reviewSha256(moduleBytes.content)}`);
  const typescript = loaded.default ?? loaded;
  if (typeof typescript.createSourceFile !== "function" ||
      typeof typescript.forEachChild !== "function") {
    throw new Error("INDEPENDENT_REVIEW_TYPESCRIPT_RUNTIME_INVALID");
  }
  if (sourceSnapshotContext) {
    typescriptParserBySnapshotContext.set(sourceSnapshotContext, {
      repo_root: canonicalRoot,
      typescript,
    });
  }
  return typescript;
}

function moduleReferences(ts, path, content) {
  const text = content.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(content)) return [];
  const source = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    reviewTypescriptScriptKind(ts, path),
  );
  const references = [];
  const add = (literal, dependencyExportAnchors = [], kind = "MODULE") => {
    if (!literal || typeof literal.text !== "string") return;
    references.push({
      specifier: literal.text,
      kind,
      importer_anchor_offset_bytes: Buffer.byteLength(text.slice(0, literal.getStart(source) + 1), "utf8"),
      dependency_export_anchors: [...new Set(dependencyExportAnchors)].sort((left, right) =>
        left.localeCompare(right, "en")),
    });
  };
  const bindingNames = (name) => {
    const names = [];
    const walk = (candidate) => {
      if (ts.isIdentifier(candidate)) names.push(candidate.text);
      else for (const element of candidate.elements ?? []) walk(element.name ?? element);
    };
    if (name) walk(name);
    return names;
  };
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const anchors = [];
      const clause = node.importClause;
      if (clause?.name) anchors.push("default");
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) anchors.push((element.propertyName ?? element.name).text);
      } else if (bindings && ts.isNamespaceImport(bindings)) {
        anchors.push(bindings.name.text);
      }
      add(node.moduleSpecifier, anchors);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier &&
        ts.isStringLiteralLike(node.moduleSpecifier)) {
      const anchors = [];
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) {
          anchors.push((element.propertyName ?? element.name).text);
        }
      }
      add(node.moduleSpecifier, anchors);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) &&
        node.moduleReference.expression && ts.isStringLiteralLike(node.moduleReference.expression)) {
      add(node.moduleReference.expression, [node.name.text]);
    } else if (ts.isCallExpression(node) && node.arguments.length === 1 &&
        ts.isStringLiteralLike(node.arguments[0]) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
         (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      const declaration = ts.isVariableDeclaration(node.parent) ? node.parent : undefined;
      add(node.arguments[0], bindingNames(declaration?.name));
    } else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) &&
        node.expression.text === "URL" && node.arguments?.length === 2 &&
        ts.isStringLiteralLike(node.arguments[0]) &&
        node.arguments[1].getText(source) === "import.meta.url") {
      add(node.arguments[0], [], "RESOURCE_URL");
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return references.sort((left, right) =>
    left.specifier.localeCompare(right.specifier, "en") ||
    left.importer_anchor_offset_bytes - right.importer_anchor_offset_bytes);
}

export async function resolveIndependentReviewLocalModulePath(
  repoRoot,
  importerPath,
  specifier,
  availablePaths,
) {
  const base = posix.normalize(posix.join(posix.dirname(importerPath), specifier));
  if (base === ".." || base.startsWith("../") || posix.isAbsolute(base)) return undefined;
  const candidates = [base];
  const extension = posix.extname(base);
  const stem = extension ? base.slice(0, -extension.length) : base;
  if (extension === ".js") candidates.push(`${stem}.ts`, `${stem}.tsx`);
  else if (extension === ".jsx") candidates.push(`${stem}.tsx`);
  else if (extension === ".mjs") candidates.push(`${stem}.mts`);
  else if (extension === ".cjs") candidates.push(`${stem}.cts`);
  if (!extension) {
    candidates.push(
      `${base}.ts`, `${base}.tsx`, `${base}.mts`, `${base}.cts`,
      `${base}.js`, `${base}.mjs`, `${base}.cjs`, `${base}.json`,
      posix.join(base, "index.ts"), posix.join(base, "index.tsx"), posix.join(base, "index.mts"),
      posix.join(base, "index.cts"), posix.join(base, "index.js"), posix.join(base, "index.mjs"),
      posix.join(base, "index.cjs"),
    );
  }
  for (const candidate of candidates) {
    if (availablePaths instanceof Set) {
      if (availablePaths.has(candidate)) return candidate;
      continue;
    }
    const stat = await optionalStat(containedPath(repoRoot, candidate, "INDEPENDENT_REVIEW_DEPENDENCY"));
    if (stat?.isFile() && !stat.isSymbolicLink()) return candidate;
  }
  return undefined;
}

export async function deriveIndependentReviewDependencyGraph({
  repoRoot,
  universePaths,
  contentByPath,
  sourceSnapshotContext,
}) {
  if (!(contentByPath instanceof Map)) {
    throw new Error("INDEPENDENT_REVIEW_DEPENDENCY_GRAPH_FROZEN_CONTENT_REQUIRED");
  }
  if (sourceSnapshotContext && dependencyGraphBySnapshotContext.has(sourceSnapshotContext)) {
    const cached = dependencyGraphBySnapshotContext.get(sourceSnapshotContext);
    if (cached.repo_root === await realpath(repoRoot) &&
        stableReviewStringify(cached.universe_paths) === stableReviewStringify(universePaths)) {
      return cached.graph;
    }
  }
  const ts = await frozenReviewTypescriptParser(repoRoot, sourceSnapshotContext);
  const universeSet = new Set(universePaths);
  const dependencies = new Map(universePaths.map((path) => [path, new Set()]));
  const consumers = new Map(universePaths.map((path) => [path, new Set()]));
  const edges = new Map();
  for (const path of universePaths) {
    if (!/\.(?:[cm]?[jt]sx?|json)$/u.test(path)) continue;
    const content = contentByPath.get(path);
    if (!Buffer.isBuffer(content)) {
      throw new Error(`INDEPENDENT_REVIEW_DEPENDENCY_GRAPH_FROZEN_CONTENT_MISSING:${path}`);
    }
    for (const reference of moduleReferences(ts, path, content).filter((item) =>
      item.specifier.startsWith("."))) {
      const dependency = await resolveIndependentReviewLocalModulePath(
        repoRoot, path, reference.specifier, universeSet,
      );
      if (!dependency || !universeSet.has(dependency)) continue;
      dependencies.get(path).add(dependency);
      consumers.get(dependency).add(path);
      const fileEdgeIdentity = stableReviewStringify([path, dependency]);
      const id = reviewSha256(fileEdgeIdentity);
      const prior = edges.get(id) ?? {
        id,
        importer: path,
        dependency,
        import_sites: [],
      };
      const siteIdentity = {
        importer_specifier: reference.specifier,
        importer_anchor_offset_bytes: reference.importer_anchor_offset_bytes,
        dependency_export_anchors: reference.dependency_export_anchors,
      };
      if (!prior.import_sites.some((site) =>
        stableReviewStringify(site) === stableReviewStringify(siteIdentity))) {
        prior.import_sites.push(siteIdentity);
        prior.import_sites.sort((left, right) =>
          left.importer_anchor_offset_bytes - right.importer_anchor_offset_bytes ||
          left.importer_specifier.localeCompare(right.importer_specifier, "en"));
      }
      edges.set(id, prior);
    }
  }
  const graph = {
    dependencies,
    consumers,
    edges: [...edges.values()].sort((left, right) =>
      left.importer.localeCompare(right.importer, "en") ||
      left.dependency.localeCompare(right.dependency, "en")),
  };
  if (sourceSnapshotContext) {
    dependencyGraphBySnapshotContext.set(sourceSnapshotContext, {
      repo_root: await realpath(repoRoot),
      universe_paths: [...universePaths],
      graph,
    });
  }
  return graph;
}

export async function deriveIndependentReviewDependencyMappings({
  document,
  allIds,
  repoRoot,
  universePaths,
  references,
  contentByPath,
  dependencyGraph,
}) {
  const universeSet = new Set(universePaths);
  const mapping = new Map();
  const queues = new Map(allIds.map((id) => [id, []]));
  const { dependencies, consumers } = dependencyGraph ?? await deriveIndependentReviewDependencyGraph({
    repoRoot,
    universePaths,
    contentByPath,
  });
  for (const [path, bindings] of references.entries()) {
    for (const binding of bindings) {
      const requirementId = binding.split(":", 1)[0];
      if (!allIds.includes(requirementId)) continue;
      addRequirementMapping(mapping, path, requirementId);
      if (/:(?:implementation_files|positive_tests|negative_or_mutation_tests):/u.test(binding)) {
        queues.get(requirementId).push(path);
      }
    }
  }
  for (const requirementId of allIds) {
    const visited = new Set();
    const queue = [...queues.get(requirementId)];
    // Review the complete local dependency component in both directions. A
    // control can be bypassed by a wrapper's wrapper just as easily as by its
    // direct consumer, so a one-hop reverse boundary is not sufficient. The
    // bounded-shard capacity check below fails closed if this semantic
    // component is too large for one reviewer execution.
    while (queue.length > 0) {
      const path = queue.shift();
      if (visited.has(path) || !universeSet.has(path)) continue;
      visited.add(path);
      addRequirementMapping(mapping, path, requirementId);
      for (const neighbor of [
        ...(dependencies.get(path) ?? []),
        ...(consumers.get(path) ?? []),
      ]) {
        if (!visited.has(neighbor)) queue.push(neighbor);
      }
    }
  }
  return mapping;
}

async function citationReferences({ document, requirementIds, repoRoot, documentPath }) {
  const references = new Map();
  const evidenceDirectory = dirname(resolve(documentPath));
  for (const requirementId of requirementIds) {
    const requirement = requirementById(document, requirementId);
    if (!isRecord(requirement)) throw new Error(`INDEPENDENT_REVIEW_INPUT_MISSING:${requirementId}`);
    for (const field of ["implementation_files", "positive_tests", "negative_or_mutation_tests", "evidence"]) {
      if (!Array.isArray(requirement[field])) throw new Error(`INDEPENDENT_REVIEW_INPUT_INVALID:${requirementId}:${field}`);
      for (const reference of requirement[field]) {
        const pathPart = field === "evidence" ? reference.split("#", 1)[0] : reference;
        const base = field === "evidence" && !pathPart.includes("/") ? evidenceDirectory : repoRoot;
        const absolute = containedPath(base, pathPart, `INDEPENDENT_REVIEW_INPUT:${requirementId}:${field}`);
        const repoRelative = relative(repoRoot, absolute);
        if (!repoRelative || repoRelative === ".." || repoRelative.startsWith(`..${sep}`) || isAbsolute(repoRelative)) {
          throw new Error(`INDEPENDENT_REVIEW_INPUT_OUTSIDE_REPOSITORY:${reference}`);
        }
        const path = safeReviewRelativePath(repoRelative.replaceAll(sep, "/"), "INDEPENDENT_REVIEW_INPUT");
        const existing = references.get(path) ?? [];
        existing.push(`${requirementId}:${field}:${reference}`);
        references.set(path, existing);
      }
    }
  }
  return references;
}

function documentRepositoryRelativePath(repoRoot, documentPath) {
  const repoRelative = relative(repoRoot, resolve(documentPath));
  if (!repoRelative || repoRelative === ".." || repoRelative.startsWith(`..${sep}`) || isAbsolute(repoRelative)) {
    throw new Error("INDEPENDENT_REVIEW_DOCUMENT_OUTSIDE_REPOSITORY");
  }
  return safeReviewRelativePath(repoRelative.replaceAll(sep, "/"), "INDEPENDENT_REVIEW_DOCUMENT");
}

async function independentReviewSupplementalPaths({
  document,
  repoRoot,
  documentPath,
  references,
  allowSyntheticSupplementalPathsForTests = false,
}) {
  const syntheticSupplementAllowed = allowSyntheticSupplementalPathsForTests === true &&
    process.env.NODE_ENV === "test";
  const paths = new Set([documentRepositoryRelativePath(repoRoot, documentPath)]);
  for (const [path, bindings] of references.entries()) {
    if (isAcceptanceSourcePath(path)) continue;
    if (!bindings.every((binding) => binding.includes(":evidence:"))) {
      throw new Error(`INDEPENDENT_REVIEW_SOURCE_SNAPSHOT_MISSING_IMPLEMENTATION_OR_TEST:${path}`);
    }
    paths.add(path);
  }
  if (isRecord(document.control_catalog) && isNonEmptyString(document.control_catalog.path) &&
      !isAcceptanceSourcePath(document.control_catalog.path)) {
    paths.add(document.control_catalog.path);
  }
  const sorted = [...paths].sort((left, right) => left.localeCompare(right, "en"));
  for (const path of sorted) {
    if (!path.startsWith("artifacts/ledger-kernel-review/") &&
        !path.startsWith("artifacts/harness-runs/") && !syntheticSupplementAllowed) {
      throw new Error(`INDEPENDENT_REVIEW_SUPPLEMENTAL_PATH_FORBIDDEN:${path}`);
    }
  }
  return sorted;
}

export async function captureIndependentReviewDocumentSourceSnapshotContext({
  document,
  repoRoot,
  documentPath,
  snapshotRoot = repoRoot,
  immutableSnapshotAttestation,
  supplementalImmutableInputs,
  allowSyntheticSupplementalPathsForTests = false,
}) {
  const syntheticFixtureAllowed = allowSyntheticSupplementalPathsForTests === true ||
    (process.env.NODE_ENV === "test" && syntheticSupplementFixtureDocuments.has(document));
  const requirementIds = allDocumentRequirementIds(document);
  const references = await citationReferences({ document, requirementIds, repoRoot, documentPath });
  const extraPaths = await independentReviewSupplementalPaths({
    document,
    repoRoot,
    documentPath,
    references,
    allowSyntheticSupplementalPathsForTests: syntheticFixtureAllowed,
  });
  const context = await captureIndependentReviewSourceSnapshotContext({
    repoRoot,
    snapshotRoot,
    extraPaths,
    immutableSnapshotAttestation,
    supplementalImmutableInputs,
    allowSyntheticSupplementalPathsForTests: syntheticFixtureAllowed,
  });
  const frozenDocument = context.contentByPath.get(documentRepositoryRelativePath(repoRoot, documentPath));
  let parsedDocument;
  try {
    parsedDocument = JSON.parse(frozenDocument?.toString("utf8") ?? "");
  } catch {
    throw new Error("INDEPENDENT_REVIEW_FROZEN_TRACEABILITY_DOCUMENT_INVALID");
  }
  const ids = allDocumentRequirementIds(document);
  if (stableReviewStringify(frozenIndependentReviewDocumentIdentity(parsedDocument, ids)) !==
      stableReviewStringify(frozenIndependentReviewDocumentIdentity(document, ids))) {
    throw new Error("INDEPENDENT_REVIEW_FROZEN_TRACEABILITY_DOCUMENT_MISMATCH");
  }
  return context;
}

/**
 * Constructs the non-self-selectable review universe. Cited files are only one
 * input. The universe always includes every byte captured beneath the fixed
 * acceptance-source roots plus root auto-config candidates. Git state and the
 * candidate's PATH are deliberately outside this authority boundary.
 */
export async function deriveIndependentReviewUniverse({
  document,
  requirementIds,
  repoRoot,
  documentPath,
  sourceSnapshotContext,
}) {
  if (!Array.isArray(requirementIds) || requirementIds.length === 0) {
    throw new Error("INDEPENDENT_REVIEW_UNIVERSE_REQUIREMENTS_REQUIRED");
  }
  const reviewedIds = [...new Set(requirementIds)].sort((left, right) => left.localeCompare(right, "en"));
  if (reviewedIds.length !== requirementIds.length) {
    throw new Error("INDEPENDENT_REVIEW_UNIVERSE_DUPLICATE_REQUIREMENT");
  }
  const allIds = allDocumentRequirementIds(document);
  if (reviewedIds.some((requirementId) => !allIds.includes(requirementId))) {
    throw new Error("INDEPENDENT_REVIEW_UNIVERSE_UNKNOWN_REQUIREMENT");
  }
  const references = await citationReferences({ document, requirementIds: allIds, repoRoot, documentPath });
  const ownsSnapshot = !sourceSnapshotContext;
  const expectedSupplementalPaths = await independentReviewSupplementalPaths({
    document,
    repoRoot,
    documentPath,
    references,
    allowSyntheticSupplementalPathsForTests: sourceSnapshotContext?.synthetic_supplement_for_tests === true ||
      (process.env.NODE_ENV === "test" && syntheticSupplementFixtureDocuments.has(document)),
  });
  const snapshot = sourceSnapshotContext ?? await captureIndependentReviewSourceSnapshotContext({
    repoRoot,
    extraPaths: expectedSupplementalPaths,
    allowSyntheticSupplementalPathsForTests:
      process.env.NODE_ENV === "test" && syntheticSupplementFixtureDocuments.has(document),
  });
  if (!(snapshot.contentByPath instanceof Map) || !isSha256(snapshot.sha256)) {
    throw new Error("INDEPENDENT_REVIEW_SOURCE_SNAPSHOT_CONTEXT_INVALID");
  }
  const frozenDocumentBytes = snapshot.contentByPath.get(documentRepositoryRelativePath(repoRoot, documentPath));
  let frozenDocument;
  try {
    frozenDocument = JSON.parse(frozenDocumentBytes?.toString("utf8") ?? "");
  } catch {
    throw new Error("INDEPENDENT_REVIEW_FROZEN_TRACEABILITY_DOCUMENT_INVALID");
  }
  if (stableReviewStringify(frozenIndependentReviewDocumentIdentity(frozenDocument, allIds)) !==
      stableReviewStringify(frozenIndependentReviewDocumentIdentity(document, allIds))) {
    throw new Error("INDEPENDENT_REVIEW_FROZEN_TRACEABILITY_DOCUMENT_MISMATCH");
  }
  if (stableReviewStringify(snapshot.supplemental_entries.map((entry) => entry.path)) !==
      stableReviewStringify(expectedSupplementalPaths)) {
    throw new Error("INDEPENDENT_REVIEW_SUPPLEMENTAL_EXACT_SET_MISMATCH");
  }
  const byPath = new Map();
  for (const entry of snapshot.entries) {
    addUniverseReason(byPath, entry.path, isAcceptanceSourcePath(entry.path)
      ? "FULL_ACCEPTANCE_SOURCE_SNAPSHOT"
      : "EXPLICIT_SNAPSHOT_INPUT");
    if (REVIEW_ROOT_AUTO_CONFIG_CANDIDATES.includes(entry.path)) {
      addUniverseReason(byPath, entry.path, "ROOT_AUTO_CONFIG_CANDIDATE");
    }
    if (entry.path.startsWith("src/")) addUniverseReason(byPath, entry.path, "RUNTIME_SOURCE");
    else if (entry.path.startsWith("migrations/")) addUniverseReason(byPath, entry.path, "MIGRATION");
    else if (entry.path.startsWith("deploy/")) addUniverseReason(byPath, entry.path, "DEPLOY");
    else if (entry.path.startsWith("schemas/")) addUniverseReason(byPath, entry.path, "RELEASE_SCHEMA");
    else if (entry.path.startsWith("scripts/release/")) {
      addUniverseReason(byPath, entry.path, "BUILD_OR_RELEASE_TOOLING");
    } else if (entry.path.startsWith("scripts/review/")) {
      addUniverseReason(byPath, entry.path, "REVIEW_MECHANISM");
    }
  }
  if (isRecord(document.control_catalog) && isNonEmptyString(document.control_catalog.path)) {
    addUniverseReason(byPath, document.control_catalog.path, "CONTROL_CATALOG");
    try {
      const catalogBytes = snapshot.contentByPath.get(document.control_catalog.path);
      if (!Buffer.isBuffer(catalogBytes)) throw new Error("catalog is absent from the frozen source snapshot");
      const catalog = JSON.parse(catalogBytes.toString("utf8"));
      for (const source of catalog.source_documents ?? []) {
        if (isRecord(source) && isNonEmptyString(source.path)) {
          if (!snapshot.contentByPath.has(source.path)) {
            throw new Error(`catalog source is absent from the frozen source snapshot: ${source.path}`);
          }
          addUniverseReason(byPath, source.path, "CONTROL_CATALOG_SOURCE");
        }
      }
    } catch (error) {
      throw new Error(`INDEPENDENT_REVIEW_CONTROL_CATALOG_INVALID:${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const path of REVIEW_UNIVERSE_FIXED_FILES) {
    if (snapshot.contentByPath.has(path)) addUniverseReason(byPath, path, "BUILD_OR_RELEASE_TOOLING");
  }
  for (const path of references.keys()) {
    if (!snapshot.contentByPath.has(path)) {
      throw new Error(`INDEPENDENT_REVIEW_SOURCE_SNAPSHOT_MISSING_CITATION:${path}`);
    }
    addUniverseReason(byPath, path, "EXPLICIT_CITATION");
  }

  const paths = [...byPath.keys()].sort((left, right) => left.localeCompare(right, "en"));
  const graph = await deriveIndependentReviewDependencyGraph({
    repoRoot,
    universePaths: paths,
    contentByPath: snapshot.contentByPath,
  });
  const requirementMappings = await deriveIndependentReviewDependencyMappings({
    document,
    allIds,
    repoRoot,
    universePaths: paths,
    references,
    contentByPath: snapshot.contentByPath,
    dependencyGraph: graph,
  });
  const releaseRequirementId = preferredRequirementId(allIds, "K-013");
  const crossCuttingRequirementId = preferredRequirementId(allIds, "K-015", 1);
  for (const path of paths) {
    if (path.startsWith("deploy/") || path.startsWith("migrations/") || path.startsWith("scripts/release/") ||
        [".dockerignore", "package.json", "package-lock.json", "tsconfig.json", "tsconfig.build.json"]
          .includes(path)) {
      addRequirementMapping(requirementMappings, path, releaseRequirementId);
    }
    if (path.startsWith("scripts/review/") || path.startsWith("schemas/") ||
        path === "scripts/local-acceptance-contract.mjs") {
      addRequirementMapping(requirementMappings, path, crossCuttingRequirementId);
    }
    if (path === document.control_catalog?.path) {
      for (const requirementId of allIds) addRequirementMapping(requirementMappings, path, requirementId);
    }
  }
  const sizes = new Map();
  for (const path of paths) {
    const content = snapshot.contentByPath.get(path);
    if (!Buffer.isBuffer(content)) throw new Error(`INDEPENDENT_REVIEW_SOURCE_SNAPSHOT_MISSING:${path}`);
    sizes.set(path, content.length);
  }
  const shardLoads = new Map(allIds.map((requirementId) => [requirementId, 0]));
  for (const [path, mappedIds] of requirementMappings.entries()) {
    for (const requirementId of mappedIds) {
      shardLoads.set(requirementId, shardLoads.get(requirementId) + (sizes.get(path) ?? 0));
    }
  }
  const unmappedPaths = paths.filter((path) => !requirementMappings.has(path))
    .sort((left, right) => (sizes.get(right) - sizes.get(left)) || left.localeCompare(right, "en"));
  for (const path of unmappedPaths) {
    const requirementId = [...allIds].sort((left, right) =>
      (shardLoads.get(left) - shardLoads.get(right)) || left.localeCompare(right, "en"))[0];
    addRequirementMapping(requirementMappings, path, requirementId);
    shardLoads.set(requirementId, shardLoads.get(requirementId) + sizes.get(path));
    addUniverseReason(byPath, path, "DETERMINISTIC_GLOBAL_REVIEW_SHARD");
  }
  const entries = paths.map((path) => {
    const directReferences = [...new Set(references.get(path) ?? [])]
      .sort((left, right) => left.localeCompare(right, "en"));
    const reasons = [...byPath.get(path)].sort((left, right) => left.localeCompare(right, "en"));
    const mapped = requirementMappings.get(path) ?? new Set();
    if (mapped.size === 0) throw new Error(`INDEPENDENT_REVIEW_UNIVERSE_UNMAPPED_PATH:${path}`);
    const mappedRequirementIds = [...mapped].sort((left, right) => left.localeCompare(right, "en"));
    const universeReferences = mappedRequirementIds.map((requirementId) =>
      `${requirementId}:review_universe:${reasons.join("+")}`);
    return {
      path,
      state: "CURRENT",
      reasons,
      mapped_requirement_ids: mappedRequirementIds,
      references: [...new Set([...directReferences, ...universeReferences])]
        .sort((left, right) => left.localeCompare(right, "en")),
    };
  });
  if (entries.length === 0) throw new Error("INDEPENDENT_REVIEW_UNIVERSE_EMPTY");
  if (entries.some((entry) => entry.mapped_requirement_ids.length === 0)) {
    throw new Error("INDEPENDENT_REVIEW_UNIVERSE_UNMAPPED_PATH");
  }
  const baseline = {
    kind: "FULL_ACCEPTANCE_SOURCE_SNAPSHOT",
    source_snapshot_sha256: snapshot.source_snapshot_sha256,
    supplemental_inputs_sha256: snapshot.supplemental_inputs_sha256,
    review_context_sha256: snapshot.sha256,
    external_immutable_snapshot: snapshot.externally_immutable,
  };
  const fullUniverseIdentity = { baseline, entries };
  const selectedEntries = entries.filter((entry) =>
    entry.mapped_requirement_ids.some((requirementId) => reviewedIds.includes(requirementId)));
  if (selectedEntries.length === 0) throw new Error("INDEPENDENT_REVIEW_UNIVERSE_SELECTED_EMPTY");
  const result = {
    schema_version: "1.0",
    algorithm: "full-acceptance-source-single-snapshot-v2",
    baseline,
    path_count: entries.length,
    selected_path_count: selectedEntries.length,
    sha256: reviewSha256(stableReviewStringify(fullUniverseIdentity)),
    entries: selectedEntries,
    sourceSnapshotContext: snapshot,
    dependencyGraph: graph,
  };
  if (ownsSnapshot) await assertIndependentReviewSourceSnapshotUnchanged(snapshot);
  return result;
}

export async function readUniverseEntryContent(repoRoot, entry, sourceSnapshotContext) {
  if (sourceSnapshotContext?.contentByPath instanceof Map) {
    const content = sourceSnapshotContext.contentByPath.get(entry.path);
    if (!Buffer.isBuffer(content)) throw new Error(`INDEPENDENT_REVIEW_SOURCE_SNAPSHOT_MISSING:${entry.path}`);
    return Buffer.from(content);
  }
  throw new Error(`INDEPENDENT_REVIEW_SOURCE_SNAPSHOT_CONTEXT_REQUIRED:${entry.path}`);
}

/** Binds every non-self-selectable universe byte and its requirement mapping. */
export async function captureIndependentReviewInputs({
  document,
  requirementIds,
  repoRoot,
  documentPath,
  sourceSnapshotContext,
}) {
  const ownsSnapshot = !sourceSnapshotContext;
  const snapshot = sourceSnapshotContext ?? await captureIndependentReviewDocumentSourceSnapshotContext({
    document,
    repoRoot,
    documentPath,
  });
  const universe = await deriveIndependentReviewUniverse({
    document,
    requirementIds,
    repoRoot,
    documentPath,
    sourceSnapshotContext: snapshot,
  });
  const files = [];
  const contentByPath = new Map();
  for (const entry of universe.entries) {
    if (snapshot.synthetic_supplement_for_tests === true && process.env.NODE_ENV === "test" &&
        /(?:^|\/)requirements(?:-traceability)?\.json$/u.test(entry.path)) {
      continue;
    }
    const content = await readUniverseEntryContent(repoRoot, entry, snapshot);
    contentByPath.set(entry.path, Buffer.from(content));
    const frozenIdentity = snapshot.identityByPath.get(entry.path);
    if (!frozenIdentity || frozenIdentity.sha256 !== reviewSha256(content)) {
      throw new Error(`INDEPENDENT_REVIEW_SOURCE_SNAPSHOT_IDENTITY_MISMATCH:${entry.path}`);
    }
    files.push({
      ...entry,
      size_bytes: content.length,
      executable: frozenIdentity.executable,
      sha256: frozenIdentity.sha256,
    });
  }
  const worktreeState = {
    source_snapshot_sha256: snapshot.source_snapshot_sha256,
    supplemental_inputs_sha256: snapshot.supplemental_inputs_sha256,
    review_context_sha256: snapshot.sha256,
  };
  const identity = {
    universe: {
      schema_version: universe.schema_version,
      algorithm: universe.algorithm,
      baseline: universe.baseline,
      path_count: universe.path_count,
      selected_path_count: universe.selected_path_count,
      sha256: universe.sha256,
    },
    worktree_state: worktreeState,
    files,
  };
  const reviewInputs = {
    algorithm: "sha256-frozen-dual-root-review-universe-v3",
    file_count: files.length,
    total_bytes: files.reduce((sum, file) => sum + file.size_bytes, 0),
    sha256: reviewSha256(stableReviewStringify(identity)),
    universe: identity.universe,
    worktree_state: worktreeState,
    files,
  };
  if (ownsSnapshot) await assertIndependentReviewSourceSnapshotUnchanged(snapshot);
  return {
    reviewInputs,
    contentByPath,
    sourceSnapshotContext: snapshot,
    dependencyGraph: universe.dependencyGraph,
  };
}

export async function fingerprintIndependentReviewInputs(options) {
  return (await captureIndependentReviewInputs(options)).reviewInputs;
}

export async function createIndependentReviewInputReceipt({
  document,
  requirementIds,
  repoRoot,
  documentPath,
  sourceFingerprint,
  nonce,
  sourceSnapshotContext,
}) {
  if (!/^[a-f0-9]{32}$/u.test(nonce ?? "") || !isSha256(sourceFingerprint)) {
    throw new Error("INDEPENDENT_REVIEW_INPUT_RECEIPT_IDENTITY_INVALID");
  }
  const reviewedIds = [...requirementIds].sort((left, right) => left.localeCompare(right, "en"));
  const { reviewInputs, contentByPath } = await captureIndependentReviewInputs({
    document,
    requirementIds: reviewedIds,
    repoRoot,
    documentPath,
    sourceSnapshotContext,
  });
  const files = [];
  let base64Bytes = 0;
  for (const identity of reviewInputs.files) {
    const content = contentByPath.get(identity.path);
    if (content.length !== identity.size_bytes || reviewSha256(content) !== identity.sha256) {
      throw new Error(`INDEPENDENT_REVIEW_CONTENT_CHANGED:${identity.path}`);
    }
    const contentChunks = contentAddressedReviewChunks(content);
    base64Bytes += contentChunks
      .filter((chunk) => chunk.encoding === "base64")
      .reduce((sum, chunk) => sum + chunk.size_bytes, 0);
    files.push({ ...identity, content_chunks: contentChunks });
  }
  const batches = reviewContentBatches(files);
  if (reviewInputs.total_bytes > REVIEW_SHARD_MAX_TOTAL_BYTES ||
      reviewInputs.file_count > REVIEW_SHARD_MAX_FILE_COUNT ||
      batches.length > REVIEW_SHARD_MAX_BATCH_COUNT) {
    throw new Error(
      `INDEPENDENT_REVIEW_SHARD_CAPACITY_EXCEEDED:bytes=${reviewInputs.total_bytes}/${REVIEW_SHARD_MAX_TOTAL_BYTES}` +
      `:files=${reviewInputs.file_count}/${REVIEW_SHARD_MAX_FILE_COUNT}` +
      `:batches=${batches.length}/${REVIEW_SHARD_MAX_BATCH_COUNT}`,
    );
  }
  const receipt = {
    schema_version: "2.0",
    receipt_kind: "INDEPENDENT_REVIEW_INPUT_READ",
    nonce,
    source_fingerprint: sourceFingerprint,
    review_subject_sha256: independentReviewSubjectSha256(document, reviewedIds),
    review_inputs_sha256: reviewInputs.sha256,
    reviewed_requirement_ids: reviewedIds,
    review_universe: reviewInputs.universe,
    worktree_state: reviewInputs.worktree_state,
    content_policy: {
      encoding: "UTF8_WHEN_JSON_COMPACT_ELSE_BASE64",
      chunk_bytes_max: REVIEW_CONTENT_CHUNK_BYTES,
      emitted_batch_json_bytes_max: REVIEW_CONTENT_BATCH_OUTPUT_JSON_BYTES,
      overflow_policy: "EMIT_ALL_ORDERED_CHUNKS_WITHOUT_OMISSION",
      reviewer_shard_bytes_max: REVIEW_SHARD_MAX_TOTAL_BYTES,
      reviewer_shard_files_max: REVIEW_SHARD_MAX_FILE_COUNT,
      reviewer_shard_batches_max: REVIEW_SHARD_MAX_BATCH_COUNT,
    },
    content_total_bytes: reviewInputs.total_bytes,
    content_chunk_count: batches.length,
    content_source_chunk_count: files.reduce((sum, file) => sum + file.content_chunks.length, 0),
    content_base64_source_bytes: base64Bytes,
    files,
  };
  for (let index = 0; index < receipt.content_chunk_count; index += 1) {
    createIndependentReviewInputChunkReceipt(receipt, index);
  }
  return receipt;
}

export function reviewContentBatches(files) {
  const flattened = files.flatMap((file) => file.content_chunks.map((chunk) => {
    const { content_chunks: _contentChunks, ...identity } = file;
    return { file: identity, chunk };
  }));
  const batches = [];
  let current = [];
  for (const selected of flattened) {
    const candidate = [...current, selected];
    const candidateBytes = Buffer.byteLength(JSON.stringify({ entries: candidate }), "utf8");
    if (current.length > 0 && candidateBytes > REVIEW_CONTENT_BATCH_PAYLOAD_JSON_BYTES) {
      batches.push(current);
      current = [];
    }
    const selectedBytes = Buffer.byteLength(JSON.stringify({ entries: [selected] }), "utf8");
    if (selectedBytes > REVIEW_CONTENT_BATCH_PAYLOAD_JSON_BYTES) {
      throw new Error(`INDEPENDENT_REVIEW_CONTENT_CHUNK_JSON_OVERFLOW:${selected.file.path}:${selected.chunk.chunk_index}`);
    }
    current.push(selected);
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export function contentAddressedReviewChunks(content) {
  if (content.length === 0) {
    return [{
      chunk_index: 0,
      chunk_count: 1,
      offset_bytes: 0,
      size_bytes: 0,
      sha256: reviewSha256(content),
      encoding: "utf8",
      content: "",
    }];
  }
  const chunks = [];
  const entireText = content.toString("utf8");
  const isUtf8 = Buffer.from(entireText, "utf8").equals(content);
  let offset = 0;
  while (offset < content.length) {
    let end = Math.min(content.length, offset + REVIEW_CONTENT_CHUNK_BYTES);
    let slice = content.subarray(offset, end);
    let encoding;
    let encoded;
    if (!isUtf8) {
      encoding = "base64";
      encoded = slice.toString("base64");
    } else {
      while (end > offset) {
        const candidate = content.subarray(offset, end);
        const text = candidate.toString("utf8");
        if (Buffer.from(text, "utf8").equals(candidate)) {
          slice = candidate;
          const base64 = candidate.toString("base64");
          if (Buffer.byteLength(JSON.stringify(text), "utf8") <=
              Buffer.byteLength(JSON.stringify(base64), "utf8")) {
            encoding = "utf8";
            encoded = text;
          } else {
            encoding = "base64";
            encoded = base64;
          }
          break;
        }
        end -= 1;
      }
      if (end === offset) throw new Error("INDEPENDENT_REVIEW_UTF8_CHUNK_BOUNDARY_INVALID");
    }
    chunks.push({
      chunk_index: chunks.length,
      chunk_count: 0,
      offset_bytes: offset,
      size_bytes: slice.length,
      sha256: reviewSha256(slice),
      encoding,
      content: encoded,
    });
    offset = end;
  }
  for (const chunk of chunks) chunk.chunk_count = chunks.length;
  return chunks;
}

export function createIndependentReviewInputChunkReceipt(receipt, chunkIndex) {
  if (!isRecord(receipt) || receipt.schema_version !== "2.0" || !Array.isArray(receipt.files) ||
      !Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= receipt.content_chunk_count) {
    throw new Error("INDEPENDENT_REVIEW_INPUT_CHUNK_INVALID");
  }
  const batches = reviewContentBatches(receipt.files);
  const selectedBatch = batches[chunkIndex];
  if (!selectedBatch) throw new Error("INDEPENDENT_REVIEW_INPUT_CHUNK_MISSING");
  const output = {
    schema_version: "2.0",
    receipt_kind: "INDEPENDENT_REVIEW_INPUT_BATCH_READ",
    nonce: receipt.nonce,
    source_fingerprint: receipt.source_fingerprint,
    review_subject_sha256: receipt.review_subject_sha256,
    review_inputs_sha256: receipt.review_inputs_sha256,
    reviewed_requirement_ids: receipt.reviewed_requirement_ids,
    review_universe: receipt.review_universe,
    worktree_state: receipt.worktree_state,
    content_policy: receipt.content_policy,
    content_total_bytes: receipt.content_total_bytes,
    content_chunk_count: receipt.content_chunk_count,
    content_source_chunk_count: receipt.content_source_chunk_count,
    content_base64_source_bytes: receipt.content_base64_source_bytes,
    global_chunk_index: chunkIndex,
    batch_size_bytes: selectedBatch.reduce((sum, selected) => sum + selected.chunk.size_bytes, 0),
    entries: selectedBatch,
  };
  const outputBytes = Buffer.byteLength(JSON.stringify(output), "utf8");
  if (outputBytes > REVIEW_CONTENT_BATCH_OUTPUT_JSON_BYTES) {
    throw new Error(`INDEPENDENT_REVIEW_CONTENT_BATCH_JSON_OVERFLOW:${chunkIndex}:${outputBytes}`);
  }
  return output;
}

export function buildIndependentReviewInspectionCommand({ traceabilityPath, nonce, requirementIds, chunkIndex }) {
  if (!isNonEmptyString(traceabilityPath) || !/^[a-f0-9]{32}$/u.test(nonce ?? "") ||
      !Number.isInteger(chunkIndex) || chunkIndex < 0) {
    throw new Error("INDEPENDENT_REVIEW_INSPECTION_COMMAND_INVALID");
  }
  return [
    process.execPath,
    REVIEW_INSPECTION_SCRIPT,
    "--file",
    traceabilityPath,
    "--nonce",
    nonce,
    "--chunk-index",
    String(chunkIndex),
    ...[...requirementIds].sort((left, right) => left.localeCompare(right, "en"))
      .flatMap((requirementId) => ["--requirement", requirementId]),
  ].map(shellQuote).join(" ");
}

export function buildIndependentReviewInspectionCommands({ traceabilityPath, nonce, requirementIds, chunkCount }) {
  if (!Number.isInteger(chunkCount) || chunkCount < 1) {
    throw new Error("INDEPENDENT_REVIEW_INSPECTION_COMMAND_COUNT_INVALID");
  }
  return Array.from({ length: chunkCount }, (_, chunkIndex) => buildIndependentReviewInspectionCommand({
    traceabilityPath,
    nonce,
    requirementIds,
    chunkIndex,
  }));
}

function assertFalsificationProbeShape(probe, inspectionNonce) {
  exactFields(probe, [
    "probe_nonce",
    "counterexample",
    "target_path",
    "test_path",
    "literal",
    "replacement",
  ], "INDEPENDENT_REVIEW_FALSIFICATION_PROBE");
  if (!/^[a-f0-9]{32}$/u.test(probe.probe_nonce ?? "") || probe.probe_nonce === inspectionNonce) {
    throw new Error("INDEPENDENT_REVIEW_FALSIFICATION_PROBE_NONCE_INVALID");
  }
  if (!isNonEmptyString(probe.counterexample) || Buffer.byteLength(probe.counterexample, "utf8") < 40 ||
      Buffer.byteLength(probe.counterexample, "utf8") > 1_000 || /[\0\r\n']/u.test(probe.counterexample)) {
    throw new Error("INDEPENDENT_REVIEW_FALSIFICATION_PROBE_COUNTEREXAMPLE_INVALID");
  }
  if (!isNonEmptyString(probe.target_path) || !isNonEmptyString(probe.test_path) ||
      !/^(?:tests|src)\/.+\.test\.ts$/u.test(probe.test_path) ||
      !isNonEmptyString(probe.literal) || !isNonEmptyString(probe.replacement) ||
      Buffer.byteLength(probe.literal, "utf8") < 4 || Buffer.byteLength(probe.literal, "utf8") > 256 ||
      Buffer.byteLength(probe.replacement, "utf8") > 256 ||
      /[\0\r\n']/u.test(probe.literal) || /[\0\r\n']/u.test(probe.replacement) ||
      probe.literal === probe.replacement) {
    throw new Error("INDEPENDENT_REVIEW_FALSIFICATION_PROBE_DEFINITION_INVALID");
  }
  if (!normalizedProbeText(probe.counterexample).includes(normalizedProbeText(probe.literal)) ||
      !normalizedProbeText(probe.counterexample).includes(normalizedProbeText(probe.replacement))) {
    throw new Error("INDEPENDENT_REVIEW_FALSIFICATION_PROBE_COUNTEREXAMPLE_NOT_BOUND_TO_MUTATION");
  }
}

export function buildIndependentReviewFalsificationProbeCommand({
  traceabilityPath,
  inspectionNonce,
  requirementId,
  probe,
}) {
  if (!isNonEmptyString(traceabilityPath) || !/^[a-f0-9]{32}$/u.test(inspectionNonce ?? "") ||
      !/^[A-Z][A-Z0-9_-]*-[0-9]{3,}$/u.test(requirementId ?? "")) {
    throw new Error("INDEPENDENT_REVIEW_FALSIFICATION_PROBE_COMMAND_INVALID");
  }
  assertFalsificationProbeShape(probe, inspectionNonce);
  return [
    process.execPath,
    REVIEW_FALSIFICATION_PROBE_SCRIPT,
    "--file",
    traceabilityPath,
    "--nonce",
    inspectionNonce,
    "--requirement",
    requirementId,
    "--probe-nonce",
    probe.probe_nonce,
    "--target",
    probe.target_path,
    "--test",
    probe.test_path,
    "--literal",
    probe.literal,
    "--replacement",
    probe.replacement,
    "--counterexample",
    probe.counterexample,
  ].map(shellQuote).join(" ");
}

function normalizedProbeText(value) {
  return String(value).normalize("NFKC").toLocaleLowerCase("en").replace(/\s+/gu, " ").trim();
}

function inMemoryVitestOutput() {
  let sizeBytes = 0;
  const hash = createHash("sha256");
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      sizeBytes += bytes.length;
      hash.update(bytes);
      callback();
    },
  });
  return {
    stream,
    finish: () => ({ size_bytes: sizeBytes, sha256: hash.digest("hex") }),
  };
}

function deterministicVitestResult(vitest) {
  const modules = vitest.state.getTestModules();
  const tests = modules.flatMap((module) => [...module.children.allTests()].map((test) => ({
    module: relative(vitest.config.root, module.moduleId).replaceAll(sep, "/"),
    name: test.name,
    state: test.result().state,
    failure_messages: (test.result().errors ?? []).map((error) => String(error?.message ?? error)),
  })));
  const states = Object.fromEntries(["passed", "failed", "skipped"].map((state) => [
    state,
    tests.filter((test) => test.state === state).length,
  ]));
  return {
    module_count: modules.length,
    test_count: tests.length,
    passed: states.passed,
    failed: states.failed,
    skipped: states.skipped,
    unhandled_error_count: vitest.state.getUnhandledErrors().length,
    result_sha256: reviewSha256(stableReviewStringify(tests)),
    tests,
  };
}

async function runInMemoryVitestMutation({ repoRoot, testPath, targetPath, literal, replacement, mutate }) {
  const canonicalRuntimeRoot = await realpath(repoRoot);
  const runtimeRequire = createRequire(resolve(canonicalRuntimeRoot, "package.json"));
  const resolvedVitestModule = await realpath(runtimeRequire.resolve("vitest/node"));
  const runtimeNodeModules = resolve(canonicalRuntimeRoot, "node_modules");
  const moduleRelative = relative(runtimeNodeModules, resolvedVitestModule);
  if (!moduleRelative || moduleRelative === ".." || moduleRelative.startsWith(`..${sep}`) ||
      isAbsolute(moduleRelative)) {
    throw new Error("INDEPENDENT_REVIEW_VITEST_RUNTIME_OUTSIDE_FROZEN_ROOT");
  }
  for (let ancestor = dirname(canonicalRuntimeRoot);;) {
    const externalNodeModules = resolve(ancestor, "node_modules");
    const external = await optionalStat(externalNodeModules);
    if (external !== undefined) {
      throw new Error(`INDEPENDENT_REVIEW_EXTERNAL_NODE_MODULES_ANCESTOR:${externalNodeModules}`);
    }
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const vitestModule = await readRegularFileFromSingleDescriptor(
    resolvedVitestModule,
    "INDEPENDENT_REVIEW_VITEST_RUNTIME_MODULE",
  );
  const { startVitest, version } = await import(pathToFileURL(resolvedVitestModule).href);
  if (typeof startVitest !== "function" || !isNonEmptyString(version)) {
    throw new Error("INDEPENDENT_REVIEW_VITEST_RUNTIME_EXPORT_INVALID");
  }
  const stdout = inMemoryVitestOutput();
  const stderr = inMemoryVitestOutput();
  let mutationApplications = 0;
  const plugins = mutate ? [{
    name: "independent-review-in-memory-falsification",
    enforce: "pre",
    transform(code, id) {
      if (id.split("?", 1)[0] !== targetPath) return undefined;
      const occurrences = code.split(literal).length - 1;
      if (occurrences !== 1) {
        throw new Error(`INDEPENDENT_REVIEW_MUTATION_LITERAL_OCCURRENCES:${occurrences}`);
      }
      mutationApplications += 1;
      return { code: code.replace(literal, replacement), map: null };
    },
  }] : [];
  const previousExitCode = process.exitCode;
  let vitest;
  try {
    vitest = await startVitest("test", [testPath], {
      root: repoRoot,
      config: false,
      run: true,
      watch: false,
      color: false,
      reporters: [{ onTestRunEnd() {} }],
      globals: true,
      cache: false,
      isolate: true,
      passWithNoTests: false,
      fileParallelism: false,
      maxWorkers: 1,
      minWorkers: 1,
    }, { root: repoRoot, plugins }, { stdout: stdout.stream, stderr: stderr.stream });
    return {
      vitest_version: version,
      vitest_module_path: relative(canonicalRuntimeRoot, resolvedVitestModule).replaceAll(sep, "/"),
      vitest_module_sha256: reviewSha256(vitestModule.content),
      mutation_applications: mutationApplications,
      result: deterministicVitestResult(vitest),
      stdout: stdout.finish(),
      stderr: stderr.finish(),
    };
  } finally {
    process.exitCode = previousExitCode;
    if (vitest) await vitest.close();
  }
}

export async function createIndependentReviewFalsificationProbeReceipt({
  document,
  requirementId,
  repoRoot,
  documentPath,
  sourceFingerprint,
  inspectionNonce,
  probe,
  sourceSnapshotContext,
  approvedReviewRuntimeSha256,
}) {
  if (!isSha256(sourceFingerprint) || !/^[a-f0-9]{32}$/u.test(inspectionNonce ?? "")) {
    throw new Error("INDEPENDENT_REVIEW_FALSIFICATION_PROBE_IDENTITY_INVALID");
  }
  const ownsSnapshot = !sourceSnapshotContext;
  const snapshot = sourceSnapshotContext ?? await captureIndependentReviewDocumentSourceSnapshotContext({
    document, repoRoot, documentPath,
  });
  assertFalsificationProbeShape(probe, inspectionNonce);
  const requirement = requirementById(document, requirementId);
  if (!isRecord(requirement)) throw new Error(`INDEPENDENT_REVIEW_FALSIFICATION_PROBE_REQUIREMENT_MISSING:${requirementId}`);
  if (!Array.isArray(requirement.implementation_files) || !requirement.implementation_files.includes(probe.target_path)) {
    throw new Error("INDEPENDENT_REVIEW_FALSIFICATION_PROBE_IMPLEMENTATION_TARGET_REQUIRED");
  }
  const executableTests = [...new Set([
    ...(requirement.positive_tests ?? []),
    ...(requirement.negative_or_mutation_tests ?? []),
  ])];
  if (!executableTests.includes(probe.test_path)) {
    throw new Error("INDEPENDENT_REVIEW_FALSIFICATION_PROBE_CITED_TEST_REQUIRED");
  }
  if ((requirement.positive_tests ?? []).includes(probe.target_path) ||
      (requirement.negative_or_mutation_tests ?? []).includes(probe.target_path)) {
    throw new Error("INDEPENDENT_REVIEW_FALSIFICATION_PROBE_IMPLEMENTATION_TARGET_REQUIRED");
  }
  const reviewInputs = await fingerprintIndependentReviewInputs({
    document,
    requirementIds: [requirementId],
    repoRoot,
    documentPath,
    sourceSnapshotContext: snapshot,
  });
  const normalizedCounterexample = normalizedProbeText(probe.counterexample);
  for (const existing of [requirement.business_risk, requirement.design_control, requirement.residual_risk]) {
    if (normalizedProbeText(existing) === normalizedCounterexample) {
      throw new Error("INDEPENDENT_REVIEW_FALSIFICATION_PROBE_NOT_FRESH");
    }
  }
  for (const identity of reviewInputs.files) {
    const content = frozenSourceBytes(
      snapshot, identity.path, "INDEPENDENT_REVIEW_FALSIFICATION_PROBE_INPUT",
    );
    const text = content.toString("utf8");
    if (text.includes(probe.probe_nonce) || normalizedProbeText(text).includes(normalizedCounterexample)) {
      throw new Error("INDEPENDENT_REVIEW_FALSIFICATION_PROBE_NOT_FRESH");
    }
  }
  const executionRoot = snapshot.snapshot_root;
  if (!isNonEmptyString(executionRoot)) {
    throw new Error("INDEPENDENT_REVIEW_FALSIFICATION_PROBE_FROZEN_SOURCE_SNAPSHOT_REQUIRED");
  }
  await assertIndependentReviewSourceSnapshotUnchanged(snapshot);
  const approvedRuntime = approvedReviewRuntimeSha256 ??
    (snapshot.externally_immutable ? undefined : (await deriveObservedIndependentReviewRuntimeIdentity({
      repoRoot: executionRoot,
      sourceSnapshotContext: snapshot,
    })).observed_review_runtime_sha256);
  await assertIndependentReviewExecutionRuntimeUnchanged({
    repoRoot: executionRoot,
    sourceSnapshotContext: snapshot,
    approvedReviewRuntimeSha256: approvedRuntime,
  });
  const targetPath = containedPath(
    executionRoot, probe.target_path, "INDEPENDENT_REVIEW_FALSIFICATION_PROBE_TARGET",
  );
  const targetRealPath = await realpath(targetPath);
  const target = frozenSourceBytes(
    snapshot, probe.target_path, "INDEPENDENT_REVIEW_FALSIFICATION_PROBE_TARGET",
  );
  const test = frozenSourceBytes(
    snapshot, probe.test_path, "INDEPENDENT_REVIEW_FALSIFICATION_PROBE_TEST",
  );
  const targetText = target.toString("utf8");
  if (!Buffer.from(targetText, "utf8").equals(target) || targetText.split(probe.literal).length - 1 !== 1) {
    throw new Error("INDEPENDENT_REVIEW_FALSIFICATION_PROBE_LITERAL_MUST_OCCUR_ONCE");
  }
  const baseline = await runInMemoryVitestMutation({
    repoRoot: executionRoot,
    testPath: probe.test_path,
    targetPath: targetRealPath,
    literal: probe.literal,
    replacement: probe.replacement,
    mutate: false,
  });
  if (baseline.result.module_count !== 1 || baseline.result.test_count < 1 || baseline.result.failed !== 0 ||
      baseline.result.skipped !== 0 || baseline.result.unhandled_error_count !== 0 ||
      baseline.result.passed !== baseline.result.test_count) {
    throw new Error("INDEPENDENT_REVIEW_FALSIFICATION_PROBE_BASELINE_NOT_GREEN");
  }
  const mutated = await runInMemoryVitestMutation({
    repoRoot: executionRoot,
    testPath: probe.test_path,
    targetPath: targetRealPath,
    literal: probe.literal,
    replacement: probe.replacement,
    mutate: true,
  });
  await assertIndependentReviewSourceSnapshotUnchanged(snapshot);
  await assertIndependentReviewExecutionRuntimeUnchanged({
    repoRoot: executionRoot,
    sourceSnapshotContext: snapshot,
    approvedReviewRuntimeSha256: approvedRuntime,
  });
  if (mutated.mutation_applications !== 1 || mutated.result.module_count !== 1 ||
      mutated.result.test_count !== baseline.result.test_count || mutated.result.failed < 1 ||
      mutated.result.skipped !== 0 || mutated.result.unhandled_error_count !== 0 ||
      mutated.result.passed + mutated.result.failed !== mutated.result.test_count) {
    throw new Error(
      `INDEPENDENT_REVIEW_FALSIFICATION_PROBE_MUTATION_DID_NOT_FAIL_TEST:${stableReviewStringify({ baseline, mutated })}`,
    );
  }
  const receipt = {
    schema_version: "2.0",
    receipt_kind: "INDEPENDENT_REVIEW_EXECUTABLE_MUTATION_PROBE",
    inspection_nonce: inspectionNonce,
    probe_nonce: probe.probe_nonce,
    source_fingerprint: sourceFingerprint,
    review_subject_sha256: independentReviewSubjectSha256(document, [requirementId]),
    review_inputs_sha256: reviewInputs.sha256,
    requirement_id: requirementId,
    operation: "IN_MEMORY_VITEST_MUTATION_MUST_FAIL",
    counterexample: probe.counterexample,
    counterexample_sha256: reviewSha256(probe.counterexample),
    target: {
      path: probe.target_path,
      size_bytes: target.length,
      sha256: reviewSha256(target),
    },
    test: {
      path: probe.test_path,
      size_bytes: test.length,
      sha256: reviewSha256(test),
    },
    literal: probe.literal,
    literal_sha256: reviewSha256(probe.literal),
    replacement: probe.replacement,
    replacement_sha256: reviewSha256(probe.replacement),
    baseline,
    mutated,
    expectation_met: true,
  };
  if (ownsSnapshot) await assertIndependentReviewSourceSnapshotUnchanged(snapshot);
  return receipt;
}

function atomicClaimAndObligation(document, requirementId, claimId, obligationId) {
  const requirement = requirementById(document, requirementId);
  if (!isRecord(requirement)) {
    throw new Error(`INDEPENDENT_REVIEW_OBLIGATION_REQUIREMENT_MISSING:${requirementId}`);
  }
  const claim = requirement.control_claims?.find((item) => item?.claim_id === claimId);
  if (!isRecord(claim) || claim.source_clause_id !== claimId) {
    throw new Error(`INDEPENDENT_REVIEW_OBLIGATION_CLAIM_MISSING:${claimId}`);
  }
  const obligation = claim.probe_obligations?.find((item) => item?.obligation_id === obligationId);
  if (!isRecord(obligation)) {
    throw new Error(`INDEPENDENT_REVIEW_OBLIGATION_MISSING:${obligationId}`);
  }
  return { requirement, claim, obligation };
}

async function recordedObligationSemanticBinding({
  document,
  requirementId,
  claimId,
  obligationId,
  repoRoot,
  documentPath,
  sourceSnapshotContext,
}) {
  const { deriveIndependentReviewPlan } = await import("./independent-review-plan-lib.mjs");
  const plan = await deriveIndependentReviewPlan({
    document,
    requirementId,
    repoRoot,
    documentPath,
    sourceSnapshotContext,
  });
  const shards = plan.shards.filter((item) =>
    item.claim_id === claimId && item.probe_obligation_ids.includes(obligationId));
  const bindings = shards.flatMap((item) => item.probe_obligation_bindings ?? [])
    .filter((item) => item?.obligation_id === obligationId);
  if (shards.length !== 1 || bindings.length !== 1 ||
      !shards[0].content_selections.some((selection) =>
        selection.semantic_unit_id === bindings[0].semantic_unit_id &&
        selection.path === bindings[0].path &&
        selection.start_offset_bytes === bindings[0].anchor_unit_start_offset_bytes &&
        selection.end_offset_bytes === bindings[0].anchor_unit_end_offset_bytes &&
        selection.sha256 === bindings[0].anchor_unit_sha256)) {
    throw new Error(`INDEPENDENT_REVIEW_OBLIGATION_SEMANTIC_BINDING_INVALID:${obligationId}`);
  }
  return bindings[0];
}

export function buildIndependentReviewObligationProbeCommand({
  traceabilityPath,
  inspectionNonce,
  requirementId,
  claimId,
  obligationId,
  probeNonce,
  liveContextPath,
}) {
  if (!isNonEmptyString(traceabilityPath) || !/^[a-f0-9]{32}$/u.test(inspectionNonce ?? "") ||
      !/^[a-f0-9]{32}$/u.test(probeNonce ?? "") || probeNonce === inspectionNonce ||
      !/^[A-Z][A-Z0-9_-]*-[0-9]{3,}$/u.test(requirementId ?? "") ||
      !new RegExp(`^${requirementId}-C[0-9]{2,}$`, "u").test(claimId ?? "") ||
      !new RegExp(`^${claimId}-P[0-9]{2,}$`, "u").test(obligationId ?? "")) {
    throw new Error("INDEPENDENT_REVIEW_OBLIGATION_PROBE_COMMAND_INVALID");
  }
  const command = [
    process.execPath,
    "scripts/review/emit-review-obligation-probe.mjs",
    "--file", traceabilityPath,
    "--nonce", inspectionNonce,
    "--requirement", requirementId,
    "--claim", claimId,
    "--obligation", obligationId,
    "--probe-nonce", probeNonce,
  ];
  if (liveContextPath !== undefined) {
    if (!isNonEmptyString(liveContextPath) || !isAbsolute(liveContextPath)) {
      throw new Error("INDEPENDENT_REVIEW_OBLIGATION_LIVE_CONTEXT_PATH_INVALID");
    }
    command.push("--live-context", liveContextPath);
  }
  return command.map(shellQuote).join(" ");
}

/** Executes exactly the mutation declared by the accepted atomic obligation. */
export async function createIndependentReviewObligationProbeReceipt({
  document,
  requirementId,
  claimId,
  obligationId,
  repoRoot,
  documentPath,
  sourceFingerprint,
  inspectionNonce,
  probeNonce,
  sourceSnapshotContext,
  approvedReviewRuntimeSha256,
}) {
  if (!isSha256(sourceFingerprint) || !/^[a-f0-9]{32}$/u.test(inspectionNonce ?? "") ||
      !/^[a-f0-9]{32}$/u.test(probeNonce ?? "") || probeNonce === inspectionNonce) {
    throw new Error("INDEPENDENT_REVIEW_OBLIGATION_PROBE_IDENTITY_INVALID");
  }
  const ownsSnapshot = !sourceSnapshotContext;
  const snapshot = sourceSnapshotContext ?? await captureIndependentReviewDocumentSourceSnapshotContext({
    document, repoRoot, documentPath,
  });
  const { claim, obligation } = atomicClaimAndObligation(
    document, requirementId, claimId, obligationId,
  );
  const executionRoot = snapshot.snapshot_root;
  if (!isNonEmptyString(executionRoot)) {
    throw new Error("INDEPENDENT_REVIEW_OBLIGATION_FROZEN_SOURCE_SNAPSHOT_REQUIRED");
  }
  await assertIndependentReviewSourceSnapshotUnchanged(snapshot);
  // The external-toolchain rule was only enforced when planning a review. A probe
  // executes the same cited tests, so a probe whose tests can shell out is exactly
  // as non-hermetic as a plan that can - it just reached the mutation run first.
  const probeTests = await testReferenceIdentities(document, [requirementId], snapshot);
  const probeExternalToolTests = probeTests.filter((test) => test.invokes_external_child_process);
  if (probeExternalToolTests.length > 0) {
    throw new Error(
      "INDEPENDENT_REVIEW_EXTERNAL_TOOLCHAIN_ATTESTATION_REQUIRED:" +
      probeExternalToolTests.map((test) => test.path).join(","),
    );
  }
  const approvedRuntime = approvedReviewRuntimeSha256 ??
    (snapshot.externally_immutable ? undefined : (await deriveObservedIndependentReviewRuntimeIdentity({
      repoRoot: executionRoot,
      sourceSnapshotContext: snapshot,
    })).observed_review_runtime_sha256);
  await assertIndependentReviewExecutionRuntimeUnchanged({
    repoRoot: executionRoot,
    sourceSnapshotContext: snapshot,
    approvedReviewRuntimeSha256: approvedRuntime,
  });
  const targetPath = containedPath(
    executionRoot, obligation.target_path, "INDEPENDENT_REVIEW_OBLIGATION_TARGET",
  );
  const targetRealPath = await realpath(targetPath);
  const target = frozenSourceBytes(
    snapshot, obligation.target_path, "INDEPENDENT_REVIEW_OBLIGATION_TARGET",
  );
  const test = frozenSourceBytes(
    snapshot, obligation.mutation_test_path, "INDEPENDENT_REVIEW_OBLIGATION_TEST",
  );
  const targetText = target.toString("utf8");
  if (!Buffer.from(targetText, "utf8").equals(target) ||
      targetText.split(obligation.literal).length - 1 !== 1 ||
      !targetText.includes(obligation.target_anchor)) {
    throw new Error("INDEPENDENT_REVIEW_OBLIGATION_TARGET_ANCHOR_OR_LITERAL_INVALID");
  }
  // executionRoot is the snapshot root, already canonicalised through realpath.
  // documentPath is not, so on any host whose temp directory is a symlink - every
  // macOS, where /var resolves to /private/var - the two describe the same place
  // in different words. Containment is decided by path.relative between them, so
  // the mismatch reports evidence sitting next to the document as living outside
  // the repository. Both sides have to be in the same form before they are compared.
  const canonicalDocumentPath = await realpath(resolve(documentPath)).catch(() => resolve(documentPath));
  const semanticBinding = await recordedObligationSemanticBinding({
    document,
    requirementId,
    claimId,
    obligationId,
    repoRoot: executionRoot,
    documentPath: canonicalDocumentPath,
    sourceSnapshotContext: snapshot,
  });
  const bindingFields = [
    "obligation_id", "path", "anchor", "literal", "semantic_unit_id",
    "anchor_unit_start_offset_bytes", "anchor_unit_end_offset_bytes", "anchor_unit_sha256",
    "mutation_start_offset_bytes", "mutation_end_offset_bytes",
  ];
  const bindingOffsets = [
    semanticBinding.anchor_unit_start_offset_bytes,
    semanticBinding.anchor_unit_end_offset_bytes,
    semanticBinding.mutation_start_offset_bytes,
    semanticBinding.mutation_end_offset_bytes,
  ];
  if (!isRecord(semanticBinding) ||
      stableReviewStringify(Object.keys(semanticBinding).sort()) !== stableReviewStringify(bindingFields.sort()) ||
      semanticBinding.obligation_id !== obligationId ||
      semanticBinding.path !== obligation.target_path ||
      semanticBinding.anchor !== obligation.target_anchor ||
      semanticBinding.literal !== obligation.literal ||
      bindingOffsets.some((offset) => !Number.isSafeInteger(offset) || offset < 0) ||
      semanticBinding.anchor_unit_start_offset_bytes >= semanticBinding.anchor_unit_end_offset_bytes ||
      semanticBinding.mutation_start_offset_bytes < semanticBinding.anchor_unit_start_offset_bytes ||
      semanticBinding.mutation_end_offset_bytes > semanticBinding.anchor_unit_end_offset_bytes ||
      semanticBinding.mutation_start_offset_bytes >= semanticBinding.mutation_end_offset_bytes) {
    throw new Error("INDEPENDENT_REVIEW_OBLIGATION_SEMANTIC_BINDING_INVALID");
  }
  const anchorUnit = target.subarray(
    semanticBinding.anchor_unit_start_offset_bytes,
    semanticBinding.anchor_unit_end_offset_bytes,
  );
  const mutationBytes = target.subarray(
    semanticBinding.mutation_start_offset_bytes,
    semanticBinding.mutation_end_offset_bytes,
  );
  const anchorUnitText = anchorUnit.toString("utf8");
  if (reviewSha256(anchorUnit) !== semanticBinding.anchor_unit_sha256 ||
      !anchorUnitText.includes(obligation.target_anchor) ||
      !anchorUnitText.includes(obligation.literal) ||
      !mutationBytes.equals(Buffer.from(obligation.literal, "utf8"))) {
    throw new Error("INDEPENDENT_REVIEW_OBLIGATION_MUTATION_OUTSIDE_RECORDED_ANCHOR_UNIT");
  }
  if (!claim.implementation_files.includes(obligation.target_path) ||
      !obligation.test_files.includes(obligation.mutation_test_path)) {
    throw new Error("INDEPENDENT_REVIEW_OBLIGATION_SCOPE_INVALID");
  }
  const reviewInputs = await fingerprintIndependentReviewInputs({
    document,
    requirementIds: [requirementId],
    repoRoot,
    documentPath,
    sourceSnapshotContext: snapshot,
  });
  const baseline = await runInMemoryVitestMutation({
    repoRoot: executionRoot,
    testPath: obligation.mutation_test_path,
    targetPath: targetRealPath,
    literal: obligation.literal,
    replacement: obligation.replacement,
    mutate: false,
  });
  if (baseline.result.module_count !== 1 || baseline.result.test_count < 1 ||
      baseline.result.failed !== 0 || baseline.result.skipped !== 0 ||
      baseline.result.unhandled_error_count !== 0 ||
      baseline.result.passed !== baseline.result.test_count) {
    throw new Error("INDEPENDENT_REVIEW_OBLIGATION_BASELINE_NOT_GREEN");
  }
  const mutated = await runInMemoryVitestMutation({
    repoRoot: executionRoot,
    testPath: obligation.mutation_test_path,
    targetPath: targetRealPath,
    literal: obligation.literal,
    replacement: obligation.replacement,
    mutate: true,
  });
  await assertIndependentReviewSourceSnapshotUnchanged(snapshot);
  await assertIndependentReviewExecutionRuntimeUnchanged({
    repoRoot: executionRoot,
    sourceSnapshotContext: snapshot,
    approvedReviewRuntimeSha256: approvedRuntime,
  });
  if (mutated.mutation_applications !== 1 || mutated.result.module_count !== 1 ||
      mutated.result.test_count !== baseline.result.test_count || mutated.result.failed < 1 ||
      mutated.result.skipped !== 0 || mutated.result.unhandled_error_count !== 0 ||
      mutated.result.passed + mutated.result.failed !== mutated.result.test_count) {
    throw new Error("INDEPENDENT_REVIEW_OBLIGATION_MUTATION_DID_NOT_FAIL_TEST");
  }
  const failedTests = mutated.result.tests.filter((item) => item.state === "failed");
  const failedNames = new Set(failedTests.map((item) => item.name));
  if (!obligation.expected_failing_test_names.every((name) => failedNames.has(name))) {
    throw new Error("INDEPENDENT_REVIEW_OBLIGATION_EXPECTED_TEST_DID_NOT_FAIL");
  }
  const failedMessages = failedTests.flatMap((item) => item.failure_messages).join("\n");
  if (!obligation.expected_failure_message_patterns.every((pattern) =>
    failedMessages.includes(pattern))) {
    throw new Error("INDEPENDENT_REVIEW_OBLIGATION_EXPECTED_ASSERTION_NOT_OBSERVED");
  }
  const receipt = {
    schema_version: "3.0",
    receipt_kind: "INDEPENDENT_REVIEW_FIXED_ATOMIC_MUTATION_PROBE",
    inspection_nonce: inspectionNonce,
    probe_nonce: probeNonce,
    source_fingerprint: sourceFingerprint,
    review_subject_sha256: independentReviewSubjectSha256(document, [requirementId]),
    review_inputs_sha256: reviewInputs.sha256,
    requirement_id: requirementId,
    claim_id: claimId,
    obligation_id: obligationId,
    obligation_sha256: reviewSha256(stableReviewStringify(obligation)),
    target: {
      path: obligation.target_path,
      anchor: obligation.target_anchor,
      size_bytes: target.length,
      sha256: reviewSha256(target),
      semantic_anchor_binding: semanticBinding,
    },
    test: {
      path: obligation.mutation_test_path,
      size_bytes: test.length,
      sha256: reviewSha256(test),
    },
    mutation_operator: obligation.mutation_operator,
    literal: obligation.literal,
    replacement: obligation.replacement,
    expected_failing_test_names: obligation.expected_failing_test_names,
    expected_failure_message_patterns: obligation.expected_failure_message_patterns,
    baseline,
    mutated,
    expectation_met: true,
  };
  if (ownsSnapshot) await assertIndependentReviewSourceSnapshotUnchanged(snapshot);
  return receipt;
}

function shellQuote(value) {
  const stringValue = String(value);
  if (/^[a-zA-Z0-9_./:=+-]+$/u.test(stringValue)) return stringValue;
  return `'${stringValue.replaceAll("'", `'"'"'`)}'`;
}

function reviewTestReferences(document, requirementIds) {
  const byPath = new Map();
  for (const requirementId of requirementIds) {
    const requirement = requirementById(document, requirementId);
    if (!isRecord(requirement)) throw new Error(`INDEPENDENT_REVIEW_TEST_REQUIREMENT_MISSING:${requirementId}`);
    for (const [field, kind] of [
      ["positive_tests", "POSITIVE"],
      ["negative_or_mutation_tests", "NEGATIVE_OR_MUTATION"],
    ]) {
      for (const path of requirement[field] ?? []) {
        const existing = byPath.get(path) ?? { path, coverage: [] };
        existing.coverage.push(`${requirementId}:${kind}`);
        byPath.set(path, existing);
      }
    }
  }
  return [...byPath.values()]
    .map((entry) => ({
      path: entry.path,
      coverage: [...new Set(entry.coverage)].sort((left, right) => left.localeCompare(right, "en")),
    }))
    .sort((left, right) => left.path.localeCompare(right.path, "en"));
}

async function testReferenceIdentities(document, requirementIds, sourceSnapshotContext) {
  if (!(sourceSnapshotContext?.contentByPath instanceof Map) ||
      !(sourceSnapshotContext?.identityByPath instanceof Map)) {
    throw new Error("INDEPENDENT_REVIEW_TEST_SOURCE_SNAPSHOT_REQUIRED");
  }
  const sourcePaths = new Set(sourceSnapshotContext.source_entries.map((entry) => entry.path));
  const references = reviewTestReferences(document, requirementIds);
  const identities = [];
  for (const reference of references) {
    const safePath = safeReviewRelativePath(reference.path, "INDEPENDENT_REVIEW_TEST_REFERENCE");
    if (!sourcePaths.has(safePath)) {
      throw new Error(`INDEPENDENT_REVIEW_TEST_REFERENCE_NOT_IN_SOURCE_SNAPSHOT:${safePath}`);
    }
    const bytes = sourceSnapshotContext.contentByPath.get(safePath);
    const identity = sourceSnapshotContext.identityByPath.get(safePath);
    if (!Buffer.isBuffer(bytes) || !identity || reviewSha256(bytes) !== identity.sha256) {
      throw new Error(`INDEPENDENT_REVIEW_TEST_REFERENCE_IDENTITY_INVALID:${safePath}`);
    }
    identities.push({
      ...reference, path: safePath, size_bytes: bytes.length, sha256: identity.sha256,
      invokes_external_child_process: /(?:node:)?child_process/u.test(bytes.toString("utf8")) ||
        reachesExternalProcessModule(safePath, sourcePaths, sourceSnapshotContext.contentByPath),
    });
  }
  return identities;
}

// EXTERNAL_PROCESS_MODULES and EXTERNAL_PROCESS_WRAPPER_PACKAGES were declared but
// never consulted: the only detection was a substring match on the cited test's own
// bytes. Moving the spawn one file away - into a helper the test imports - defeated
// it completely, which is the whole point of the rule. Follow the test's local
// import graph inside the frozen snapshot and inspect every file it reaches.
function reviewModuleSpecifiers(text) {
  const specifiers = new Set();
  for (const pattern of [
    /\bfrom\s*["']([^"']+)["']/gu,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/gu,
    /\bimport\s+["']([^"']+)["']/gu,
  ]) {
    for (const match of text.matchAll(pattern)) specifiers.add(match[1]);
  }
  return specifiers;
}

function resolveFrozenSnapshotImport(fromPath, specifier, sourcePaths) {
  if (!specifier.startsWith(".")) return undefined;
  const base = posix.normalize(posix.join(posix.dirname(fromPath), specifier));
  const candidates = [];
  // TypeScript ESM cites the emitted extension, so ./helper.js means ./helper.ts.
  if (base.endsWith(".js")) candidates.push(`${base.slice(0, -3)}.ts`, `${base.slice(0, -3)}.tsx`);
  if (base.endsWith(".mjs")) candidates.push(`${base.slice(0, -4)}.mts`);
  candidates.push(base, `${base}.ts`, `${base}.tsx`, `${base}.mjs`, `${base}.js`,
    posix.join(base, "index.ts"), posix.join(base, "index.js"));
  return candidates.find((candidate) => sourcePaths.has(candidate));
}

function reachesExternalProcessModule(startPath, sourcePaths, contentByPath) {
  const visited = new Set();
  const pending = [startPath];
  while (pending.length > 0) {
    const current = pending.pop();
    if (visited.has(current)) continue;
    visited.add(current);
    const bytes = contentByPath.get(current);
    if (!Buffer.isBuffer(bytes)) continue;
    for (const specifier of reviewModuleSpecifiers(bytes.toString("utf8"))) {
      if (EXTERNAL_PROCESS_MODULES.has(specifier) ||
          EXTERNAL_PROCESS_WRAPPER_PACKAGES.has(specifier)) {
        return true;
      }
      const resolved = resolveFrozenSnapshotImport(current, specifier, sourcePaths);
      if (resolved) pending.push(resolved);
    }
  }
  return false;
}

function lockedRuntimeDependencyPath(packages, fromPackagePath, dependencyName) {
  let directory = fromPackagePath;
  while (directory && directory !== ".") {
    if (posix.basename(directory) !== "node_modules") {
      const candidate = posix.join(directory, "node_modules", dependencyName);
      if (isRecord(packages[candidate])) return candidate;
    }
    const parent = posix.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  const rootCandidate = posix.join("node_modules", dependencyName);
  return isRecord(packages[rootCandidate]) ? rootCandidate : undefined;
}

function lockedReviewRuntimeClosure(lockfile) {
  if (!isRecord(lockfile) || !isRecord(lockfile.packages) ||
      !isRecord(lockfile.packages["node_modules/vitest"]) ||
      !isRecord(lockfile.packages["node_modules/typescript"])) {
    throw new Error("INDEPENDENT_REVIEW_RUNTIME_LOCKFILE_REVIEW_DEPENDENCY_MISSING");
  }
  const packages = lockfile.packages;
  const closure = new Set();
  const queue = ["node_modules/typescript", "node_modules/vitest"];
  while (queue.length > 0) {
    const packagePath = queue.shift();
    if (closure.has(packagePath)) continue;
    const record = packages[packagePath];
    if (!isRecord(record)) throw new Error(`INDEPENDENT_REVIEW_RUNTIME_LOCK_PACKAGE_MISSING:${packagePath}`);
    closure.add(packagePath);
    const optionalPeers = new Set(Object.entries(record.peerDependenciesMeta ?? {})
      .filter(([, metadata]) => metadata?.optional === true).map(([name]) => name));
    for (const [field, dependencies] of [
      ["dependencies", record.dependencies],
      ["optionalDependencies", record.optionalDependencies],
      ["peerDependencies", record.peerDependencies],
    ]) {
      if (!isRecord(dependencies)) continue;
      for (const dependencyName of Object.keys(dependencies).sort((left, right) => left.localeCompare(right, "en"))) {
        const dependencyPath = lockedRuntimeDependencyPath(packages, packagePath, dependencyName);
        const optional = field === "optionalDependencies" ||
          (field === "peerDependencies" && optionalPeers.has(dependencyName));
        if (!dependencyPath) {
          if (optional) continue;
          throw new Error(`INDEPENDENT_REVIEW_RUNTIME_LOCK_DEPENDENCY_MISSING:${packagePath}:${dependencyName}`);
        }
        if (!closure.has(dependencyPath)) queue.push(dependencyPath);
      }
    }
  }
  return [...closure].sort((left, right) => left.localeCompare(right, "en"));
}

export async function deriveObservedIndependentReviewRuntimeIdentity({ repoRoot, sourceSnapshotContext }) {
  if (!(sourceSnapshotContext?.contentByPath instanceof Map)) {
    throw new Error("INDEPENDENT_REVIEW_RUNTIME_SOURCE_SNAPSHOT_REQUIRED");
  }
  const packageBytes = sourceSnapshotContext.contentByPath.get("package.json");
  const lockBytes = sourceSnapshotContext.contentByPath.get("package-lock.json");
  if (!Buffer.isBuffer(packageBytes) || !Buffer.isBuffer(lockBytes)) {
    throw new Error("INDEPENDENT_REVIEW_RUNTIME_PACKAGE_IDENTITY_MISSING");
  }
  let lockfile;
  try {
    lockfile = JSON.parse(lockBytes.toString("utf8"));
  } catch {
    throw new Error("INDEPENDENT_REVIEW_RUNTIME_LOCKFILE_INVALID");
  }
  // The executed tests import application dependencies in addition to the
  // Vitest/TypeScript toolchain. A lockfile-only tool closure would allow a
  // candidate to patch (for example) zod or pg while preserving the approved
  // runtime digest. Bind every installed dependency byte instead. Symlinks and
  // unsupported filesystem nodes are rejected by the snapshot walker rather
  // than followed or silently omitted.
  lockedReviewRuntimeClosure(lockfile);
  const runtimeByPath = new Map();
  await captureIndependentReviewInstalledRuntimeTree(repoRoot, "node_modules", runtimeByPath);
  const dependencyEntries = [...runtimeByPath.values()].map((entry) => entry.identity)
    .sort((left, right) => left.path.localeCompare(right.path, "en"));
  if (dependencyEntries.length === 0) throw new Error("INDEPENDENT_REVIEW_RUNTIME_DEPENDENCY_CLOSURE_EMPTY");
  const nodeExecutable = await realpath(process.execPath);
  const nodeRead = await readRegularFileFromSingleDescriptor(
    nodeExecutable,
    "INDEPENDENT_REVIEW_NODE_RUNTIME",
  );
  const nodeRuntimeIdentity = {
    executable_path: nodeExecutable,
    executable_sha256: reviewSha256(nodeRead.content),
    version: process.version,
  };
  const identity = {
    schema_version: "1.0",
    algorithm: "node-plus-entire-installed-dependency-content-tree-v3",
    node_runtime_identity: nodeRuntimeIdentity,
    package_json_sha256: reviewSha256(packageBytes),
    package_lock_sha256: reviewSha256(lockBytes),
    installed_dependency_root: "node_modules",
    excluded_dependency_subtree_segment: ".bin",
    dependency_symlink_policy: "REJECT_OUTSIDE_EXCLUDED_DOT_BIN_SUBTREES",
    dependency_unsupported_node_policy: "REJECT",
    execution_policy_sha256: independentReviewEnvironmentPolicy().sha256,
    dependency_file_count: dependencyEntries.length,
    dependency_total_bytes: dependencyEntries.reduce((sum, entry) => sum + entry.size_bytes, 0),
    dependency_entries: dependencyEntries,
  };
  return {
    ...identity,
    observed_review_runtime_sha256: reviewSha256(stableReviewStringify(identity)),
  };
}

export async function assertIndependentReviewExecutionRuntimeUnchanged({
  repoRoot,
  sourceSnapshotContext,
  approvedReviewRuntimeSha256,
}) {
  const observed = await deriveObservedIndependentReviewRuntimeIdentity({
    repoRoot,
    sourceSnapshotContext,
  });
  if (!isSha256(approvedReviewRuntimeSha256) ||
      observed.observed_review_runtime_sha256 !== approvedReviewRuntimeSha256) {
    throw new Error("INDEPENDENT_REVIEW_RUNTIME_NOT_APPROVED");
  }
  return observed;
}

export async function createIndependentReviewTestPlan({
  document,
  requirementIds,
  repoRoot,
  documentPath,
  sourceSnapshotContext,
  approvedReviewRuntimeSha256,
}) {
  if (!isSha256(approvedReviewRuntimeSha256)) {
    throw new Error("INDEPENDENT_REVIEW_APPROVED_RUNTIME_REQUIRED");
  }
  if (!sourceSnapshotContext) {
    throw new Error("INDEPENDENT_REVIEW_TEST_SOURCE_SNAPSHOT_REQUIRED");
  }
  const tests = await testReferenceIdentities(document, requirementIds, sourceSnapshotContext);
  const externalToolTests = tests.filter((test) => test.invokes_external_child_process);
  if (externalToolTests.length > 0) {
    throw new Error(
      "INDEPENDENT_REVIEW_EXTERNAL_TOOLCHAIN_ATTESTATION_REQUIRED:" +
      externalToolTests.map((test) => test.path).join(","),
    );
  }
  const vitest = tests.filter((test) => /^(?:tests|src)\/.+\.test\.ts$/u.test(test.path));
  const nodeTests = tests.filter((test) => /^harness\/.+\/verify-[^/]+\.mjs$/u.test(test.path));
  if (vitest.length + nodeTests.length !== tests.length) {
    const unsupported = tests.filter((test) => !vitest.includes(test) && !nodeTests.includes(test));
    throw new Error(`INDEPENDENT_REVIEW_TEST_REFERENCE_NOT_EXECUTABLE:${unsupported.map((item) => item.path).join(",")}`);
  }
  const observedRuntime = await deriveObservedIndependentReviewRuntimeIdentity({
    repoRoot,
    sourceSnapshotContext,
  });
  if (observedRuntime.observed_review_runtime_sha256 !== approvedReviewRuntimeSha256) {
    throw new Error("INDEPENDENT_REVIEW_RUNTIME_NOT_APPROVED");
  }
  const commands = [];
  if (vitest.length > 0) {
    const request = {
      kind: "VITEST_NODE_API_EXACT_INVENTORY",
      config: false,
      pass_with_no_tests: false,
      max_workers: 1,
      exact_module_paths: vitest.map((test) => test.path),
    };
    commands.push({
      kind: request.kind,
      execution_request: request,
      execution_request_sha256: reviewSha256(stableReviewStringify(request)),
      tests: vitest,
      approved_review_runtime_sha256: approvedReviewRuntimeSha256,
      observed_review_runtime_sha256: observedRuntime.observed_review_runtime_sha256,
      node_runtime_identity: observedRuntime.node_runtime_identity,
    });
  }
  if (nodeTests.length > 0) {
    const request = {
      kind: "NODE_TEST_PROGRAMMATIC_EXACT_INVENTORY",
      pass_with_no_tests: false,
      exact_module_paths: nodeTests.map((test) => test.path),
    };
    commands.push({
      kind: request.kind,
      execution_request: request,
      execution_request_sha256: reviewSha256(stableReviewStringify(request)),
      tests: nodeTests,
      approved_review_runtime_sha256: approvedReviewRuntimeSha256,
      observed_review_runtime_sha256: observedRuntime.observed_review_runtime_sha256,
      node_runtime_identity: observedRuntime.node_runtime_identity,
    });
  }
  if (commands.length === 0) throw new Error("INDEPENDENT_REVIEW_TEST_PLAN_EMPTY");
  return commands;
}

export function expectedStructuredReviewChecks({ document, requirementId, reviewInputs }) {
  const requirement = requirementById(document, requirementId);
  if (!isRecord(requirement) || !Array.isArray(reviewInputs?.files)) {
    throw new Error(`INDEPENDENT_REVIEW_STRUCTURED_CHECKS_INVALID:${requirementId}`);
  }
  const citations = [
    ...requirement.implementation_files.map((reference) => ({ field: "implementation_files", reference })),
    ...requirement.positive_tests.map((reference) => ({ field: "positive_tests", reference })),
    ...requirement.negative_or_mutation_tests.map((reference) => ({ field: "negative_or_mutation_tests", reference })),
    ...requirement.evidence.map((reference) => ({ field: "evidence", reference })),
  ];
  const citedFiles = new Map();
  for (const citation of citations) {
    const binding = `${requirementId}:${citation.field}:${citation.reference}`;
    const file = reviewInputs.files.find((candidate) => candidate.references.includes(binding));
    if (!file) throw new Error(`INDEPENDENT_REVIEW_STRUCTURED_CHECK_MISSING:${binding}`);
    citedFiles.set(file.path, file);
  }
  for (const file of reviewInputs.files) {
    if (file.references.some((reference) => reference.startsWith(`${requirementId}:review_universe:`))) {
      citedFiles.set(file.path, file);
    }
  }
  const evidenceChecked = [...citedFiles.values()]
    .sort((left, right) => left.path.localeCompare(right.path, "en"))
    .map((file) => ({ path: file.path, sha256: file.sha256 }));
  const adversarialChecks = [...new Set(requirement.negative_or_mutation_tests)]
    .sort((left, right) => left.localeCompare(right, "en"))
    .map((testPath) => {
      const binding = `${requirementId}:negative_or_mutation_tests:${testPath}`;
      const file = reviewInputs.files.find((candidate) => candidate.references.includes(binding));
      if (!file) throw new Error(`INDEPENDENT_REVIEW_STRUCTURED_CHECK_MISSING:${binding}`);
      return { test_path: file.path, sha256: file.sha256 };
    });
  return { evidenceChecked, adversarialChecks };
}

export function verifyIndependentReviewTestExecutionResult(item, run) {
  exactFields(run, [
    "schema_version", "receipt_kind", "execution_request_sha256",
    "approved_review_runtime_sha256", "observed_review_runtime_sha256",
    "node_runtime_identity", "started_at", "finished_at", "inventory",
  ], "INDEPENDENT_REVIEW_TEST_EXECUTION_RESULT");
  if (run.schema_version !== "1.0" ||
      run.receipt_kind !== "APPROVED_HOST_PROGRAMMATIC_TEST_INVENTORY" ||
      run.execution_request_sha256 !== item.execution_request_sha256 ||
      run.approved_review_runtime_sha256 !== item.approved_review_runtime_sha256 ||
      run.observed_review_runtime_sha256 !== item.observed_review_runtime_sha256 ||
      stableReviewStringify(run.node_runtime_identity) !== stableReviewStringify(item.node_runtime_identity)) {
    throw new Error("INDEPENDENT_REVIEW_TEST_EXECUTION_IDENTITY_INVALID");
  }
  assertDateTime(run.started_at, "INDEPENDENT_REVIEW_TEST_EXECUTION_RESULT.started_at");
  assertDateTime(run.finished_at, "INDEPENDENT_REVIEW_TEST_EXECUTION_RESULT.finished_at");
  if (Date.parse(run.finished_at) < Date.parse(run.started_at)) {
    throw new Error("INDEPENDENT_REVIEW_TEST_EXECUTION_TIME_INVALID");
  }
  exactFields(run.inventory, [
    "module_count", "test_count", "passed", "failed", "skipped", "todo", "pending",
    "unhandled_errors", "modules",
  ], "INDEPENDENT_REVIEW_TEST_INVENTORY");
  const inventory = run.inventory;
  if (![inventory.module_count, inventory.test_count, inventory.passed, inventory.failed,
    inventory.skipped, inventory.todo, inventory.pending].every((value) =>
    Number.isSafeInteger(value) && value >= 0) || !Array.isArray(inventory.unhandled_errors) ||
    !Array.isArray(inventory.modules)) {
    throw new Error("INDEPENDENT_REVIEW_TEST_INVENTORY_INVALID");
  }
  if (inventory.module_count < 1 || inventory.test_count < 1 || inventory.failed !== 0 ||
      inventory.skipped !== 0 || inventory.todo !== 0 || inventory.pending !== 0 ||
      inventory.unhandled_errors.length !== 0 || inventory.passed !== inventory.test_count) {
    throw new Error("INDEPENDENT_REVIEW_TEST_INVENTORY_NOT_EXACT_GREEN");
  }
  const expectedModules = item.tests.map((test) => ({ path: test.path, sha256: test.sha256 }))
    .sort((left, right) => left.path.localeCompare(right.path, "en"));
  const actualModules = [];
  const testIds = new Set();
  let countedTests = 0;
  for (const module of inventory.modules) {
    exactFields(module, ["path", "sha256", "tests"], "INDEPENDENT_REVIEW_TEST_MODULE");
    if (!isNonEmptyString(module.path) || !isSha256(module.sha256) || !Array.isArray(module.tests) ||
        module.tests.length === 0) {
      throw new Error("INDEPENDENT_REVIEW_TEST_MODULE_INVALID");
    }
    actualModules.push({ path: module.path, sha256: module.sha256 });
    for (const test of module.tests) {
      exactFields(test, ["id", "name", "state"], "INDEPENDENT_REVIEW_TEST_CASE");
      if (!isNonEmptyString(test.id) || !isNonEmptyString(test.name) || test.state !== "passed" ||
          testIds.has(test.id)) {
        throw new Error("INDEPENDENT_REVIEW_TEST_CASE_INVALID");
      }
      testIds.add(test.id);
      countedTests += 1;
    }
  }
  actualModules.sort((left, right) => left.path.localeCompare(right.path, "en"));
  if (inventory.module_count !== inventory.modules.length || inventory.test_count !== countedTests ||
      stableReviewStringify(actualModules) !== stableReviewStringify(expectedModules)) {
    throw new Error("INDEPENDENT_REVIEW_TEST_EXACT_MODULE_INVENTORY_MISMATCH");
  }
  return {
    ...run,
    inventory_sha256: reviewSha256(stableReviewStringify(run.inventory)),
  };
}

export async function runIndependentReviewTestPlan({
  document,
  requirementIds,
  repoRoot,
  documentPath,
  executor,
  sourceFingerprint,
  reviewSubjectSha256,
  reviewInputsSha256,
  sourceSnapshotContext,
  approvedReviewRuntimeSha256,
}) {
  if (![sourceFingerprint, reviewSubjectSha256, reviewInputsSha256].every(isSha256)) {
    throw new Error("INDEPENDENT_REVIEW_TEST_BINDING_INVALID");
  }
  if (typeof executor !== "function") {
    throw new Error("INDEPENDENT_REVIEW_HOST_TEST_EXECUTOR_REQUIRED");
  }
  const plan = await createIndependentReviewTestPlan({
    document,
    requirementIds,
    repoRoot,
    documentPath,
    sourceSnapshotContext,
    approvedReviewRuntimeSha256,
  });
  const planIdentity = reviewSha256(stableReviewStringify({
    plan,
    sourceFingerprint,
    reviewSubjectSha256,
    reviewInputsSha256,
  }));
  const receipts = [];
  for (const item of plan) {
    await assertIndependentReviewSourceSnapshotUnchanged(sourceSnapshotContext);
    await assertIndependentReviewExecutionRuntimeUnchanged({
      repoRoot,
      sourceSnapshotContext,
      approvedReviewRuntimeSha256,
    });
    const executionResult = await executor(item, repoRoot);
    await assertIndependentReviewSourceSnapshotUnchanged(sourceSnapshotContext);
    await assertIndependentReviewExecutionRuntimeUnchanged({
      repoRoot,
      sourceSnapshotContext,
      approvedReviewRuntimeSha256,
    });
    const verified = verifyIndependentReviewTestExecutionResult(
      item,
      executionResult,
    );
    receipts.push({
      schema_version: "2.0",
      receipt_kind: "INDEPENDENT_REVIEW_GATE_TEST_PROGRAMMATIC_INVENTORY",
      source_fingerprint: sourceFingerprint,
      review_subject_sha256: reviewSubjectSha256,
      review_inputs_sha256: reviewInputsSha256,
      plan_identity_sha256: planIdentity,
      kind: item.kind,
      execution_request_sha256: item.execution_request_sha256,
      tests: item.tests,
      approved_review_runtime_sha256: item.approved_review_runtime_sha256,
      observed_review_runtime_sha256: item.observed_review_runtime_sha256,
      node_runtime_identity: item.node_runtime_identity,
      started_at: verified.started_at,
      finished_at: verified.finished_at,
      inventory_sha256: verified.inventory_sha256,
      inventory: verified.inventory,
    });
  }
  return receipts;
}

export function buildIndependentReviewPrompt({
  implementationExecutionId,
  sourceFingerprint,
  reviewSubjectSha256,
  reviewInputsSha256,
  inspectionCommands,
  traceabilityPath,
  requestedRequirements,
}) {
  const assignments = requestedRequirements
    .map((item) => `- ${stableReviewStringify(item)}`)
    .join("\n");
  if (!Array.isArray(inspectionCommands) || inspectionCommands.length === 0 ||
      inspectionCommands.some((command) => !isNonEmptyString(command))) {
    throw new Error("INDEPENDENT_REVIEW_PROMPT_INSPECTION_COMMANDS_INVALID");
  }
  const inspectionCommandList = inspectionCommands.map((command, index) =>
    `  ${index + 1}. ${command}`).join("\n");
  return `You are an independent local release reviewer operating in a separate Codex execution.

Execution boundary:
- The controller/implementation-side execution identity is ${implementationExecutionId}.
- You must remain read-only. Do not edit files, stage, commit, push, deploy, publish to Feishu, call external services, or ask another agent to perform the review.
- Inspect only the local repository and local evidence. Do not use web search, browser, MCP, apps, plugins, computer use, or image generation.
- Do not trust existing PASS/CLOSED prose or the implementer's cited-file list. Recompute and falsify claims from the non-self-selectable review universe, implementation, tests, negative/mutation tests, evidence references, and architecture boundaries.

Frozen review identity:
- source_fingerprint=${sourceFingerprint}
- review_subject_sha256=${reviewSubjectSha256}
- review_inputs_sha256=${reviewInputsSha256}
- traceability_path=${JSON.stringify(traceabilityPath)}

Mandatory machine-readable inspection receipt:
- Before giving any verdict, run every exact command below once, in order, as a separate command_execution and inspect every complete output:
${inspectionCommandList}
- Each command must complete with exit code 0 and returns exactly one bounded content batch. Together the ordered outputs contain the actual bytes of the mechanically assigned review shard as content-addressed UTF-8/base64 chunks. The full universe is independently derived from accepted release/runtime/build/deploy/migrations and the fixed-baseline critical worktree delta, then covered by the union of requirement shards; this shard's mapping is not implementer-selectable. Large inputs are split into more commands and small chunks may share one bounded batch; no mapped path or byte may be omitted. Read every entry completely. Do not wrap a command, combine commands in a loop, offset one with another command, or replace them with rg/cat prose. The release validator will reconstruct and replay every chunk against current bytes, full-universe identity, shard mapping, baseline identity and invocation nonce.

Assigned requirements:
${assignments}

For every assigned requirement, inspect every universe file mapped to it plus the actual cited implementation/test/evidence files. Then originate exactly one fresh, requirement-specific executable mutation probe. The probe must target one cited implementation_files path, select one cited executable Vitest test, and replace exactly one 4-256 character implementation literal with a different 1-256 character literal entirely in memory. The fixed helper first requires that exact test to pass against the unmodified source, then applies the proposed mutation through a Vite transform without writing the worktree, and requires at least one collected test assertion to fail with no skip, collection error, or unhandled error. Choose a new 32-lowercase-hex probe nonce that does not appear in the prompt or reviewed bytes, and state a concrete counterexample of at least 40 characters containing both exact mutation literals. Run the exact command once after the inspection receipt and before the verdict:
  ${process.execPath} ${REVIEW_FALSIFICATION_PROBE_SCRIPT} --file ${shellQuote(traceabilityPath)} --nonce <the inspection nonce above> --requirement <assigned requirement ID> --probe-nonce <new 32 lowercase hex> --target <cited implementation file> --test <cited Vitest test file> --literal <one exact source literal> --replacement <different replacement literal> --counterexample <concrete counterexample containing both literals>
Do not run any other command. Copy the probe definition into that requirement's falsification_probe verdict field and include both exact mutation literals in the requirement rationale. The validator accepts only the exact command derived from that field, independently reruns the green baseline and in-memory mutation against current bytes, and requires the mutation to produce a real test failure before CLOSED is valid. A literal count, prose-only counterexample, syntax or collection failure, skipped test, or worktree edit cannot satisfy this requirement.

Mark CLOSED only when the control is implemented at the correct MCP layer, generic enough for the stated boundary, positive and adversarial evidence is sufficient, the fresh probe expectation holds, and no unresolved P0/P1 issue remains. Otherwise mark REOPEN and state the concrete counterexample. The overall decision is CLOSED only if every requirement is CLOSED.

Return only JSON conforming to the supplied output schema. Echo the exact implementation_execution_id, source_fingerprint, review_subject_sha256, review_inputs_sha256, requirement IDs, and assigned reviewer roles above. For each requirement, evidence_checked must be the exact sorted array of every file mechanically mapped to that requirement (including citations) as {path,sha256} from the inspection receipt; adversarial_checks must be the exact sorted array of its negative_or_mutation_tests as {test_path,sha256}; falsification_probe must exactly describe the fresh probe command you ran. Missing, extra, stale, metadata-only or prose-only entries are invalid. Rationale and residual risk must still explain the concrete judgment.`;
}

export function buildIndependentReviewCodexCommand({
  codexPath,
  repoRoot,
  outputSchemaPath,
  finalVerdictPath,
}) {
  return [
    codexPath,
    "exec",
    "--strict-config",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--disable", "plugins",
    "--disable", "apps",
    "--disable", "recommended_plugins",
    "--disable", "memories",
    "--disable", "browser_use",
    "--disable", "in_app_browser",
    "--disable", "computer_use",
    "--disable", "image_generation",
    "--disable", "multi_agent",
    "--disable", "workspace_dependencies",
    "-m", INDEPENDENT_REVIEW_MODEL,
    "-c", `model_reasoning_effort=${JSON.stringify(INDEPENDENT_REVIEW_REASONING_EFFORT)}`,
    "-c", "shell_environment_policy.inherit=none",
    "-c", `shell_environment_policy.set.PATH=${JSON.stringify(INDEPENDENT_REVIEW_FIXED_PATH)}`,
    "-c", "shell_environment_policy.set.LANG=\"C.UTF-8\"",
    "-c", "shell_environment_policy.set.LC_ALL=\"C.UTF-8\"",
    "-c", "shell_environment_policy.set.HOME=\"/var/empty\"",
    "--skip-git-repo-check",
    "-C", repoRoot,
    "-s", "read-only",
    "--json",
    "--output-schema", outputSchemaPath,
    "--output-last-message", finalVerdictPath,
    "-",
  ];
}

function containedPath(base, candidate, label) {
  if (!isNonEmptyString(candidate) || isAbsolute(candidate) || candidate.includes("\0")) {
    throw new Error(`${label}: path must be relative to its evidence boundary`);
  }
  const absolute = resolve(base, candidate);
  if (absolute !== base && !absolute.startsWith(`${base}${sep}`)) {
    throw new Error(`${label}: path escapes its evidence boundary`);
  }
  return absolute;
}

async function readRegularFileFromSingleDescriptor(path, label) {
  if (!Number.isInteger(fsConstants.O_NOFOLLOW)) {
    throw new Error(`${label}: O_NOFOLLOW is unavailable`);
  }
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`${label}: referenced file does not exist`);
    if (error?.code === "ELOOP") throw new Error(`${label}: must be a regular non-symlink file`);
    throw error;
  }
  let appliedTestHook = false;
  try {
    const testHook = snapshotDescriptorReadTestHook;
    if (testHook) appliedTestHook = await testHook({ phase: "after_open", path }) === true;
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new Error(`${label}: must be a regular non-symlink file`);
    const content = await handle.readFile();
    if (appliedTestHook) await testHook({ phase: "after_read", path });
    const after = await handle.stat({ bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.mode !== after.mode ||
        before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs ||
        BigInt(content.length) !== after.size) {
      throw new Error(`${label}: file changed while its frozen bytes were read`);
    }
    return {
      content,
      mode: Number(after.mode),
      device: String(after.dev),
      inode: String(after.ino),
      uid: Number(after.uid),
      gid: Number(after.gid),
    };
  } finally {
    if (appliedTestHook) snapshotDescriptorReadTestHook = undefined;
    await handle.close();
  }
}

async function readRegularFile(path, label) {
  return (await readRegularFileFromSingleDescriptor(path, label)).content;
}

async function readCodexVersion(executablePath, cwd) {
  const child = spawn(executablePath, ["--version"], {
    cwd,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  let outputBytes = 0;
  let overflow = false;
  const collect = (target) => (chunk) => {
    outputBytes += chunk.length;
    if (outputBytes > 1024 * 1024) {
      overflow = true;
      child.kill("SIGTERM");
      return;
    }
    target.push(chunk);
  };
  child.stdout.on("data", collect(stdout));
  child.stderr.on("data", collect(stderr));
  const timeout = setTimeout(() => child.kill("SIGTERM"), 30_000);
  const outcome = await new Promise((resolvePromise) => {
    child.once("error", (error) => resolvePromise({ code: null, signal: null, error: error.message }));
    child.once("close", (code, signal) => resolvePromise({ code, signal, error: null }));
  });
  clearTimeout(timeout);
  if (overflow || outcome.code !== 0) {
    throw new Error(`INDEPENDENT_REVIEW_CODEX: --version failed (${outcome.code ?? outcome.signal ?? outcome.error ?? "unknown"})`);
  }
  const version = Buffer.concat(stdout).toString("utf8").trim();
  if (!version) throw new Error("INDEPENDENT_REVIEW_CODEX: --version returned no identity");
  return version;
}

function parseJson(content, label) {
  try {
    return JSON.parse(content.toString("utf8"));
  } catch {
    throw new Error(`${label}: invalid JSON`);
  }
}

function parseJsonLines(content, label) {
  const values = [];
  for (const [index, line] of content.toString("utf8").split(/\r?\n/u).entries()) {
    if (!line.trim()) continue;
    try {
      values.push(JSON.parse(line));
    } catch {
      throw new Error(`${label}: invalid JSONL at line ${index + 1}`);
    }
  }
  if (values.length === 0) throw new Error(`${label}: empty JSONL`);
  return values;
}

function validateRequestedRequirements(value, document, reviewedIds) {
  if (!Array.isArray(value) || value.length !== reviewedIds.length) {
    throw new Error("INDEPENDENT_REVIEW_INVOCATION: requested_requirements do not cover the reviewed subject");
  }
  const expected = reviewedIds.map((requirementId) => {
    const requirement = requirementById(document, requirementId);
    return {
      requirement_id: requirementId,
      implementation_owner: requirement?.implementation_owner,
      reviewer_role: requirement?.reviewer,
    };
  });
  if (stableReviewStringify(value) !== stableReviewStringify(expected)) {
    throw new Error("INDEPENDENT_REVIEW_INVOCATION: requested requirement identities diverged");
  }
  return expected;
}

function validateFinalVerdict(value, expected) {
  exactFields(value, [
    "schema_version",
    "implementation_execution_id",
    "source_fingerprint",
    "review_subject_sha256",
    "review_inputs_sha256",
    "overall_decision",
    "requirements",
  ], "INDEPENDENT_REVIEW_FINAL_VERDICT");
  if (value.schema_version !== "1.0" || value.implementation_execution_id !== expected.implementationExecutionId ||
      value.source_fingerprint !== expected.sourceFingerprint ||
      value.review_subject_sha256 !== expected.reviewSubjectSha256 ||
      value.review_inputs_sha256 !== expected.reviewInputsSha256 ||
      !["CLOSED", "REOPEN"].includes(value.overall_decision) ||
      !Array.isArray(value.requirements) || value.requirements.length !== expected.requestedRequirements.length) {
    throw new Error("INDEPENDENT_REVIEW_FINAL_VERDICT: frozen identity or coverage diverged");
  }
  const records = new Map();
  for (const [index, record] of value.requirements.entries()) {
    exactFields(record, [
      "requirement_id",
      "reviewer_role",
      "decision",
      "evidence_checked",
      "adversarial_checks",
      "falsification_probe",
      "rationale",
      "residual_risk",
    ], `INDEPENDENT_REVIEW_FINAL_VERDICT.requirements[${index}]`);
    const assignment = expected.requestedRequirements[index];
    if (record.requirement_id !== assignment.requirement_id || record.reviewer_role !== assignment.reviewer_role ||
        !["CLOSED", "REOPEN"].includes(record.decision) || records.has(record.requirement_id)) {
      throw new Error("INDEPENDENT_REVIEW_FINAL_VERDICT: requirement identity, role or decision diverged");
    }
    const structuredChecks = expectedStructuredReviewChecks({
      document: expected.document,
      requirementId: record.requirement_id,
      reviewInputs: expected.reviewInputs,
    });
    if (stableReviewStringify(record.evidence_checked) !== stableReviewStringify(structuredChecks.evidenceChecked) ||
        stableReviewStringify(record.adversarial_checks) !== stableReviewStringify(structuredChecks.adversarialChecks)) {
      throw new Error(`INDEPENDENT_REVIEW_FINAL_VERDICT: ${record.requirement_id} check receipts do not match current cited bytes`);
    }
    assertFalsificationProbeShape(record.falsification_probe, expected.inspectionNonce);
    if (!normalizedProbeText(record.rationale).includes(normalizedProbeText(record.falsification_probe.literal)) ||
        !normalizedProbeText(record.rationale).includes(normalizedProbeText(record.falsification_probe.replacement))) {
      throw new Error(`INDEPENDENT_REVIEW_FINAL_VERDICT: ${record.requirement_id} rationale is not bound to its executable mutation`);
    }
    for (const field of ["rationale", "residual_risk"]) {
      if (!isNonEmptyString(record[field])) {
        throw new Error(`INDEPENDENT_REVIEW_FINAL_VERDICT: ${record.requirement_id}.${field} is required`);
      }
    }
    records.set(record.requirement_id, record);
  }
  const derivedDecision = [...records.values()].every((record) => record.decision === "CLOSED")
    ? "CLOSED"
    : "REOPEN";
  if (value.overall_decision !== derivedDecision) {
    throw new Error("INDEPENDENT_REVIEW_FINAL_VERDICT: overall_decision was not derived from requirement decisions");
  }
  return records;
}

function deriveReviewerExecution(events, reviewerProcessId) {
  const threadEvents = events.filter((event) => event?.type === "thread.started");
  const turnStarted = events.filter((event) => event?.type === "turn.started");
  const turnCompleted = events.filter((event) => event?.type === "turn.completed");
  if (threadEvents.length !== 1 || !isNonEmptyString(threadEvents[0]?.thread_id) ||
      turnStarted.length !== 1 || turnCompleted.length !== 1) {
    throw new Error("INDEPENDENT_REVIEW_RAW_EVENTS: one real thread and one completed turn are required");
  }
  if (events.some((event) => DISALLOWED_REVIEW_ITEM_TYPES.has(event?.item?.type))) {
    throw new Error("INDEPENDENT_REVIEW_RAW_EVENTS: a forbidden non-read-only tool was used");
  }
  const usage = turnCompleted[0]?.usage;
  if (!isRecord(usage) || !Number.isInteger(usage.input_tokens) || !Number.isInteger(usage.output_tokens) ||
      usage.input_tokens <= 1 || usage.output_tokens <= 1) {
    throw new Error("INDEPENDENT_REVIEW_RAW_EVENTS: non-trivial reviewer token usage is required");
  }
  const commandItems = events.filter((event) => event?.item?.type === "command_execution");
  if (commandItems.some((event) => event.item?.status === "failed" ||
      (Number.isInteger(event.item?.exit_code) && event.item.exit_code !== 0))) {
    throw new Error("INDEPENDENT_REVIEW_RAW_EVENTS: an inspection command failed");
  }
  return `codex-thread:${threadEvents[0].thread_id}:pid:${reviewerProcessId}`;
}

export function independentReviewCommandMatchesExpected(command, expectedCommand) {
  if (!isNonEmptyString(command)) return false;
  const normalized = command.trim();
  if (normalized === expectedCommand) return true;
  return ["/bin/zsh", "/bin/bash", "/bin/sh"].some((shell) =>
    normalized === `${shell} -lc ${JSON.stringify(expectedCommand)}` ||
    normalized === `${shell} -lc ${shellQuote(expectedCommand)}`);
}

function validateContentAddressedInspectionReceipt(receipt, expectedReviewInputs) {
  if (!isRecord(receipt) || receipt.schema_version !== "2.0" ||
      receipt.receipt_kind !== "INDEPENDENT_REVIEW_INPUT_READ" || !Array.isArray(receipt.files) ||
      receipt.files.length !== expectedReviewInputs.file_count) {
    throw new Error("INDEPENDENT_REVIEW_RAW_EVENTS: metadata-only inspection receipt is forbidden");
  }
  let totalBytes = 0;
  let totalChunks = 0;
  let totalBase64Bytes = 0;
  for (const file of receipt.files) {
    if (!isRecord(file) || !Array.isArray(file.content_chunks) || file.content_chunks.length === 0) {
      throw new Error("INDEPENDENT_REVIEW_RAW_EVENTS: every cited file requires actual content chunks");
    }
    const chunks = [];
    let expectedOffset = 0;
    for (const [index, chunk] of file.content_chunks.entries()) {
      if (!isRecord(chunk) || chunk.chunk_index !== index || chunk.chunk_count !== file.content_chunks.length ||
          chunk.offset_bytes !== expectedOffset || !Number.isInteger(chunk.size_bytes) || chunk.size_bytes < 0 ||
          !isSha256(chunk.sha256) || !["utf8", "base64"].includes(chunk.encoding) || typeof chunk.content !== "string") {
        throw new Error(`INDEPENDENT_REVIEW_RAW_EVENTS: invalid content chunk coverage for ${file.path ?? "unknown"}`);
      }
      let bytes;
      if (chunk.encoding === "utf8") {
        bytes = Buffer.from(chunk.content, "utf8");
      } else {
        bytes = Buffer.from(chunk.content, "base64");
        totalBase64Bytes += bytes.length;
        if (bytes.toString("base64") !== chunk.content) {
          throw new Error(`INDEPENDENT_REVIEW_RAW_EVENTS: non-canonical content chunk for ${file.path ?? "unknown"}`);
        }
      }
      if (bytes.length !== chunk.size_bytes || reviewSha256(bytes) !== chunk.sha256) {
        throw new Error(`INDEPENDENT_REVIEW_RAW_EVENTS: content chunk digest diverged for ${file.path ?? "unknown"}`);
      }
      chunks.push(bytes);
      expectedOffset += bytes.length;
      totalChunks += 1;
    }
    const content = Buffer.concat(chunks);
    if (content.length !== file.size_bytes || reviewSha256(content) !== file.sha256) {
      throw new Error(`INDEPENDENT_REVIEW_RAW_EVENTS: cited file content was not reconstructed for ${file.path ?? "unknown"}`);
    }
    totalBytes += content.length;
  }
  if (receipt.content_total_bytes !== totalBytes || receipt.content_source_chunk_count !== totalChunks ||
      receipt.content_chunk_count !== reviewContentBatches(receipt.files).length ||
      receipt.content_base64_source_bytes !== totalBase64Bytes || totalBytes !== expectedReviewInputs.total_bytes) {
    throw new Error("INDEPENDENT_REVIEW_RAW_EVENTS: content chunk totals do not cover every cited byte");
  }
}

function validateContentAddressedInspectionChunkReceipts(receipts, expectedFullReceipt, expectedReviewInputs) {
  if (!Array.isArray(receipts) || receipts.length !== expectedFullReceipt.content_chunk_count) {
    throw new Error("INDEPENDENT_REVIEW_RAW_EVENTS: every cited content chunk command is mandatory");
  }
  const reconstructedFiles = new Map(expectedFullReceipt.files.map((file) => [file.path, {
    ...file,
    content_chunks: [],
  }]));
  for (const [index, receipt] of receipts.entries()) {
    if (!isRecord(receipt) || receipt.schema_version !== "2.0" ||
        receipt.receipt_kind !== "INDEPENDENT_REVIEW_INPUT_BATCH_READ" ||
        !Array.isArray(receipt.entries) || receipt.entries.length === 0 ||
        receipt.entries.some((entry) => !isRecord(entry?.file) || !isRecord(entry?.chunk) ||
          typeof entry.chunk.content !== "string")) {
      throw new Error("INDEPENDENT_REVIEW_RAW_EVENTS: metadata-only inspection receipt is forbidden");
    }
    const expected = createIndependentReviewInputChunkReceipt(expectedFullReceipt, index);
    if (stableReviewStringify(receipt) !== stableReviewStringify(expected)) {
      throw new Error(`INDEPENDENT_REVIEW_RAW_EVENTS: content chunk ${index} diverged from current bytes or nonce`);
    }
    for (const entry of receipt.entries) {
      const file = reconstructedFiles.get(entry.file.path);
      if (!file) throw new Error(`INDEPENDENT_REVIEW_RAW_EVENTS: unknown content chunk file ${entry.file.path}`);
      file.content_chunks.push(entry.chunk);
    }
  }
  validateContentAddressedInspectionReceipt({
    ...expectedFullReceipt,
    files: [...reconstructedFiles.values()],
  }, expectedReviewInputs);
}

/**
 * Replays a closure from raw Codex events and local bytes. The summary's
 * decision and human-readable identity are deliberately not authoritative.
 */
export async function verifyIndependentReviewClosure({
  document,
  requirement,
  closure,
  reviewArtifactPath,
  expectedReviewArtifactSha256,
  expectedSourceFingerprint,
  repoRoot,
  documentPath,
  allowedCodexExecutablePaths,
  reviewTestExecutor,
  reviewExecutionReceipts,
  sourceSnapshotContext,
  approvedReviewRuntimeSha256,
}) {
  if (!isSha256(expectedSourceFingerprint)) {
    throw new Error("INDEPENDENT_REVIEW_CURRENT_SOURCE_FINGERPRINT_REQUIRED");
  }
  const summaryBytes = await readRegularFile(reviewArtifactPath, "INDEPENDENT_REVIEW_ARTIFACT");
  if (reviewSha256(summaryBytes) !== expectedReviewArtifactSha256) {
    throw new Error("INDEPENDENT_REVIEW_ARTIFACT: review_artifact_sha256 does not match");
  }
  const summary = parseJson(summaryBytes, "INDEPENDENT_REVIEW_ARTIFACT");
  exactFields(summary, SUMMARY_FIELDS, "INDEPENDENT_REVIEW_ARTIFACT");
  if (summary.schema_version !== "1.0" || summary.evidence_boundary !== "LOCAL_READ_ONLY_CODEX_REVIEW") {
    throw new Error("INDEPENDENT_REVIEW_ARTIFACT: unsupported evidence boundary or schema");
  }
  assertDateTime(summary.captured_at, "INDEPENDENT_REVIEW_ARTIFACT.captured_at");
  if (!isSha256(summary.source_fingerprint) || summary.source_fingerprint !== expectedSourceFingerprint ||
      summary.source_fingerprint !== closure.source_fingerprint) {
    throw new Error("INDEPENDENT_REVIEW_STALE: source fingerprint does not match current source");
  }
  if (!Array.isArray(summary.reviewed_requirement_ids) || summary.reviewed_requirement_ids.length === 0 ||
      !summary.reviewed_requirement_ids.includes(requirement.requirement_id)) {
    throw new Error("INDEPENDENT_REVIEW_ARTIFACT: requirement was not part of the invocation");
  }
  const reviewedIds = [...summary.reviewed_requirement_ids];
  if (JSON.stringify(reviewedIds) !== JSON.stringify([...reviewedIds].sort((a, b) => a.localeCompare(b, "en"))) ||
      new Set(reviewedIds).size !== reviewedIds.length) {
    throw new Error("INDEPENDENT_REVIEW_ARTIFACT: reviewed_requirement_ids must be sorted and unique");
  }
  const subjectDigest = independentReviewSubjectSha256(document, reviewedIds);
  if (summary.review_subject_sha256 !== subjectDigest || closure.review_subject_sha256 !== subjectDigest) {
    throw new Error("INDEPENDENT_REVIEW_STALE: traceability review subject changed");
  }
  const currentReviewInputs = await fingerprintIndependentReviewInputs({
    document,
    requirementIds: reviewedIds,
    repoRoot,
    documentPath,
    sourceSnapshotContext,
  });
  if (summary.review_inputs_sha256 !== currentReviewInputs.sha256 ||
      closure.review_inputs_sha256 !== currentReviewInputs.sha256) {
    throw new Error(
      "INDEPENDENT_REVIEW_STALE: a reviewed implementation, test or evidence artifact changed:" +
      `expected=${summary.review_inputs_sha256}:current=${currentReviewInputs.sha256}`,
    );
  }

  exactFields(summary.generator, GENERATOR_FIELDS, "INDEPENDENT_REVIEW_GENERATOR");
  if (summary.generator.kind !== "INDEPENDENT_READ_ONLY_CODEX_REVIEW" ||
      summary.generator.version !== "3.0.0" ||
      !isNonEmptyString(summary.generator.command) || !isSha256(summary.generator.executable_sha256)) {
    throw new Error("INDEPENDENT_REVIEW_GENERATOR: invalid identity");
  }
  const generatorPath = containedPath(repoRoot, summary.generator.executable_path, "INDEPENDENT_REVIEW_GENERATOR");
  const generatorBytes = await readRegularFile(generatorPath, "INDEPENDENT_REVIEW_GENERATOR");
  if (reviewSha256(generatorBytes) !== summary.generator.executable_sha256 ||
      summary.generator.command !== `node ${summary.generator.executable_path}`) {
    throw new Error("INDEPENDENT_REVIEW_GENERATOR: executable identity is stale");
  }

  if (!Array.isArray(summary.raw_artifacts) || summary.raw_artifacts.length !== RAW_ARTIFACT_TYPES.length) {
    throw new Error("INDEPENDENT_REVIEW_ARTIFACT: exact raw artifact set is required");
  }
  const evidenceDirectory = dirname(reviewArtifactPath);
  const raw = new Map();
  const rawPaths = new Map();
  for (const [index, artifact] of summary.raw_artifacts.entries()) {
    exactFields(artifact, ["artifact_type", "path", "sha256", "size_bytes"], `INDEPENDENT_REVIEW_RAW_ARTIFACT_${index}`);
    if (!RAW_ARTIFACT_TYPES.includes(artifact.artifact_type) || raw.has(artifact.artifact_type) ||
        !isSha256(artifact.sha256) || !Number.isInteger(artifact.size_bytes) || artifact.size_bytes < 1) {
      throw new Error("INDEPENDENT_REVIEW_ARTIFACT: raw artifact identities are incomplete or duplicated");
    }
    const path = containedPath(evidenceDirectory, artifact.path, "INDEPENDENT_REVIEW_RAW_ARTIFACT");
    const bytes = await readRegularFile(path, "INDEPENDENT_REVIEW_RAW_ARTIFACT");
    if (bytes.length !== artifact.size_bytes || reviewSha256(bytes) !== artifact.sha256) {
      throw new Error(`INDEPENDENT_REVIEW_RAW_ARTIFACT: ${artifact.path} is stale or tampered`);
    }
    raw.set(artifact.artifact_type, bytes);
    rawPaths.set(artifact.artifact_type, path);
  }
  if (RAW_ARTIFACT_TYPES.some((type) => !raw.has(type))) {
    throw new Error("INDEPENDENT_REVIEW_ARTIFACT: every required raw artifact is mandatory");
  }

  const invocation = parseJson(raw.get("INVOCATION"), "INDEPENDENT_REVIEW_INVOCATION");
  exactFields(invocation, INVOCATION_FIELDS, "INDEPENDENT_REVIEW_INVOCATION");
  if (invocation.schema_version !== "1.0" || invocation.evidence_boundary !== "LOCAL_READ_ONLY_CODEX_REVIEW" ||
      invocation.exit_code !== 0 || !Number.isInteger(invocation.controller_process_id) ||
      !Number.isInteger(invocation.reviewer_process_id) || invocation.controller_process_id < 1 ||
      invocation.reviewer_process_id < 1 || invocation.controller_process_id === invocation.reviewer_process_id ||
      !isNonEmptyString(invocation.implementation_execution_id)) {
    throw new Error("INDEPENDENT_REVIEW_INVOCATION: no distinct successful controller/reviewer process identity");
  }
  assertDateTime(invocation.started_at, "INDEPENDENT_REVIEW_INVOCATION.started_at");
  assertDateTime(invocation.finished_at, "INDEPENDENT_REVIEW_INVOCATION.finished_at");
  if (Date.parse(invocation.finished_at) < Date.parse(invocation.started_at)) {
    throw new Error("INDEPENDENT_REVIEW_INVOCATION: finished_at precedes started_at");
  }
  if (!/^controller-process:[1-9][0-9]*:run:[0-9a-f-]{36}$/u.test(invocation.implementation_execution_id) ||
      invocation.implementation_execution_id !==
        `controller-process:${invocation.controller_process_id}:run:${invocation.implementation_execution_id.slice(-36)}`) {
    throw new Error("INDEPENDENT_REVIEW_INVOCATION: implementation execution ID is not bound to controller PID and run UUID");
  }
  const expectedTraceabilityPath = relative(repoRoot, resolve(documentPath));
  if (invocation.traceability_path !== expectedTraceabilityPath || invocation.review_subject_sha256 !== subjectDigest ||
      invocation.implementation_execution_id !== summary.implementation_execution_id ||
      invocation.implementation_execution_id !== closure.implementation_execution_id) {
    throw new Error("INDEPENDENT_REVIEW_INVOCATION: implementation identity or reviewed subject diverged");
  }
  const requestedRequirements = validateRequestedRequirements(invocation.requested_requirements, document, reviewedIds);
  for (const field of ["source_fingerprint_before", "source_fingerprint_after"]) {
    if (!isRecord(invocation[field]) || invocation[field].sha256 !== expectedSourceFingerprint) {
      throw new Error("INDEPENDENT_REVIEW_STALE: source changed before or during reviewer invocation");
    }
  }
  if (stableReviewStringify(invocation.source_fingerprint_before) !==
      stableReviewStringify(invocation.source_fingerprint_after)) {
    throw new Error("INDEPENDENT_REVIEW_STALE: source fingerprint changed during reviewer invocation");
  }
  if (stableReviewStringify(invocation.review_inputs_before) !== stableReviewStringify(currentReviewInputs) ||
      stableReviewStringify(invocation.review_inputs_after) !== stableReviewStringify(currentReviewInputs)) {
    throw new Error("INDEPENDENT_REVIEW_STALE: reviewed input bytes changed before, during or after invocation");
  }
  const expectedInspectionReceipt = await createIndependentReviewInputReceipt({
    document,
    requirementIds: reviewedIds,
    repoRoot,
    documentPath,
    sourceFingerprint: expectedSourceFingerprint,
    nonce: invocation.inspection_nonce,
    sourceSnapshotContext,
  });
  const expectedInspectionCommands = buildIndependentReviewInspectionCommands({
    traceabilityPath: expectedTraceabilityPath,
    nonce: invocation.inspection_nonce,
    requirementIds: reviewedIds,
    chunkCount: expectedInspectionReceipt.content_chunk_count,
  });
  if (stableReviewStringify(invocation.inspection_commands) !== stableReviewStringify(expectedInspectionCommands)) {
    throw new Error("INDEPENDENT_REVIEW_INVOCATION: inspection commands are not fixed to every current content chunk");
  }
  const expectedPrompt = buildIndependentReviewPrompt({
    implementationExecutionId: invocation.implementation_execution_id,
    sourceFingerprint: expectedSourceFingerprint,
    reviewSubjectSha256: subjectDigest,
    reviewInputsSha256: currentReviewInputs.sha256,
    inspectionCommands: expectedInspectionCommands,
    traceabilityPath: expectedTraceabilityPath,
    requestedRequirements,
  });
  if (invocation.prompt !== expectedPrompt || invocation.prompt_sha256 !== reviewSha256(expectedPrompt)) {
    throw new Error("INDEPENDENT_REVIEW_INVOCATION: prompt is not the fixed review prompt");
  }
  exactFields(invocation.output_schema, ["path", "sha256"], "INDEPENDENT_REVIEW_OUTPUT_SCHEMA");
  const outputSchemaPath = containedPath(repoRoot, invocation.output_schema.path, "INDEPENDENT_REVIEW_OUTPUT_SCHEMA");
  const outputSchemaBytes = await readRegularFile(outputSchemaPath, "INDEPENDENT_REVIEW_OUTPUT_SCHEMA");
  if (reviewSha256(outputSchemaBytes) !== invocation.output_schema.sha256) {
    throw new Error("INDEPENDENT_REVIEW_OUTPUT_SCHEMA: current schema hash diverged");
  }

  exactFields(invocation.codex, ["executable_path", "executable_sha256", "version", "command"], "INDEPENDENT_REVIEW_CODEX");
  if (!isAbsolute(invocation.codex.executable_path) || invocation.codex.executable_path.includes("\0") ||
      !isSha256(invocation.codex.executable_sha256) || !isNonEmptyString(invocation.codex.version) ||
      !Array.isArray(invocation.codex.command)) {
    throw new Error("INDEPENDENT_REVIEW_CODEX: executable identity is incomplete");
  }
  const approvedCodexPaths = new Set((allowedCodexExecutablePaths ?? APPROVED_INDEPENDENT_REVIEW_CODEX_PATHS)
    .filter(isNonEmptyString).map((path) => resolve(path)));
  if (!approvedCodexPaths.has(resolve(invocation.codex.executable_path))) {
    throw new Error("INDEPENDENT_REVIEW_CODEX: executable path is not an approved Codex CLI identity");
  }
  const codexBytes = await readRegularFile(invocation.codex.executable_path, "INDEPENDENT_REVIEW_CODEX");
  if (reviewSha256(codexBytes) !== invocation.codex.executable_sha256) {
    throw new Error("INDEPENDENT_REVIEW_CODEX: executable hash is stale");
  }
  const actualCodexVersion = await readCodexVersion(invocation.codex.executable_path, repoRoot);
  if (actualCodexVersion !== invocation.codex.version) {
    throw new Error("INDEPENDENT_REVIEW_CODEX: --version output diverged from invocation identity");
  }
  const expectedCommand = buildIndependentReviewCodexCommand({
    codexPath: invocation.codex.executable_path,
    repoRoot,
    outputSchemaPath,
    finalVerdictPath: rawPaths.get("FINAL_VERDICT"),
  });
  if (stableReviewStringify(invocation.codex.command) !== stableReviewStringify(expectedCommand)) {
    throw new Error("INDEPENDENT_REVIEW_CODEX: command was not the fixed read-only invocation");
  }

  const events = parseJsonLines(raw.get("CODEX_EVENTS_JSONL"), "INDEPENDENT_REVIEW_CODEX_EVENTS");
  const reviewerExecutionId = deriveReviewerExecution(events, invocation.reviewer_process_id);
  if (reviewerExecutionId === invocation.implementation_execution_id ||
      reviewerExecutionId !== summary.reviewer_execution_id ||
      reviewerExecutionId !== closure.reviewer_execution_id) {
    throw new Error("INDEPENDENT_REVIEW_IDENTITY: implementer/controller and reviewer executions are not independently bound");
  }
  const inspectionEvents = expectedInspectionCommands.map((expectedInspectionCommand, chunkIndex) => {
    const matches = events.filter((event) => {
      const item = event?.item;
      return item?.type === "command_execution" && item?.status === "completed" && item?.exit_code === 0 &&
        isNonEmptyString(item.command) &&
        independentReviewCommandMatchesExpected(item.command, expectedInspectionCommand);
    });
    if (matches.length !== 1) {
      throw new Error(`INDEPENDENT_REVIEW_RAW_EVENTS: exactly one fixed input inspection command is required for chunk ${chunkIndex}`);
    }
    return matches[0];
  });
  const inspectionIndices = inspectionEvents.map((event) => events.indexOf(event));
  if (inspectionIndices.some((index, position) => position > 0 && index <= inspectionIndices[position - 1])) {
    throw new Error("INDEPENDENT_REVIEW_RAW_EVENTS: content chunk inspection commands are out of order");
  }
  const actualInspectionChunkReceipts = inspectionEvents.map((event, chunkIndex) => {
    try {
      return JSON.parse(event.item.aggregated_output?.trim() ?? "");
    } catch {
      throw new Error(`INDEPENDENT_REVIEW_RAW_EVENTS: inspection chunk ${chunkIndex} did not return structured receipt JSON`);
    }
  });
  validateContentAddressedInspectionChunkReceipts(
    actualInspectionChunkReceipts,
    expectedInspectionReceipt,
    currentReviewInputs,
  );
  const finalVerdict = parseJson(raw.get("FINAL_VERDICT"), "INDEPENDENT_REVIEW_FINAL_VERDICT");
  const finalAgentMessages = events.filter((event) => event?.item?.type === "agent_message");
  if (finalAgentMessages.length === 0 ||
      stableReviewStringify(parseJson(Buffer.from(finalAgentMessages.at(-1)?.item?.text ?? ""),
        "INDEPENDENT_REVIEW_FINAL_AGENT_MESSAGE")) !== stableReviewStringify(finalVerdict) ||
      events.indexOf(finalAgentMessages.at(-1)) >= events.findLastIndex((event) => event?.type === "turn.completed")) {
    throw new Error("INDEPENDENT_REVIEW_RAW_EVENTS: final structured verdict is missing or out of order");
  }
  const records = validateFinalVerdict(finalVerdict, {
    implementationExecutionId: invocation.implementation_execution_id,
    sourceFingerprint: expectedSourceFingerprint,
    reviewSubjectSha256: subjectDigest,
    reviewInputsSha256: currentReviewInputs.sha256,
    requestedRequirements,
    document,
    reviewInputs: currentReviewInputs,
    inspectionNonce: invocation.inspection_nonce,
  });
  const completedCommandEvents = events.filter((event) =>
    event?.item?.type === "command_execution" && event.item?.status === "completed" &&
    event.item?.exit_code === 0 && isNonEmptyString(event.item?.command));
  if (completedCommandEvents.length !== reviewedIds.length + inspectionEvents.length) {
    throw new Error("INDEPENDENT_REVIEW_RAW_EVENTS: only the complete chunk inspection plan and one fresh probe per requirement are allowed");
  }
  const inspectionEventIndex = events.indexOf(inspectionEvents.at(-1));
  const finalMessageIndex = events.indexOf(finalAgentMessages.at(-1));
  const probeNonces = new Set();
  for (const requirementId of reviewedIds) {
    const probe = records.get(requirementId)?.falsification_probe;
    if (probeNonces.has(probe.probe_nonce) || invocation.prompt.includes(probe.probe_nonce)) {
      throw new Error(`INDEPENDENT_REVIEW_FALSIFICATION_PROBE_NOT_FRESH:${requirementId}`);
    }
    probeNonces.add(probe.probe_nonce);
    const expectedProbeCommand = buildIndependentReviewFalsificationProbeCommand({
      traceabilityPath: expectedTraceabilityPath,
      inspectionNonce: invocation.inspection_nonce,
      requirementId,
      probe,
    });
    const matchingProbeEvents = completedCommandEvents.filter((event) =>
      independentReviewCommandMatchesExpected(event.item.command, expectedProbeCommand));
    if (matchingProbeEvents.length !== 1) {
      throw new Error(`INDEPENDENT_REVIEW_RAW_EVENTS: exactly one fixed fresh falsification probe is required for ${requirementId}`);
    }
    const eventIndex = events.indexOf(matchingProbeEvents[0]);
    if (eventIndex <= inspectionEventIndex || eventIndex >= finalMessageIndex) {
      throw new Error(`INDEPENDENT_REVIEW_RAW_EVENTS: falsification probe ordering is invalid for ${requirementId}`);
    }
    const expectedProbeReceipt = await createIndependentReviewFalsificationProbeReceipt({
      document,
      requirementId,
      repoRoot,
      documentPath,
      sourceFingerprint: expectedSourceFingerprint,
      inspectionNonce: invocation.inspection_nonce,
      probe,
      sourceSnapshotContext,
    });
    let actualProbeReceipt;
    try {
      actualProbeReceipt = JSON.parse(matchingProbeEvents[0].item.aggregated_output?.trim() ?? "");
    } catch {
      throw new Error(`INDEPENDENT_REVIEW_RAW_EVENTS: falsification probe did not return structured receipt JSON for ${requirementId}`);
    }
    if (stableReviewStringify(actualProbeReceipt) !== stableReviewStringify(expectedProbeReceipt)) {
      throw new Error(`INDEPENDENT_REVIEW_RAW_EVENTS: falsification probe receipt diverged from current bytes or nonce for ${requirementId}`);
    }
    if (records.get(requirementId)?.decision === "CLOSED" && expectedProbeReceipt.expectation_met !== true) {
      throw new Error(`INDEPENDENT_REVIEW_FALSIFICATION_PROBE_FAILED:${requirementId}`);
    }
  }
  if (completedCommandEvents.some((event) =>
    !expectedInspectionCommands.some((command) =>
      independentReviewCommandMatchesExpected(event.item.command, command)) &&
    !reviewedIds.some((requirementId) => independentReviewCommandMatchesExpected(event.item.command,
      buildIndependentReviewFalsificationProbeCommand({
        traceabilityPath: expectedTraceabilityPath,
        inspectionNonce: invocation.inspection_nonce,
        requirementId,
        probe: records.get(requirementId).falsification_probe,
      }))))) {
    throw new Error("INDEPENDENT_REVIEW_RAW_EVENTS: unexpected or command-offset reviewer command is forbidden");
  }
  const record = records.get(requirement.requirement_id);
  if (record?.decision !== "CLOSED" || summary.decision !== finalVerdict.overall_decision ||
      closure.decision !== "CLOSED" || closure.reviewer_role !== record.reviewer_role ||
      closure.reviewed_at !== summary.captured_at) {
    throw new Error("INDEPENDENT_REVIEW_CLOSURE: raw reviewer verdict did not independently close this requirement");
  }
  const testExecutionReceipts = await runIndependentReviewTestPlan({
    document,
    requirementIds: reviewedIds,
    repoRoot,
    documentPath,
    executor: reviewTestExecutor,
    sourceFingerprint: expectedSourceFingerprint,
    reviewSubjectSha256: subjectDigest,
    reviewInputsSha256: currentReviewInputs.sha256,
    sourceSnapshotContext,
    approvedReviewRuntimeSha256,
  });
  if (Array.isArray(reviewExecutionReceipts)) {
    reviewExecutionReceipts.push(...testExecutionReceipts);
  }
  return {
    reviewerExecutionId,
    finalVerdict,
    record,
    testExecutionReceipts,
    reviewInputs: currentReviewInputs,
  };
}
