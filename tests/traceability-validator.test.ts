import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { registerIndependentReviewSyntheticSupplementFixture } from "../scripts/review/independent-review-evidence-lib.mjs";
import {
  REQUIRED_REQUIREMENT_FIELDS,
  validateTraceabilityDocument,
  validateTraceabilityReferences,
} from "../scripts/review/traceability-validator-lib.mjs";

function validRequirement() {
  const control = "Evidence and the claim share a deterministic identity chain.";
  return {
    requirement_id: "K-999",
    business_risk: "A release can make an unsupported completion claim.",
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
        target_anchor: "evidenceIdentity",
        mutation_operator: "FLIP_BOOLEAN_LITERAL",
        literal: "true",
        replacement: "false",
        test_files: ["tests/example-positive.test.ts", "tests/example-negative.test.ts"],
        mutation_test_path: "tests/example-positive.test.ts",
        expected_failing_test_names: ["evidence identity remains bound"],
        expected_failure_message_patterns: ["expected true"],
      }],
    }],
    implementation_files: ["src/example.ts"],
    positive_tests: ["tests/example-positive.test.ts"],
    negative_or_mutation_tests: ["tests/example-negative.test.ts"],
    implementation_owner: "/root",
    reviewer: "Acceptance Operator",
    status: "CLOSED",
    evidence: ["evidence.json"],
    residual_risk: "No residual risk identified within the frozen local evidence boundary.",
    closure: {
      implementation_execution_id: "controller-process:100:run:fixture",
      reviewer_execution_id: "codex-thread:fixture:pid:101",
      reviewer_role: "Acceptance Operator",
      reviewed_at: "2026-08-13T12:30:00.000Z",
      decision: "CLOSED",
      source_fingerprint: "a".repeat(64),
      review_subject_sha256: "c".repeat(64),
      review_inputs_sha256: "d".repeat(64),
      review_artifact: "independent-review.json",
      review_artifact_sha256: "b".repeat(64),
    },
  };
}

function validDocument() {
  const document = {
    schema_version: "4.0",
    round_id: "round-test",
    generated_at: "2026-08-13T12:00:00.000Z",
    evidence_boundary: "Synthetic validator fixture only.",
    control_catalog: {
      path: "schemas/ledger-control-clauses.v1.json",
      schema_version: "1.0",
      sha256: "e".repeat(64),
    },
    requirements: [validRequirement()],
  };
  registerIndependentReviewSyntheticSupplementFixture(document);
  return document;
}

function runNode(arguments_: string[]) {
  return new Promise<{ exitCode: number | null; stdout: string; stderr: string }>((resolveResult, reject) => {
    const child = spawn(process.execPath, arguments_, { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (exitCode) => resolveResult({ exitCode, stdout, stderr }));
  });
}

describe("requirements traceability validator", () => {

  it("CLI rejects missing host-approved catalog digest even in diagnostic mode", async () => {
    const result = await runNode(["scripts/review/validate-requirements-traceability.mjs"]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "--approved-control-catalog-sha256 is required from the host acceptance boundary",
    );
  });
  it.each(REQUIRED_REQUIREMENT_FIELDS)("rejects a requirement missing %s", (field) => {
    const document = validDocument();
    delete (document.requirements[0] as Record<string, unknown>)[field];
    expect(validateTraceabilityDocument(document).join("\n")).toContain(`${field}: required field is missing`);
  });

  it("rejects legacy shorthand and identical positive/negative test lists", () => {
    const document = validDocument();
    const requirement = document.requirements[0] as Record<string, unknown>;
    requirement.risk = requirement.business_risk;
    requirement.negative_or_mutation_tests = [...(requirement.positive_tests as string[])];
    requirement.control_claims[0].negative_or_mutation_tests =
      [...(requirement.control_claims[0].positive_tests as string[])];
    const errors = validateTraceabilityDocument(document).join("\n");
    expect(errors).toContain("unknown field");
    expect(errors).toContain("positive_tests and negative_or_mutation_tests cannot be identical");
  });

  it("requires exact control-clause derivation, citation coverage, and scoped probe obligations", () => {
    const document = validDocument();
    const requirement = document.requirements[0] as Record<string, any>;
    requirement.design_control = "A broader unchecked control claim.";
    requirement.control_claims[0].probe_obligations[0].target_path = "src/other.ts";
    requirement.implementation_files.push("src/unassigned.ts");
    const errors = validateTraceabilityDocument(document).join("\n");
    expect(errors).toContain("must be derived exactly from ordered control claims");
    expect(errors).toContain("is not a claim implementation file");
    expect(errors).toContain("must equal the exact union of control-claim citations");
  });

  it("rejects reuse of one executable probe fingerprint across distinct control claims", () => {
    const document = validDocument();
    const requirement = document.requirements[0] as Record<string, any>;
    const first = requirement.control_claims[0];
    const second = structuredClone(first);
    second.claim_id = "K-999-C02";
    second.source_clause_id = "K-999-C02";
    second.control = "A second claim must have its own atomic falsification target.";
    second.probe_obligations[0].obligation_id = "K-999-C02-P01";
    // Cosmetic operator/replacement/expected-output changes cannot turn the
    // same target anchor, literal and test into a distinct semantic probe.
    second.probe_obligations[0].mutation_operator = "REPLACE_EXACT_LITERAL";
    second.probe_obligations[0].replacement = "disabled";
    second.probe_obligations[0].expected_failing_test_names = ["different prose"];
    second.probe_obligations[0].expected_failure_message_patterns = ["different message"];
    requirement.control_claims.push(second);
    requirement.design_control = `${first.control} ${second.control}`;
    const errors = validateTraceabilityDocument(document).join("\n");
    expect(errors).toContain("INDEPENDENT_REVIEW_CROSS_CLAIM_PROBE_FINGERPRINT_REUSED");
  });

  it("rejects globally reused obligation IDs even when the claims differ", () => {
    const document = validDocument();
    const duplicate = structuredClone(document.requirements[0]);
    duplicate.requirement_id = "K-998";
    duplicate.control_claims[0].claim_id = "K-998-C01";
    duplicate.control_claims[0].source_clause_id = "K-998-C01";
    // Retaining the first claim's obligation ID must fail independently of
    // the ordinary claim-scoped ID-format check.
    document.requirements.push(duplicate);
    const errors = validateTraceabilityDocument(document).join("\n");
    expect(errors).toContain("INDEPENDENT_REVIEW_PROBE_OBLIGATION_ID_REUSED");
  });

  it("fails the release mode for unresolved requirements", () => {
    const document = validDocument();
    document.requirements[0]!.status = "FIXED_PENDING_REVIEW";
    delete (document.requirements[0] as Record<string, unknown>).closure;
    expect(validateTraceabilityDocument(document, { requireClosed: true }).join("\n"))
      .toContain("local release gate requires independently CLOSED");
  });

  it("requires the host-approved control root for release closure and rejects a candidate-selected digest", async () => {
    const root = await mkdtemp(join(tmpdir(), "traceability-control-root-"));
    const round = join(root, "artifacts/round");
    try {
      await Promise.all([
        mkdir(join(root, "schemas"), { recursive: true }),
        mkdir(join(root, "src"), { recursive: true }),
        mkdir(join(root, "tests"), { recursive: true }),
        mkdir(round, { recursive: true }),
      ]);
      await Promise.all([
        writeFile(join(root, "src/example.ts"), "export const evidenceIdentity = true;\n"),
        writeFile(join(root, "tests/example-positive.test.ts"), "positive\n"),
        writeFile(join(root, "tests/example-negative.test.ts"), "negative\n"),
        writeFile(join(round, "evidence.json"), "{}\n"),
      ]);
      const document = validDocument();
      const sourceBytes = Buffer.from("export const evidenceIdentity = true;\n");
      const catalog = {
        schema_version: "1.0",
        catalog_id: "fixture-control-catalog",
        source_documents: [{
          path: "src/example.ts",
          sha256: createHash("sha256").update(sourceBytes).digest("hex"),
        }],
        requirements: [{
          requirement_id: "K-999",
          business_risk: document.requirements[0]!.business_risk,
          clauses: [{
            clause_id: "K-999-C01",
            control: document.requirements[0]!.control_claims[0].control,
          }],
        }],
      };
      const catalogBytes = Buffer.from(`${JSON.stringify(catalog, null, 2)}\n`);
      const catalogSha256 = createHash("sha256").update(catalogBytes).digest("hex");
      await writeFile(join(root, document.control_catalog.path), catalogBytes);
      document.control_catalog.sha256 = catalogSha256;
      document.requirements[0]!.evidence = ["evidence.json"];
      const documentPath = join(round, "requirements.json");
      await writeFile(documentPath, `${JSON.stringify(document, null, 2)}\n`);
      const missing = await validateTraceabilityReferences(document, {
        repoRoot: root,
        documentPath,
      });
      expect(missing.join("\n")).toContain("trusted validation requires an externally supplied approved control-catalog digest");
      const wrong = await validateTraceabilityReferences(document, {
        repoRoot: root,
        documentPath,
        requireClosed: true,
        expectedControlCatalogSha256: "f".repeat(64),
      });
      expect(wrong.join("\n")).toContain("externally approved control-catalog digest");

      const candidateCatalog = JSON.parse(catalogBytes.toString("utf8"));
      candidateCatalog.catalog_id = "candidate-self-selected-two-of-twenty-two";
      const candidateBytes = Buffer.from(`${JSON.stringify(candidateCatalog, null, 2)}\n`);
      await writeFile(join(root, document.control_catalog.path), candidateBytes);
      document.control_catalog.sha256 = createHash("sha256").update(candidateBytes).digest("hex");
      await writeFile(documentPath, `${JSON.stringify(document, null, 2)}\n`);
      const candidateMirror = await validateTraceabilityReferences(document, {
        repoRoot: root,
        documentPath,
        expectedControlCatalogSha256: catalogSha256,
      });
      expect(candidateMirror.join("\n")).toContain("externally approved control-catalog digest");
      await writeFile(join(root, document.control_catalog.path), catalogBytes);
      document.control_catalog.sha256 = catalogSha256;

      document.requirements[0]!.control_claims[0].probe_obligations[0].target_anchor =
        "candidateSelectedShallowAnchor";
      await writeFile(documentPath, `${JSON.stringify(document, null, 2)}\n`);
      const rebound = await validateTraceabilityReferences(document, {
        repoRoot: root,
        documentPath,
        expectedControlCatalogSha256: catalogSha256,
      });
      expect(rebound.join("\n")).not.toContain("canonical catalog");

      document.requirements[0]!.control_claims[0].control = "Candidate changed canonical control.";
      await writeFile(documentPath, `${JSON.stringify(document, null, 2)}\n`);
      const changedControl = await validateTraceabilityReferences(document, {
        repoRoot: root,
        documentPath,
        expectedControlCatalogSha256: catalogSha256,
      });
      expect(changedControl.join("\n")).toContain(
        "claim IDs, source clause IDs and controls must exactly cover the canonical catalog",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("tracks a complete unexpired waiver but never lets it satisfy the local release gate", () => {
    const document = validDocument();
    const requirement = document.requirements[0] as Record<string, unknown>;
    requirement.status = "WAIVED";
    delete requirement.closure;
    requirement.waiver = {
      accepted_by: "Independent reviewer",
      reason: "Bounded test-environment exception",
      scope: "One local synthetic fixture",
      expires_at: "2026-09-01T00:00:00.000Z",
    };
    expect(validateTraceabilityDocument(document, {
      requireClosed: false,
      now: new Date("2026-08-13T12:00:00.000Z"),
    })).toEqual([]);
    expect(validateTraceabilityDocument(document, {
      requireClosed: true,
      now: new Date("2026-08-13T12:00:00.000Z"),
    }).join("\n")).toContain("WAIVED cannot satisfy this gate");
    expect(validateTraceabilityDocument(document, {
      requireClosed: true,
      now: new Date("2026-09-02T00:00:00.000Z"),
    }).join("\n")).toContain("waiver is expired");
  });

  it("rejects a two-requirement trace against the externally approved full 18/90 catalog", async () => {
    const root = await mkdtemp(join(tmpdir(), "traceability-partial-catalog-"));
    const round = join(root, "artifacts/round");
    try {
      const canonicalBytes = await readFile(resolve(process.cwd(), "schemas/ledger-control-clauses.v1.json"));
      const canonical = JSON.parse(canonicalBytes.toString("utf8"));
      expect(canonical.requirements).toHaveLength(18);
      expect(canonical.requirements.flatMap((item: any) => item.clauses)).toHaveLength(90);
      await Promise.all([
        mkdir(join(root, "schemas"), { recursive: true }),
        mkdir(join(root, "src"), { recursive: true }),
        mkdir(join(root, "tests"), { recursive: true }),
        mkdir(round, { recursive: true }),
      ]);
      await Promise.all([
        writeFile(join(root, "schemas/ledger-control-clauses.v1.json"), canonicalBytes),
        writeFile(join(root, "src/example.ts"), "export const example = true;\n"),
        writeFile(join(root, "tests/example-positive.test.ts"), "positive\n"),
        writeFile(join(root, "tests/example-negative.test.ts"), "negative\n"),
        writeFile(join(round, "evidence.json"), "{}\n"),
        ...canonical.source_documents.map(async (source: any) => {
          const bytes = await readFile(resolve(process.cwd(), source.path));
          await mkdir(join(root, source.path, ".."), { recursive: true });
          await writeFile(join(root, source.path), bytes);
        }),
      ]);
      const requirements = canonical.requirements.slice(0, 2).map((catalogRequirement: any) => {
        const claims = catalogRequirement.clauses.map((clause: any, index: number) => ({
          claim_id: clause.clause_id,
          source_clause_id: clause.clause_id,
          control: clause.control,
          evidence: ["evidence.json"],
          implementation_files: ["src/example.ts"],
          positive_tests: ["tests/example-positive.test.ts"],
          negative_or_mutation_tests: ["tests/example-negative.test.ts"],
          probe_obligations: [{
            obligation_id: `${clause.clause_id}-P01`,
            invariant: clause.control,
            target_path: "src/example.ts",
            target_anchor: "example",
            mutation_operator: "FLIP_BOOLEAN_LITERAL",
            literal: "true",
            replacement: "false",
            test_files: ["tests/example-positive.test.ts", "tests/example-negative.test.ts"],
            mutation_test_path: "tests/example-positive.test.ts",
            expected_failing_test_names: [`catalog clause ${index}`],
            expected_failure_message_patterns: ["expected true"],
          }],
        }));
        return {
          requirement_id: catalogRequirement.requirement_id,
          business_risk: catalogRequirement.business_risk,
          design_control: claims.map((claim: any) => claim.control).join(" "),
          control_claims: claims,
          implementation_files: ["src/example.ts"],
          positive_tests: ["tests/example-positive.test.ts"],
          negative_or_mutation_tests: ["tests/example-negative.test.ts"],
          implementation_owner: "/root",
          reviewer: "Independent reviewer",
          status: "FIXED_PENDING_REVIEW",
          evidence: ["evidence.json"],
          residual_risk: "Partial trace is intentionally incomplete.",
        };
      });
      const document = {
        schema_version: "4.0",
        round_id: "partial-full-catalog-negative",
        generated_at: "2026-08-14T00:00:00.000Z",
        evidence_boundary: "Synthetic partial-catalog negative.",
        control_catalog: {
          path: "schemas/ledger-control-clauses.v1.json",
          schema_version: canonical.schema_version,
          sha256: createHash("sha256").update(canonicalBytes).digest("hex"),
        },
        requirements,
      };
      registerIndependentReviewSyntheticSupplementFixture(document);
      const documentPath = join(round, "requirements.json");
      await writeFile(documentPath, `${JSON.stringify(document, null, 2)}\n`);
      const errors = await validateTraceabilityReferences(document, {
        repoRoot: root,
        documentPath,
        requireClosed: true,
        expectedControlCatalogSha256: document.control_catalog.sha256,
      });
      expect(errors.join("\n")).toContain(
        "catalog requirement IDs must exactly cover the traceability document",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires a source-bound independent closure and rejects implementer self-closure", () => {
    const document = validDocument();
    expect(validateTraceabilityDocument(document, {
      requireClosed: true,
      expectedSourceFingerprint: "a".repeat(64),
    })).toEqual([]);
    document.requirements[0]!.closure!.reviewer_execution_id =
      document.requirements[0]!.closure!.implementation_execution_id;
    expect(validateTraceabilityDocument(document).join("\n")).toContain("implementer/controller execution cannot close");
    document.requirements[0]!.closure!.reviewer_execution_id = "codex-thread:fixture:pid:101";
    expect(validateTraceabilityDocument(document, {
      expectedSourceFingerprint: "c".repeat(64),
    }).join("\n")).toContain("reviewer verdict is stale");
  });

  it("keeps the current traceability artifact at schema v4 with the exact 18/90 atomic shape", async () => {
    const path = resolve(
      process.cwd(),
      "artifacts/ledger-kernel-review/round-2026-08-13-local/requirements-traceability.json",
    );
    const document = JSON.parse(await readFile(path, "utf8"));
    const errors = validateTraceabilityDocument(document);
    expect(document.schema_version).toBe("4.0");
    expect(document.requirements).toHaveLength(18);
    expect(document.requirements.reduce(
      (count: number, requirement: { control_claims: unknown[] }) => count + requirement.control_claims.length,
      0,
    )).toBe(90);
    expect(document.requirements.some(({ status }: { status: string }) => status === "CLOSED")).toBe(false);
    expect(errors).toEqual([]);
  });

  it("rejects missing implementation/test files and invented JSON evidence fragments", async () => {
    const root = await mkdtemp(join(tmpdir(), "traceability-refs-"));
    const round = join(root, "artifacts/round");
    try {
      await Promise.all([
        mkdir(join(root, "src"), { recursive: true }),
        mkdir(join(root, "tests"), { recursive: true }),
        mkdir(round, { recursive: true }),
      ]);
      await Promise.all([
        writeFile(join(root, "src/example.ts"), "export {};\n"),
        writeFile(join(root, "tests/example-positive.test.ts"), "positive\n"),
        writeFile(join(root, "tests/example-negative.test.ts"), "negative\n"),
        writeFile(join(round, "evidence.json"), JSON.stringify({ id: "real-record" })),
      ]);
      const document = validDocument();
      const catalog = {
        schema_version: "1.0",
        catalog_id: "fixture-control-catalog",
        source_documents: [{
          path: "src/example.ts",
          sha256: createHash("sha256").update("export {};\n").digest("hex"),
        }],
        requirements: [{
          requirement_id: "K-999",
          business_risk: document.requirements[0]!.business_risk,
          clauses: [{
            clause_id: "K-999-C01",
            control: document.requirements[0]!.control_claims[0].control,
          }],
        }],
      };
      const catalogBytes = Buffer.from(`${JSON.stringify(catalog, null, 2)}\n`);
      await mkdir(join(root, "schemas"), { recursive: true });
      await writeFile(join(root, "schemas/ledger-control-clauses.v1.json"), catalogBytes);
      document.control_catalog.sha256 = createHash("sha256").update(catalogBytes).digest("hex");
      document.requirements[0]!.evidence = ["evidence.json#invented-record"];
      const documentPath = join(round, "requirements.json");
      await writeFile(documentPath, `${JSON.stringify(document, null, 2)}\n`);
      let errors = await validateTraceabilityReferences(document, {
        repoRoot: root,
        documentPath,
        testOnlyAllowUnapprovedControlCatalog: true,
      });
      expect(errors.join("\n")).toContain("invented-record");

      document.requirements[0]!.implementation_files = ["src/missing.ts"];
      document.requirements[0]!.evidence = ["evidence.json#real-record"];
      await writeFile(documentPath, `${JSON.stringify(document, null, 2)}\n`);
      errors = await validateTraceabilityReferences(document, {
        repoRoot: root,
        documentPath,
        testOnlyAllowUnapprovedControlCatalog: true,
      });
      expect(errors.join("\n")).toContain("absent from the acceptance source snapshot");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
