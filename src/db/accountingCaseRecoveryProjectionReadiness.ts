import type { AccountingCaseVersionRecord } from "../domain/accountingCasePersistence.js";
import { XERO_ACCOUNTING_CASE_PROVIDER_PROJECTION_VERSION } from "../policy/xeroAccountingCaseProviderContract.js";
import { XERO_DECLARED_LEDGER_POLICY_PROJECTION_VERSION } from "../policy/xeroDeclaredLedgerPolicy.js";

export type ActiveAccountingCaseRecoveryProjectionStatus =
  | "COMPATIBLE"
  | "UNSUPPORTED_ACTIVE_RECOVERY_PROJECTION"
  | "UNKNOWN";

/** Public, aggregate-only evidence. It must never contain a Case identifier. */
export interface ActiveAccountingCaseRecoveryProjectionEvidence {
  status: ActiveAccountingCaseRecoveryProjectionStatus;
  activeCaseCount: number | null;
  storedPolicyProjectionVersions: string[];
  storedProviderProjectionVersions: string[];
  requiredPolicyProjectionVersion: string;
  requiredProviderProjectionVersion: string;
}

export interface PostgresActiveRecoveryProjectionRow {
  active_recovery_case_count: string | number;
  stored_policy_projection_versions: unknown;
  stored_provider_projection_versions: unknown;
  active_recovery_projection_valid: unknown;
  active_recovery_projection_compatible: unknown;
}

const UNCERTAIN_OPERATION_STATES = new Set([
  "WRITE_IN_FLIGHT",
  "WRITE_UNCERTAIN",
  "READBACK_MISMATCH",
]);
// Both the retired jurisdiction policy and the released declared-ledger policy
// are recognised: a legacy stored projection must still be *identified* so the
// compatibility gate can refuse to reinterpret it.
const POLICY_PROJECTION_VERSION =
  /^xero-(?:sg-accounting-policy|declared-ledger-policy)-projection:v[1-9][0-9]*$/u;
const PROVIDER_PROJECTION_VERSION = /^xero-accounting-case-provider-projection:v[1-9][0-9]*$/u;

function requiredEvidence(
  value: Omit<ActiveAccountingCaseRecoveryProjectionEvidence,
    "requiredPolicyProjectionVersion" | "requiredProviderProjectionVersion">,
): ActiveAccountingCaseRecoveryProjectionEvidence {
  return {
    ...value,
    requiredPolicyProjectionVersion: XERO_DECLARED_LEDGER_POLICY_PROJECTION_VERSION,
    requiredProviderProjectionVersion: XERO_ACCOUNTING_CASE_PROVIDER_PROJECTION_VERSION,
  };
}

export function unknownActiveAccountingCaseRecoveryProjectionEvidence():
ActiveAccountingCaseRecoveryProjectionEvidence {
  return requiredEvidence({
    status: "UNKNOWN",
    activeCaseCount: null,
    storedPolicyProjectionVersions: [],
    storedProviderProjectionVersions: [],
  });
}

export function isActiveAccountingCaseRecoveryProjectionEvidence(
  value: unknown,
): value is ActiveAccountingCaseRecoveryProjectionEvidence {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const evidence = value as Partial<ActiveAccountingCaseRecoveryProjectionEvidence>;
  if (
    evidence.requiredPolicyProjectionVersion !== XERO_DECLARED_LEDGER_POLICY_PROJECTION_VERSION ||
    evidence.requiredProviderProjectionVersion !== XERO_ACCOUNTING_CASE_PROVIDER_PROJECTION_VERSION ||
    !Array.isArray(evidence.storedPolicyProjectionVersions) ||
    evidence.storedPolicyProjectionVersions.some((entry) =>
      typeof entry !== "string" || !POLICY_PROJECTION_VERSION.test(entry)) ||
    !Array.isArray(evidence.storedProviderProjectionVersions) ||
    evidence.storedProviderProjectionVersions.some((entry) =>
      typeof entry !== "string" || !PROVIDER_PROJECTION_VERSION.test(entry))
  ) return false;
  if (evidence.status === "UNKNOWN") {
    return evidence.activeCaseCount === null &&
      evidence.storedPolicyProjectionVersions.length === 0 &&
      evidence.storedProviderProjectionVersions.length === 0;
  }
  if (!Number.isSafeInteger(evidence.activeCaseCount)) return false;
  const count = evidence.activeCaseCount ?? -1;
  if (evidence.status === "COMPATIBLE") {
    return (count === 0 && evidence.storedPolicyProjectionVersions.length === 0 &&
        evidence.storedProviderProjectionVersions.length === 0) ||
      (count > 0 && evidence.storedPolicyProjectionVersions.length === 1 &&
        evidence.storedPolicyProjectionVersions[0] === XERO_DECLARED_LEDGER_POLICY_PROJECTION_VERSION &&
        evidence.storedProviderProjectionVersions.length === 1 &&
        evidence.storedProviderProjectionVersions[0] === XERO_ACCOUNTING_CASE_PROVIDER_PROJECTION_VERSION);
  }
  return evidence.status === "UNSUPPORTED_ACTIVE_RECOVERY_PROJECTION" && count > 0 &&
    evidence.storedPolicyProjectionVersions.length > 0 &&
    evidence.storedProviderProjectionVersions.length > 0;
}

export function isActiveAccountingCaseRecovery(record: AccountingCaseVersionRecord): boolean {
  if (record.state === "TERMINAL") return false;
  return record.state === "RECOVERY_REQUIRED" || record.operations.some((operation) =>
    UNCERTAIN_OPERATION_STATES.has(operation.state));
}

function projectionVersion(
  value: Readonly<Record<string, unknown>>,
  pattern: RegExp,
): string | undefined {
  return typeof value.schemaVersion === "string" && pattern.test(value.schemaVersion)
    ? value.schemaVersion
    : undefined;
}

export function evaluateActiveAccountingCaseRecoveryProjections(
  records: Iterable<AccountingCaseVersionRecord>,
): ActiveAccountingCaseRecoveryProjectionEvidence {
  const policyVersions = new Set<string>();
  const providerVersions = new Set<string>();
  let activeCaseCount = 0;
  let compatible = true;
  for (const record of records) {
    if (!isActiveAccountingCaseRecovery(record)) continue;
    activeCaseCount += 1;
    const policyVersion = projectionVersion(record.compiled.policyProjection, POLICY_PROJECTION_VERSION);
    const providerVersion = projectionVersion(record.compiled.providerProjection, PROVIDER_PROJECTION_VERSION);
    if (policyVersion === undefined || providerVersion === undefined) {
      return unknownActiveAccountingCaseRecoveryProjectionEvidence();
    }
    policyVersions.add(policyVersion);
    providerVersions.add(providerVersion);
    if (
      policyVersion !== XERO_DECLARED_LEDGER_POLICY_PROJECTION_VERSION ||
      providerVersion !== XERO_ACCOUNTING_CASE_PROVIDER_PROJECTION_VERSION
    ) compatible = false;
  }
  return requiredEvidence({
    status: compatible ? "COMPATIBLE" : "UNSUPPORTED_ACTIVE_RECOVERY_PROJECTION",
    activeCaseCount,
    storedPolicyProjectionVersions: [...policyVersions].sort(),
    storedProviderProjectionVersions: [...providerVersions].sort(),
  });
}

function exactStringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error("ACTIVE_RECOVERY_PROJECTION_QUERY_INVALID");
  }
  const sorted = [...value].sort();
  if (new Set(sorted).size !== sorted.length) {
    throw new Error("ACTIVE_RECOVERY_PROJECTION_QUERY_INVALID");
  }
  return sorted;
}

export function activeAccountingCaseRecoveryProjectionEvidenceFromPostgres(
  row: PostgresActiveRecoveryProjectionRow,
): ActiveAccountingCaseRecoveryProjectionEvidence {
  const activeCaseCount = typeof row.active_recovery_case_count === "number"
    ? row.active_recovery_case_count
    : Number(row.active_recovery_case_count);
  if (!Number.isSafeInteger(activeCaseCount) || activeCaseCount < 0 ||
      typeof row.active_recovery_projection_valid !== "boolean" ||
      typeof row.active_recovery_projection_compatible !== "boolean") {
    throw new Error("ACTIVE_RECOVERY_PROJECTION_QUERY_INVALID");
  }
  if (!row.active_recovery_projection_valid) {
    return unknownActiveAccountingCaseRecoveryProjectionEvidence();
  }
  const storedPolicyProjectionVersions = exactStringArray(row.stored_policy_projection_versions);
  const storedProviderProjectionVersions = exactStringArray(row.stored_provider_projection_versions);
  if (
    storedPolicyProjectionVersions.some((value) => !POLICY_PROJECTION_VERSION.test(value)) ||
    storedProviderProjectionVersions.some((value) => !PROVIDER_PROJECTION_VERSION.test(value))
  ) return unknownActiveAccountingCaseRecoveryProjectionEvidence();
  const compatible = row.active_recovery_projection_compatible;
  if (
    compatible && (
      (activeCaseCount === 0 && (
        storedPolicyProjectionVersions.length !== 0 || storedProviderProjectionVersions.length !== 0
      )) ||
      (activeCaseCount > 0 && (
        storedPolicyProjectionVersions.length !== 1 ||
        storedPolicyProjectionVersions[0] !== XERO_DECLARED_LEDGER_POLICY_PROJECTION_VERSION ||
        storedProviderProjectionVersions.length !== 1 ||
        storedProviderProjectionVersions[0] !== XERO_ACCOUNTING_CASE_PROVIDER_PROJECTION_VERSION
      ))
    )
  ) throw new Error("ACTIVE_RECOVERY_PROJECTION_QUERY_INVALID");
  return requiredEvidence({
    status: compatible ? "COMPATIBLE" : "UNSUPPORTED_ACTIVE_RECOVERY_PROJECTION",
    activeCaseCount,
    storedPolicyProjectionVersions,
    storedProviderProjectionVersions,
  });
}
