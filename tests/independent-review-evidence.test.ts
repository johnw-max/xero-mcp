import {
  chmod, cp, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink,
  writeFile,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildIndependentReviewCodexCommand,
  buildIndependentReviewObligationProbeCommand,
  buildIndependentReviewFalsificationProbeCommand,
  buildIndependentReviewInspectionCommands,
  buildIndependentReviewPrompt,
  assertIndependentReviewSourceSnapshotUnchanged,
  createIndependentReviewFalsificationProbeReceipt,
  createIndependentReviewObligationProbeReceipt,
  createIndependentReviewInputReceipt,
  createIndependentReviewInputChunkReceipt,
  createIndependentReviewTestPlan,
  captureIndependentReviewDocumentSourceSnapshotContext,
  captureIndependentReviewSourceSnapshotContext,
  deriveIndependentReviewDependencyGraph,
  deriveIndependentReviewUniverse,
  deriveIndependentReviewDependencyMappings,
  deriveObservedIndependentReviewRuntimeIdentity,
  expectedStructuredReviewChecks,
  fingerprintIndependentReviewInputs,
  independentReviewSubjectSha256,
  INDEPENDENT_REVIEW_HOST_CONTEXT_FILES,
  loadIndependentReviewLiveSourceSnapshotContext,
  resolveIndependentReviewLocalModulePath,
  reviewSha256,
  registerIndependentReviewSnapshotDescriptorReadTestHook,
  registerIndependentReviewSyntheticSupplementFixture,
  stableReviewStringify,
  verifyIndependentReviewTestExecutionResult,
} from "../scripts/review/independent-review-evidence-lib.mjs";
import {
  buildIndependentReviewShardInspectionCommands,
  createIndependentReviewShardChunkReceipt,
  createIndependentReviewShardReceipt,
  deriveIndependentReviewPlan,
  deriveIndependentReviewDocumentPlan,
} from "../scripts/review/independent-review-plan-lib.mjs";
import {
  assertIndependentReviewLivePlanBinding,
  buildIndependentReviewShardPrompt,
  normalizeIndependentReviewLiveContext,
  verifyIndependentReviewAggregateClosure,
  verifyIndependentReviewShardArtifact,
} from "../scripts/review/independent-review-shard-evidence-lib.mjs";
import {
  validateTraceabilityDocument,
  validateTraceabilityReferences,
} from "../scripts/review/traceability-validator-lib.mjs";
import { ACCEPTANCE_SOURCE_ROOTS } from "../scripts/release/local-acceptance-gate-lib.mjs";

const SOURCE_FINGERPRINT = "a".repeat(64);
const CAPTURED_AT = "2026-08-13T13:00:00.000Z";
const IMPLEMENTATION_EXECUTION_ID = "controller-process:100:run:11111111-1111-4111-8111-111111111111";
const REVIEWER_EXECUTION_ID = "codex-thread:review-thread-fixture:pid:101";

async function syntheticSourceSnapshotContext(document: Record<string, any>, root: string, documentPath: string) {
  return captureIndependentReviewDocumentSourceSnapshotContext({
    document,
    repoRoot: root,
    documentPath,
    allowSyntheticSupplementalPathsForTests: true,
  });
}

async function writeLiveHostContextFixture(
  fixture: Awaited<ReturnType<typeof writeIndependentReviewFixture>>,
) {
  const boundary = await mkdtemp(join(tmpdir(), "independent-review-live-host-"));
  const snapshotRoot = join(boundary, INDEPENDENT_REVIEW_HOST_CONTEXT_FILES.snapshot_directory);
  await cp(fixture.root, snapshotRoot, { recursive: true });
  const source = await captureIndependentReviewSourceSnapshotContext({ repoRoot: snapshotRoot });
  const documentRelativePath = relative(fixture.root, fixture.documentPath).replaceAll("\\", "/");
  const snapshotDocumentPath = join(snapshotRoot, documentRelativePath);
  const snapshotDocument = JSON.parse(await readFile(snapshotDocumentPath, "utf8"));
  registerIndependentReviewSyntheticSupplementFixture(snapshotDocument);
  const completeSnapshot = await captureIndependentReviewDocumentSourceSnapshotContext({
    document: snapshotDocument,
    repoRoot: snapshotRoot,
    documentPath: snapshotDocumentPath,
    allowSyntheticSupplementalPathsForTests: true,
  });
  const supplementalEntries = completeSnapshot.supplemental_entries;
  const supplementalIdentity = {
    schema_version: "1.0",
    algorithm: "exact-round-artifact-supplement-v1",
    paths: supplementalEntries.map((entry: any) => entry.path),
    path_count: supplementalEntries.length,
    total_bytes: supplementalEntries.reduce((sum: number, entry: any) => sum + entry.size_bytes, 0),
    entries: supplementalEntries,
  };
  const gateRunId = "11111111-1111-4111-8111-111111111111";
  const liveChallenge = "1".repeat(64);
  const sourceManifest = {
    schema_version: "1.0",
    kind: "INDEPENDENT_REVIEW_SOURCE_SNAPSHOT_MANIFEST",
    algorithm: "full-acceptance-source-content-snapshot-v1",
    roots: source.roots,
    path_count: source.source_entries.length,
    total_bytes: source.source_entries.reduce((sum: number, entry: any) => sum + entry.size_bytes, 0),
    entries: source.source_entries,
    source_fingerprint_sha256: SOURCE_FINGERPRINT,
    source_snapshot_sha256: source.source_snapshot_sha256,
  };
  const supplementalManifest = {
    schema_version: "1.0",
    kind: "INDEPENDENT_REVIEW_SUPPLEMENTAL_INPUTS_MANIFEST",
    authority: "APPROVED_REVIEW_HOST",
    gate_run_id: gateRunId,
    live_challenge: liveChallenge,
    snapshot_root: INDEPENDENT_REVIEW_HOST_CONTEXT_FILES.snapshot_directory,
    ...supplementalIdentity,
    supplemental_inputs_sha256: reviewSha256(stableReviewStringify(supplementalIdentity)),
  };
  const sourceManifestBytes = Buffer.from(`${JSON.stringify(sourceManifest, null, 2)}\n`);
  const supplementalManifestBytes = Buffer.from(`${JSON.stringify(supplementalManifest, null, 2)}\n`);
  const sourceAttestation = {
    schema_version: "1.0",
    authority: "APPROVED_REVIEW_HOST",
    gate_run_id: gateRunId,
    live_challenge: liveChallenge,
    snapshot_root: INDEPENDENT_REVIEW_HOST_CONTEXT_FILES.snapshot_directory,
    source_snapshot_sha256: source.source_snapshot_sha256,
    source_snapshot_manifest_sha256: reviewSha256(sourceManifestBytes),
    supplemental_inputs_sha256: supplementalManifest.supplemental_inputs_sha256,
    supplemental_manifest_sha256: reviewSha256(supplementalManifestBytes),
  };
  const sourceAttestationBytes = Buffer.from(`${JSON.stringify(sourceAttestation, null, 2)}\n`);
  const liveContext = {
    schema_version: "1.0",
    mode: "LOCAL_ACCEPTANCE_GATE_LIVE",
    gate_run_id: gateRunId,
    live_challenge: liveChallenge,
    source_fingerprint_sha256: SOURCE_FINGERPRINT,
    source_snapshot_sha256: source.source_snapshot_sha256,
    source_snapshot_manifest_sha256: reviewSha256(sourceManifestBytes),
    source_snapshot_attestation_sha256: reviewSha256(sourceAttestationBytes),
    supplemental_inputs_sha256: supplementalManifest.supplemental_inputs_sha256,
    supplemental_manifest_sha256: reviewSha256(supplementalManifestBytes),
    approved_review_codex_sha256: "5".repeat(64),
    approved_review_runtime_sha256: "6".repeat(64),
  };
  const liveContextPath = join(boundary, INDEPENDENT_REVIEW_HOST_CONTEXT_FILES.live_context);
  const outputRoot = join(boundary, INDEPENDENT_REVIEW_HOST_CONTEXT_FILES.output_directory);
  await Promise.all([
    mkdir(outputRoot, { mode: 0o700 }),
    writeFile(join(boundary, INDEPENDENT_REVIEW_HOST_CONTEXT_FILES.source_manifest), sourceManifestBytes),
    writeFile(join(boundary, INDEPENDENT_REVIEW_HOST_CONTEXT_FILES.source_attestation), sourceAttestationBytes),
    writeFile(join(boundary, INDEPENDENT_REVIEW_HOST_CONTEXT_FILES.supplemental_manifest),
      supplementalManifestBytes),
    writeFile(liveContextPath, `${JSON.stringify(liveContext, null, 2)}\n`),
  ]);
  await Promise.all([
    chmod(liveContextPath, 0o444),
    chmod(join(boundary, INDEPENDENT_REVIEW_HOST_CONTEXT_FILES.source_manifest), 0o444),
    chmod(join(boundary, INDEPENDENT_REVIEW_HOST_CONTEXT_FILES.source_attestation), 0o444),
    chmod(join(boundary, INDEPENDENT_REVIEW_HOST_CONTEXT_FILES.supplemental_manifest), 0o444),
  ]);
  return {
    boundary,
    liveContext,
    liveContextPath,
    documentRelativePath,
  };
}

async function hardlinkFrozenRuntimeFixture(source: string, target: string) {
  const walk = async (sourceDirectory: string, targetDirectory: string) => {
    await mkdir(targetDirectory, { recursive: true });
    const entries = await readdir(sourceDirectory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (let index = 0; index < entries.length; index += 64) {
      await Promise.all(entries.slice(index, index + 64).map(async (entry) => {
        if (entry.name === ".bin") return;
        const sourcePath = join(sourceDirectory, entry.name);
        const targetPath = join(targetDirectory, entry.name);
        const identity = await lstat(sourcePath);
        if (identity.isDirectory()) return walk(sourcePath, targetPath);
        if (identity.isFile()) return link(sourcePath, targetPath);
        throw new Error(`INDEPENDENT_REVIEW_TEST_RUNTIME_UNSUPPORTED:${sourcePath}`);
      }));
    }
  };
  await walk(source, target);
}

async function replaceFixtureRuntimeFile(path: string, content: string) {
  const replacement = `${path}.replacement-${process.pid}-${Date.now()}`;
  await writeFile(replacement, content, { flag: "wx" });
  await rename(replacement, path);
}

async function syntheticPlan(options: {
  document: Record<string, any>;
  requirementId: string;
  repoRoot: string;
  documentPath: string;
  testOnlyMaxShardCount?: number;
}) {
  return deriveIndependentReviewPlan({
    ...options,
    sourceSnapshotContext: await syntheticSourceSnapshotContext(
      options.document,
      options.repoRoot,
      options.documentPath,
    ),
  });
}

async function installFrozenTypescriptFixture(root: string) {
  await mkdir(join(root, "node_modules/typescript/lib"), { recursive: true });
  await Promise.all([
    cp(join(process.cwd(), "node_modules/typescript/package.json"),
      join(root, "node_modules/typescript/package.json"), { mode: fsConstants.COPYFILE_FICLONE }),
    cp(join(process.cwd(), "node_modules/typescript/lib/typescript.js"),
      join(root, "node_modules/typescript/lib/typescript.js"), { mode: fsConstants.COPYFILE_FICLONE }),
    writeFile(join(root, "package.json"), `${JSON.stringify({
      name: "independent-review-plan-fixture",
      private: true,
      devDependencies: { typescript: "5.9.2" },
    })}\n`),
  ]);
}

// installFrozenTypescriptFixture writes package.json but no lockfile, and
// deriveObservedIndependentReviewRuntimeIdentity requires both. Supply only the
// missing lockfile, mirroring the package.json already there - rewriting the
// manifest would change the fixture's declared dependency set and quietly move
// the control being tested.
async function installFrozenRuntimeLockfile(root: string) {
  // No stub node_modules/vitest here: probes that actually run an in-memory Vitest
  // mutation resolve vitest from this root, and a stub shadows the real package.
  // The lockfile closure check reads the lockfile, not the directory.
  await Promise.all([
    writeFile(join(root, "package.json"), `${JSON.stringify({
      name: "independent-review-plan-fixture",
      private: true,
      devDependencies: { typescript: "5.9.2", vitest: "1.0.0" },
    })}\n`),
    writeFile(join(root, "package-lock.json"), `${JSON.stringify({
      name: "independent-review-plan-fixture",
      lockfileVersion: 3,
      packages: {
        "": {
          name: "independent-review-plan-fixture",
          devDependencies: { typescript: "5.9.2", vitest: "1.0.0" },
        },
        "node_modules/typescript": { version: "5.9.2" },
        "node_modules/vitest": { version: "1.0.0" },
      },
    })}\n`),
  ]);
}

function requirement() {
  const control = "Closure is replayed from a separate read-only Codex process.";
  return {
    requirement_id: "K-999",
    business_risk: "A release can be closed by an unverified reviewer string.",
    design_control: control,
    control_claims: [{
      claim_id: "K-999-C01",
      source_clause_id: "K-999-C01",
      control,
      evidence: ["evidence.json"],
      implementation_files: ["src/example.ts"],
      positive_tests: ["tests/example-positive.test.ts"],
      negative_or_mutation_tests: ["tests/example-negative.test.ts"],
      probe_obligations: [{
        obligation_id: "K-999-C01-P01",
        invariant: control,
        target_path: "src/example.ts",
        target_anchor: "enforcementMarker",
        mutation_operator: "REPLACE_ENUM_LITERAL",
        literal: "strict-review-control",
        replacement: "disabled-review-control",
        test_files: ["tests/example-positive.test.ts", "tests/example-negative.test.ts"],
        mutation_test_path: "tests/example-positive.test.ts",
        expected_failing_test_names: ["positive control"],
        expected_failure_message_patterns: ["strict-review-control"],
      }],
    }],
    implementation_files: ["src/example.ts"],
    positive_tests: ["tests/example-positive.test.ts"],
    negative_or_mutation_tests: ["tests/example-negative.test.ts"],
    implementation_owner: "/root",
    reviewer: "Independent Acceptance Reviewer",
    status: "CLOSED",
    evidence: ["evidence.json"],
    residual_risk: "Local raw evidence is not a cryptographic remote signer.",
  } as Record<string, any>;
}

function document() {
  return {
    schema_version: "4.0",
    round_id: "round-test",
    generated_at: "2026-08-13T12:00:00.000Z",
    evidence_boundary: "Synthetic independent-review replay fixture.",
    control_catalog: {
      path: "schemas/ledger-control-clauses.v1.json",
      schema_version: "1.0",
      sha256: "e".repeat(64),
    },
    requirements: [requirement()],
  } as Record<string, any>;
}

async function writePlanFixture({
  files,
  implementationFiles,
  positiveTests,
  negativeTests,
  obligations,
}: {
  files: Record<string, string>;
  implementationFiles: string[];
  positiveTests: string[];
  negativeTests: string[];
  obligations: Array<Record<string, unknown>>;
}) {
  const root = await mkdtemp(join(tmpdir(), "independent-review-plan-fixture-"));
  const round = join(root, "artifacts/round");
  await mkdir(round, { recursive: true });
  await installFrozenTypescriptFixture(root);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  await Promise.all([
    mkdir(join(root, "schemas"), { recursive: true }),
    writeFile(join(round, "evidence.json"), "{}\n"),
  ]);
  const control = "Every assigned dependency boundary is reviewed with its atomic enforcement core.";
  const claim = {
    claim_id: "K-999-C01",
    source_clause_id: "K-999-C01",
    control,
    evidence: ["evidence.json"],
    implementation_files: implementationFiles,
    positive_tests: positiveTests,
    negative_or_mutation_tests: negativeTests,
    probe_obligations: obligations,
  };
  const traceability = {
    schema_version: "4.0",
    round_id: "round-plan-fixture",
    generated_at: "2026-08-14T00:00:00.000Z",
    evidence_boundary: "Synthetic reviewer plan fixture.",
    control_catalog: {
      path: "schemas/ledger-control-clauses.v1.json",
      schema_version: "1.0",
      sha256: "0".repeat(64),
    },
    requirements: [{
      requirement_id: "K-999",
      business_risk: "A dependency boundary can be omitted from atomic review.",
      design_control: control,
      control_claims: [claim],
      implementation_files: implementationFiles,
      positive_tests: positiveTests,
      negative_or_mutation_tests: negativeTests,
      implementation_owner: "/root",
      reviewer: "Independent reviewer",
      status: "FIXED_PENDING_REVIEW",
      evidence: ["evidence.json"],
      residual_risk: "None within the fixture.",
    }],
  } as Record<string, any>;
  const catalog = {
    schema_version: "1.0",
    catalog_id: "plan-fixture",
    source_documents: await Promise.all(implementationFiles.map(async (path) => ({
      path,
      sha256: reviewSha256(await readFile(join(root, path))),
    }))),
    requirements: [{
      requirement_id: "K-999",
      business_risk: traceability.requirements[0].business_risk,
      clauses: [{ clause_id: "K-999-C01", control }],
    }],
  };
  const catalogBytes = Buffer.from(`${JSON.stringify(catalog, null, 2)}\n`);
  await writeFile(join(root, "schemas/ledger-control-clauses.v1.json"), catalogBytes);
  traceability.control_catalog.sha256 = reviewSha256(catalogBytes);
  const documentPath = join(round, "requirements.json");
  await writeFile(documentPath, `${JSON.stringify(traceability, null, 2)}\n`);
  registerIndependentReviewSyntheticSupplementFixture(traceability);
  return { root, round, traceability, documentPath };
}

async function writeHostProtectionPlanFixture() {
  return writePlanFixture({
    files: {
      "src/control.ts": 'export const protectedControl = "strict";\n',
      "tests/control.test.ts":
        'import { protectedControl } from "../src/control.js"; test("strict", () => expect(protectedControl).toBe("strict"));\n',
      "tests/control-negative.test.ts":
        'import { protectedControl } from "../src/control.js"; test("not disabled", () => expect(protectedControl).not.toBe("disabled"));\n',
    },
    implementationFiles: ["src/control.ts"],
    positiveTests: ["tests/control.test.ts"],
    negativeTests: ["tests/control-negative.test.ts"],
    obligations: [{
      obligation_id: "K-999-C01-P01",
      invariant: "The protected host input remains strict.",
      target_path: "src/control.ts",
      target_anchor: "protectedControl",
      mutation_operator: "REPLACE_ENUM_LITERAL",
      literal: "strict",
      replacement: "disabled",
      test_files: ["tests/control.test.ts", "tests/control-negative.test.ts"],
      mutation_test_path: "tests/control.test.ts",
      expected_failing_test_names: ["strict"],
      expected_failure_message_patterns: ["strict"],
    }],
  });
}

// deriveObservedIndependentReviewRuntimeIdentity needs package.json AND
// package-lock.json present in the snapshot, and throws
// RUNTIME_PACKAGE_IDENTITY_MISSING before any later check runs. A fixture without
// them fails on the wrong control, so a test aiming at the toolchain check never
// reaches it.
async function installRuntimeIdentityFixture(root: string) {
  await Promise.all([
    mkdir(join(root, "node_modules/vitest"), { recursive: true }),
    mkdir(join(root, "node_modules/zod"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(root, "node_modules/vitest/package.json"),
      `${JSON.stringify({ name: "vitest", version: "1.0.0" })}\n`),
    writeFile(join(root, "node_modules/vitest/vitest.mjs"),
      "export const fixtureVitest = true;\n"),
    writeFile(join(root, "node_modules/zod/package.json"),
      `${JSON.stringify({ name: "zod", version: "1.0.0" })}\n`),
    writeFile(join(root, "node_modules/zod/index.js"),
      "export const fixtureZod = true;\n"),
    writeFile(join(root, "package.json"), `${JSON.stringify({
      name: "independent-review-runtime-fixture",
      private: true,
      dependencies: { zod: "1.0.0" },
      devDependencies: { typescript: "1.0.0", vitest: "1.0.0" },
    })}\n`),
    writeFile(join(root, "package-lock.json"), `${JSON.stringify({
      name: "independent-review-runtime-fixture",
      lockfileVersion: 3,
      packages: {
        "": {
          name: "independent-review-runtime-fixture",
          dependencies: { zod: "1.0.0" },
          devDependencies: { typescript: "1.0.0", vitest: "1.0.0" },
        },
        "node_modules/typescript": { version: "1.0.0" },
        "node_modules/vitest": { version: "1.0.0" },
        "node_modules/zod": { version: "1.0.0" },
      },
    })}\n`),
  ]);
}

async function writeRuntimeIdentityPlanFixture() {
  const fixture = await writeHostProtectionPlanFixture();
  await installRuntimeIdentityFixture(fixture.root);
  const sourceSnapshotContext = await syntheticSourceSnapshotContext(
    fixture.traceability,
    fixture.root,
    fixture.documentPath,
  );
  return { ...fixture, sourceSnapshotContext };
}

async function writeCurrentK013K015PlanningProjection() {
  const sourceRoot = process.cwd();
  const roundPath = join(sourceRoot, "artifacts/ledger-kernel-review/round-2026-08-13-local");
  const current = JSON.parse(await readFile(join(roundPath, "requirements-traceability.json"), "utf8"));
  const catalogBytes = await readFile(join(sourceRoot, "schemas/ledger-control-clauses.v1.json"));
  const catalog = JSON.parse(catalogBytes.toString("utf8"));
  const root = await mkdtemp(join(tmpdir(), "current-k013-k015-review-plan-"));
  for (const source of ACCEPTANCE_SOURCE_ROOTS) {
    try {
      await stat(join(sourceRoot, source));
    } catch (error: any) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    await cp(join(sourceRoot, source), join(root, source), { recursive: true });
  }
  await installFrozenTypescriptFixture(root);
  const requirements = [];
  for (const requirementId of ["K-013", "K-015"]) {
    const requirement = current.requirements.find((item: any) => item.requirement_id === requirementId);
    const catalogRequirement = catalog.requirements.find((item: any) =>
      item.requirement_id === requirementId);
    const claims = [];
    for (const [index, clause] of catalogRequirement.clauses.entries()) {
      const implementation = requirementId === "K-013"
        ? "scripts/release/local-acceptance-gate-lib.mjs"
        : "scripts/review/independent-review-evidence-lib.mjs";
      const selectedTest = requirementId === "K-013"
        ? "tests/local-acceptance-mechanism.test.ts"
        : "tests/independent-review-evidence.test.ts";
      const negative = selectedTest;
      const evidence = requirement.evidence[index % requirement.evidence.length];
      const implementationText = await readFile(join(sourceRoot, implementation), "utf8");
      const declaration = /\b(?:export\s+)?(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)[^\n]*/u
        .exec(implementationText);
      const anchor = declaration?.[1] ?? implementationText.trim().slice(0, 12);
      const literal = declaration?.[0] ?? implementationText.trim().split("\n", 1)[0];
      const testText = await readFile(join(sourceRoot, selectedTest), "utf8");
      const testName = /\b(?:it|test)\(\s*["'`]([^"'`]+)/u.exec(testText)?.[1] ?? "test";
      claims.push({
        claim_id: clause.clause_id,
        source_clause_id: clause.clause_id,
        control: clause.control,
        evidence: [evidence],
        implementation_files: [implementation],
        positive_tests: [selectedTest],
        negative_or_mutation_tests: [negative],
        probe_obligations: [{
          obligation_id: `${clause.clause_id}-P01`,
          invariant: clause.control,
          target_path: implementation,
          target_anchor: anchor,
          mutation_operator: "REPLACE_EXACT_LITERAL",
          literal,
          replacement: `${literal} /* disabled-planning-projection-${clause.clause_id} */`,
          test_files: [selectedTest, negative],
          mutation_test_path: selectedTest,
          expected_failing_test_names: [testName],
          expected_failure_message_patterns: [testName],
        }],
      });
    }
    requirements.push({ ...requirement, status: "FIXED_PENDING_REVIEW", control_claims: claims });
  }
  const traceability = {
    schema_version: "4.0",
    round_id: "current-real-k013-k015-planning-diagnostic",
    generated_at: "2026-08-14T00:00:00.000Z",
    evidence_boundary: "Planner-capacity-only current-byte projection with representative real imports; " +
      "never semantic claim mapping or closure evidence.",
    control_catalog: {
      path: "schemas/ledger-control-clauses.v1.json",
      schema_version: catalog.schema_version,
      sha256: reviewSha256(catalogBytes),
    },
    requirements,
  } as Record<string, any>;
  const projectedRound = join(root, "artifacts/ledger-kernel-review/current-k013-k015-plan");
  await mkdir(projectedRound, { recursive: true });
  for (const evidence of ["attestation.json", "test-results.json"]) {
    await cp(join(roundPath, evidence), join(projectedRound, evidence));
  }
  const documentPath = join(projectedRound, "requirements-traceability.json");
  await writeFile(documentPath, `${JSON.stringify(traceability, null, 2)}\n`);
  return { root, traceability, documentPath };
}

async function writeIndependentReviewFixture() {
  const root = await mkdtemp(join(tmpdir(), "independent-review-"));
  const round = join(root, "artifacts/round");
  const raw = join(round, "independent-review.raw");
  const generatorPath = join(root, "scripts/review/run-independent-review.mjs");
  const shardGeneratorPath = join(root, "scripts/review/run-independent-review-shard.mjs");
  const outputSchemaPath = join(root, "schemas/independent-review-verdict.schema.json");
  const shardOutputSchemaPath = join(root, "schemas/independent-review-shard-verdict.schema.json");
  const codexPath = join(root, "fake-codex");
  const documentPath = join(round, "requirements.json");
  const catalog = {
    schema_version: "1.0",
    catalog_id: "fixture-control-catalog",
    source_documents: [{ path: "src/example.ts", sha256: createHash("sha256")
      .update('export const enforcementMarker = "strict-review-control";\n').digest("hex") }],
    requirements: [{
      requirement_id: "K-999",
      business_risk: "A release can be closed by an unverified reviewer string.",
      clauses: [{
        clause_id: "K-999-C01",
        control: "Closure is replayed from a separate read-only Codex process.",
      }],
    }],
  };
  const catalogBytes = Buffer.from(`${JSON.stringify(catalog, null, 2)}\n`);
  await Promise.all([
    mkdir(join(root, "src"), { recursive: true }),
    mkdir(join(root, "tests"), { recursive: true }),
    mkdir(join(root, "scripts/review"), { recursive: true }),
    mkdir(join(root, "schemas"), { recursive: true }),
    mkdir(raw, { recursive: true }),
  ]);
  await hardlinkFrozenRuntimeFixture(join(process.cwd(), "node_modules"), join(root, "node_modules"));
  await Promise.all([
    writeFile(join(root, "src/example.ts"), "export const enforcementMarker = \"strict-review-control\";\n"),
    writeFile(
      join(root, "src/unreferenced-critical.ts"),
      `export const uncitedCriticalControl = \"covered-bottom-up\";\n/* ${"x".repeat(64 * 1024)} */\n`,
    ),
    writeFile(
      join(root, "tests/example-positive.test.ts"),
      'import { enforcementMarker } from "../src/example.js";\ntest("positive control", () => expect(enforcementMarker).toBe("strict-review-control"));\n',
    ),
    writeFile(
      join(root, "tests/example-negative.test.ts"),
      '// If strict-review-control becomes disabled-review-control exactly as this existing negative test says, the probe is not fresh.\n' +
        'import { enforcementMarker } from "../src/example.js";\ntest("negative control", () => expect(enforcementMarker).not.toBe("disabled-review-control"));\n',
    ),
    writeFile(join(round, "evidence.json"), "{}\n"),
    writeFile(generatorPath, "// fixture generator\n"),
    writeFile(shardGeneratorPath, "// fixture shard generator\n"),
    writeFile(outputSchemaPath, "{}\n"),
    writeFile(shardOutputSchemaPath, "{}\n"),
    writeFile(join(root, "schemas/ledger-control-clauses.v1.json"), catalogBytes),
    writeFile(join(root, "package.json"), `${JSON.stringify({
      name: "independent-review-fixture",
      private: true,
      dependencies: { zod: "1.0.0" },
      devDependencies: { typescript: "1.0.0", vitest: "1.0.0" },
    })}\n`),
    writeFile(join(root, "package-lock.json"), `${JSON.stringify({
      name: "independent-review-fixture",
      lockfileVersion: 3,
      packages: {
        "": {
          name: "independent-review-fixture",
          dependencies: { zod: "1.0.0" },
          devDependencies: { typescript: "1.0.0", vitest: "1.0.0" },
        },
        "node_modules/typescript": { version: "1.0.0" },
        "node_modules/vitest": { version: "1.0.0" },
        "node_modules/zod": { version: "1.0.0" },
      },
    })}\n`),
    writeFile(codexPath, "#!/bin/sh\nprintf 'codex fixture 1.0\\n'\n"),
  ]);
  await chmod(codexPath, 0o755);
  const codexCanonicalPath = await realpath(codexPath);

  const traceability = document();
  registerIndependentReviewSyntheticSupplementFixture(traceability);
  traceability.control_catalog.sha256 = createHash("sha256").update(catalogBytes).digest("hex");
  await writeFile(documentPath, `${JSON.stringify(traceability, null, 2)}\n`);
  const sourceSnapshotContext = await syntheticSourceSnapshotContext(traceability, root, documentPath);
  const reviewedIds = ["K-999"];
  const subjectSha256 = independentReviewSubjectSha256(traceability, reviewedIds);
  const reviewInputs = await fingerprintIndependentReviewInputs({
    document: traceability,
    requirementIds: reviewedIds,
    repoRoot: root,
    documentPath,
    sourceSnapshotContext,
  });
  const requestedRequirements = [{
    requirement_id: "K-999",
    implementation_owner: "/root",
    reviewer_role: "Independent Acceptance Reviewer",
  }];
  const traceabilityPath = relative(root, documentPath);
  const inspectionNonce = "1".repeat(32);
  const inspectionReceipt = await createIndependentReviewInputReceipt({
    document: traceability,
    requirementIds: reviewedIds,
    repoRoot: root,
    documentPath,
    sourceFingerprint: SOURCE_FINGERPRINT,
    nonce: inspectionNonce,
    sourceSnapshotContext,
  });
  const inspectionCommands = buildIndependentReviewInspectionCommands({
    traceabilityPath,
    nonce: inspectionNonce,
    requirementIds: reviewedIds,
    chunkCount: inspectionReceipt.content_chunk_count,
  });
  const prompt = buildIndependentReviewPrompt({
    implementationExecutionId: IMPLEMENTATION_EXECUTION_ID,
    sourceFingerprint: SOURCE_FINGERPRINT,
    reviewSubjectSha256: subjectSha256,
    reviewInputsSha256: reviewInputs.sha256,
    inspectionCommands,
    traceabilityPath,
    requestedRequirements,
  });
  const structuredChecks = expectedStructuredReviewChecks({
    document: traceability,
    requirementId: "K-999",
    reviewInputs,
  });
  const falsificationProbe = {
    probe_nonce: "2".repeat(32),
    counterexample: "If strict-review-control becomes disabled-review-control, the cited positive behavior must fail.",
    target_path: "src/example.ts",
    test_path: "tests/example-positive.test.ts",
    literal: "strict-review-control",
    replacement: "disabled-review-control",
  };
  const finalVerdict = {
    schema_version: "1.0",
    implementation_execution_id: IMPLEMENTATION_EXECUTION_ID,
    source_fingerprint: SOURCE_FINGERPRINT,
    review_subject_sha256: subjectSha256,
    review_inputs_sha256: reviewInputs.sha256,
    overall_decision: "CLOSED",
    requirements: [{
      requirement_id: "K-999",
      reviewer_role: "Independent Acceptance Reviewer",
      decision: "CLOSED",
      evidence_checked: structuredChecks.evidenceChecked,
      adversarial_checks: structuredChecks.adversarialChecks,
      falsification_probe: falsificationProbe,
      rationale: "Replacing strict-review-control with disabled-review-control makes the bound positive test fail.",
      residual_risk: "The evidence remains local rather than remotely signed.",
    }],
  };
  const falsificationProbeCommand = buildIndependentReviewFalsificationProbeCommand({
    traceabilityPath,
    inspectionNonce,
    requirementId: "K-999",
    probe: falsificationProbe,
  });
  const falsificationProbeReceipt = await createIndependentReviewFalsificationProbeReceipt({
    document: traceability,
    requirementId: "K-999",
    repoRoot: root,
    documentPath,
    sourceFingerprint: SOURCE_FINGERPRINT,
    inspectionNonce,
    probe: falsificationProbe,
    sourceSnapshotContext,
  });
  const events = [
    { type: "thread.started", thread_id: "review-thread-fixture" },
    { type: "turn.started" },
    ...inspectionCommands.map((command, chunkIndex) => ({
      type: "item.completed",
      item: {
        type: "command_execution",
        id: `cmd-inspection-${chunkIndex}`,
        command,
        aggregated_output: `${JSON.stringify(createIndependentReviewInputChunkReceipt(inspectionReceipt, chunkIndex))}\n`,
        status: "completed",
        exit_code: 0,
      },
    })),
    {
      type: "item.completed",
      item: {
        type: "command_execution",
        id: "cmd-probe",
        command: falsificationProbeCommand,
        aggregated_output: `${JSON.stringify(falsificationProbeReceipt)}\n`,
        status: "completed",
        exit_code: 0,
      },
    },
    { type: "item.completed", item: { type: "agent_message", id: "msg-1", text: JSON.stringify(finalVerdict) } },
    { type: "turn.completed", usage: { input_tokens: 1024, output_tokens: 256 } },
  ];
  const finalPath = join(raw, "final-verdict.json");
  const eventsPath = join(raw, "codex-events.jsonl");
  const stderrPath = join(raw, "codex-stderr.log");
  const invocationPath = join(raw, "invocation.json");
  const sourceIdentity = { algorithm: "fixture", file_count: 1, sha256: SOURCE_FINGERPRINT, roots: ["fixture"] };
  const invocation = {
    schema_version: "1.0",
    evidence_boundary: "LOCAL_READ_ONLY_CODEX_REVIEW",
    started_at: "2026-08-13T12:55:00.000Z",
    finished_at: "2026-08-13T12:59:00.000Z",
    exit_code: 0,
    controller_process_id: 100,
    reviewer_process_id: 101,
    implementation_execution_id: IMPLEMENTATION_EXECUTION_ID,
    traceability_path: traceabilityPath,
    requested_requirements: requestedRequirements,
    source_fingerprint_before: sourceIdentity,
    source_fingerprint_after: sourceIdentity,
    review_subject_sha256: subjectSha256,
    review_inputs_before: reviewInputs,
    review_inputs_after: reviewInputs,
    inspection_nonce: inspectionNonce,
    inspection_commands: inspectionCommands,
    prompt,
    prompt_sha256: reviewSha256(prompt),
    output_schema: {
      path: relative(root, outputSchemaPath),
      sha256: reviewSha256(await readFile(outputSchemaPath)),
    },
    codex: {
      executable_path: codexCanonicalPath,
      executable_sha256: reviewSha256(await readFile(codexCanonicalPath)),
      version: "codex fixture 1.0",
      command: buildIndependentReviewCodexCommand({
        codexPath: codexCanonicalPath,
        repoRoot: root,
        outputSchemaPath,
        finalVerdictPath: finalPath,
      }),
    },
  };
  await Promise.all([
    writeFile(finalPath, `${JSON.stringify(finalVerdict, null, 2)}\n`),
    writeFile(eventsPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`),
    writeFile(stderrPath, "<empty>\n"),
    writeFile(invocationPath, `${JSON.stringify(invocation, null, 2)}\n`),
  ]);

  const rawSpecs = [
    ["CODEX_EVENTS_JSONL", eventsPath],
    ["CODEX_STDERR", stderrPath],
    ["FINAL_VERDICT", finalPath],
    ["INVOCATION", invocationPath],
  ] as const;
  const rawArtifacts = await Promise.all(rawSpecs.map(async ([artifactType, path]) => {
    const bytes = await readFile(path);
    return {
      artifact_type: artifactType,
      path: relative(round, path),
      sha256: reviewSha256(bytes),
      size_bytes: bytes.length,
    };
  }));
  const summaryPath = join(round, "independent-review.json");
  const summary = {
    schema_version: "1.0",
    evidence_boundary: "LOCAL_READ_ONLY_CODEX_REVIEW",
    captured_at: CAPTURED_AT,
    source_fingerprint: SOURCE_FINGERPRINT,
    review_subject_sha256: subjectSha256,
    review_inputs_sha256: reviewInputs.sha256,
    implementation_execution_id: IMPLEMENTATION_EXECUTION_ID,
    reviewer_execution_id: REVIEWER_EXECUTION_ID,
    decision: "CLOSED",
    generator: {
      kind: "INDEPENDENT_READ_ONLY_CODEX_REVIEW",
      command: "node scripts/review/run-independent-review.mjs",
      version: "3.0.0",
      executable_path: "scripts/review/run-independent-review.mjs",
      executable_sha256: reviewSha256(await readFile(generatorPath)),
    },
    raw_artifacts: rawArtifacts,
    reviewed_requirement_ids: reviewedIds,
  };
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  traceability.requirements[0].closure = {
    implementation_execution_id: IMPLEMENTATION_EXECUTION_ID,
    reviewer_execution_id: REVIEWER_EXECUTION_ID,
    reviewer_role: "Independent Acceptance Reviewer",
    reviewed_at: CAPTURED_AT,
    decision: "CLOSED",
    source_fingerprint: SOURCE_FINGERPRINT,
    review_subject_sha256: subjectSha256,
    review_inputs_sha256: reviewInputs.sha256,
    review_artifact: relative(round, summaryPath),
    review_artifact_sha256: reviewSha256(await readFile(summaryPath)),
  };
  await writeFile(documentPath, `${JSON.stringify(traceability, null, 2)}\n`);

  async function refreshRawArtifact(artifactType: string) {
    const artifact = summary.raw_artifacts.find((item) => item.artifact_type === artifactType)!;
    const path = join(round, artifact.path);
    const bytes = await readFile(path);
    artifact.sha256 = reviewSha256(bytes);
    artifact.size_bytes = bytes.length;
    await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
    traceability.requirements[0].closure.review_artifact_sha256 = reviewSha256(await readFile(summaryPath));
  }

  return {
    root,
    round,
    raw,
    documentPath,
    traceability,
    summary,
    summaryPath,
    invocation,
    invocationPath,
    finalVerdict,
    finalPath,
    inspectionReceipt,
    inspectionCommands,
    inspectionEventStart: 2,
    inspectionEventCount: inspectionCommands.length,
    probeEventIndex: 2 + inspectionCommands.length,
    messageEventIndex: 3 + inspectionCommands.length,
    falsificationProbe,
    falsificationProbeCommand,
    falsificationProbeReceipt,
    events,
    eventsPath,
    codexPath: codexCanonicalPath,
    sourceSnapshotContext,
    shardGeneratorPath,
    shardOutputSchemaPath,
    refreshRawArtifact,
  };
}

const passingTestExecutor = async (item: Record<string, any>) => ({
  schema_version: "1.0",
  receipt_kind: "APPROVED_HOST_PROGRAMMATIC_TEST_INVENTORY",
  execution_request_sha256: item.execution_request_sha256,
  approved_review_runtime_sha256: item.approved_review_runtime_sha256,
  observed_review_runtime_sha256: item.observed_review_runtime_sha256,
  node_runtime_identity: item.node_runtime_identity,
  started_at: "2026-08-13T12:59:00.000Z",
  finished_at: "2026-08-13T12:59:01.000Z",
  inventory: {
    module_count: item.tests.length,
    test_count: item.tests.length,
    passed: item.tests.length,
    failed: 0,
    skipped: 0,
    todo: 0,
    pending: 0,
    unhandled_errors: [],
    modules: item.tests.map((test: Record<string, any>, index: number) => ({
      path: test.path,
      sha256: test.sha256,
      tests: [{ id: `${test.path}:${index}`, name: `fixture test ${index}`, state: "passed" }],
    })),
  },
});

async function fixtureTestPlan(fixture: {
  sourceSnapshotContext: any;
  root: string;
  traceability: Record<string, any>;
  documentPath: string;
}) {
  const sourceSnapshotContext = fixture.sourceSnapshotContext;
  const runtime = await deriveObservedIndependentReviewRuntimeIdentity({
    repoRoot: fixture.root,
    sourceSnapshotContext,
  });
  const plan = await createIndependentReviewTestPlan({
    document: fixture.traceability,
    requirementIds: ["K-999"],
    repoRoot: fixture.root,
    documentPath: fixture.documentPath,
    sourceSnapshotContext,
    approvedReviewRuntimeSha256: runtime.observed_review_runtime_sha256,
    testOnlyAllowUnapprovedControlCatalog: true,
  });
  return { plan, runtime, sourceSnapshotContext };
}

async function writeShardAggregateFixture(
  fixture: Awaited<ReturnType<typeof writeIndependentReviewFixture>>,
) {
  const plan = await syntheticPlan({
    document: fixture.traceability,
    requirementId: "K-999",
    repoRoot: fixture.root,
    documentPath: fixture.documentPath,
  });
  const shardDirectory = join(fixture.round, "atomic-shards");
  await mkdir(shardDirectory, { recursive: true });
  const traceabilityPath = relative(fixture.root, fixture.documentPath);
  const sourceIdentity = {
    algorithm: "fixture",
    file_count: 1,
    sha256: SOURCE_FINGERPRINT,
    roots: ["fixture"],
  };
  const verifiedIdentities: Array<{
    implementationExecutionId: string;
    reviewerExecutionId: string;
  }> = [];
  const aggregateShards = [];
  for (const [shardIndex, shard] of plan.shards.entries()) {
    const inspectionNonce = (shardIndex + 10).toString(16).padStart(32, "0");
    const { receipt } = await createIndependentReviewShardReceipt({
      document: fixture.traceability,
      requirementId: "K-999",
      claimId: shard.claim_id,
      shardId: shard.shard_id,
      repoRoot: fixture.root,
      documentPath: fixture.documentPath,
      sourceFingerprint: SOURCE_FINGERPRINT,
      nonce: inspectionNonce,
    });
    const inspectionCommands = buildIndependentReviewShardInspectionCommands({
      traceabilityPath,
      nonce: inspectionNonce,
      requirementId: "K-999",
      claimId: shard.claim_id,
      shardId: shard.shard_id,
      chunkCount: receipt.content_chunk_count,
    });
    const probeNonces = shard.probe_obligation_ids.map((obligationId: string, probeIndex: number) => ({
      obligation_id: obligationId,
      probe_nonce: (10_000 + shardIndex * 100 + probeIndex).toString(16).padStart(32, "0"),
    }));
    const probeCommands = probeNonces.map((item: any) => buildIndependentReviewObligationProbeCommand({
      traceabilityPath,
      inspectionNonce,
      requirementId: "K-999",
      claimId: shard.claim_id,
      obligationId: item.obligation_id,
      probeNonce: item.probe_nonce,
    }));
    const evidenceChecked = shard.content_selections.map((selection: any) => ({
      path: `${selection.path}#bytes=${selection.start_offset_bytes}-${selection.end_offset_bytes}` +
        `;semantic=${selection.semantic_unit_id};role=${selection.role}`,
      sha256: selection.sha256,
    }));
    const claim = shard.scope_kind === "ATOMIC_CLAIM"
      ? fixture.traceability.requirements[0].control_claims.find((item: any) =>
        item.claim_id === shard.claim_id)
      : {
          claim_id: shard.claim_id,
          control: "Mechanically assigned release-critical peripheral paths and dependency edges are reviewed bottom-up.",
          probe_obligations: [],
        };
    const implementationExecutionId = `controller-process:${1000 + shardIndex}:run:fixture-${shardIndex}`;
    const reviewerProcessId = 2000 + shardIndex;
    const threadId = `review-shard-${shardIndex}`;
    const reviewerExecutionId = `codex-thread:${threadId}:pid:${reviewerProcessId}`;
    const prompt = buildIndependentReviewShardPrompt({
      implementationExecutionId,
      sourceFingerprint: SOURCE_FINGERPRINT,
      plan,
      shard,
      claim,
      reviewerRole: "Independent Acceptance Reviewer",
      inspectionCommands,
      probeCommands,
      evidenceChecked,
    });
    const finalVerdict = {
      schema_version: "2.0",
      implementation_execution_id: implementationExecutionId,
      source_fingerprint: SOURCE_FINGERPRINT,
      review_subject_sha256: plan.review_subject_sha256,
      review_inputs_sha256: plan.review_inputs_sha256,
      plan_sha256: plan.plan_sha256,
      requirement_id: "K-999",
      claim_id: shard.claim_id,
      shard_id: shard.shard_id,
      reviewer_role: "Independent Acceptance Reviewer",
      decision: "CLOSED",
      evidence_checked: evidenceChecked,
      dependency_edges_checked: shard.dependency_edges.map(({ importer, dependency }: any) => ({
        importer,
        dependency,
      })),
      probe_obligations_checked: shard.probe_obligation_ids,
      review_axes: {
        mcp_layer: "The assigned shard does not bypass the MCP boundary.",
        provider_neutrality: "The assigned shard preserves the declared provider boundary.",
        durable_state: "The assigned durable evidence is internally consistent.",
        concurrency_recovery: "The assigned recovery boundary remains fail closed.",
        test_evidence: "Every fixed probe and cited test receipt was inspected.",
        adversarial_counterexample: "Removing an assigned edge or obligation would invalidate exact aggregation.",
      },
      rationale: "All assigned content, edges and fixed obligations were reviewed without an unresolved blocker.",
      residual_risk: "This fixture proves local mechanical closure rather than remote signing.",
    };
    const events: Array<Record<string, any>> = [
      { type: "thread.started", thread_id: threadId },
      { type: "turn.started" },
    ];
    for (const [chunkIndex, command] of inspectionCommands.entries()) {
      events.push({
        type: "item.completed",
        item: {
          type: "command_execution",
          id: `inspection-${shardIndex}-${chunkIndex}`,
          command,
          aggregated_output: `${JSON.stringify(createIndependentReviewShardChunkReceipt(receipt, chunkIndex))}\n`,
          status: "completed",
          exit_code: 0,
        },
      });
    }
    for (const [probeIndex, command] of probeCommands.entries()) {
      const probeReceipt = await createIndependentReviewObligationProbeReceipt({
        document: fixture.traceability,
        requirementId: "K-999",
        claimId: shard.claim_id,
        obligationId: shard.probe_obligation_ids[probeIndex],
        repoRoot: fixture.root,
        documentPath: fixture.documentPath,
        sourceFingerprint: SOURCE_FINGERPRINT,
        inspectionNonce,
        probeNonce: probeNonces[probeIndex].probe_nonce,
        sourceSnapshotContext: plan.documentPlan.reviewCapture.sourceSnapshotContext,
      });
      events.push({
        type: "item.completed",
        item: {
          type: "command_execution",
          id: `probe-${shardIndex}-${probeIndex}`,
          command,
          aggregated_output: `${JSON.stringify(probeReceipt)}\n`,
          status: "completed",
          exit_code: 0,
        },
      });
    }
    events.push(
      { type: "item.completed", item: { type: "agent_message", id: "final", text: JSON.stringify(finalVerdict) } },
      { type: "turn.completed", usage: { input_tokens: 4096, output_tokens: 512 } },
    );
    const summaryPath = join(shardDirectory, `${shard.shard_id}.json`);
    const rawDirectory = join(shardDirectory, `${shard.shard_id}.raw`);
    await mkdir(rawDirectory, { recursive: true });
    const eventsPath = join(rawDirectory, "codex-events.jsonl");
    const stderrPath = join(rawDirectory, "codex-stderr.log");
    const finalPath = join(rawDirectory, "final-verdict.json");
    const invocationPath = join(rawDirectory, "invocation.json");
    const codexCommand = buildIndependentReviewCodexCommand({
      codexPath: fixture.codexPath,
      repoRoot: fixture.root,
      outputSchemaPath: fixture.shardOutputSchemaPath,
      finalVerdictPath: finalPath,
    });
    const invocation = {
      schema_version: "2.0",
      evidence_boundary: "LOCAL_READ_ONLY_CODEX_ATOMIC_CLAIM_SHARD_REVIEW",
      started_at: "2026-08-14T00:00:00.000Z",
      finished_at: "2026-08-14T00:01:00.000Z",
      exit_code: 0,
      controller_process_id: 1000 + shardIndex,
      reviewer_process_id: reviewerProcessId,
      implementation_execution_id: implementationExecutionId,
      traceability_path: traceabilityPath,
      requirement_id: "K-999",
      claim_id: shard.claim_id,
      shard_id: shard.shard_id,
      source_fingerprint_before: sourceIdentity,
      source_fingerprint_after: sourceIdentity,
      review_subject_sha256: plan.review_subject_sha256,
      review_inputs_sha256: plan.review_inputs_sha256,
      plan_sha256: plan.plan_sha256,
      inspection_nonce: inspectionNonce,
      inspection_commands: inspectionCommands,
      probe_nonces: probeNonces,
      probe_commands: probeCommands,
      prompt,
      prompt_sha256: reviewSha256(prompt),
      output_schema: {
        path: relative(fixture.root, fixture.shardOutputSchemaPath),
        sha256: reviewSha256(await readFile(fixture.shardOutputSchemaPath)),
      },
      codex: {
        executable_path: fixture.codexPath,
        executable_sha256: reviewSha256(await readFile(fixture.codexPath)),
        version: "codex fixture 1.0",
        command: codexCommand,
      },
    };
    await Promise.all([
      writeFile(eventsPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`),
      writeFile(stderrPath, "<empty>\n"),
      writeFile(finalPath, `${JSON.stringify(finalVerdict, null, 2)}\n`),
      writeFile(invocationPath, `${JSON.stringify(invocation, null, 2)}\n`),
    ]);
    const rawArtifacts = await Promise.all([
      ["CODEX_EVENTS_JSONL", eventsPath],
      ["CODEX_STDERR", stderrPath],
      ["FINAL_VERDICT", finalPath],
      ["INVOCATION", invocationPath],
    ].map(async ([artifactType, path]) => {
      const bytes = await readFile(path);
      return {
        artifact_type: artifactType,
        path: relative(shardDirectory, path),
        sha256: reviewSha256(bytes),
        size_bytes: bytes.length,
      };
    }));
    const summary = {
      schema_version: "2.0",
      evidence_boundary: "LOCAL_READ_ONLY_CODEX_ATOMIC_CLAIM_SHARD_REVIEW",
      captured_at: "2026-08-14T00:02:00.000Z",
      source_fingerprint: SOURCE_FINGERPRINT,
      review_subject_sha256: plan.review_subject_sha256,
      review_inputs_sha256: plan.review_inputs_sha256,
      plan_sha256: plan.plan_sha256,
      requirement_id: "K-999",
      claim_id: shard.claim_id,
      shard_id: shard.shard_id,
      implementation_execution_id: implementationExecutionId,
      reviewer_execution_id: reviewerExecutionId,
      decision: "CLOSED",
      generator: {
        kind: "INDEPENDENT_ATOMIC_CLAIM_SHARD_REVIEW",
        command: `node ${relative(fixture.root, fixture.shardGeneratorPath)}`,
        version: "4.0.0",
        executable_path: relative(fixture.root, fixture.shardGeneratorPath),
        executable_sha256: reviewSha256(await readFile(fixture.shardGeneratorPath)),
      },
      raw_artifacts: rawArtifacts,
    };
    await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
    const summaryBytes = await readFile(summaryPath);
    aggregateShards.push({
      claim_id: shard.claim_id,
      shard_id: shard.shard_id,
      artifact: relative(fixture.round, summaryPath),
      sha256: reviewSha256(summaryBytes),
    });
    verifiedIdentities.push({ implementationExecutionId, reviewerExecutionId });
  }
  const capturedAt = "2026-08-14T00:03:00.000Z";
  const aggregate = {
    schema_version: "2.0",
    evidence_boundary: "LOCAL_READ_ONLY_CODEX_ATOMIC_CLAIM_AGGREGATE",
    captured_at: capturedAt,
    source_fingerprint: SOURCE_FINGERPRINT,
    review_subject_sha256: plan.review_subject_sha256,
    review_inputs_sha256: plan.review_inputs_sha256,
    plan_sha256: plan.plan_sha256,
    requirement_id: "K-999",
    implementation_execution_id: `atomic-review-controllers:${reviewSha256(stableReviewStringify(
      verifiedIdentities.map((item) => item.implementationExecutionId).sort(),
    ))}`,
    reviewer_execution_id: `atomic-reviewers:${reviewSha256(stableReviewStringify(
      verifiedIdentities.map((item) => item.reviewerExecutionId).sort(),
    ))}`,
    decision: "CLOSED",
    shards: aggregateShards,
  };
  const aggregatePath = join(fixture.round, "independent-review-aggregate.json");
  await writeFile(aggregatePath, `${JSON.stringify(aggregate, null, 2)}\n`);
  const closure = {
    implementation_execution_id: aggregate.implementation_execution_id,
    reviewer_execution_id: aggregate.reviewer_execution_id,
    reviewed_at: capturedAt,
    decision: "CLOSED",
    source_fingerprint: SOURCE_FINGERPRINT,
    review_subject_sha256: plan.review_subject_sha256,
    review_inputs_sha256: plan.review_inputs_sha256,
  };
  return { plan, aggregate, aggregatePath, closure, shardDirectory };
}

async function referenceErrors(
  fixture: Awaited<ReturnType<typeof writeIndependentReviewFixture>>,
  source = SOURCE_FINGERPRINT,
  reviewTestExecutor: typeof passingTestExecutor = passingTestExecutor,
  reviewExecutionReceipts?: Array<Record<string, unknown>>,
) {
  await writeFile(fixture.documentPath, `${JSON.stringify(fixture.traceability, null, 2)}\n`);
  const sourceSnapshotContext = fixture.sourceSnapshotContext;
  const runtime = await deriveObservedIndependentReviewRuntimeIdentity({
    repoRoot: fixture.root,
    sourceSnapshotContext,
  });
  return validateTraceabilityReferences(fixture.traceability, {
    repoRoot: fixture.root,
    documentPath: fixture.documentPath,
    expectedSourceFingerprint: source,
    allowedCodexExecutablePaths: [fixture.codexPath],
    legacyIndependentReviewFixture: true,
    reviewTestExecutor,
    reviewExecutionReceipts,
    sourceSnapshotContext,
    approvedReviewRuntimeSha256: runtime.observed_review_runtime_sha256,
    testOnlyAllowUnapprovedControlCatalog: true,
  });
}

async function recomputeDeclaredClosureWithoutFreshInspection(
  fixture: Awaited<ReturnType<typeof writeIndependentReviewFixture>>,
) {
  const reviewedIds = ["K-999"];
  const currentInputs = await fingerprintIndependentReviewInputs({
    document: fixture.traceability,
    requirementIds: reviewedIds,
    repoRoot: fixture.root,
    documentPath: fixture.documentPath,
  });
  const currentReceipt = await createIndependentReviewInputReceipt({
    document: fixture.traceability,
    requirementIds: reviewedIds,
    repoRoot: fixture.root,
    documentPath: fixture.documentPath,
    sourceFingerprint: SOURCE_FINGERPRINT,
    nonce: fixture.invocation.inspection_nonce,
  });
  const currentCommands = buildIndependentReviewInspectionCommands({
    traceabilityPath: relative(fixture.root, fixture.documentPath),
    nonce: fixture.invocation.inspection_nonce,
    requirementIds: reviewedIds,
    chunkCount: currentReceipt.content_chunk_count,
  });
  fixture.summary.review_inputs_sha256 = currentInputs.sha256;
  fixture.traceability.requirements[0].closure.review_inputs_sha256 = currentInputs.sha256;
  fixture.invocation.review_inputs_before = currentInputs;
  fixture.invocation.review_inputs_after = currentInputs;
  fixture.invocation.inspection_commands = currentCommands;
  fixture.invocation.prompt = buildIndependentReviewPrompt({
    implementationExecutionId: IMPLEMENTATION_EXECUTION_ID,
    sourceFingerprint: SOURCE_FINGERPRINT,
    reviewSubjectSha256: fixture.summary.review_subject_sha256,
    reviewInputsSha256: currentInputs.sha256,
    inspectionCommands: currentCommands,
    traceabilityPath: relative(fixture.root, fixture.documentPath),
    requestedRequirements: fixture.invocation.requested_requirements,
  });
  fixture.invocation.prompt_sha256 = reviewSha256(fixture.invocation.prompt);
  fixture.finalVerdict.review_inputs_sha256 = currentInputs.sha256;
  const checks = expectedStructuredReviewChecks({
    document: fixture.traceability,
    requirementId: "K-999",
    reviewInputs: currentInputs,
  });
  fixture.finalVerdict.requirements[0].evidence_checked = checks.evidenceChecked;
  fixture.finalVerdict.requirements[0].adversarial_checks = checks.adversarialChecks;
  const finalMessage: any = fixture.events.find((event: any) => event?.item?.type === "agent_message");
  if (!finalMessage) throw new Error("fixture final message missing");
  finalMessage.item.text = JSON.stringify(fixture.finalVerdict);
  await Promise.all([
    writeFile(fixture.finalPath, `${JSON.stringify(fixture.finalVerdict, null, 2)}\n`),
    writeFile(fixture.invocationPath, `${JSON.stringify(fixture.invocation, null, 2)}\n`),
    writeFile(fixture.eventsPath, `${fixture.events.map((event) => JSON.stringify(event)).join("\n")}\n`),
  ]);
  await fixture.refreshRawArtifact("FINAL_VERDICT");
  await fixture.refreshRawArtifact("INVOCATION");
  await fixture.refreshRawArtifact("CODEX_EVENTS_JSONL");
}

// Every test here hashes real trees, resolves real dependency graphs, and runs
// real in-memory Vitest mutations; the honest running time is seconds to tens of
// seconds, not the 5s default. Individual tests were already carrying 30s/60s/120s
// overrides one at a time, and the ones that never got one failed or passed
// depending on machine load - which made the suite's failure count vary run to run
// and cost real time chasing failures that were only clocks.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

describe("independent Codex review closure evidence", () => {
  it("partitions a transitive requirement component into bounded atomic-claim shards with exact path, edge, and probe coverage", async () => {
    const root = await mkdtemp(join(tmpdir(), "independent-review-plan-"));
    const round = join(root, "artifacts/round");
    try {
      await installFrozenTypescriptFixture(root);
      await Promise.all([
        mkdir(join(root, "src"), { recursive: true }),
        mkdir(join(root, "tests"), { recursive: true }),
        mkdir(join(root, "schemas"), { recursive: true }),
        mkdir(round, { recursive: true }),
      ]);
      await Promise.all([
        writeFile(join(root, "src/control.ts"), 'export const control = "strict";\n'),
        writeFile(join(root, "src/wrapper.ts"), 'export { control } from "./control.js";\n'),
        writeFile(join(root, "src/consumer.ts"), 'import { control } from "./wrapper.js"; export const result = control;\n'),
        writeFile(join(root, "tests/control-positive.test.ts"),
          'import { result } from "../src/consumer.js"; test("strict control", () => expect(result).toBe("strict"));\n'),
        writeFile(join(root, "tests/control-negative.test.ts"),
          'import { result } from "../src/consumer.js"; test("disabled control", () => expect(result).not.toBe("disabled"));\n'),
        writeFile(join(round, "evidence.json"), "{}\n"),
      ]);
      const control = "The cited control remains enforced through every transitive consumer.";
      const traceability = {
        schema_version: "4.0",
        round_id: "round-plan",
        generated_at: "2026-08-14T00:00:00.000Z",
        evidence_boundary: "Synthetic plan fixture.",
        control_catalog: {
          path: "schemas/ledger-control-clauses.v1.json",
          schema_version: "1.0",
          sha256: "0".repeat(64),
        },
        requirements: [{
          requirement_id: "K-999",
          business_risk: "A wrapper can bypass the cited control.",
          design_control: control,
          control_claims: [{
            claim_id: "K-999-C01",
            source_clause_id: "K-999-C01",
            control,
            evidence: ["evidence.json"],
            implementation_files: ["src/control.ts"],
            positive_tests: ["tests/control-positive.test.ts"],
            negative_or_mutation_tests: ["tests/control-negative.test.ts"],
            probe_obligations: [{
              obligation_id: "K-999-C01-P01",
              invariant: control,
              target_path: "src/control.ts",
              target_anchor: "control",
              mutation_operator: "REPLACE_ENUM_LITERAL",
              literal: "strict",
              replacement: "disabled",
              test_files: ["tests/control-positive.test.ts", "tests/control-negative.test.ts"],
              mutation_test_path: "tests/control-positive.test.ts",
              expected_failing_test_names: ["strict control"],
              expected_failure_message_patterns: ["strict"],
            }],
          }],
          implementation_files: ["src/control.ts"],
          positive_tests: ["tests/control-positive.test.ts"],
          negative_or_mutation_tests: ["tests/control-negative.test.ts"],
          implementation_owner: "/root",
          reviewer: "Independent reviewer",
          status: "FIXED_PENDING_REVIEW",
          evidence: ["evidence.json"],
          residual_risk: "None within the fixture.",
        }],
      } as Record<string, any>;
      const catalog = {
        schema_version: "1.0",
        catalog_id: "plan-fixture",
        source_documents: [{
          path: "src/control.ts",
          sha256: reviewSha256(await readFile(join(root, "src/control.ts"))),
        }],
        requirements: [{
          requirement_id: "K-999",
          business_risk: traceability.requirements[0].business_risk,
          clauses: [{
            clause_id: "K-999-C01",
            control,
          }],
        }],
      };
      const catalogBytes = Buffer.from(`${JSON.stringify(catalog, null, 2)}\n`);
      await writeFile(join(root, "schemas/ledger-control-clauses.v1.json"), catalogBytes);
      traceability.control_catalog.sha256 = reviewSha256(catalogBytes);
      const documentPath = join(round, "requirements.json");
      await writeFile(documentPath, `${JSON.stringify(traceability, null, 2)}\n`);

      const plan = await syntheticPlan({
        document: traceability,
        requirementId: "K-999",
        repoRoot: root,
        documentPath,
      });
      expect(plan.expected_paths).toEqual(expect.arrayContaining([
        "src/control.ts", "src/wrapper.ts", "src/consumer.ts",
      ]));
      expect(plan.shards.flatMap((item: any) => item.dependency_edges)).toEqual(expect.arrayContaining([
        expect.objectContaining({ importer: "src/consumer.ts", dependency: "src/wrapper.ts" }),
        expect.objectContaining({ importer: "src/wrapper.ts", dependency: "src/control.ts" }),
      ]));
      expect(plan.expected_probe_obligations).toEqual(["K-999-C01-P01"]);
      expect(plan.shards.every((shard: any) =>
        shard.capacity.total_bytes <= 1024 * 1024 &&
        shard.capacity.file_count <= 128 && shard.capacity.batch_count <= 32)).toBe(true);
      const shard = plan.shards[0];
      const generated = await createIndependentReviewShardReceipt({
        document: traceability,
        requirementId: "K-999",
        claimId: "K-999-C01",
        shardId: shard.shard_id,
        repoRoot: root,
        documentPath,
        sourceFingerprint: SOURCE_FINGERPRINT,
        nonce: "9".repeat(32),
        sourceSnapshotContext: plan.documentPlan.reviewCapture.sourceSnapshotContext,
      });
      expect(generated.receipt.plan_sha256).toBe(plan.plan_sha256);
      expect(generated.receipt.probe_obligation_ids).toEqual(["K-999-C01-P01"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps reciprocal dependency edges and delimiter-colliding path tuples distinct", async () => {
    const root = await mkdtemp(join(tmpdir(), "independent-review-directed-graph-"));
    try {
      await installFrozenTypescriptFixture(root);
      const contents = new Map<string, Buffer>([
        ["a.ts", Buffer.from('import "./b.js";\n')],
        ["b.ts", Buffer.from('import "./a.js";\n')],
        ["x.ts", Buffer.from('import "./y.ts->z.js";\n')],
        ["y.ts->z.ts", Buffer.from("export const one = 1;\n")],
        ["x.ts->y.ts", Buffer.from('import "./z.js";\n')],
        ["z.ts", Buffer.from("export const two = 2;\n")],
      ]);
      const graph = await deriveIndependentReviewDependencyGraph({
        repoRoot: root,
        universePaths: [...contents.keys()],
        contentByPath: contents,
      });
      expect(graph.edges).toEqual(expect.arrayContaining([
        expect.objectContaining({ importer: "a.ts", dependency: "b.ts" }),
        expect.objectContaining({ importer: "b.ts", dependency: "a.ts" }),
        expect.objectContaining({ importer: "x.ts", dependency: "y.ts->z.ts" }),
        expect.objectContaining({ importer: "x.ts->y.ts", dependency: "z.ts" }),
      ]));
      expect(new Set(graph.edges.map((edge: any) => edge.id)).size).toBe(4);
      expect("x.ts->y.ts->z.ts").toBe("x.ts->y.ts->z.ts");
      const colliding = graph.edges.filter((edge: any) =>
        (edge.importer === "x.ts" && edge.dependency === "y.ts->z.ts") ||
        (edge.importer === "x.ts->y.ts" && edge.dependency === "z.ts"));
      expect(colliding).toHaveLength(2);
      expect(colliding[0].id).not.toBe(colliding[1].id);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("binds every repeated import site and every side-effect dependency statement to its file-edge witness", async () => {
    const fixture = await writePlanFixture({
      files: {
        "src/control.ts": 'import { first } from "./register.js";\nimport { second } from "./register.js";\nexport const control = first + second;\n',
        "src/side-effect.ts": 'import "./register.js";\nexport const loaded = true;\n',
        "src/register.ts":
          'export const first = "first";\nexport const second = "second";\nglobalThis.firstRegistration = first;\nglobalThis.secondRegistration = second;\n',
        "tests/positive.test.ts":
          'import { control } from "../src/control.js"; test("all import sites", () => expect(control).toBe("firstsecond"));\n',
        "tests/negative.test.ts":
          'import "../src/side-effect.js"; test("side effect body", () => expect(globalThis.secondRegistration).toBe("second"));\n',
      },
      implementationFiles: ["src/control.ts", "src/side-effect.ts"],
      positiveTests: ["tests/positive.test.ts"],
      negativeTests: ["tests/negative.test.ts"],
      obligations: [{
        obligation_id: "K-999-C01-P01",
        invariant: "Both imported symbols remain bound.",
        target_path: "src/control.ts",
        target_anchor: "control",
        mutation_operator: "REPLACE_EXACT_LITERAL",
        literal: "first + second",
        replacement: "first",
        test_files: ["tests/positive.test.ts", "tests/negative.test.ts"],
        mutation_test_path: "tests/positive.test.ts",
        expected_failing_test_names: ["all import sites"],
        expected_failure_message_patterns: ["firstsecond"],
      }],
    });
    try {
      const plan = await syntheticPlan({
        document: fixture.traceability,
        requirementId: "K-999",
        repoRoot: fixture.root,
        documentPath: fixture.documentPath,
      });
      const repeated = plan.shards.flatMap((shard: any) => shard.dependency_edges)
        .find((edge: any) => edge.importer === "src/control.ts" && edge.dependency === "src/register.ts");
      expect(repeated.import_sites).toHaveLength(2);
      expect(repeated.import_sites.map((site: any) => site.dependency_export_anchors).flat())
        .toEqual(["first", "second"]);
      const repeatedShard = plan.shards.find((shard: any) =>
        shard.dependency_edges.some((edge: any) => edge.id === repeated.id));
      const repeatedText = repeatedShard.content_selections
        .filter((selection: any) => ["src/control.ts", "src/register.ts"].includes(selection.path))
        .map((selection: any) => selection.semantic_unit_id);
      expect(new Set(repeatedText).size).toBeGreaterThanOrEqual(4);

      const sideEffect = plan.shards.flatMap((shard: any) => shard.dependency_edges)
        .find((edge: any) => edge.importer === "src/side-effect.ts" && edge.dependency === "src/register.ts");
      expect(sideEffect.import_sites).toEqual([
        expect.objectContaining({ dependency_export_anchors: [] }),
      ]);
      const sideEffectShard = plan.shards.find((shard: any) =>
        shard.dependency_edges.some((edge: any) => edge.id === sideEffect.id));
      const registerRanges = sideEffectShard.content_selections.filter((selection: any) =>
        selection.path === "src/register.ts");
      expect(registerRanges.length).toBeGreaterThanOrEqual(4);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects an obligation whose anchor and unique literal occupy different semantic units", async () => {
    const fixture = await writePlanFixture({
      files: {
        "src/control.ts":
          'export function realControl() { return true; }\nexport const easyLiteral = "strict-review-control";\n',
        "tests/positive.test.ts":
          'import { realControl } from "../src/control.js"; test("real control", () => expect(realControl()).toBe(true));\n',
        "tests/negative.test.ts":
          'import { realControl } from "../src/control.js"; test("real negative", () => expect(realControl()).not.toBe(false));\n',
      },
      implementationFiles: ["src/control.ts"],
      positiveTests: ["tests/positive.test.ts"],
      negativeTests: ["tests/negative.test.ts"],
      obligations: [{
        obligation_id: "K-999-C01-P01",
        invariant: "The real control must be the mutated enforcement unit.",
        target_path: "src/control.ts",
        target_anchor: "realControl",
        mutation_operator: "REPLACE_EXACT_LITERAL",
        literal: "strict-review-control",
        replacement: "disabled-review-control",
        test_files: ["tests/positive.test.ts", "tests/negative.test.ts"],
        mutation_test_path: "tests/positive.test.ts",
        expected_failing_test_names: ["real control"],
        expected_failure_message_patterns: ["true"],
      }],
    });
    try {
      await expect(syntheticPlan({
        document: fixture.traceability,
        requirementId: "K-999",
        repoRoot: fixture.root,
        documentPath: fixture.documentPath,
      })).rejects.toThrow("ANCHOR_LITERAL_NOT_COLOCATED");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }, 30_000);

  it("derives deleted-file dependency edges from captured baseline bytes instead of rereading the worktree", async () => {
    const root = await mkdtemp(join(tmpdir(), "independent-review-captured-graph-"));
    try {
      await installFrozenTypescriptFixture(root);
      await writeFile(join(root, "deleted.ts"), "// current worktree replacement has no import\n");
      const captured = new Map<string, Buffer>([
        ["deleted.ts", Buffer.from('import { dependency } from "./dependency.js";\nexport { dependency };\n')],
        ["dependency.ts", Buffer.from("export const dependency = true;\n")],
      ]);
      const graph = await deriveIndependentReviewDependencyGraph({
        repoRoot: root,
        universePaths: [...captured.keys()],
        contentByPath: captured,
      });
      expect(graph.edges).toEqual([
        expect.objectContaining({ importer: "deleted.ts", dependency: "dependency.ts" }),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not pull an unrelated sibling consumer through a shared helper and assigns every obligation once", async () => {
    const fixture = await writePlanFixture({
      files: {
        "src/control.ts": 'export const control = "strict";\n',
        "src/shared.ts": "export const shared = true;\n",
        "src/claimed.ts": 'import { control } from "./control.js"; import { shared } from "./shared.js"; export const result = control + shared;\n',
        "src/unrelated.ts": 'import { shared } from "./shared.js"; export const unrelated = shared;\n',
        "tests/positive.test.ts": 'import { result } from "../src/claimed.js"; test("strict one", () => expect(result).toContain("strict")); test("strict two", () => expect(result).not.toContain("disabled"));\n',
        "tests/negative.test.ts": 'import { result } from "../src/claimed.js"; test("negative", () => expect(result).not.toContain("disabled"));\n',
      },
      implementationFiles: ["src/control.ts"],
      positiveTests: ["tests/positive.test.ts"],
      negativeTests: ["tests/negative.test.ts"],
      obligations: [
        {
          obligation_id: "K-999-C01-P01",
          invariant: "The strict literal controls the first assertion.",
          target_path: "src/control.ts",
          target_anchor: "control",
          mutation_operator: "REPLACE_ENUM_LITERAL",
          literal: "strict",
          replacement: "disabled",
          test_files: ["tests/positive.test.ts", "tests/negative.test.ts"],
          mutation_test_path: "tests/positive.test.ts",
          expected_failing_test_names: ["strict one"],
          expected_failure_message_patterns: ["strict"],
        },
        {
          obligation_id: "K-999-C01-P02",
          invariant: "The strict literal controls the second assertion.",
          target_path: "src/control.ts",
          target_anchor: "control",
          mutation_operator: "REPLACE_ENUM_LITERAL",
          literal: "strict",
          replacement: "disabled",
          test_files: ["tests/positive.test.ts", "tests/negative.test.ts"],
          mutation_test_path: "tests/positive.test.ts",
          expected_failing_test_names: ["strict two"],
          expected_failure_message_patterns: ["strict"],
        },
      ],
    });
    try {
      const plan = await syntheticPlan({
        document: fixture.traceability,
        requirementId: "K-999",
        repoRoot: fixture.root,
        documentPath: fixture.documentPath,
      });
      const atomic = plan.shards.filter((shard: any) => shard.scope_kind === "ATOMIC_CLAIM");
      const global = plan.shards.filter((shard: any) =>
        shard.scope_kind === "DOCUMENT_GLOBAL_PERIPHERAL_COVERAGE");
      expect(atomic.flatMap((shard: any) => shard.paths)).toContain("src/claimed.ts");
      expect(atomic.flatMap((shard: any) => shard.paths)).not.toContain("src/shared.ts");
      expect(atomic.flatMap((shard: any) => shard.paths)).not.toContain("src/unrelated.ts");
      expect(global.flatMap((shard: any) => shard.paths)).toContain("src/shared.ts");
      expect(global.flatMap((shard: any) => shard.paths)).toContain("src/unrelated.ts");
      expect(atomic.flatMap((shard: any) => shard.dependency_edges)).toEqual(expect.arrayContaining([
        expect.objectContaining({ importer: "tests/positive.test.ts", dependency: "src/claimed.ts" }),
        expect.objectContaining({ importer: "tests/negative.test.ts", dependency: "src/claimed.ts" }),
        expect.objectContaining({ importer: "src/claimed.ts", dependency: "src/control.ts" }),
      ]));
      expect(atomic.every((shard: any) => shard.probe_obligation_ids.length <= 1)).toBe(true);
      expect(atomic.flatMap((shard: any) => shard.probe_obligation_ids).sort()).toEqual([
        "K-999-C01-P01", "K-999-C01-P02",
      ]);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("fails closed when one cited implementation has no directed test witness", async () => {
    const fixture = await writePlanFixture({
      files: {
        "src/a.ts": 'export const a = "strict-a";\n',
        "src/b.ts": 'export const b = "strict-b";\n',
        "tests/positive.test.ts": 'import { a } from "../src/a.js"; test("only a", () => expect(a).toContain("strict"));\n',
        "tests/negative.test.ts": 'import { a } from "../src/a.js"; test("only a negative", () => expect(a).not.toContain("disabled"));\n',
      },
      implementationFiles: ["src/a.ts", "src/b.ts"],
      positiveTests: ["tests/positive.test.ts"],
      negativeTests: ["tests/negative.test.ts"],
      obligations: [{
        obligation_id: "K-999-C01-P01",
        invariant: "Every cited implementation must be exercised.",
        target_path: "src/a.ts",
        target_anchor: "a",
        mutation_operator: "REPLACE_ENUM_LITERAL",
        literal: "strict-a",
        replacement: "disabled-a",
        test_files: ["tests/positive.test.ts", "tests/negative.test.ts"],
        mutation_test_path: "tests/positive.test.ts",
        expected_failing_test_names: ["only a"],
        expected_failure_message_patterns: ["strict"],
      }, {
        obligation_id: "K-999-C01-P02",
        invariant: "The disconnected implementation must not be silently accepted.",
        target_path: "src/b.ts",
        target_anchor: "b",
        mutation_operator: "REPLACE_ENUM_LITERAL",
        literal: "strict-b",
        replacement: "disabled-b",
        test_files: ["tests/positive.test.ts", "tests/negative.test.ts"],
        mutation_test_path: "tests/positive.test.ts",
        expected_failing_test_names: ["only a"],
        expected_failure_message_patterns: ["strict"],
      }],
    });
    try {
      await expect(syntheticPlan({
        document: fixture.traceability,
        requirementId: "K-999",
        repoRoot: fixture.root,
        documentPath: fixture.documentPath,
      })).rejects.toThrow("INDEPENDENT_REVIEW_IMPLEMENTATION_DIRECTED_WITNESS_MISSING:src/b.ts");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("preserves a core-connected witness for every edge when a long chain is split", async () => {
    const files: Record<string, string> = {
      "src/n00.ts": 'export const value00 = "strict";\n',
    };
    for (let index = 1; index <= 12; index += 1) {
      const current = String(index).padStart(2, "0");
      const prior = String(index - 1).padStart(2, "0");
      files[`src/n${current}.ts`] =
        `import { value${prior} } from "./n${prior}.js"; export const value${current} = value${prior};\n`;
    }
    for (let index = 0; index < 25; index += 1) {
      const leaf = String(index).padStart(2, "0");
      files[`src/leaf${leaf}.ts`] =
        `import { value12 } from "./n12.js"; export const leaf${leaf} = value12;\n`;
    }
    files["tests/positive.test.ts"] =
      'import { leaf00 } from "../src/leaf00.js"; test("chain", () => expect(leaf00).toBe("strict"));\n';
    files["tests/negative.test.ts"] =
      'import { leaf00 } from "../src/leaf00.js"; test("chain negative", () => expect(leaf00).not.toBe("disabled"));\n';
    const fixture = await writePlanFixture({
      files,
      implementationFiles: ["src/n00.ts"],
      positiveTests: ["tests/positive.test.ts"],
      negativeTests: ["tests/negative.test.ts"],
      obligations: [{
        obligation_id: "K-999-C01-P01",
        invariant: "The chain keeps the strict value.",
        target_path: "src/n00.ts",
        target_anchor: "value00",
        mutation_operator: "REPLACE_ENUM_LITERAL",
        literal: "strict",
        replacement: "disabled",
        test_files: ["tests/positive.test.ts", "tests/negative.test.ts"],
        mutation_test_path: "tests/positive.test.ts",
        expected_failing_test_names: ["chain"],
        expected_failure_message_patterns: ["strict"],
      }],
    });
    try {
      const plan = await syntheticPlan({
        document: fixture.traceability,
        requirementId: "K-999",
        repoRoot: fixture.root,
        documentPath: fixture.documentPath,
      });
      const atomic = plan.shards.filter((shard: any) => shard.scope_kind === "ATOMIC_CLAIM");
      expect(atomic.length).toBeGreaterThan(1);
      for (const shard of atomic) {
        expect(shard.dependency_edges.length).toBeLessThanOrEqual(24);
        const adjacency = new Map<string, Set<string>>(shard.paths.map((path: string) => [path, new Set()]));
        for (const edge of shard.dependency_edges) {
          adjacency.get(edge.importer)?.add(edge.dependency);
          adjacency.get(edge.dependency)?.add(edge.importer);
        }
        const reachable = new Set<string>(shard.core_paths);
        const queue = [...reachable];
        while (queue.length > 0) {
          const current = queue.shift()!;
          for (const neighbor of adjacency.get(current) ?? []) {
            if (!reachable.has(neighbor)) {
              reachable.add(neighbor);
              queue.push(neighbor);
            }
          }
        }
        for (const edge of shard.dependency_edges) {
          expect(reachable.has(edge.importer)).toBe(true);
          expect(reachable.has(edge.dependency)).toBe(true);
        }
      }
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("fails closed when dense dependency edges exceed the bounded multi-execution plan", async () => {
    const files: Record<string, string> = {};
    const moduleCount = 4;
    for (let importer = 0; importer < moduleCount; importer += 1) {
      const statements = [];
      for (let dependency = 0; dependency < moduleCount; dependency += 1) {
        if (dependency === importer) continue;
        statements.push(`import "./f${String(dependency).padStart(2, "0")}.js";`);
      }
      files[`src/f${String(importer).padStart(2, "0")}.ts`] =
        `${statements.join("\n")}\nexport const f${importer} = ${importer};\n`;
    }
    files["tests/positive.test.ts"] =
      'import { f0 } from "../src/f00.js"; test("dense", () => expect(f0).toBe(0));\n';
    files["tests/negative.test.ts"] =
      'import { f0 } from "../src/f00.js"; test("dense negative", () => expect(f0).not.toBe(1));\n';
    const fixture = await writePlanFixture({
      files,
      implementationFiles: ["src/f00.ts"],
      positiveTests: ["tests/positive.test.ts"],
      negativeTests: ["tests/negative.test.ts"],
      obligations: [{
        obligation_id: "K-999-C01-P01",
        invariant: "The dense graph still enforces f0.",
        target_path: "src/f00.ts",
        target_anchor: "f0",
        mutation_operator: "REPLACE_EXACT_LITERAL",
        literal: "export const f0 = 0;",
        replacement: "export const f0 = 1;",
        test_files: ["tests/positive.test.ts", "tests/negative.test.ts"],
        mutation_test_path: "tests/positive.test.ts",
        expected_failing_test_names: ["dense"],
        expected_failure_message_patterns: ["expected 1 to be"],
      }],
    });
    try {
      await expect(syntheticPlan({
        document: fixture.traceability,
        requirementId: "K-999",
        repoRoot: fixture.root,
        documentPath: fixture.documentPath,
        testOnlyMaxShardCount: 2,
      })).rejects.toThrow(/INDEPENDENT_REVIEW_(?:DOCUMENT_PLAN_TOTAL|DOCUMENT_GLOBAL_EDGE_SEMANTIC_UNIT|PLAN_TOTAL|EDGE_UNIT|SHARD)_CAPACITY_EXCEEDED/u);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }, 10_000);

  it("semantically shards the current giant postgresRepository without truncating a class member", async () => {
    const postgresRepository = await readFile(join(process.cwd(), "src/db/postgresRepository.ts"), "utf8");
    expect(Buffer.byteLength(postgresRepository, "utf8")).toBeGreaterThan(400_000);
    const fixture = await writePlanFixture({
      files: {
        "src/db/postgresRepository.ts": postgresRepository,
        "src/control.ts": 'export const control = "strict";\n',
        "tests/positive.test.ts":
          'import { control } from "../src/control.js"; test("postgres giant close", () => expect(control).toBe("strict"));\n',
        "tests/negative.test.ts":
          'import { control } from "../src/control.js"; test("postgres giant negative", () => expect(control).not.toBe("disabled"));\n',
      },
      implementationFiles: ["src/control.ts"],
      positiveTests: ["tests/positive.test.ts"],
      negativeTests: ["tests/negative.test.ts"],
      obligations: [{
        obligation_id: "K-999-C01-P01",
        invariant: "The giant repository remains globally covered while the claim mutation stays atomic.",
        target_path: "src/control.ts",
        target_anchor: "control",
        mutation_operator: "REPLACE_ENUM_LITERAL",
        literal: "strict",
        replacement: "disabled",
        test_files: ["tests/positive.test.ts", "tests/negative.test.ts"],
        mutation_test_path: "tests/positive.test.ts",
        expected_failing_test_names: ["postgres giant close"],
        expected_failure_message_patterns: ["pool.end"],
      }],
    });
    try {
      const plan = await syntheticPlan({
        document: fixture.traceability,
        requirementId: "K-999",
        repoRoot: fixture.root,
        documentPath: fixture.documentPath,
      });
      const repositorySelections = plan.shards.flatMap((shard: any) =>
        shard.content_selections.filter((selection: any) =>
          selection.path === "src/db/postgresRepository.ts"));
      const ownedRepositorySelections = repositorySelections.filter((selection: any) =>
        selection.role === "COVERAGE");
      expect(new Set(ownedRepositorySelections.map((selection: any) => selection.semantic_unit_id)).size)
        .toBe(ownedRepositorySelections.length);
      expect(ownedRepositorySelections.length).toBeGreaterThan(100);
      expect(ownedRepositorySelections.every((selection: any) =>
        selection.boundary_kind === "TYPESCRIPT_AST_SYMBOL_OR_STATEMENT_RANGE")).toBe(true);
      expect(plan.shards.every((shard: any) =>
        shard.capacity.conservative_total_tokens <= 400_000)).toBe(true);
      const closeOffset = Buffer.byteLength(
        postgresRepository.slice(0, postgresRepository.indexOf("async close()")), "utf8",
      );
      const closeBodyOffset = Buffer.byteLength(
        postgresRepository.slice(0, postgresRepository.indexOf("await this.pool.end();")), "utf8",
      );
      const closeSelection = ownedRepositorySelections.find((selection: any) =>
        selection.start_offset_bytes <= closeOffset &&
        selection.end_offset_bytes > closeBodyOffset);
      expect(closeSelection).toMatchObject({
        boundary_kind: "TYPESCRIPT_AST_SYMBOL_OR_STATEMENT_RANGE",
      });
      expect(closeSelection.size_bytes).toBeLessThan(400_000);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }, 60_000);

  it("plans the real current K-013/K-015 tree with exact path, edge, semantic-unit and chunk unions", async () => {
    const fixture = await writeCurrentK013K015PlanningProjection();
    try {
      const sourceSnapshotContext = await syntheticSourceSnapshotContext(
        fixture.traceability, fixture.root, fixture.documentPath,
      );
      const plan = await deriveIndependentReviewDocumentPlan({
        document: fixture.traceability,
        repoRoot: fixture.root,
        documentPath: fixture.documentPath,
        sourceSnapshotContext,
      });
      const shards = plan.requirement_plans.flatMap((item: any) => item.shards);
      const assignedEdges = shards.flatMap((shard: any) =>
        shard.dependency_edges.map((edge: any) => edge.id));
      const ownedEdges = shards.flatMap((shard: any) => shard.owned_dependency_edge_ids);
      const ownedUnits = shards.flatMap((shard: any) => shard.owned_content_unit_ids);
      const ownedChunks = shards.flatMap((shard: any) => shard.owned_transport_chunk_ids);
      expect(plan.expected_paths.length).toBeGreaterThanOrEqual(550);
      expect(plan.expected_dependency_edges.length).toBeGreaterThanOrEqual(900);
      expect(new Set(assignedEdges).size).toBe(plan.expected_dependency_edges.length);
      expect([...new Set(assignedEdges)].sort()).toEqual(plan.expected_dependency_edges);
      expect(ownedEdges.length).toBe(plan.expected_dependency_edges.length);
      expect(new Set(ownedEdges).size).toBe(ownedEdges.length);
      expect([...ownedEdges].sort()).toEqual(plan.expected_dependency_edges);
      expect(ownedUnits.length).toBe(plan.expected_content_unit_ids.length);
      expect(new Set(ownedUnits).size).toBe(ownedUnits.length);
      expect([...ownedUnits].sort()).toEqual(plan.expected_content_unit_ids);
      expect(ownedChunks.length).toBe(plan.expected_transport_chunk_ids.length);
      expect(new Set(ownedChunks).size).toBe(ownedChunks.length);
      expect([...ownedChunks].sort()).toEqual(plan.expected_transport_chunk_ids);
      expect(shards.every((shard: any) => shard.capacity.conservative_total_tokens <= 360_000)).toBe(true);
      expect(shards.every((shard: any) => shard.dependency_edges.length <= 24)).toBe(true);
      for (const shard of shards) {
        const adjacency = new Map<string, Set<string>>(shard.paths.map((path: string) => [path, new Set()]));
        for (const edge of shard.dependency_edges) {
          adjacency.get(edge.importer)?.add(edge.dependency);
          adjacency.get(edge.dependency)?.add(edge.importer);
        }
        const reachable = new Set<string>(shard.core_paths);
        const queue = [...reachable];
        while (queue.length > 0) {
          const current = queue.shift()!;
          for (const neighbor of adjacency.get(current) ?? []) {
            if (reachable.has(neighbor)) continue;
            reachable.add(neighbor);
            queue.push(neighbor);
          }
        }
        for (const edge of shard.dependency_edges) {
          expect(reachable.has(edge.importer)).toBe(true);
          expect(reachable.has(edge.dependency)).toBe(true);
        }
      }
      expect(plan.planned_review_turn_count).toBeLessThanOrEqual(plan.document_review_turn_budget_max);
      expect(plan.total_duplicated_bytes).toBeLessThanOrEqual(plan.document_duplicated_bytes_budget_max);
      expect(plan.global_peripheral_owner_requirement_id).toBe("K-015");
      expect(shards.some((shard: any) => shard.content_selections.some((selection: any) =>
        selection.path === "src/db/postgresRepository.ts"))).toBe(true);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }, 120_000);

  it("executes the catalog-bound atomic mutation and requires its named failing assertion", async () => {
    const fixture = await writeIndependentReviewFixture();
    try {
      const receipt = await createIndependentReviewObligationProbeReceipt({
        document: fixture.traceability,
        requirementId: "K-999",
        claimId: "K-999-C01",
        obligationId: "K-999-C01-P01",
        repoRoot: fixture.root,
        documentPath: fixture.documentPath,
        sourceFingerprint: SOURCE_FINGERPRINT,
        inspectionNonce: "7".repeat(32),
        probeNonce: "8".repeat(32),
        sourceSnapshotContext: fixture.sourceSnapshotContext,
      });
      expect(receipt.expectation_met).toBe(true);
      expect(receipt.mutated.result.tests).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "positive control", state: "failed" }),
      ]));
      fixture.traceability.requirements[0].control_claims[0]
        .probe_obligations[0].expected_failing_test_names = ["a different assertion"];
      await writeFile(fixture.documentPath, `${JSON.stringify(fixture.traceability, null, 2)}\n`);
      const changedSourceSnapshotContext = await syntheticSourceSnapshotContext(
        fixture.traceability, fixture.root, fixture.documentPath,
      );
      await expect(createIndependentReviewObligationProbeReceipt({
        document: fixture.traceability,
        requirementId: "K-999",
        claimId: "K-999-C01",
        obligationId: "K-999-C01-P01",
        repoRoot: fixture.root,
        documentPath: fixture.documentPath,
        sourceFingerprint: SOURCE_FINGERPRINT,
        inspectionNonce: "7".repeat(32),
        probeNonce: "8".repeat(32),
        sourceSnapshotContext: changedSourceSnapshotContext,
      })).rejects.toThrow("EXPECTED_TEST_DID_NOT_FAIL");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }, 60_000);

  it("closes only the exact plan shard multiset and rejects an aggregate with one shard omitted", async () => {
    const fixture = await writeIndependentReviewFixture();
    try {
      const generated = await writeShardAggregateFixture(fixture);
      const executionReceipts: Array<Record<string, unknown>> = [];
      const sourceSnapshotContext = generated.plan.documentPlan.reviewCapture.sourceSnapshotContext;
      const runtime = await deriveObservedIndependentReviewRuntimeIdentity({
        repoRoot: fixture.root,
        sourceSnapshotContext,
      });
      const result = await verifyIndependentReviewAggregateClosure({
        document: fixture.traceability,
        requirement: fixture.traceability.requirements[0],
        closure: generated.closure,
        reviewArtifactPath: generated.aggregatePath,
        expectedReviewArtifactSha256: reviewSha256(await readFile(generated.aggregatePath)),
        expectedSourceFingerprint: SOURCE_FINGERPRINT,
        repoRoot: fixture.root,
        documentPath: fixture.documentPath,
        allowedCodexExecutablePaths: [fixture.codexPath],
        reviewTestExecutor: passingTestExecutor,
        reviewExecutionReceipts: executionReceipts,
        sourceSnapshotContext,
        approvedReviewRuntimeSha256: runtime.observed_review_runtime_sha256,
      });
      expect(result.finalVerdict.decision).toBe("CLOSED");
      expect(executionReceipts.length).toBeGreaterThan(0);

      fixture.traceability.requirements[0].closure = {
        ...generated.closure,
        reviewer_role: "Independent Acceptance Reviewer",
        review_artifact: relative(fixture.round, generated.aggregatePath),
        review_artifact_sha256: reviewSha256(await readFile(generated.aggregatePath)),
      };
      fixture.traceability.requirements[0].closure.review_artifact =
        relative(fixture.round, fixture.summaryPath);
      fixture.traceability.requirements[0].closure.review_artifact_sha256 =
        reviewSha256(await readFile(fixture.summaryPath));
      await writeFile(fixture.documentPath, `${JSON.stringify(fixture.traceability, null, 2)}\n`);
      const validationContext = await syntheticSourceSnapshotContext(
        fixture.traceability, fixture.root, fixture.documentPath,
      );
      expect((await validateTraceabilityReferences(fixture.traceability, {
        repoRoot: fixture.root,
        documentPath: fixture.documentPath,
        expectedSourceFingerprint: SOURCE_FINGERPRINT,
        allowedCodexExecutablePaths: [fixture.codexPath],
        reviewTestExecutor: passingTestExecutor,
        sourceSnapshotContext: validationContext,
        approvedReviewRuntimeSha256: runtime.observed_review_runtime_sha256,
        testOnlyAllowUnapprovedControlCatalog: true,
      })).join("\n")).toContain("INDEPENDENT_REVIEW_AGGREGATE");

      generated.aggregate.shards = generated.aggregate.shards.slice(1);
      await writeFile(generated.aggregatePath, `${JSON.stringify(generated.aggregate, null, 2)}\n`);
      await expect(verifyIndependentReviewAggregateClosure({
        document: fixture.traceability,
        requirement: fixture.traceability.requirements[0],
        closure: generated.closure,
        reviewArtifactPath: generated.aggregatePath,
        expectedReviewArtifactSha256: reviewSha256(await readFile(generated.aggregatePath)),
        expectedSourceFingerprint: SOURCE_FINGERPRINT,
        repoRoot: fixture.root,
        documentPath: fixture.documentPath,
        allowedCodexExecutablePaths: [fixture.codexPath],
        reviewTestExecutor: passingTestExecutor,
        sourceSnapshotContext,
        approvedReviewRuntimeSha256: runtime.observed_review_runtime_sha256,
      })).rejects.toThrow("INDEPENDENT_REVIEW_AGGREGATE_SHARD_COVERAGE_INVALID");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects an extra completed reviewer command that failed even when every expected command passed", async () => {
    const fixture = await writeIndependentReviewFixture();
    try {
      const generated = await writeShardAggregateFixture(fixture);
      const shard = generated.plan.shards[0];
      const summaryPath = join(generated.shardDirectory, `${shard.shard_id}.json`);
      const summary = JSON.parse(await readFile(summaryPath, "utf8"));
      const eventsArtifact = summary.raw_artifacts.find((item: any) =>
        item.artifact_type === "CODEX_EVENTS_JSONL");
      const eventsPath = join(generated.shardDirectory, eventsArtifact.path);
      const events = (await readFile(eventsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      events.splice(-2, 0, {
        type: "item.completed",
        item: {
          type: "command_execution",
          id: "failed-extra-command",
          command: "false",
          aggregated_output: "",
          status: "completed",
          exit_code: 1,
        },
      });
      const eventsBytes = Buffer.from(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
      await writeFile(eventsPath, eventsBytes);
      eventsArtifact.sha256 = reviewSha256(eventsBytes);
      eventsArtifact.size_bytes = eventsBytes.length;
      await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
      await expect(verifyIndependentReviewShardArtifact({
        document: fixture.traceability,
        documentPath: fixture.documentPath,
        requirementId: "K-999",
        claimId: shard.claim_id,
        shardId: shard.shard_id,
        artifactPath: summaryPath,
        expectedArtifactSha256: reviewSha256(await readFile(summaryPath)),
        expectedSourceFingerprint: SOURCE_FINGERPRINT,
        repoRoot: fixture.root,
        allowedCodexExecutablePaths: [fixture.codexPath],
      })).rejects.toThrow("INDEPENDENT_REVIEW_SHARD_RAW_COMMAND_FAILED");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("resolves NodeNext JavaScript specifiers back to their reviewed TypeScript source", async () => {
    await expect(resolveIndependentReviewLocalModulePath(
      process.cwd(),
      "src/services/xeroAccountingCaseService.ts",
      "../policy/xeroSingaporeAccountingPolicy.js",
    )).resolves.toBe("src/policy/xeroSingaporeAccountingPolicy.ts");
    await expect(resolveIndependentReviewLocalModulePath(
      process.cwd(),
      "src/services/xeroAccountingCaseService.ts",
      "../domain/accountingCaseSchemas.js",
    )).resolves.toBe("src/domain/accountingCaseSchemas.ts");
    await expect(resolveIndependentReviewLocalModulePath(
      process.cwd(),
      "src/services/xeroAccountingCaseService.ts",
      "../../outside.js",
    )).resolves.toBeUndefined();
  });

  it("maps a reviewed control to its direct consumer and that consumer's dependencies", async () => {
    const root = await mkdtemp(join(tmpdir(), "independent-review-dependency-"));
    try {
      // frozenReviewTypescriptParser resolves TypeScript from this root, so the
      // fixture needs the same frozen toolchain every other test here installs.
      await installFrozenTypescriptFixture(root);
      await mkdir(join(root, "src"), { recursive: true });
      await Promise.all([
        writeFile(join(root, "src/control.ts"), "export const control = true;\n"),
        writeFile(join(root, "src/helper.ts"), "export const helper = true;\n"),
        writeFile(join(root, "src/consumer.ts"),
          'import { control } from "./control.js";\nimport { helper } from "./helper.js";\nexport const outcome = control && helper;\n'),
        writeFile(join(root, "src/outer-consumer.ts"),
          'import { outcome } from "./consumer.js";\nexport const externallyVisible = outcome;\n'),
      ]);
      const mapping = await deriveIndependentReviewDependencyMappings({
        document: { requirements: [] },
        allIds: ["K-998", "K-999"],
        repoRoot: root,
        universePaths: ["src/consumer.ts", "src/control.ts", "src/helper.ts", "src/outer-consumer.ts"],
        references: new Map([["src/control.ts", ["K-999:implementation_files:src/control.ts"]]]),
        contentByPath: new Map(await Promise.all([
          "src/consumer.ts", "src/control.ts", "src/helper.ts", "src/outer-consumer.ts",
        ].map(async (path) => [path, await readFile(join(root, path))] as const))),
      });
      expect([...mapping.get("src/consumer.ts") ?? []]).toContain("K-999");
      expect([...mapping.get("src/helper.ts") ?? []]).toContain("K-999");
      expect([...mapping.get("src/outer-consumer.ts") ?? []]).toContain("K-999");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("emits every universe byte in lossless batches and rejects non-implementation probe targets", async () => {
    const fixture = await writeIndependentReviewFixture();
    try {
      const receipt = await createIndependentReviewInputReceipt({
        document: fixture.traceability,
        requirementIds: ["K-999"],
        repoRoot: fixture.root,
        documentPath: fixture.documentPath,
        sourceFingerprint: SOURCE_FINGERPRINT,
        nonce: fixture.invocation.inspection_nonce,
      });
      expect(receipt.files.length).toBeGreaterThan(0);
      expect(receipt.files.every((file: any) => Array.isArray(file.content_chunks) && file.content_chunks.length > 0)).toBe(true);
      for (const file of receipt.files as Array<any>) {
        const reconstructed = Buffer.concat(file.content_chunks.map((chunk: any) =>
          chunk.encoding === "utf8" ? Buffer.from(chunk.content, "utf8") : Buffer.from(chunk.content, "base64")));
        expect(reviewSha256(reconstructed)).toBe(file.sha256);
        expect(file.content_chunks.map((chunk: any) => chunk.offset_bytes)).toEqual(
          file.content_chunks.map((_: any, index: number) =>
            file.content_chunks.slice(0, index).reduce((sum: number, chunk: any) => sum + chunk.size_bytes, 0)),
        );
      }
      const batches = Array.from({ length: receipt.content_chunk_count }, (_, index) =>
        createIndependentReviewInputChunkReceipt(receipt, index));
      expect(batches.every((batch: any) => batch.receipt_kind === "INDEPENDENT_REVIEW_INPUT_BATCH_READ" &&
        Buffer.byteLength(JSON.stringify(batch), "utf8") <= 64 * 1024 && batch.entries.length > 0)).toBe(true);
      expect(batches.flatMap((batch: any) => batch.entries).length).toBe(receipt.content_source_chunk_count);

      await expect(createIndependentReviewFalsificationProbeReceipt({
        document: fixture.traceability,
        requirementId: "K-999",
        repoRoot: fixture.root,
        documentPath: fixture.documentPath,
        sourceFingerprint: SOURCE_FINGERPRINT,
        inspectionNonce: fixture.invocation.inspection_nonce,
        probe: {
          probe_nonce: "2".repeat(32),
          counterexample: "If negative becomes disabled in the test itself, this mutates a test rather than implementation.",
          target_path: "tests/example-negative.test.ts",
          test_path: "tests/example-positive.test.ts",
          literal: "negative",
          replacement: "disabled",
        },
        sourceSnapshotContext: fixture.sourceSnapshotContext,
      })).rejects.toThrow("IMPLEMENTATION_TARGET_REQUIRED");

      await writeFile(join(fixture.root, "src/example.ts"), Buffer.alloc(512 * 1024 + 1, "x"));
      const oversizedTextReceipt = await createIndependentReviewInputReceipt({
        document: fixture.traceability,
        requirementIds: ["K-999"],
        repoRoot: fixture.root,
        documentPath: fixture.documentPath,
        sourceFingerprint: SOURCE_FINGERPRINT,
        nonce: fixture.invocation.inspection_nonce,
      });
      const oversizedText = oversizedTextReceipt.files.find((file: any) => file.path === "src/example.ts")!;
      expect(oversizedText.content_chunks.length).toBeGreaterThan(10);
      expect(Buffer.concat(oversizedText.content_chunks.map((chunk: any) => Buffer.from(chunk.content, "utf8"))))
        .toEqual(Buffer.alloc(512 * 1024 + 1, "x"));

      await writeFile(join(fixture.root, "src/example.ts"), Buffer.alloc(64 * 1024 + 1, 0xff));
      const oversizedBinaryReceipt = await createIndependentReviewInputReceipt({
        document: fixture.traceability,
        requirementIds: ["K-999"],
        repoRoot: fixture.root,
        documentPath: fixture.documentPath,
        sourceFingerprint: SOURCE_FINGERPRINT,
        nonce: fixture.invocation.inspection_nonce,
      });
      const oversizedBinary = oversizedBinaryReceipt.files.find((file: any) => file.path === "src/example.ts")!;
      expect(oversizedBinary.content_chunks.length).toBeGreaterThan(1);
      expect(Buffer.concat(oversizedBinary.content_chunks.map((chunk: any) => Buffer.from(chunk.content, "base64"))))
        .toEqual(Buffer.alloc(64 * 1024 + 1, 0xff));

      await writeFile(join(fixture.root, "src/example.ts"), Buffer.alloc(64 * 1024 + 1, 0));
      const escapedReceipt = await createIndependentReviewInputReceipt({
        document: fixture.traceability,
        requirementIds: ["K-999"],
        repoRoot: fixture.root,
        documentPath: fixture.documentPath,
        sourceFingerprint: SOURCE_FINGERPRINT,
        nonce: fixture.invocation.inspection_nonce,
      });
      const escapedFile = escapedReceipt.files.find((file: any) => file.path === "src/example.ts")!;
      expect(escapedFile.content_chunks.every((chunk: any) => chunk.encoding === "base64")).toBe(true);
      for (let index = 0; index < escapedReceipt.content_chunk_count; index += 1) {
        expect(Buffer.byteLength(JSON.stringify(
          createIndependentReviewInputChunkReceipt(escapedReceipt, index),
        ), "utf8")).toBeLessThanOrEqual(64 * 1024);
      }

      await writeFile(join(fixture.root, "src/example.ts"), Buffer.alloc(1024 * 1024 + 1, "z"));
      await expect(createIndependentReviewInputReceipt({
        document: fixture.traceability,
        requirementIds: ["K-999"],
        repoRoot: fixture.root,
        documentPath: fixture.documentPath,
        sourceFingerprint: SOURCE_FINGERPRINT,
        nonce: fixture.invocation.inspection_nonce,
      })).rejects.toThrow("SHARD_CAPACITY_EXCEEDED");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("derives every acceptance source and root config independently of citations without Git", async () => {
    const fixture = await writePlanFixture({
      files: {
        "src/current.ts": "export const current = true;\n",
        "src/domain/accountingCaseContinuation.ts": "export const continuation = true;\n",
        "scripts/release/build-accepted-oci-image.mjs": "export const build = true;\n",
        "scripts/verify-accepted-oci-release.mjs": "export const verify = true;\n",
        "scripts/require-test-database-url.mjs": "export const requireDatabase = true;\n",
        "migrations/035_accounting_case_business_reservation_scopes.sql": "select 1;\n",
        "vitest.config.ts": "export default { passWithNoTests: true };\n",
        "tests/positive.test.ts": "test('current', () => expect(true).toBe(true));\n",
        "tests/negative.test.ts": "test('negative', () => expect(false).toBe(false));\n",
      },
      implementationFiles: ["src/current.ts"],
      positiveTests: ["tests/positive.test.ts"],
      negativeTests: ["tests/negative.test.ts"],
      obligations: [{
        obligation_id: "K-999-C01-P01",
        invariant: "Every acceptance source byte is in the frozen universe.",
        target_path: "src/current.ts",
        target_anchor: "current",
        mutation_operator: "FLIP_BOOLEAN_LITERAL",
        literal: "true",
        replacement: "false",
        test_files: ["tests/positive.test.ts", "tests/negative.test.ts"],
        mutation_test_path: "tests/positive.test.ts",
        expected_failing_test_names: ["current"],
        expected_failure_message_patterns: ["true"],
      }],
    });
    try {
      const sourceSnapshotContext = await syntheticSourceSnapshotContext(
        fixture.traceability, fixture.root, fixture.documentPath,
      );
      const universe = await deriveIndependentReviewUniverse({
        document: fixture.traceability,
        requirementIds: ["K-999"],
        repoRoot: fixture.root,
        documentPath: fixture.documentPath,
        sourceSnapshotContext,
      });
      const byPath = new Map(universe.entries.map((entry: any) => [entry.path, entry]));
      for (const requiredPath of [
        "scripts/release/build-accepted-oci-image.mjs",
        "scripts/verify-accepted-oci-release.mjs",
        "migrations/035_accounting_case_business_reservation_scopes.sql",
        "src/domain/accountingCaseContinuation.ts",
        "scripts/require-test-database-url.mjs",
        "vitest.config.ts",
      ]) {
        expect(byPath.get(requiredPath), requiredPath).toMatchObject({ mapped_requirement_ids: ["K-999"] });
      }
      expect(byPath.get("vitest.config.ts")?.reasons).toContain("ROOT_AUTO_CONFIG_CANDIDATE");
      expect(byPath.get("scripts/require-test-database-url.mjs")?.reasons)
        .toContain("FULL_ACCEPTANCE_SOURCE_SNAPSHOT");
      expect(universe.baseline).toMatchObject({ kind: "FULL_ACCEPTANCE_SOURCE_SNAPSHOT" });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }, 60_000);

  it("uses full current roots and never resurrects deleted bytes from candidate Git", async () => {
    const fixture = await writePlanFixture({
      files: {
        "src/current.ts": "export const current = true;\n",
        "src/deleted-critical.ts": "export const baselineSafetyControl = true;\n",
        "tests/positive.test.ts": "test('current', () => expect(true).toBe(true));\n",
        "tests/negative.test.ts": "test('negative', () => expect(false).toBe(false));\n",
      },
      implementationFiles: ["src/current.ts"],
      positiveTests: ["tests/positive.test.ts"],
      negativeTests: ["tests/negative.test.ts"],
      obligations: [{
        obligation_id: "K-999-C01-P01",
        invariant: "Current bytes are reviewed without a candidate Git baseline.",
        target_path: "src/current.ts",
        target_anchor: "current",
        mutation_operator: "FLIP_BOOLEAN_LITERAL",
        literal: "true",
        replacement: "false",
        test_files: ["tests/positive.test.ts", "tests/negative.test.ts"],
        mutation_test_path: "tests/positive.test.ts",
        expected_failing_test_names: ["current"],
        expected_failure_message_patterns: ["true"],
      }],
    });
    try {
      await rm(join(fixture.root, "src/deleted-critical.ts"));
      const receipt = await createIndependentReviewInputReceipt({
        document: fixture.traceability,
        requirementIds: ["K-999"],
        repoRoot: fixture.root,
        documentPath: fixture.documentPath,
        sourceFingerprint: SOURCE_FINGERPRINT,
        nonce: "3".repeat(32),
      });
      expect(receipt.review_universe.baseline.kind).toBe("FULL_ACCEPTANCE_SOURCE_SNAPSHOT");
      expect(receipt.files.some((file: any) => file.path === "src/deleted-critical.ts")).toBe(false);
      expect(receipt.files.some((file: any) => file.path === "src/current.ts")).toBe(true);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("never invokes PATH Git, reads replacement races through one descriptor, and rejects source symlinks", async () => {
    const fixture = await writePlanFixture({
      files: {
        "src/current.ts": "export const captured = 'original';\n",
        "src/replacement.ts": "export const captured = 'replacement';\n",
        "tests/positive.test.ts": "test('current', () => expect(true).toBe(true));\n",
        "tests/negative.test.ts": "test('negative', () => expect(false).toBe(false));\n",
      },
      implementationFiles: ["src/current.ts"],
      positiveTests: ["tests/positive.test.ts"],
      negativeTests: ["tests/negative.test.ts"],
      obligations: [{
        obligation_id: "K-999-C01-P01",
        invariant: "The source snapshot uses one non-following file descriptor.",
        target_path: "src/current.ts",
        target_anchor: "captured",
        mutation_operator: "REPLACE_ENUM_LITERAL",
        literal: "original",
        replacement: "disabled",
        test_files: ["tests/positive.test.ts", "tests/negative.test.ts"],
        mutation_test_path: "tests/positive.test.ts",
        expected_failing_test_names: ["current"],
        expected_failure_message_patterns: ["expected"],
      }],
    });
    const bin = join(fixture.root, "candidate-bin");
    const gitMarker = join(fixture.root, "candidate-git-called");
    const target = join(fixture.root, "src/current.ts");
    const replacement = join(fixture.root, "src/replacement.ts");
    const displaced = join(fixture.root, "src/current.displaced");
    const previousPath = process.env.PATH;
    try {
      await mkdir(bin, { recursive: true });
      const fakeGit = join(bin, "git");
      await writeFile(fakeGit, `#!/bin/sh\nprintf called > '${gitMarker}'\nexit 99\n`);
      await chmod(fakeGit, 0o755);
      process.env.PATH = `${bin}:${previousPath ?? ""}`;
      registerIndependentReviewSnapshotDescriptorReadTestHook(async ({ phase, path }: any) => {
        if (path !== target) return false;
        if (phase === "after_open") {
          await rename(target, displaced);
          await rename(replacement, target);
          return true;
        }
        if (phase === "after_read") {
          await rename(target, replacement);
          await rename(displaced, target);
          return true;
        }
        return false;
      });
      const context = await captureIndependentReviewSourceSnapshotContext({ repoRoot: fixture.root });
      expect(context.contentByPath.get("src/current.ts")?.toString("utf8"))
        .toBe("export const captured = 'original';\n");
      expect(await readFile(target, "utf8")).toBe("export const captured = 'original';\n");
      await expect(readFile(gitMarker)).rejects.toMatchObject({ code: "ENOENT" });

      await symlink("current.ts", join(fixture.root, "src/symlink.ts"));
      await expect(captureIndependentReviewSourceSnapshotContext({ repoRoot: fixture.root }))
        .rejects.toThrow("INDEPENDENT_REVIEW_SOURCE_SNAPSHOT_SYMLINK:src/symlink.ts");
    } finally {
      registerIndependentReviewSnapshotDescriptorReadTestHook(undefined);
      process.env.PATH = previousPath;
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("accepts harness-run evidence only as an exact host-sealed supplemental set", async () => {
    const root = await mkdtemp(join(tmpdir(), "independent-review-host-harness-"));
    const evidencePath = "artifacts/harness-runs/run-1/oracle-results.json";
    try {
      await Promise.all([
        mkdir(join(root, "src"), { recursive: true }),
        mkdir(dirname(join(root, evidencePath)), { recursive: true }),
      ]);
      await writeFile(join(root, "src/example.ts"), "export const example = true;\n");
      const evidenceBytes = Buffer.from('{"verified":true}\n');
      await writeFile(join(root, evidencePath), evidenceBytes);
      await expect(captureIndependentReviewSourceSnapshotContext({
        repoRoot: root,
        extraPaths: [evidencePath],
      })).rejects.toThrow(`INDEPENDENT_REVIEW_SUPPLEMENTAL_PATH_FORBIDDEN:${evidencePath}`);

      const source = await captureIndependentReviewSourceSnapshotContext({ repoRoot: root });
      const entry = {
        path: evidencePath,
        size_bytes: evidenceBytes.length,
        executable: false,
        sha256: reviewSha256(evidenceBytes),
      };
      const supplementalIdentity = {
        schema_version: "1.0",
        algorithm: "exact-round-artifact-supplement-v1",
        paths: [evidencePath],
        path_count: 1,
        total_bytes: evidenceBytes.length,
        entries: [entry],
      };
      const gate = {
        schema_version: "1.0",
        authority: "APPROVED_REVIEW_HOST",
        gate_run_id: "11111111-1111-4111-8111-111111111111",
        live_challenge: "c".repeat(64),
      };
      const immutableSnapshotAttestation = {
        ...gate,
        snapshot_root: root,
        source_snapshot_sha256: source.source_snapshot_sha256,
      };
      const supplementalImmutableInputs = {
        ...gate,
        entries: [entry],
        contentByPath: new Map([[evidencePath, evidenceBytes]]),
        supplemental_inputs_sha256: reviewSha256(stableReviewStringify(supplementalIdentity)),
      };
      const captured = await captureIndependentReviewSourceSnapshotContext({
        repoRoot: root,
        extraPaths: [evidencePath],
        immutableSnapshotAttestation,
        supplementalImmutableInputs,
      });
      expect(captured.supplemental_entries).toEqual([entry]);
      await expect(captureIndependentReviewSourceSnapshotContext({
        repoRoot: root,
        extraPaths: [evidencePath],
        immutableSnapshotAttestation,
        supplementalImmutableInputs: {
          ...supplementalImmutableInputs,
          contentByPath: new Map([[evidencePath, Buffer.from("patched")]]),
        },
      })).rejects.toThrow(`INDEPENDENT_REVIEW_SUPPLEMENTAL_CONTENT_MISMATCH:${evidencePath}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("covers a directed edge crossing K-013 and K-015 in the exact frozen document-plan union", async () => {
    const root = await mkdtemp(join(tmpdir(), "independent-review-cross-requirement-"));
    const round = join(root, "artifacts/round");
    try {
      await installFrozenTypescriptFixture(root);
      await Promise.all([
        mkdir(join(root, "src"), { recursive: true }),
        mkdir(join(root, "tests"), { recursive: true }),
        mkdir(join(root, "migrations"), { recursive: true }),
        mkdir(join(root, "scripts/review"), { recursive: true }),
        mkdir(join(root, "schemas"), { recursive: true }),
        mkdir(round, { recursive: true }),
      ]);
      await Promise.all([
        writeFile(join(root, "src/release.ts"), "export const release = true;\n"),
        writeFile(join(root, "migrations/039.sql"), "select 39;\n"),
        writeFile(join(root, "scripts/review/peripheral.mjs"), "export const peripheral = true;\n"),
        writeFile(join(root, "tests/release.test.ts"),
          'import { release } from "../src/release.js"; new URL("../migrations/039.sql", import.meta.url); test("release", () => expect(release).toBe(true));\n'),
        writeFile(join(root, "tests/review.test.ts"),
          'new URL("../migrations/039.sql", import.meta.url); test("review", () => expect(true).toBe(true));\n'),
        writeFile(join(round, "evidence.json"), "{}\n"),
      ]);
      const makeObligation = (id: string, target: string, test: string) => ({
        obligation_id: `${id}-P01`,
        invariant: `Invariant for ${id}.`,
        target_path: target,
        target_anchor: target.includes("release") ? "release" : "select",
        mutation_operator: "REPLACE_EXACT_LITERAL",
        literal: target.includes("release") ? "true" : "39",
        replacement: target.includes("release") ? "false" : "40",
        test_files: [test],
        mutation_test_path: test,
        expected_failing_test_names: [target.includes("release") ? "release" : "review"],
        expected_failure_message_patterns: [target.includes("release") ? "release" : "review"],
      });
      const makeRequirement = (requirementId: string, implementation: string, test: string) => {
        const claimId = `${requirementId}-C01`;
        const control = `Canonical ${requirementId} control.`;
        const claim = {
          claim_id: claimId,
          source_clause_id: claimId,
          control,
          evidence: ["evidence.json"],
          implementation_files: [implementation],
          positive_tests: [test],
          negative_or_mutation_tests: [test],
          probe_obligations: [makeObligation(claimId, implementation, test)],
        };
        return {
          requirement_id: requirementId,
          business_risk: `${requirementId} risk.`,
          design_control: control,
          control_claims: [claim],
          implementation_files: [implementation],
          positive_tests: [test],
          negative_or_mutation_tests: [test],
          implementation_owner: "/root",
          reviewer: "Independent reviewer",
          status: "FIXED_PENDING_REVIEW",
          evidence: ["evidence.json"],
          residual_risk: "None in fixture.",
        };
      };
      const traceability = {
        schema_version: "4.0",
        round_id: "cross-requirement-fixture",
        generated_at: "2026-08-14T00:00:00.000Z",
        evidence_boundary: "Synthetic cross-requirement graph fixture.",
        control_catalog: {
          path: "schemas/ledger-control-clauses.v1.json", schema_version: "1.0", sha256: "0".repeat(64),
        },
        requirements: [
          makeRequirement("K-013", "src/release.ts", "tests/release.test.ts"),
          makeRequirement("K-015", "migrations/039.sql", "tests/review.test.ts"),
        ],
      } as Record<string, any>;
      const catalog = {
        schema_version: "1.0",
        catalog_id: "cross-requirement-fixture",
        source_documents: await Promise.all(traceability.requirements.map(async (requirement: any) => ({
          path: requirement.implementation_files[0],
          sha256: reviewSha256(await readFile(join(root, requirement.implementation_files[0]))),
        }))),
        requirements: traceability.requirements.map((requirement: any) => ({
          requirement_id: requirement.requirement_id,
          business_risk: requirement.business_risk,
          clauses: requirement.control_claims.map((claim: any) => ({
            clause_id: claim.claim_id, control: claim.control,
          })),
        })),
      };
      const catalogBytes = Buffer.from(`${JSON.stringify(catalog, null, 2)}\n`);
      traceability.control_catalog.sha256 = reviewSha256(catalogBytes);
      const documentPath = join(round, "requirements.json");
      await Promise.all([
        writeFile(join(root, "schemas/ledger-control-clauses.v1.json"), catalogBytes),
        writeFile(documentPath, `${JSON.stringify(traceability, null, 2)}\n`),
      ]);
      registerIndependentReviewSyntheticSupplementFixture(traceability);
      const sourceSnapshotContext = await syntheticSourceSnapshotContext(traceability, root, documentPath);
      const documentPlan = await deriveIndependentReviewDocumentPlan({
        document: traceability, repoRoot: root, documentPath, sourceSnapshotContext,
      });
      const crossing = documentPlan.requirement_plans.flatMap((plan: any) =>
        plan.shards.flatMap((shard: any) => shard.dependency_edges))
        .filter((edge: any) => edge.importer === "tests/release.test.ts" &&
          edge.dependency === "migrations/039.sql");
      expect(crossing.length).toBeGreaterThan(0);
      const crossingIds = [...new Set(crossing.map((edge: any) => edge.id))];
      expect(crossingIds).toHaveLength(1);
      expect(documentPlan.expected_dependency_edges).toContain(crossingIds[0]);
      const globalShards = documentPlan.requirement_plans.flatMap((plan: any) =>
        plan.shards.filter((shard: any) => shard.scope_kind === "DOCUMENT_GLOBAL_PERIPHERAL_COVERAGE")
          .map((shard: any) => ({ requirement_id: plan.requirement_id, shard })));
      expect(globalShards.length).toBeGreaterThan(0);
      expect(globalShards.every((item: any) => item.requirement_id === "K-015")).toBe(true);
      expect(new Set(globalShards.map((item: any) => item.shard.shard_id)).size).toBe(globalShards.length);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ignores candidate root Vitest config and rejects zero/silent structured inventories", async () => {
    const fixture = await writeIndependentReviewFixture();
    try {
      await writeFile(join(fixture.root, "vitest.config.ts"),
        "export default { passWithNoTests: true, reporters: [] };\n");
      const sourceSnapshotContext = await syntheticSourceSnapshotContext(
        fixture.traceability, fixture.root, fixture.documentPath,
      );
      const runtime = await deriveObservedIndependentReviewRuntimeIdentity({
        repoRoot: fixture.root, sourceSnapshotContext,
      });
      const plan = await createIndependentReviewTestPlan({
        document: fixture.traceability,
        requirementIds: ["K-999"],
        repoRoot: fixture.root,
        documentPath: fixture.documentPath,
        sourceSnapshotContext,
        approvedReviewRuntimeSha256: runtime.observed_review_runtime_sha256,
      });
      const item = plan.find((candidate: any) => candidate.kind === "VITEST_NODE_API_EXACT_INVENTORY")!;
      expect(item.execution_request).toMatchObject({ config: false, pass_with_no_tests: false });
      expect(sourceSnapshotContext.identityByPath.has("vitest.config.ts")).toBe(true);
      const silent = await passingTestExecutor(item);
      silent.inventory = {
        ...silent.inventory,
        module_count: 0,
        test_count: 0,
        passed: 0,
        modules: [],
      };
      expect(() => verifyIndependentReviewTestExecutionResult(item, silent))
        .toThrow("INDEPENDENT_REVIEW_TEST_INVENTORY_NOT_EXACT_GREEN");
      const skipped = await passingTestExecutor(item);
      skipped.inventory.skipped = 1;
      skipped.inventory.passed -= 1;
      skipped.inventory.modules[0].tests[0].state = "skipped";
      expect(() => verifyIndependentReviewTestExecutionResult(item, skipped))
        .toThrow("INDEPENDENT_REVIEW_TEST_INVENTORY_NOT_EXACT_GREEN");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects a patched candidate Vitest runtime against the host-approved closure hash", async () => {
    const fixture = await writeRuntimeIdentityPlanFixture();
    try {
      const { runtime, sourceSnapshotContext } = await fixtureTestPlan(fixture);
      await replaceFixtureRuntimeFile(
        join(fixture.root, "node_modules/vitest/vitest.mjs"),
        "// patched candidate runner\n",
      );
      await expect(createIndependentReviewTestPlan({
        document: fixture.traceability,
        requirementIds: ["K-999"],
        repoRoot: fixture.root,
        documentPath: fixture.documentPath,
        sourceSnapshotContext,
        approvedReviewRuntimeSha256: runtime.observed_review_runtime_sha256,
      })).rejects.toThrow("INDEPENDENT_REVIEW_RUNTIME_NOT_APPROVED");
      await expect(createIndependentReviewTestPlan({
        document: fixture.traceability,
        requirementIds: ["K-999"],
        repoRoot: fixture.root,
        documentPath: fixture.documentPath,
        sourceSnapshotContext,
      })).rejects.toThrow("INDEPENDENT_REVIEW_APPROVED_RUNTIME_REQUIRED");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }, 30_000);

  it("rejects a patched application dependency outside the Vitest and TypeScript tool closure", async () => {
    const fixture = await writeRuntimeIdentityPlanFixture();
    try {
      const { runtime, sourceSnapshotContext } = await fixtureTestPlan(fixture);
      expect(runtime).toMatchObject({
        algorithm: "node-plus-entire-installed-dependency-content-tree-v3",
        installed_dependency_root: "node_modules",
        excluded_dependency_subtree_segment: ".bin",
        dependency_symlink_policy: "REJECT_OUTSIDE_EXCLUDED_DOT_BIN_SUBTREES",
      });
      expect(runtime.node_runtime_identity).toMatchObject({
        executable_path: await realpath(process.execPath),
        version: process.version,
      });
      expect(runtime.node_runtime_identity.executable_sha256)
        .toBe(reviewSha256(await readFile(process.execPath)));
      expect(runtime.dependency_entries.map((entry: any) => entry.path))
        .toContain("node_modules/zod/index.js");
      await replaceFixtureRuntimeFile(
        join(fixture.root, "node_modules/zod/index.js"),
        "// patched application validation dependency\n",
      );
      await expect(createIndependentReviewTestPlan({
        document: fixture.traceability,
        requirementIds: ["K-999"],
        repoRoot: fixture.root,
        documentPath: fixture.documentPath,
        sourceSnapshotContext,
        approvedReviewRuntimeSha256: runtime.observed_review_runtime_sha256,
      })).rejects.toThrow("INDEPENDENT_REVIEW_RUNTIME_NOT_APPROVED");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }, 30_000);

  it("rejects cited tests that can launch an undeclared external toolchain under a Node-only runtime", async () => {
    const fixture = await writePlanFixture({
      files: {
        "src/control.ts": 'export const control = "strict";\n',
        "tests/positive.test.ts":
          'import { spawnSync } from "node:child_process"; import { control } from "../src/control.js"; ' +
          'test("external tool", () => expect([control, typeof spawnSync]).toEqual(["strict", "function"]));\n',
        "tests/negative.test.ts":
          'import { control } from "../src/control.js"; test("disabled", () => expect(control).not.toBe("disabled"));\n',
      },
      implementationFiles: ["src/control.ts"],
      positiveTests: ["tests/positive.test.ts"],
      negativeTests: ["tests/negative.test.ts"],
      obligations: [{
        obligation_id: "K-999-C01-P01",
        invariant: "The strict control remains enforced.",
        target_path: "src/control.ts",
        target_anchor: "control",
        mutation_operator: "REPLACE_ENUM_LITERAL",
        literal: "strict",
        replacement: "disabled",
        test_files: ["tests/positive.test.ts", "tests/negative.test.ts"],
        mutation_test_path: "tests/positive.test.ts",
        expected_failing_test_names: ["external tool"],
        expected_failure_message_patterns: ["strict"],
      }],
    });
    try {
      const sourceSnapshotContext = await syntheticSourceSnapshotContext(
        fixture.traceability,
        fixture.root,
        fixture.documentPath,
      );
      await expect(createIndependentReviewTestPlan({
        document: fixture.traceability,
        requirementIds: ["K-999"],
        repoRoot: fixture.root,
        documentPath: fixture.documentPath,
        sourceSnapshotContext,
        approvedReviewRuntimeSha256: "9".repeat(64),
      })).rejects.toThrow("INDEPENDENT_REVIEW_EXTERNAL_TOOLCHAIN_ATTESTATION_REQUIRED");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }, 30_000);

  it("rejects a cited test whose frozen local dependency launches an external child process", async () => {
    const fixture = await writePlanFixture({
      files: {
        "src/control.ts": 'export const control = "strict";\n',
        "tests/tool-helper.ts":
          'import { spawnSync } from "node:child_process"; export const launch = () => spawnSync("git", ["--version"]);\n',
        "tests/positive.test.ts":
          'import { launch } from "./tool-helper.js"; import { control } from "../src/control.js"; ' +
          'test("transitive external tool", () => expect([control, typeof launch]).toEqual(["strict", "function"]));\n',
        "tests/negative.test.ts":
          'import { control } from "../src/control.js"; test("disabled", () => expect(control).not.toBe("disabled"));\n',
      },
      implementationFiles: ["src/control.ts"],
      positiveTests: ["tests/positive.test.ts"],
      negativeTests: ["tests/negative.test.ts"],
      obligations: [{
        obligation_id: "K-999-C01-P01",
        invariant: "The strict control remains enforced.",
        target_path: "src/control.ts",
        target_anchor: "control",
        mutation_operator: "REPLACE_ENUM_LITERAL",
        literal: "strict",
        replacement: "disabled",
        test_files: ["tests/positive.test.ts", "tests/negative.test.ts"],
        mutation_test_path: "tests/positive.test.ts",
        expected_failing_test_names: ["transitive external tool"],
        expected_failure_message_patterns: ["strict"],
      }],
    });
    await installFrozenRuntimeLockfile(fixture.root);
    try {
      const sourceSnapshotContext = await syntheticSourceSnapshotContext(
        fixture.traceability,
        fixture.root,
        fixture.documentPath,
      );
      // The fixture's own runtime is the approved one here; the check under test is
      // the external-toolchain rule further down, not runtime approval.
      const runtime = await deriveObservedIndependentReviewRuntimeIdentity({
        repoRoot: fixture.root,
        sourceSnapshotContext,
      });
      await expect(createIndependentReviewTestPlan({
        document: fixture.traceability,
        requirementIds: ["K-999"],
        repoRoot: fixture.root,
        documentPath: fixture.documentPath,
        sourceSnapshotContext,
        approvedReviewRuntimeSha256: runtime.observed_review_runtime_sha256,
      })).rejects.toThrow("INDEPENDENT_REVIEW_EXTERNAL_TOOLCHAIN_ATTESTATION_REQUIRED");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }, 30_000);

  it("rejects a cited test whose frozen helper imports a process wrapper package", async () => {
    const fixture = await writePlanFixture({
      files: {
        "src/control.ts": 'export const control = "strict";\n',
        "tests/tool-helper.ts":
          'import { execa } from "execa"; export const launch = () => execa("git", ["--version"]);\n',
        "tests/positive.test.ts":
          'import { launch } from "./tool-helper.js"; import { control } from "../src/control.js"; ' +
          'test("wrapper external tool", () => expect([control, typeof launch]).toEqual(["strict", "function"]));\n',
        "tests/negative.test.ts":
          'import { control } from "../src/control.js"; test("disabled", () => expect(control).not.toBe("disabled"));\n',
      },
      implementationFiles: ["src/control.ts"],
      positiveTests: ["tests/positive.test.ts"],
      negativeTests: ["tests/negative.test.ts"],
      obligations: [{
        obligation_id: "K-999-C01-P01",
        invariant: "The strict control remains enforced.",
        target_path: "src/control.ts",
        target_anchor: "control",
        mutation_operator: "REPLACE_ENUM_LITERAL",
        literal: "strict",
        replacement: "disabled",
        test_files: ["tests/positive.test.ts", "tests/negative.test.ts"],
        mutation_test_path: "tests/positive.test.ts",
        expected_failing_test_names: ["wrapper external tool"],
        expected_failure_message_patterns: ["strict"],
      }],
    });
    await installFrozenRuntimeLockfile(fixture.root);
    try {
      const sourceSnapshotContext = await syntheticSourceSnapshotContext(
        fixture.traceability,
        fixture.root,
        fixture.documentPath,
      );
      // The fixture's own runtime is the approved one here; the check under test is
      // the external-toolchain rule further down, not runtime approval.
      const runtime = await deriveObservedIndependentReviewRuntimeIdentity({
        repoRoot: fixture.root,
        sourceSnapshotContext,
      });
      await expect(createIndependentReviewTestPlan({
        document: fixture.traceability,
        requirementIds: ["K-999"],
        repoRoot: fixture.root,
        documentPath: fixture.documentPath,
        sourceSnapshotContext,
        approvedReviewRuntimeSha256: runtime.observed_review_runtime_sha256,
      })).rejects.toThrow("INDEPENDENT_REVIEW_EXTERNAL_TOOLCHAIN_ATTESTATION_REQUIRED");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }, 30_000);

  it("rejects a mutation probe whose frozen test dependency can launch an external tool", async () => {
    const fixture = await writePlanFixture({
      files: {
        "src/control.ts": 'export const control = "strict";\n',
        "tests/tool-helper.ts":
          'import { execFileSync } from "node:child_process"; export const launch = () => execFileSync("git", ["--version"]);\n',
        "tests/positive.test.ts":
          'import { launch } from "./tool-helper.js"; import { control } from "../src/control.js"; ' +
          'test("probe external tool", () => expect([control, typeof launch]).toEqual(["strict", "function"]));\n',
        "tests/negative.test.ts":
          'import { control } from "../src/control.js"; test("disabled", () => expect(control).not.toBe("disabled"));\n',
      },
      implementationFiles: ["src/control.ts"],
      positiveTests: ["tests/positive.test.ts"],
      negativeTests: ["tests/negative.test.ts"],
      obligations: [{
        obligation_id: "K-999-C01-P01",
        invariant: "The strict control remains enforced.",
        target_path: "src/control.ts",
        target_anchor: "control",
        mutation_operator: "REPLACE_ENUM_LITERAL",
        literal: "strict",
        replacement: "disabled",
        test_files: ["tests/positive.test.ts", "tests/negative.test.ts"],
        mutation_test_path: "tests/positive.test.ts",
        expected_failing_test_names: ["probe external tool"],
        expected_failure_message_patterns: ["strict"],
      }],
    });
    await installFrozenRuntimeLockfile(fixture.root);
    try {
      const sourceSnapshotContext = await syntheticSourceSnapshotContext(
        fixture.traceability,
        fixture.root,
        fixture.documentPath,
      );
      // The fixture's own runtime is the approved one here; the check under test is
      // the external-toolchain rule, not runtime approval.
      const runtime = await deriveObservedIndependentReviewRuntimeIdentity({
        repoRoot: fixture.root,
        sourceSnapshotContext,
      });
      await expect(createIndependentReviewObligationProbeReceipt({
        document: fixture.traceability,
        requirementId: "K-999",
        claimId: "K-999-C01",
        obligationId: "K-999-C01-P01",
        repoRoot: fixture.root,
        documentPath: fixture.documentPath,
        sourceFingerprint: SOURCE_FINGERPRINT,
        inspectionNonce: "7".repeat(32),
        probeNonce: "8".repeat(32),
        sourceSnapshotContext,
        approvedReviewRuntimeSha256: runtime.observed_review_runtime_sha256,
      })).rejects.toThrow("INDEPENDENT_REVIEW_EXTERNAL_TOOLCHAIN_ATTESTATION_REQUIRED");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }, 30_000);

  it("accepts only a source-bound, subject-bound, raw-replayed read-only Codex closure", async () => {
    const fixture = await writeIndependentReviewFixture();
    try {
      const receipts: Array<Record<string, unknown>> = [];
      expect(validateTraceabilityDocument(fixture.traceability, {
        requireClosed: true,
        expectedSourceFingerprint: SOURCE_FINGERPRINT,
      })).toEqual([]);
      expect((await validateTraceabilityReferences(fixture.traceability, {
        repoRoot: fixture.root,
        documentPath: fixture.documentPath,
        allowedCodexExecutablePaths: [fixture.codexPath],
        legacyIndependentReviewFixture: true,
        reviewTestExecutor: async () => ({
          exitCode: 0,
          signal: null,
          error: null,
          overflow: false,
          stdout: Buffer.from("1 test passed\n"),
          stderr: Buffer.alloc(0),
        }),
        testOnlyAllowUnapprovedControlCatalog: true,
      })).join("\n")).toContain("CURRENT_SOURCE_FINGERPRINT_REQUIRED");
      const sourceSnapshotContext = fixture.sourceSnapshotContext;
      const runtime = await deriveObservedIndependentReviewRuntimeIdentity({
        repoRoot: fixture.root,
        sourceSnapshotContext,
      });
      expect((await validateTraceabilityReferences(fixture.traceability, {
        repoRoot: fixture.root,
        documentPath: fixture.documentPath,
        expectedSourceFingerprint: SOURCE_FINGERPRINT,
        reviewTestExecutor: passingTestExecutor,
        legacyIndependentReviewFixture: true,
        sourceSnapshotContext,
        approvedReviewRuntimeSha256: runtime.observed_review_runtime_sha256,
        testOnlyAllowUnapprovedControlCatalog: true,
      })).join("\n")).toContain("executable path is not an approved Codex CLI identity");
      expect(await referenceErrors(fixture, SOURCE_FINGERPRINT, passingTestExecutor, receipts)).toEqual([]);
      expect(receipts).toEqual([expect.objectContaining({
        receipt_kind: "INDEPENDENT_REVIEW_GATE_TEST_PROGRAMMATIC_INVENTORY",
        source_fingerprint: SOURCE_FINGERPRINT,
        review_subject_sha256: fixture.summary.review_subject_sha256,
        review_inputs_sha256: fixture.summary.review_inputs_sha256,
        inventory: expect.objectContaining({ failed: 0, skipped: 0, todo: 0, pending: 0 }),
      })]);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects a hand-authored CLOSED summary even when its digest and identity strings match", async () => {
    const fixture = await writeIndependentReviewFixture();
    try {
      const forged = {
        ...fixture.summary,
        raw_artifacts: [],
      };
      await writeFile(fixture.summaryPath, `${JSON.stringify(forged, null, 2)}\n`);
      fixture.traceability.requirements[0].closure.review_artifact_sha256 =
        reviewSha256(await readFile(fixture.summaryPath));
      expect((await referenceErrors(fixture)).join("\n")).toContain("exact raw artifact set is required");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects stale source or a changed material review subject", async () => {
    const fixture = await writeIndependentReviewFixture();
    try {
      expect((await referenceErrors(fixture, "d".repeat(64))).join("\n")).toContain("source fingerprint");
      await writeFile(join(fixture.round, "evidence.json"), "{\"tampered\":true}\n");
      expect((await referenceErrors(fixture)).join("\n")).toContain("SOURCE_CHANGED_DURING_STANDALONE_CAPTURE");
      await writeFile(join(fixture.round, "evidence.json"), "{}\n");
      fixture.traceability.requirements[0].design_control = "Changed after independent review.";
      expect((await referenceErrors(fixture)).join("\n")).toContain("review subject changed");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects an uncited new critical file even after declared closure hashes are recomputed", async () => {
    const fixture = await writeIndependentReviewFixture();
    try {
      await writeFile(
        join(fixture.root, "src/new-unreferenced-release-critical.ts"),
        "export const hiddenCriticalBypass = true;\n",
      );
      await recomputeDeclaredClosureWithoutFreshInspection(fixture);
      const errors = (await referenceErrors(fixture)).join("\n");
      expect(errors).toContain("SOURCE_CHANGED_DURING_STANDALONE_CAPTURE");
      const currentInputs = await fingerprintIndependentReviewInputs({
        document: fixture.traceability,
        requirementIds: ["K-999"],
        repoRoot: fixture.root,
        documentPath: fixture.documentPath,
      });
      expect(currentInputs.files.find((file: any) => file.path === "src/new-unreferenced-release-critical.ts"))
        .toMatchObject({ mapped_requirement_ids: ["K-999"] });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects an uncited critical byte change even after every declared identity is recomputed", async () => {
    const fixture = await writeIndependentReviewFixture();
    try {
      await writeFile(
        join(fixture.root, "src/unreferenced-critical.ts"),
        "export const uncitedCriticalControl = \"silently-weakened\";\n",
      );
      await recomputeDeclaredClosureWithoutFreshInspection(fixture);
      const errors = (await referenceErrors(fixture)).join("\n");
      expect(errors).toContain("SOURCE_CHANGED_DURING_STANDALONE_CAPTURE");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects a flexible prompt and a same-process controller/reviewer identity after all digests are recomputed", async () => {
    const fixture = await writeIndependentReviewFixture();
    try {
      fixture.invocation.prompt = "Trust the existing CLOSED strings.";
      fixture.invocation.prompt_sha256 = reviewSha256(fixture.invocation.prompt);
      await writeFile(fixture.invocationPath, `${JSON.stringify(fixture.invocation, null, 2)}\n`);
      await fixture.refreshRawArtifact("INVOCATION");
      expect((await referenceErrors(fixture)).join("\n")).toContain("fixed review prompt");

      fixture.invocation.prompt = buildIndependentReviewPrompt({
        implementationExecutionId: IMPLEMENTATION_EXECUTION_ID,
        sourceFingerprint: SOURCE_FINGERPRINT,
        reviewSubjectSha256: fixture.summary.review_subject_sha256,
        reviewInputsSha256: fixture.summary.review_inputs_sha256,
        inspectionCommands: fixture.invocation.inspection_commands,
        traceabilityPath: relative(fixture.root, fixture.documentPath),
        requestedRequirements: fixture.invocation.requested_requirements,
      });
      fixture.invocation.prompt_sha256 = reviewSha256(fixture.invocation.prompt);
      fixture.invocation.reviewer_process_id = fixture.invocation.controller_process_id;
      await writeFile(fixture.invocationPath, `${JSON.stringify(fixture.invocation, null, 2)}\n`);
      await fixture.refreshRawArtifact("INVOCATION");
      expect((await referenceErrors(fixture)).join("\n")).toContain("distinct successful controller/reviewer process identity");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects mutation-capable raw events and stale Codex executable bytes", async () => {
    const fixture = await writeIndependentReviewFixture();
    try {
      fixture.events.splice(3, 0, {
        type: "item.completed",
        item: { type: "file_change", id: "change-1", status: "completed" },
      });
      await writeFile(fixture.eventsPath, `${fixture.events.map((event) => JSON.stringify(event)).join("\n")}\n`);
      await fixture.refreshRawArtifact("CODEX_EVENTS_JSONL");
      expect((await referenceErrors(fixture)).join("\n")).toContain("forbidden non-read-only tool");

      fixture.events.splice(3, 1);
      await writeFile(fixture.eventsPath, `${fixture.events.map((event) => JSON.stringify(event)).join("\n")}\n`);
      await fixture.refreshRawArtifact("CODEX_EVENTS_JSONL");
      fixture.invocation.codex.version = "self-authored fake version";
      await writeFile(fixture.invocationPath, `${JSON.stringify(fixture.invocation, null, 2)}\n`);
      await fixture.refreshRawArtifact("INVOCATION");
      expect((await referenceErrors(fixture)).join("\n")).toContain("--version output diverged");

      fixture.invocation.codex.version = "codex fixture 1.0";
      await writeFile(fixture.invocationPath, `${JSON.stringify(fixture.invocation, null, 2)}\n`);
      await fixture.refreshRawArtifact("INVOCATION");
      await writeFile(fixture.codexPath, "different-codex-binary\n");
      expect((await referenceErrors(fixture)).join("\n")).toContain("executable hash is stale");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects zero/irrelevant inspection commands and forged per-file read receipts", async () => {
    const fixture = await writeIndependentReviewFixture();
    try {
      const inspectionEvent = fixture.events[2];
      fixture.events.splice(2, 1);
      await writeFile(fixture.eventsPath, `${fixture.events.map((event) => JSON.stringify(event)).join("\n")}\n`);
      await fixture.refreshRawArtifact("CODEX_EVENTS_JSONL");
      expect((await referenceErrors(fixture)).join("\n")).toContain("exactly one fixed input inspection command");

      fixture.events.splice(2, 0, inspectionEvent);
      [fixture.events[2], fixture.events[3]] = [fixture.events[3], fixture.events[2]];
      await writeFile(fixture.eventsPath, `${fixture.events.map((event) => JSON.stringify(event)).join("\n")}\n`);
      await fixture.refreshRawArtifact("CODEX_EVENTS_JSONL");
      expect((await referenceErrors(fixture)).join("\n")).toContain("inspection commands are out of order");
      [fixture.events[2], fixture.events[3]] = [fixture.events[3], fixture.events[2]];

      fixture.events[2].item.command = `true; ${fixture.inspectionCommands[0]}`;
      await writeFile(fixture.eventsPath, `${fixture.events.map((event) => JSON.stringify(event)).join("\n")}\n`);
      await fixture.refreshRawArtifact("CODEX_EVENTS_JSONL");
      expect((await referenceErrors(fixture)).join("\n")).toContain("exactly one fixed input inspection command");

      fixture.events[2].item.command = "rg -n closure scripts/review";
      await writeFile(fixture.eventsPath, `${fixture.events.map((event) => JSON.stringify(event)).join("\n")}\n`);
      await fixture.refreshRawArtifact("CODEX_EVENTS_JSONL");
      expect((await referenceErrors(fixture)).join("\n")).toContain("exactly one fixed input inspection command");

      fixture.events[2].item.command = fixture.inspectionCommands[0];
      const forgedReceipt = JSON.parse(fixture.events[2].item.aggregated_output);
      forgedReceipt.entries[0].chunk.sha256 = "f".repeat(64);
      fixture.events[2].item.aggregated_output = `${JSON.stringify(forgedReceipt)}\n`;
      await writeFile(fixture.eventsPath, `${fixture.events.map((event) => JSON.stringify(event)).join("\n")}\n`);
      await fixture.refreshRawArtifact("CODEX_EVENTS_JSONL");
      expect((await referenceErrors(fixture)).join("\n")).toContain("content chunk 0 diverged");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects metadata-only inspection output and a one-token reviewer fixture", async () => {
    const metadataOnly = await writeIndependentReviewFixture();
    try {
      const receipt = JSON.parse(metadataOnly.events[2].item.aggregated_output);
      delete receipt.entries;
      receipt.schema_version = "1.0";
      metadataOnly.events[2].item.aggregated_output = `${JSON.stringify(receipt)}\n`;
      await writeFile(
        metadataOnly.eventsPath,
        `${metadataOnly.events.map((event) => JSON.stringify(event)).join("\n")}\n`,
      );
      await metadataOnly.refreshRawArtifact("CODEX_EVENTS_JSONL");
      expect((await referenceErrors(metadataOnly)).join("\n")).toContain("metadata-only inspection receipt is forbidden");
    } finally {
      await rm(metadataOnly.root, { recursive: true, force: true });
    }

    const oneToken = await writeIndependentReviewFixture();
    try {
      oneToken.events.at(-1).usage = { input_tokens: 1, output_tokens: 1 };
      await writeFile(oneToken.eventsPath, `${oneToken.events.map((event) => JSON.stringify(event)).join("\n")}\n`);
      await oneToken.refreshRawArtifact("CODEX_EVENTS_JSONL");
      expect((await referenceErrors(oneToken)).join("\n")).toContain("non-trivial reviewer token usage is required");
    } finally {
      await rm(oneToken.root, { recursive: true, force: true });
    }
  });

  it("rejects missing, command-offset, and existing-test-restatement falsification probes", async () => {
    const missing = await writeIndependentReviewFixture();
    try {
      missing.events.splice(missing.probeEventIndex, 1);
      await writeFile(missing.eventsPath, `${missing.events.map((event) => JSON.stringify(event)).join("\n")}\n`);
      await missing.refreshRawArtifact("CODEX_EVENTS_JSONL");
      expect((await referenceErrors(missing)).join("\n")).toContain("one fresh probe per requirement");
    } finally {
      await rm(missing.root, { recursive: true, force: true });
    }

    const offset = await writeIndependentReviewFixture();
    try {
      offset.events[offset.probeEventIndex].item.command = `true; ${offset.falsificationProbeCommand}`;
      await writeFile(offset.eventsPath, `${offset.events.map((event) => JSON.stringify(event)).join("\n")}\n`);
      await offset.refreshRawArtifact("CODEX_EVENTS_JSONL");
      expect((await referenceErrors(offset)).join("\n")).toContain("exactly one fixed fresh falsification probe");
    } finally {
      await rm(offset.root, { recursive: true, force: true });
    }

    const restatement = await writeIndependentReviewFixture();
    try {
      const probe = {
        ...restatement.falsificationProbe,
        counterexample: "If strict-review-control becomes disabled-review-control exactly as this existing negative test says, the probe is not fresh.",
      };
      restatement.finalVerdict.requirements[0].falsification_probe = probe;
      restatement.events[restatement.probeEventIndex].item.command = buildIndependentReviewFalsificationProbeCommand({
        traceabilityPath: relative(restatement.root, restatement.documentPath),
        inspectionNonce: restatement.invocation.inspection_nonce,
        requirementId: "K-999",
        probe,
      });
      restatement.events[restatement.messageEventIndex].item.text = JSON.stringify(restatement.finalVerdict);
      await Promise.all([
        writeFile(restatement.finalPath, `${JSON.stringify(restatement.finalVerdict, null, 2)}\n`),
        writeFile(restatement.eventsPath, `${restatement.events.map((event) => JSON.stringify(event)).join("\n")}\n`),
      ]);
      await restatement.refreshRawArtifact("FINAL_VERDICT");
      await restatement.refreshRawArtifact("CODEX_EVENTS_JSONL");
      expect((await referenceErrors(restatement)).join("\n")).toContain("FALSIFICATION_PROBE_NOT_FRESH");
    } finally {
      await rm(restatement.root, { recursive: true, force: true });
    }
  });

  it("requires exact programmatic test inventory and rejects non-executable citations", async () => {
    const fixture = await writeIndependentReviewFixture();
    try {
      expect((await referenceErrors(fixture, SOURCE_FINGERPRINT, async (item) => {
        const result = await passingTestExecutor(item);
        result.inventory.failed = 1;
        result.inventory.passed -= 1;
        result.inventory.modules[0].tests[0].state = "failed";
        return result;
      })).join("\n")).toContain("TEST_INVENTORY_NOT_EXACT_GREEN");
      expect((await referenceErrors(fixture, SOURCE_FINGERPRINT, async (item) => {
        const result = await passingTestExecutor(item);
        result.inventory.skipped = 1;
        result.inventory.passed -= 1;
        result.inventory.modules[0].tests[0].state = "skipped";
        return result;
      })).join("\n")).toContain("TEST_INVENTORY_NOT_EXACT_GREEN");
      expect((await referenceErrors(fixture, SOURCE_FINGERPRINT, async (item) => {
        const result = await passingTestExecutor(item);
        result.inventory.modules[0].path = "tests/uncited.test.ts";
        return result;
      })).join("\n")).toContain("TEST_EXACT_MODULE_INVENTORY_MISMATCH");

      await writeFile(join(fixture.root, "tests/not-a-test.txt"), "not executable\n");
      fixture.traceability.requirements[0].positive_tests = ["tests/not-a-test.txt"];
      await writeFile(fixture.documentPath, `${JSON.stringify(fixture.traceability, null, 2)}\n`);
      const sourceSnapshotContext = await syntheticSourceSnapshotContext(
        fixture.traceability,
        fixture.root,
        fixture.documentPath,
      );
      const runtime = await deriveObservedIndependentReviewRuntimeIdentity({
        repoRoot: fixture.root,
        sourceSnapshotContext,
      });
      await expect(createIndependentReviewTestPlan({
        document: fixture.traceability,
        requirementIds: ["K-999"],
        repoRoot: fixture.root,
        documentPath: fixture.documentPath,
        sourceSnapshotContext,
        approvedReviewRuntimeSha256: runtime.observed_review_runtime_sha256,
      })).rejects.toThrow("TEST_REFERENCE_NOT_EXECUTABLE");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects a self-consistent plan from frozen context B against live binding A", async () => {
    const fixture = await writeHostProtectionPlanFixture();
    try {
      const contextA = await syntheticSourceSnapshotContext(
        fixture.traceability, fixture.root, fixture.documentPath,
      );
      await writeFile(join(fixture.root, "src/control.ts"),
        "export const protectedControl = 'strict-b';\n");
      const contextB = await syntheticSourceSnapshotContext(
        fixture.traceability, fixture.root, fixture.documentPath,
      );
      const planB = await deriveIndependentReviewPlan({
        document: fixture.traceability,
        requirementId: "K-999",
        repoRoot: fixture.root,
        documentPath: fixture.documentPath,
        sourceSnapshotContext: contextB,
      });
      const liveBinding = normalizeIndependentReviewLiveContext({
        schema_version: "1.0",
        mode: "LOCAL_ACCEPTANCE_GATE_LIVE",
        gate_run_id: "11111111-1111-4111-8111-111111111111",
        live_challenge: "1".repeat(64),
        source_fingerprint_sha256: SOURCE_FINGERPRINT,
        source_snapshot_sha256: contextA.source_snapshot_sha256,
        source_snapshot_manifest_sha256: "2".repeat(64),
        source_snapshot_attestation_sha256: "3".repeat(64),
        supplemental_inputs_sha256: contextA.supplemental_inputs_sha256,
        supplemental_manifest_sha256: "4".repeat(64),
        approved_review_codex_sha256: "5".repeat(64),
        approved_review_runtime_sha256: "6".repeat(64),
      });
      expect(() => assertIndependentReviewLivePlanBinding({
        plan: planB,
        liveBinding,
        sourceSnapshotContext: contextB,
      })).toThrow("INDEPENDENT_REVIEW_LIVE_PLAN_SOURCE_CONTEXT_DIVERGED");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }, 30_000);

  it("rejects a self-reported externally immutable context without verified host protection", () => {
    const sourceSnapshotSha256 = "7".repeat(64);
    const supplementalInputsSha256 = "8".repeat(64);
    const liveBinding = normalizeIndependentReviewLiveContext({
      schema_version: "1.0",
      mode: "LOCAL_ACCEPTANCE_GATE_LIVE",
      gate_run_id: "11111111-1111-4111-8111-111111111111",
      live_challenge: "1".repeat(64),
      source_fingerprint_sha256: SOURCE_FINGERPRINT,
      source_snapshot_sha256: sourceSnapshotSha256,
      source_snapshot_manifest_sha256: "2".repeat(64),
      source_snapshot_attestation_sha256: "3".repeat(64),
      supplemental_inputs_sha256: supplementalInputsSha256,
      supplemental_manifest_sha256: "4".repeat(64),
      approved_review_codex_sha256: "5".repeat(64),
      approved_review_runtime_sha256: "6".repeat(64),
    });
    expect(() => assertIndependentReviewLivePlanBinding({
      plan: { source_snapshot_sha256: sourceSnapshotSha256, supplemental_inputs_sha256: supplementalInputsSha256 },
      liveBinding,
      sourceSnapshotContext: {
        source_snapshot_sha256: sourceSnapshotSha256,
        supplemental_inputs_sha256: supplementalInputsSha256,
        externally_immutable: true,
        host_snapshot_protection_verified: false,
      },
    })).toThrow("INDEPENDENT_REVIEW_HOST_SNAPSHOT_PROTECTION_UNVERIFIED");
  });

  it("rejects writable fixed host inputs even when their live binding is self-consistent", async () => {
    const fixture = await writeHostProtectionPlanFixture();
    const host = await writeLiveHostContextFixture(fixture);
    try {
      await chmod(host.liveContextPath, 0o644);
      const changed = {
        ...host.liveContext,
        source_fingerprint_sha256: "b".repeat(64),
      };
      await writeFile(host.liveContextPath, `${JSON.stringify(changed, null, 2)}\n`);
      await expect(loadIndependentReviewLiveSourceSnapshotContext({
        liveContextPath: host.liveContextPath,
        documentRelativePath: host.documentRelativePath,
        allowSyntheticSupplementalPathsForTests: true,
      })).rejects.toThrow("INDEPENDENT_REVIEW_FIXED_HOST_INPUT_NOT_PROTECTED");
    } finally {
      await Promise.all([
        rm(host.boundary, { recursive: true, force: true }),
        rm(fixture.root, { recursive: true, force: true }),
      ]);
    }
  }, 30_000);

  it("rejects an unconfined writable host output boundary", async () => {
    const fixture = await writeHostProtectionPlanFixture();
    const host = await writeLiveHostContextFixture(fixture);
    try {
      await chmod(join(host.boundary, INDEPENDENT_REVIEW_HOST_CONTEXT_FILES.output_directory), 0o777);
      await expect(loadIndependentReviewLiveSourceSnapshotContext({
        liveContextPath: host.liveContextPath,
        documentRelativePath: host.documentRelativePath,
        allowSyntheticSupplementalPathsForTests: true,
      })).rejects.toThrow("INDEPENDENT_REVIEW_HOST_OUTPUT_BOUNDARY_INVALID");
    } finally {
      await Promise.all([
        rm(host.boundary, { recursive: true, force: true }),
        rm(fixture.root, { recursive: true, force: true }),
      ]);
    }
  }, 30_000);

  it("rechecks fixed host inputs and the private output boundary after live-context load", async () => {
    const fixture = await writeHostProtectionPlanFixture();
    const host = await writeLiveHostContextFixture(fixture);
    try {
      const captured = await loadIndependentReviewLiveSourceSnapshotContext({
        liveContextPath: host.liveContextPath,
        documentRelativePath: host.documentRelativePath,
        allowSyntheticSupplementalPathsForTests: true,
      });
      await chmod(host.liveContextPath, 0o644);
      await expect(assertIndependentReviewSourceSnapshotUnchanged(captured.sourceSnapshotContext))
        .rejects.toThrow("INDEPENDENT_REVIEW_FIXED_HOST_INPUT_NOT_PROTECTED");
      await chmod(host.liveContextPath, 0o444);
      await chmod(join(host.boundary, INDEPENDENT_REVIEW_HOST_CONTEXT_FILES.output_directory), 0o777);
      await expect(assertIndependentReviewSourceSnapshotUnchanged(captured.sourceSnapshotContext))
        .rejects.toThrow("INDEPENDENT_REVIEW_HOST_OUTPUT_BOUNDARY_INVALID");
    } finally {
      await Promise.all([
        rm(host.boundary, { recursive: true, force: true }),
        rm(fixture.root, { recursive: true, force: true }),
      ]);
    }
  }, 30_000);

  it("keeps live planning on the one host snapshot after the candidate worktree is swapped", async () => {
    const fixture = await writeHostProtectionPlanFixture();
    const host = await writeLiveHostContextFixture(fixture);
    try {
      const captured = await loadIndependentReviewLiveSourceSnapshotContext({
        liveContextPath: host.liveContextPath,
        documentRelativePath: host.documentRelativePath,
        allowSyntheticSupplementalPathsForTests: true,
      });
      const liveBinding = normalizeIndependentReviewLiveContext(captured.liveContext);
      const before = await deriveIndependentReviewPlan({
        document: captured.document,
        requirementId: "K-999",
        repoRoot: captured.repoRoot,
        documentPath: captured.documentPath,
        sourceSnapshotContext: captured.sourceSnapshotContext,
      });
      assertIndependentReviewLivePlanBinding({
        plan: before,
        liveBinding,
        sourceSnapshotContext: captured.sourceSnapshotContext,
        hostContextReceipt: captured.hostContextReceipt,
      });
      await writeFile(join(fixture.root, "src/control.ts"),
        "export const protectedControl = 'candidate-worktree-swapped';\n");
      await replaceFixtureRuntimeFile(
        join(fixture.root, "node_modules/typescript/lib/typescript.js"),
        "throw new Error('candidate TypeScript runtime patched after host snapshot');\n",
      );
      const after = await deriveIndependentReviewPlan({
        document: captured.document,
        requirementId: "K-999",
        repoRoot: captured.repoRoot,
        documentPath: captured.documentPath,
        sourceSnapshotContext: captured.sourceSnapshotContext,
      });
      expect(after.plan_sha256).toBe(before.plan_sha256);
      expect(captured.sourceSnapshotContext.contentByPath.get("src/control.ts")?.toString("utf8"))
        .toContain("protectedControl = \"strict\"");
      expect(await readFile(join(fixture.root, "src/control.ts"), "utf8"))
        .toContain("candidate-worktree-swapped");
      expect(await readFile(join(fixture.root, "node_modules/typescript/lib/typescript.js"), "utf8"))
        .toContain("candidate TypeScript runtime patched");
    } finally {
      await Promise.all([
        rm(host.boundary, { recursive: true, force: true }),
        rm(fixture.root, { recursive: true, force: true }),
      ]);
    }
  }, 30_000);

  it("rejects added source paths and changed modules after loading the host manifest", async () => {
    const fixture = await writePlanFixture({
      files: {
        "src/control.ts": 'export const control = "strict";\n',
        "tests/positive.test.ts":
          'import { control } from "../src/control.js"; test("strict", () => expect(control).toBe("strict"));\n',
        "tests/negative.test.ts":
          'import { control } from "../src/control.js"; test("disabled", () => expect(control).not.toBe("disabled"));\n',
      },
      implementationFiles: ["src/control.ts"],
      positiveTests: ["tests/positive.test.ts"],
      negativeTests: ["tests/negative.test.ts"],
      obligations: [{
        obligation_id: "K-999-C01-P01",
        invariant: "The strict control remains enforced.",
        target_path: "src/control.ts",
        target_anchor: "control",
        mutation_operator: "REPLACE_ENUM_LITERAL",
        literal: "strict",
        replacement: "disabled",
        test_files: ["tests/positive.test.ts", "tests/negative.test.ts"],
        mutation_test_path: "tests/positive.test.ts",
        expected_failing_test_names: ["strict"],
        expected_failure_message_patterns: ["strict"],
      }],
    });
    const host = await writeLiveHostContextFixture(fixture as any);
    try {
      const captured = await loadIndependentReviewLiveSourceSnapshotContext({
        liveContextPath: host.liveContextPath,
        documentRelativePath: host.documentRelativePath,
        allowSyntheticSupplementalPathsForTests: true,
      });
      await writeFile(join(captured.repoRoot, "vitest.config.ts"),
        "export default { passWithNoTests: true };\n");
      await expect(assertIndependentReviewSourceSnapshotUnchanged(captured.sourceSnapshotContext))
        .rejects.toThrow("LIVE_SNAPSHOT_EXACT_SOURCE_SET_CHANGED");
      await rm(join(captured.repoRoot, "vitest.config.ts"));
      await writeFile(join(captured.repoRoot, "tests/positive.test.ts"),
        'test("swapped", () => expect(true).toBe(true));\n');
      await expect(assertIndependentReviewSourceSnapshotUnchanged(captured.sourceSnapshotContext))
        .rejects.toThrow("LIVE_SNAPSHOT_EXACT_SOURCE_SET_CHANGED");
    } finally {
      await Promise.all([
        rm(host.boundary, { recursive: true, force: true }),
        rm(fixture.root, { recursive: true, force: true }),
      ]);
    }
  }, 60_000);

  it("rejects prose-only evidence_checked and adversarial_checks even when raw final hashes match", async () => {
    const fixture = await writeIndependentReviewFixture();
    try {
      fixture.finalVerdict.requirements[0].evidence_checked = ["I looked at all files"];
      fixture.finalVerdict.requirements[0].adversarial_checks = ["negative tests passed"];
      fixture.events[fixture.messageEventIndex].item.text = JSON.stringify(fixture.finalVerdict);
      await Promise.all([
        writeFile(fixture.finalPath, `${JSON.stringify(fixture.finalVerdict, null, 2)}\n`),
        writeFile(fixture.eventsPath, `${fixture.events.map((event) => JSON.stringify(event)).join("\n")}\n`),
      ]);
      await fixture.refreshRawArtifact("FINAL_VERDICT");
      await fixture.refreshRawArtifact("CODEX_EVENTS_JSONL");
      expect((await referenceErrors(fixture)).join("\n")).toContain("check receipts do not match current cited bytes");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("recomputes CLOSED from the raw final message instead of trusting summary.decision", async () => {
    const fixture = await writeIndependentReviewFixture();
    try {
      fixture.finalVerdict.overall_decision = "REOPEN";
      fixture.finalVerdict.requirements[0].decision = "REOPEN";
      fixture.events[fixture.messageEventIndex].item.text = JSON.stringify(fixture.finalVerdict);
      fixture.summary.decision = "REOPEN";
      await Promise.all([
        writeFile(fixture.finalPath, `${JSON.stringify(fixture.finalVerdict, null, 2)}\n`),
        writeFile(fixture.eventsPath, `${fixture.events.map((event) => JSON.stringify(event)).join("\n")}\n`),
      ]);
      await fixture.refreshRawArtifact("FINAL_VERDICT");
      await fixture.refreshRawArtifact("CODEX_EVENTS_JSONL");
      expect((await referenceErrors(fixture)).join("\n")).toContain("did not independently close");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});
