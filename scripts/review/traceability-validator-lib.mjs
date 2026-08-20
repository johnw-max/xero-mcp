import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  captureIndependentReviewDocumentSourceSnapshotContext,
  assertIndependentReviewSourceSnapshotUnchanged,
  verifyIndependentReviewClosure,
} from "./independent-review-evidence-lib.mjs";
import { deriveIndependentReviewDocumentPlan } from "./independent-review-plan-lib.mjs";
import { verifyIndependentReviewAggregateClosure } from "./independent-review-shard-evidence-lib.mjs";

const TOP_LEVEL_FIELDS = Object.freeze([
  "schema_version",
  "round_id",
  "generated_at",
  "evidence_boundary",
  "control_catalog",
  "requirements",
]);

export const REQUIRED_REQUIREMENT_FIELDS = Object.freeze([
  "requirement_id",
  "business_risk",
  "design_control",
  "control_claims",
  "implementation_files",
  "positive_tests",
  "negative_or_mutation_tests",
  "implementation_owner",
  "reviewer",
  "status",
  "evidence",
  "residual_risk",
]);

const ARRAY_FIELDS = Object.freeze([
  "implementation_files",
  "positive_tests",
  "negative_or_mutation_tests",
  "evidence",
]);

const CLAIM_ARRAY_FIELDS = Object.freeze([
  "implementation_files",
  "positive_tests",
  "negative_or_mutation_tests",
  "evidence",
]);

const CONTROL_CLAIM_FIELDS = Object.freeze([
  "claim_id",
  "source_clause_id",
  "control",
  "evidence",
  "implementation_files",
  "positive_tests",
  "negative_or_mutation_tests",
  "probe_obligations",
]);

const PROBE_OBLIGATION_FIELDS = Object.freeze([
  "obligation_id",
  "invariant",
  "target_path",
  "target_anchor",
  "mutation_operator",
  "literal",
  "replacement",
  "test_files",
  "mutation_test_path",
  "expected_failing_test_names",
  "expected_failure_message_patterns",
]);

const CONTROL_CATALOG_IDENTITY_FIELDS = Object.freeze(["path", "schema_version", "sha256"]);
const VALID_MUTATION_OPERATORS = new Set([
  "FLIP_BOOLEAN_LITERAL",
  "FLIP_COMPARATOR",
  "REPLACE_ENUM_LITERAL",
  "REMOVE_GUARD",
  "DROP_OBJECT_FIELD",
  "REPLACE_EXACT_LITERAL",
]);

const STRING_FIELDS = Object.freeze([
  "requirement_id",
  "business_risk",
  "design_control",
  "implementation_owner",
  "reviewer",
  "status",
  "residual_risk",
]);

const VALID_STATUSES = new Set(["OPEN", "FIXED_PENDING_REVIEW", "CLOSED", "WAIVED"]);
const WAIVER_FIELDS = Object.freeze(["accepted_by", "reason", "scope", "expires_at"]);
const CLOSURE_FIELDS = Object.freeze([
  "implementation_execution_id",
  "reviewer_execution_id",
  "reviewer_role",
  "reviewed_at",
  "decision",
  "source_fingerprint",
  "review_subject_sha256",
  "review_inputs_sha256",
  "review_artifact",
  "review_artifact_sha256",
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && /\S/u.test(value);
}

function hasExactFields(value, required, optional, path, errors) {
  for (const field of required) {
    if (!(field in value)) errors.push(`${path}.${field}: required field is missing`);
  }
  const allowed = new Set([...required, ...optional]);
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) errors.push(`${path}.${field}: unknown field`);
  }
}

function validateDateTime(value, path, errors) {
  if (!isNonEmptyString(value) || Number.isNaN(Date.parse(value))) {
    errors.push(`${path}: expected an ISO date-time string`);
  }
}

function validateStringArray(value, path, errors) {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${path}: expected a non-empty array`);
    return;
  }
  const seen = new Set();
  for (const [index, item] of value.entries()) {
    if (!isNonEmptyString(item)) {
      errors.push(`${path}[${index}]: expected a non-empty string`);
      continue;
    }
    if (seen.has(item)) errors.push(`${path}[${index}]: duplicate value ${JSON.stringify(item)}`);
    seen.add(item);
  }
}

function sortedUnique(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right, "en"));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort((left, right) => left.localeCompare(right, "en"))
    .map((key) => [key, stableValue(value[key])]));
}

async function validateControlCatalog(
  document,
  {
    repoRoot,
    documentPath,
    expectedControlCatalogSha256,
    testOnlyAllowUnapprovedControlCatalog = false,
    sourceSnapshotContext,
  },
  errors,
) {
  if (!isRecord(document.control_catalog) || !isNonEmptyString(document.control_catalog.path)) return;
  const label = "$.control_catalog";
  let catalogBytes;
  try {
    catalogBytes = sourceSnapshotContext?.contentByPath?.get(document.control_catalog.path);
    if (!Buffer.isBuffer(catalogBytes)) throw new Error(`${label}: absent from the frozen review context`);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
    return;
  }
  const actualCatalogSha256 = sha256(catalogBytes);
  if (actualCatalogSha256 !== document.control_catalog.sha256) {
    errors.push(`${label}.sha256: does not match the current control catalog bytes`);
    return;
  }
  const syntheticUnapprovedAllowed = testOnlyAllowUnapprovedControlCatalog === true &&
    process.env.NODE_ENV === "test" && sourceSnapshotContext.synthetic_supplement_for_tests === true;
  if (!/^[a-f0-9]{64}$/u.test(expectedControlCatalogSha256 ?? "") && !syntheticUnapprovedAllowed) {
    errors.push(
      `${label}.sha256: trusted validation requires an externally supplied approved control-catalog digest`,
    );
  } else if (expectedControlCatalogSha256 !== undefined &&
      actualCatalogSha256 !== expectedControlCatalogSha256) {
    errors.push(`${label}.sha256: does not match the externally approved control-catalog digest`);
  }
  let catalog;
  try {
    catalog = JSON.parse(catalogBytes.toString("utf8"));
  } catch {
    errors.push(`${label}.path: control catalog must be valid JSON`);
    return;
  }
  if (!isRecord(catalog) || catalog.schema_version !== document.control_catalog.schema_version ||
      !isNonEmptyString(catalog.catalog_id) || !Array.isArray(catalog.source_documents) ||
      catalog.source_documents.length === 0 || !Array.isArray(catalog.requirements) ||
      catalog.requirements.length === 0) {
    errors.push(`${label}.path: control catalog shape is invalid`);
    return;
  }
  const expectedCatalogFields = ["catalog_id", "requirements", "schema_version", "source_documents"];
  if (JSON.stringify(Object.keys(catalog).sort()) !== JSON.stringify(expectedCatalogFields)) {
    errors.push(`${label}.path: control catalog fields differ from the fixed schema`);
  }
  for (const [sourceIndex, source] of catalog.source_documents.entries()) {
    const sourceLabel = `${label}.source_documents[${sourceIndex}]`;
    if (!isRecord(source) || JSON.stringify(Object.keys(source).sort()) !==
        JSON.stringify(["path", "sha256"]) || !isNonEmptyString(source.path) ||
        !/^[a-f0-9]{64}$/u.test(source.sha256 ?? "")) {
      errors.push(`${sourceLabel}: invalid source document identity`);
      continue;
    }
    try {
      if (!sourceSnapshotContext.source_entries.some((entry) => entry.path === source.path)) {
        throw new Error(`${sourceLabel}: source specification must be in the acceptance source snapshot`);
      }
      const sourceBytes = sourceSnapshotContext.contentByPath.get(source.path);
      if (!Buffer.isBuffer(sourceBytes) || sha256(sourceBytes) !== source.sha256) {
        errors.push(`${sourceLabel}.sha256: source specification bytes changed`);
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  const requirementsById = new Map();
  const catalogClauseIds = new Set();
  for (const [requirementIndex, requirement] of catalog.requirements.entries()) {
    const requirementLabel = `${label}.requirements[${requirementIndex}]`;
    if (!isRecord(requirement) || JSON.stringify(Object.keys(requirement).sort()) !==
        JSON.stringify(["business_risk", "clauses", "requirement_id"]) ||
        !isNonEmptyString(requirement.requirement_id) || !isNonEmptyString(requirement.business_risk) ||
        !Array.isArray(requirement.clauses) || requirement.clauses.length === 0 ||
        requirementsById.has(requirement.requirement_id)) {
      errors.push(`${requirementLabel}: invalid or duplicate catalog requirement`);
      continue;
    }
    const clauses = new Map();
    for (const [clauseIndex, clause] of requirement.clauses.entries()) {
      const clauseLabel = `${requirementLabel}.clauses[${clauseIndex}]`;
      if (!isRecord(clause) || JSON.stringify(Object.keys(clause).sort()) !==
          JSON.stringify(["clause_id", "control"]) || !isNonEmptyString(clause.clause_id) ||
          !isNonEmptyString(clause.control) || clauses.has(clause.clause_id) ||
          catalogClauseIds.has(clause.clause_id) ||
          !clause.clause_id.startsWith(`${requirement.requirement_id}-C`)) {
        errors.push(`${clauseLabel}: invalid, duplicate or incorrectly scoped clause`);
        continue;
      }
      const canonicalClause = {
        claim_id: clause.clause_id,
        source_clause_id: clause.clause_id,
        control: clause.control,
      };
      clauses.set(clause.clause_id, canonicalClause);
      catalogClauseIds.add(clause.clause_id);
    }
    requirementsById.set(requirement.requirement_id, { ...requirement, clauses });
  }
  const documentRequirementIds = document.requirements.map((requirement) => requirement?.requirement_id);
  if (JSON.stringify(sortedUnique(documentRequirementIds)) !==
      JSON.stringify(sortedUnique([...requirementsById.keys()]))) {
    errors.push(`${label}.path: catalog requirement IDs must exactly cover the traceability document`);
  }
  for (const [requirementIndex, requirement] of document.requirements.entries()) {
    if (!isRecord(requirement)) continue;
    const requirementLabel = `$.requirements[${requirementIndex}]`;
    const catalogRequirement = requirementsById.get(requirement.requirement_id);
    if (!catalogRequirement) continue;
    if (requirement.business_risk !== catalogRequirement.business_risk) {
      errors.push(`${requirementLabel}.business_risk: must equal the canonical catalog risk`);
    }
    const actualClauses = new Map((requirement.control_claims ?? [])
      .filter(isRecord).map((claim) => [claim.source_clause_id, {
        claim_id: claim.claim_id,
        source_clause_id: claim.source_clause_id,
        control: claim.control,
      }]));
    if (JSON.stringify(stableValue([...actualClauses.entries()].sort())) !==
        JSON.stringify(stableValue([...catalogRequirement.clauses.entries()].sort()))) {
      errors.push(
        `${requirementLabel}.control_claims: claim IDs, source clause IDs and controls must exactly cover the canonical catalog`,
      );
    }
  }
  // The catalog itself is part of the reviewed subject; locating it beside the
  // traceability file is deliberately not permitted because that would let a
  // review artifact redefine its own accepted controls outside source scope.
  if (resolve(repoRoot, document.control_catalog.path) === resolve(documentPath)) {
    errors.push(`${label}.path: control catalog must be a distinct accepted-source artifact`);
  }
}

function validateMutationDefinition(obligation, path, errors) {
  if (!VALID_MUTATION_OPERATORS.has(obligation.mutation_operator)) {
    errors.push(`${path}.mutation_operator: unsupported fixed mutation operator`);
  }
  if (!isNonEmptyString(obligation.literal) || typeof obligation.replacement !== "string" ||
      obligation.literal === obligation.replacement || /[\0\r\n]/u.test(obligation.literal) ||
      /[\0\r\n]/u.test(obligation.replacement)) {
    errors.push(`${path}: literal and replacement must be distinct single-line exact mutations`);
  }
  if (obligation.mutation_operator === "FLIP_BOOLEAN_LITERAL" &&
      !((obligation.literal === "true" && obligation.replacement === "false") ||
        (obligation.literal === "false" && obligation.replacement === "true"))) {
    errors.push(`${path}: FLIP_BOOLEAN_LITERAL must flip true and false exactly`);
  }
  if (obligation.mutation_operator === "FLIP_COMPARATOR" &&
      !new Set(["===", "!==", "<=", ">=", "<", ">"]).has(obligation.literal)) {
    errors.push(`${path}: FLIP_COMPARATOR requires an exact comparator literal`);
  }
}

function validateControlClaims(requirement, path, errors, globalProbeRegistry) {
  if (!Array.isArray(requirement.control_claims) || requirement.control_claims.length === 0) {
    errors.push(`${path}.control_claims: expected a non-empty array`);
    return;
  }
  const requirementId = requirement.requirement_id;
  const claimIds = new Set();
  const sourceClauseIds = new Set();
  const aggregate = new Map(CLAIM_ARRAY_FIELDS.map((field) => [field, []]));
  for (const [claimIndex, claim] of requirement.control_claims.entries()) {
    const claimPath = `${path}.control_claims[${claimIndex}]`;
    if (!isRecord(claim)) {
      errors.push(`${claimPath}: expected an object`);
      continue;
    }
    hasExactFields(claim, CONTROL_CLAIM_FIELDS, [], claimPath, errors);
    const expectedClaimPrefix = isNonEmptyString(requirementId) ? `${requirementId}-C` : "";
    if (!isNonEmptyString(claim.claim_id) ||
        !/^[A-Z][A-Z0-9_-]*-[0-9]{3,}-C[0-9]{2,}$/u.test(claim.claim_id) ||
        (expectedClaimPrefix && !claim.claim_id.startsWith(expectedClaimPrefix))) {
      errors.push(`${claimPath}.claim_id: expected a stable ID scoped to ${requirementId}`);
    } else if (claimIds.has(claim.claim_id)) {
      errors.push(`${claimPath}.claim_id: duplicate claim ID ${claim.claim_id}`);
    }
    claimIds.add(claim.claim_id);
    if (!isNonEmptyString(claim.source_clause_id) || claim.source_clause_id !== claim.claim_id) {
      errors.push(`${claimPath}.source_clause_id: must equal the stable claim ID`);
    } else if (sourceClauseIds.has(claim.source_clause_id)) {
      errors.push(`${claimPath}.source_clause_id: duplicate source clause ${claim.source_clause_id}`);
    }
    sourceClauseIds.add(claim.source_clause_id);
    if (!isNonEmptyString(claim.control)) errors.push(`${claimPath}.control: expected a non-empty string`);
    for (const field of CLAIM_ARRAY_FIELDS) {
      validateStringArray(claim[field], `${claimPath}.${field}`, errors);
      if (Array.isArray(claim[field])) aggregate.get(field).push(...claim[field]);
    }
    if (Array.isArray(claim.positive_tests) && Array.isArray(claim.negative_or_mutation_tests) &&
        JSON.stringify(sortedUnique(claim.positive_tests)) ===
          JSON.stringify(sortedUnique(claim.negative_or_mutation_tests))) {
      errors.push(`${claimPath}: positive_tests and negative_or_mutation_tests cannot be identical`);
    }
    if (!Array.isArray(claim.probe_obligations) || claim.probe_obligations.length === 0) {
      errors.push(`${claimPath}.probe_obligations: expected a non-empty array`);
      continue;
    }
    const obligationIds = new Set();
    const obligationTargets = [];
    const obligationTests = [];
    for (const [obligationIndex, obligation] of claim.probe_obligations.entries()) {
      const obligationPath = `${claimPath}.probe_obligations[${obligationIndex}]`;
      if (!isRecord(obligation)) {
        errors.push(`${obligationPath}: expected an object`);
        continue;
      }
      hasExactFields(obligation, PROBE_OBLIGATION_FIELDS, [], obligationPath, errors);
      const expectedObligationPrefix = isNonEmptyString(claim.claim_id) ? `${claim.claim_id}-P` : "";
      if (!isNonEmptyString(obligation.obligation_id) ||
          !/^[A-Z][A-Z0-9_-]*-[0-9]{3,}-C[0-9]{2,}-P[0-9]{2,}$/u.test(obligation.obligation_id) ||
          (expectedObligationPrefix && !obligation.obligation_id.startsWith(expectedObligationPrefix))) {
        errors.push(`${obligationPath}.obligation_id: expected a stable ID scoped to ${claim.claim_id}`);
      } else if (obligationIds.has(obligation.obligation_id)) {
        errors.push(`${obligationPath}.obligation_id: duplicate obligation ID ${obligation.obligation_id}`);
      }
      obligationIds.add(obligation.obligation_id);
      if (isNonEmptyString(obligation.obligation_id)) {
        const priorObligation = globalProbeRegistry.obligationIds.get(obligation.obligation_id);
        if (priorObligation !== undefined) {
          errors.push(
            `${obligationPath}.obligation_id: ` +
            `INDEPENDENT_REVIEW_PROBE_OBLIGATION_ID_REUSED:${obligation.obligation_id}:${priorObligation}`,
          );
        } else {
          globalProbeRegistry.obligationIds.set(obligation.obligation_id, obligationPath);
        }
      }
      if (!isNonEmptyString(obligation.invariant)) {
        errors.push(`${obligationPath}.invariant: expected a non-empty string`);
      }
      if (!isNonEmptyString(obligation.target_path)) {
        errors.push(`${obligationPath}.target_path: expected a non-empty string`);
      } else {
        obligationTargets.push(obligation.target_path);
      }
      if (!isNonEmptyString(obligation.target_anchor)) {
        errors.push(`${obligationPath}.target_anchor: expected a stable symbol or source anchor`);
      }
      validateMutationDefinition(obligation, obligationPath, errors);
      validateStringArray(obligation.test_files, `${obligationPath}.test_files`, errors);
      validateStringArray(obligation.expected_failing_test_names,
        `${obligationPath}.expected_failing_test_names`, errors);
      validateStringArray(obligation.expected_failure_message_patterns,
        `${obligationPath}.expected_failure_message_patterns`, errors);
      if (Array.isArray(obligation.test_files)) obligationTests.push(...obligation.test_files);
      if (!Array.isArray(obligation.test_files) || !obligation.test_files.includes(obligation.mutation_test_path)) {
        errors.push(`${obligationPath}.mutation_test_path: must be one of the obligation test_files`);
      }
      if (Array.isArray(claim.implementation_files) &&
          isNonEmptyString(obligation.target_path) &&
          !claim.implementation_files.includes(obligation.target_path)) {
        errors.push(`${obligationPath}.target_path: ${obligation.target_path} is not a claim implementation file`);
      }
      if ([obligation.target_path, obligation.target_anchor, obligation.literal,
        obligation.mutation_test_path].every(isNonEmptyString)) {
        const fingerprint = JSON.stringify([
          obligation.target_path,
          obligation.target_anchor,
          obligation.literal,
          obligation.mutation_test_path,
        ]);
        const prior = globalProbeRegistry.fingerprints.get(fingerprint);
        if (prior !== undefined && prior.claimId !== claim.claim_id) {
          errors.push(
            `${obligationPath}: INDEPENDENT_REVIEW_CROSS_CLAIM_PROBE_FINGERPRINT_REUSED:` +
            `${prior.claimId}:${prior.path}`,
          );
        } else if (prior === undefined) {
          globalProbeRegistry.fingerprints.set(fingerprint, { claimId: claim.claim_id, path: obligationPath });
        }
      }
    }
    const expectedTargets = sortedUnique(claim.implementation_files ?? []);
    if (JSON.stringify(sortedUnique(obligationTargets)) !== JSON.stringify(expectedTargets)) {
      errors.push(`${claimPath}.implementation_files: must equal the exact union of probe-obligation targets`);
    }
    const expectedTests = sortedUnique([
      ...(claim.positive_tests ?? []),
      ...(claim.negative_or_mutation_tests ?? []),
    ]);
    if (JSON.stringify(sortedUnique(obligationTests)) !== JSON.stringify(expectedTests)) {
      errors.push(`${claimPath}: claim tests must equal the exact union of probe-obligation test_files`);
    }
  }
  if (isNonEmptyString(requirement.design_control)) {
    const derivedControl = requirement.control_claims
      .filter(isRecord)
      .map((claim) => claim.control)
      .filter(isNonEmptyString)
      .join(" ");
    if (requirement.design_control !== derivedControl) {
      errors.push(`${path}.design_control: must be derived exactly from ordered control claims`);
    }
  }
  for (const field of CLAIM_ARRAY_FIELDS) {
    const expected = sortedUnique(aggregate.get(field) ?? []);
    const actual = sortedUnique(Array.isArray(requirement[field]) ? requirement[field] : []);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      errors.push(`${path}.${field}: must equal the exact union of control-claim citations`);
    }
  }
}

function validateWaiver(requirement, path, errors, now) {
  if (requirement.status !== "WAIVED") {
    if ("waiver" in requirement) errors.push(`${path}.waiver: only WAIVED requirements may carry a waiver`);
    return;
  }
  if (!isRecord(requirement.waiver)) {
    errors.push(`${path}.waiver: WAIVED status requires waiver metadata`);
    return;
  }
  hasExactFields(requirement.waiver, WAIVER_FIELDS, [], `${path}.waiver`, errors);
  for (const field of ["accepted_by", "reason", "scope"]) {
    if (!isNonEmptyString(requirement.waiver[field])) {
      errors.push(`${path}.waiver.${field}: expected a non-empty string`);
    }
  }
  validateDateTime(requirement.waiver.expires_at, `${path}.waiver.expires_at`, errors);
  if (isNonEmptyString(requirement.waiver.expires_at) && Date.parse(requirement.waiver.expires_at) <= now.getTime()) {
    errors.push(`${path}.waiver.expires_at: waiver is expired`);
  }
}

function validateClosure(requirement, path, errors, expectedSourceFingerprint) {
  if (requirement.status !== "CLOSED") {
    if ("closure" in requirement) errors.push(`${path}.closure: only CLOSED requirements may carry closure evidence`);
    return;
  }
  if (!isRecord(requirement.closure)) {
    errors.push(`${path}.closure: CLOSED status requires independent reviewer closure evidence`);
    return;
  }
  hasExactFields(requirement.closure, CLOSURE_FIELDS, [], `${path}.closure`, errors);
  for (const field of [
    "implementation_execution_id",
    "reviewer_execution_id",
    "reviewer_role",
    "review_artifact",
  ]) {
    if (!isNonEmptyString(requirement.closure[field])) {
      errors.push(`${path}.closure.${field}: expected a non-empty string`);
    }
  }
  validateDateTime(requirement.closure.reviewed_at, `${path}.closure.reviewed_at`, errors);
  if (requirement.closure.decision !== "CLOSED") errors.push(`${path}.closure.decision: expected CLOSED`);
  for (const field of [
    "source_fingerprint",
    "review_subject_sha256",
    "review_inputs_sha256",
    "review_artifact_sha256",
  ]) {
    if (!/^[a-f0-9]{64}$/u.test(requirement.closure[field] ?? "")) {
      errors.push(`${path}.closure.${field}: expected a SHA-256 digest`);
    }
  }
  if (requirement.closure.reviewer_execution_id === requirement.closure.implementation_execution_id) {
    errors.push(`${path}.closure.reviewer_execution_id: implementer/controller execution cannot close its own requirement`);
  }
  if (requirement.closure.reviewer_role !== requirement.reviewer) {
    errors.push(`${path}.closure.reviewer_role: must match the assigned reviewer role`);
  }
  if (expectedSourceFingerprint && requirement.closure.source_fingerprint !== expectedSourceFingerprint) {
    errors.push(`${path}.closure.source_fingerprint: reviewer verdict is stale for this source`);
  }
}

export function validateTraceabilityDocument(document, options = {}) {
  const errors = [];
  const requireClosed = options.requireClosed === true;
  const now = options.now ?? new Date();
  const expectedSourceFingerprint = options.expectedSourceFingerprint;
  if (!isRecord(document)) return ["$: expected an object"];

  hasExactFields(document, TOP_LEVEL_FIELDS, [], "$", errors);
  if (document.schema_version !== "4.0") errors.push("$.schema_version: expected 4.0");
  if (!isNonEmptyString(document.round_id)) errors.push("$.round_id: expected a non-empty string");
  validateDateTime(document.generated_at, "$.generated_at", errors);
  if (!isNonEmptyString(document.evidence_boundary)) {
    errors.push("$.evidence_boundary: expected a non-empty string");
  }
  if (!isRecord(document.control_catalog)) {
    errors.push("$.control_catalog: expected an object");
  } else {
    hasExactFields(document.control_catalog, CONTROL_CATALOG_IDENTITY_FIELDS, [], "$.control_catalog", errors);
    if (!isNonEmptyString(document.control_catalog.path)) {
      errors.push("$.control_catalog.path: expected a non-empty string");
    }
    if (document.control_catalog.schema_version !== "1.0") {
      errors.push("$.control_catalog.schema_version: expected 1.0");
    }
    if (!/^[a-f0-9]{64}$/u.test(document.control_catalog.sha256 ?? "")) {
      errors.push("$.control_catalog.sha256: expected a SHA-256 digest");
    }
  }
  if (!Array.isArray(document.requirements) || document.requirements.length === 0) {
    errors.push("$.requirements: expected a non-empty array");
    return errors;
  }

  const requirementIds = new Set();
  const globalProbeRegistry = {
    obligationIds: new Map(),
    fingerprints: new Map(),
  };
  for (const [index, requirement] of document.requirements.entries()) {
    const path = `$.requirements[${index}]`;
    if (!isRecord(requirement)) {
      errors.push(`${path}: expected an object`);
      continue;
    }
    hasExactFields(requirement, REQUIRED_REQUIREMENT_FIELDS, ["waiver", "closure"], path, errors);
    for (const field of STRING_FIELDS) {
      if (!isNonEmptyString(requirement[field])) errors.push(`${path}.${field}: expected a non-empty string`);
    }
    if (isNonEmptyString(requirement.requirement_id)) {
      if (!/^[A-Z][A-Z0-9_-]*-[0-9]{3,}$/u.test(requirement.requirement_id)) {
        errors.push(`${path}.requirement_id: invalid stable requirement ID`);
      }
      if (requirementIds.has(requirement.requirement_id)) {
        errors.push(`${path}.requirement_id: duplicate ID ${requirement.requirement_id}`);
      }
      requirementIds.add(requirement.requirement_id);
    }
    for (const field of ARRAY_FIELDS) validateStringArray(requirement[field], `${path}.${field}`, errors);
    validateControlClaims(requirement, path, errors, globalProbeRegistry);
    if (Array.isArray(requirement.positive_tests) && Array.isArray(requirement.negative_or_mutation_tests)) {
      const positive = JSON.stringify([...requirement.positive_tests].sort());
      const negative = JSON.stringify([...requirement.negative_or_mutation_tests].sort());
      if (positive === negative) {
        errors.push(`${path}: positive_tests and negative_or_mutation_tests cannot be identical`);
      }
    }
    if (!VALID_STATUSES.has(requirement.status)) errors.push(`${path}.status: unsupported status`);
    validateWaiver(requirement, path, errors, now);
    validateClosure(requirement, path, errors, expectedSourceFingerprint);
    if (requireClosed && requirement.status !== "CLOSED") {
      errors.push(`${path}.status: local release gate requires independently CLOSED; WAIVED cannot satisfy this gate`);
    }
  }
  return errors;
}

function containedPath(base, candidate, label) {
  if (!isNonEmptyString(candidate) || isAbsolute(candidate) || candidate.includes("\0")) {
    throw new Error(`${label}: path must be repository-relative`);
  }
  const absolute = resolve(base, candidate);
  if (absolute !== base && !absolute.startsWith(`${base}${sep}`)) {
    throw new Error(`${label}: path escapes its evidence boundary`);
  }
  return absolute;
}

function containsExactJsonValue(value, expected) {
  if (value === expected) return true;
  if (Array.isArray(value)) return value.some((child) => containsExactJsonValue(child, expected));
  return isRecord(value) && Object.values(value).some((child) => containsExactJsonValue(child, expected));
}

async function regularFile(path, label, errors) {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) errors.push(`${label}: must resolve to a regular non-symlink file`);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch (error) {
    errors.push(`${label}: referenced file does not exist`);
    return false;
  }
}

/** Verifies that traceability citations point to real, non-symlink artifacts. */
export async function validateTraceabilityReferences(document, options) {
  const errors = [];
  if (!isRecord(document) || !Array.isArray(document.requirements)) return ["$: requirements are missing"];
  const repoRoot = resolve(options.repoRoot);
  const evidenceDirectory = dirname(resolve(options.documentPath));
  const verifiedUniversePaths = new Set();
  const verifiedUniverseDigests = new Set();
  const verifiedPlans = new Map();
  let sourceSnapshotContext;
  try {
    sourceSnapshotContext = options.sourceSnapshotContext ??
      await captureIndependentReviewDocumentSourceSnapshotContext({
        document,
        repoRoot,
        documentPath: options.documentPath,
      });
    await assertIndependentReviewSourceSnapshotUnchanged(sourceSnapshotContext);
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
  const sourcePaths = new Set(sourceSnapshotContext.source_entries.map((entry) => entry.path));
  await validateControlCatalog(document, {
    repoRoot,
    documentPath: options.documentPath,
    expectedControlCatalogSha256: options.expectedControlCatalogSha256,
    testOnlyAllowUnapprovedControlCatalog: options.testOnlyAllowUnapprovedControlCatalog,
    sourceSnapshotContext,
  }, errors);
  for (const [requirementIndex, requirement] of document.requirements.entries()) {
    if (!isRecord(requirement)) continue;
    for (const field of ["implementation_files", "positive_tests", "negative_or_mutation_tests"]) {
      if (!Array.isArray(requirement[field])) continue;
      for (const [index, reference] of requirement[field].entries()) {
        const label = `$.requirements[${requirementIndex}].${field}[${index}]`;
        try {
          const absolute = containedPath(repoRoot, reference, label);
          const repoRelative = relative(repoRoot, absolute).replaceAll(sep, "/");
          if (!sourcePaths.has(repoRelative) ||
              !Buffer.isBuffer(sourceSnapshotContext.contentByPath.get(repoRelative))) {
            errors.push(`${label}: implementation/test reference is absent from the acceptance source snapshot`);
          }
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error));
        }
      }
    }
    if (!Array.isArray(requirement.evidence)) continue;
    for (const [index, reference] of requirement.evidence.entries()) {
      const label = `$.requirements[${requirementIndex}].evidence[${index}]`;
      if (!isNonEmptyString(reference)) continue;
      const separator = reference.indexOf("#");
      const pathPart = separator < 0 ? reference : reference.slice(0, separator);
      const fragment = separator < 0 ? undefined : reference.slice(separator + 1);
      try {
        const base = pathPart.includes("/") ? repoRoot : evidenceDirectory;
        const path = containedPath(base, pathPart, label);
        const repoRelative = relative(repoRoot, path).replaceAll(sep, "/");
        const contentBytes = sourceSnapshotContext.contentByPath.get(repoRelative);
        if (!Buffer.isBuffer(contentBytes)) {
          errors.push(`${label}: evidence is absent from the exact supplemental input set`);
          continue;
        }
        if (fragment === undefined) continue;
        if (!isNonEmptyString(fragment)) {
          errors.push(`${label}: evidence fragment is empty`);
          continue;
        }
        const content = contentBytes.toString("utf8");
        const values = [];
        if (path.endsWith(".jsonl")) {
          for (const [lineIndex, line] of content.split(/\r?\n/u).entries()) {
            if (!line.trim()) continue;
            try {
              values.push(JSON.parse(line));
            } catch {
              errors.push(`${label}: invalid JSONL at line ${lineIndex + 1}`);
              break;
            }
          }
        } else {
          try {
            values.push(JSON.parse(content));
          } catch {
            errors.push(`${label}: fragments require JSON or JSONL evidence`);
            continue;
          }
        }
        if (!values.some((value) => containsExactJsonValue(value, fragment))) {
          errors.push(`${label}: fragment ${JSON.stringify(fragment)} was not found as an exact JSON value`);
        }
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (requirement.status === "CLOSED" && isRecord(requirement.closure)) {
      const label = `$.requirements[${requirementIndex}].closure.review_artifact`;
      try {
        const path = containedPath(evidenceDirectory, requirement.closure.review_artifact, label);
        const verifier = options.legacyIndependentReviewFixture === true &&
          process.env.NODE_ENV === "test"
          ? verifyIndependentReviewClosure
          : verifyIndependentReviewAggregateClosure;
        const verified = await verifier({
          document,
          requirement,
          closure: requirement.closure,
          reviewArtifactPath: path,
          expectedReviewArtifactSha256: requirement.closure.review_artifact_sha256,
          expectedSourceFingerprint: options.expectedSourceFingerprint,
          repoRoot,
          documentPath: options.documentPath,
          allowedCodexExecutablePaths: options.allowedCodexExecutablePaths,
          reviewTestExecutor: options.reviewTestExecutor,
          reviewExecutionReceipts: options.reviewExecutionReceipts,
          sourceSnapshotContext,
          approvedReviewRuntimeSha256: options.approvedReviewRuntimeSha256,
        });
        for (const file of verified.reviewInputs.files) verifiedUniversePaths.add(file.path);
        verifiedUniverseDigests.add(verified.reviewInputs.universe.sha256);
        if (verified.plan) verifiedPlans.set(requirement.requirement_id, verified.plan);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
  }
  if (document.requirements.every((requirement) => requirement?.status === "CLOSED")) {
    try {
      const documentPlan = await deriveIndependentReviewDocumentPlan({
        document,
        repoRoot,
        documentPath: options.documentPath,
        sourceSnapshotContext,
      });
      const expectedPaths = documentPlan.expected_paths;
      const missing = expectedPaths.filter((path) => !verifiedUniversePaths.has(path));
      const extra = [...verifiedUniversePaths].filter((path) => !expectedPaths.includes(path));
      if (missing.length > 0 || extra.length > 0 || verifiedUniversePaths.size !== expectedPaths.length ||
          verifiedUniverseDigests.size !== 1 ||
          !verifiedUniverseDigests.has(documentPlan.review_universe_sha256)) {
        errors.push(
          `INDEPENDENT_REVIEW_UNIVERSE_COVERAGE_INCOMPLETE:` +
          `expected=${expectedPaths.length}:verified=${verifiedUniversePaths.size}:` +
          `missing=${missing.slice(0, 20).join(",")}:extra=${extra.slice(0, 20).join(",")}`,
        );
      }
      const requirementIds = documentPlan.requirement_ids;
      if (verifiedPlans.size === 0 && options.legacyIndependentReviewFixture !== true) {
        errors.push("INDEPENDENT_REVIEW_DOCUMENT_PLAN_BINDING_MISSING");
      } else if (verifiedPlans.size > 0) {
        const expectedPlanDigests = new Map(documentPlan.requirement_plans.map((plan) =>
          [plan.requirement_id, plan.plan_sha256]));
        for (const requirementId of requirementIds) {
          const verified = verifiedPlans.get(requirementId);
          if (!verified || verified.plan_sha256 !== expectedPlanDigests.get(requirementId) ||
              verified.document_plan_sha256 !== documentPlan.document_plan_sha256 ||
              verified.full_graph_sha256 !== documentPlan.full_graph_sha256 ||
              verified.global_peripheral_plan_sha256 !== documentPlan.global_peripheral_plan_sha256) {
            errors.push(`INDEPENDENT_REVIEW_DOCUMENT_PLAN_BINDING_INVALID:${requirementId}`);
          }
        }
        const verifiedPaths = sortedUnique([...verifiedPlans.values()].flatMap((plan) => plan.expected_paths));
        const verifiedEdges = sortedUnique([...verifiedPlans.values()].flatMap((plan) =>
          plan.expected_dependency_edges));
        const assignedOwnedEdges = [...verifiedPlans.values()].flatMap((plan) =>
          plan.expected_owned_dependency_edge_ids);
        const verifiedOwnedEdges = sortedUnique(assignedOwnedEdges);
        const assignedContentUnits = [...verifiedPlans.values()].flatMap((plan) =>
          plan.expected_owned_content_unit_ids);
        const assignedTransportChunks = [...verifiedPlans.values()].flatMap((plan) =>
          plan.expected_owned_transport_chunk_ids);
        const verifiedContentUnits = sortedUnique(assignedContentUnits);
        const verifiedTransportChunks = sortedUnique(assignedTransportChunks);
        if (JSON.stringify(verifiedPaths) !== JSON.stringify(documentPlan.expected_paths) ||
            JSON.stringify(verifiedEdges) !== JSON.stringify(documentPlan.expected_dependency_edges) ||
            assignedOwnedEdges.length !== verifiedOwnedEdges.length ||
            JSON.stringify(verifiedOwnedEdges) !== JSON.stringify(documentPlan.expected_dependency_edges) ||
            assignedContentUnits.length !== verifiedContentUnits.length ||
            assignedTransportChunks.length !== verifiedTransportChunks.length ||
            JSON.stringify(verifiedContentUnits) !== JSON.stringify(documentPlan.expected_content_unit_ids) ||
            JSON.stringify(verifiedTransportChunks) !== JSON.stringify(documentPlan.expected_transport_chunk_ids)) {
          errors.push("INDEPENDENT_REVIEW_DOCUMENT_PLAN_EXACT_PATH_EDGE_UNION_INVALID");
        }
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return errors;
}
