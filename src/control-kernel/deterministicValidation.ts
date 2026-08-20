import { z } from "zod/v4";
import { hashObject } from "../security/hash.js";

export const LEDGER_DETERMINISTIC_VALIDATOR_VERSION = "0.1.0";

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const validationCheckSchema = z.object({
  code: z.string().trim().min(1).max(128),
  passed: z.literal(true),
  evidenceHash: hashSchema,
}).strict();

const unsignedReceiptSchema = z.object({
  receiptType: z.literal("LEDGER_DETERMINISTIC_VALIDATION"),
  validatorVersion: z.string().trim().min(1).max(64),
  actionId: z.string().trim().min(1).max(128),
  canonicalPayloadHash: hashSchema,
  sourceRevisionHash: hashSchema,
  caseId: z.string().trim().min(1).max(128).nullable(),
  caseVersion: z.number().int().nonnegative(),
  policyVersion: z.string().trim().min(1).max(64),
  compilerVersion: z.string().trim().min(1).max(64),
  checks: z.array(validationCheckSchema).min(1).max(128),
  issuedAt: z.string().datetime({ offset: true }),
}).strict();

export const deterministicValidationReceiptSchema = unsignedReceiptSchema.extend({
  receiptHash: hashSchema,
}).strict();

export type DeterministicValidationReceipt = z.infer<typeof deterministicValidationReceiptSchema>;

export interface PassedDeterministicCheck {
  readonly code: string;
  readonly evidence: Record<string, unknown>;
}

export interface IssueDeterministicValidationReceiptInput {
  readonly actionId: string;
  readonly canonicalPayloadHash: string;
  readonly sourceRevisionHash: string;
  readonly caseId?: string;
  readonly caseVersion?: number;
  readonly policyVersion: string;
  readonly compilerVersion: string;
  readonly checks: readonly PassedDeterministicCheck[];
  readonly now: Date;
}

export function issueDeterministicValidationReceipt(
  input: IssueDeterministicValidationReceiptInput,
): DeterministicValidationReceipt {
  const unsigned = unsignedReceiptSchema.parse({
    receiptType: "LEDGER_DETERMINISTIC_VALIDATION",
    validatorVersion: LEDGER_DETERMINISTIC_VALIDATOR_VERSION,
    actionId: input.actionId,
    canonicalPayloadHash: input.canonicalPayloadHash,
    sourceRevisionHash: input.sourceRevisionHash,
    caseId: input.caseId ?? null,
    caseVersion: input.caseVersion ?? 0,
    policyVersion: input.policyVersion,
    compilerVersion: input.compilerVersion,
    checks: input.checks.map((check) => ({
      code: check.code,
      passed: true as const,
      evidenceHash: hashObject(check.evidence),
    })),
    issuedAt: input.now.toISOString(),
  });
  return Object.freeze({ ...unsigned, receiptHash: hashObject(unsigned) });
}

export function verifyDeterministicValidationReceipt(
  raw: unknown,
  expected: {
    actionId: string;
    canonicalPayloadHash: string;
    sourceRevisionHash: string;
  },
): DeterministicValidationReceipt | undefined {
  const parsed = deterministicValidationReceiptSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const { receiptHash, ...unsigned } = parsed.data;
  if (hashObject(unsigned) !== receiptHash) return undefined;
  if (
    unsigned.actionId !== expected.actionId ||
    unsigned.canonicalPayloadHash !== expected.canonicalPayloadHash ||
    unsigned.sourceRevisionHash !== expected.sourceRevisionHash
  ) return undefined;
  return Object.freeze(parsed.data);
}

export function objectPreparationSourceRevisionHash(source: {
  sourceRef?: string;
  sourceUnitKey: string;
  sourceSha256: string;
  sourceEvidenceType: string;
}): string {
  return hashObject({
    sourceRef: source.sourceRef ?? null,
    sourceUnitKey: source.sourceUnitKey,
    sourceSha256: source.sourceSha256,
    sourceEvidenceType: source.sourceEvidenceType,
  });
}

export function issueObjectPreparationValidationReceipt(input: {
  actionId: string;
  preparation: {
    preparationId: string;
    canonicalPayloadHash: string;
    sourceRef?: string;
    sourceUnitKey: string;
    sourceSha256: string;
    sourceEvidenceType: string;
    createdAt: Date;
  };
  policyVersion: string;
  compilerVersion: string;
  checks: readonly PassedDeterministicCheck[];
}): DeterministicValidationReceipt {
  return issueDeterministicValidationReceipt({
    actionId: input.actionId,
    canonicalPayloadHash: input.preparation.canonicalPayloadHash,
    sourceRevisionHash: objectPreparationSourceRevisionHash(input.preparation),
    caseVersion: 0,
    policyVersion: input.policyVersion,
    compilerVersion: input.compilerVersion,
    checks: input.checks,
    // A stable issuance instant keeps idempotent re-validation deterministic.
    now: input.preparation.createdAt,
  });
}
