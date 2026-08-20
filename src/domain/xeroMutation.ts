import type { LedgerFirmGovernanceClaim } from "../control-kernel/ledgerControlKernel.js";

export const XERO_MUTATION_OBJECT_TYPES = [
  "SUPPLIER_BILL",
  "SALES_INVOICE",
  "QUOTE",
  "PURCHASE_ORDER",
  "CREDIT_NOTE",
  "MANUAL_JOURNAL",
  "CONTACT",
  "ITEM",
  "TRACKING_CATEGORY",
  "TRACKING_OPTION",
  "PAYMENT",
  "BANK_TRANSACTION",
  "ATTACHMENT",
] as const;

export type XeroMutationObjectType = typeof XERO_MUTATION_OBJECT_TYPES[number];

export const XERO_MUTATION_EXPECTED_READBACK_STATUS = Object.freeze({
  SUPPLIER_BILL: "DRAFT",
  SALES_INVOICE: "DRAFT",
  QUOTE: "DRAFT",
  PURCHASE_ORDER: "DRAFT",
  CREDIT_NOTE: "DRAFT",
  MANUAL_JOURNAL: "DRAFT",
  CONTACT: "ACTIVE",
  ITEM: "UNTRACKED",
  TRACKING_CATEGORY: "ACTIVE",
  TRACKING_OPTION: "ACTIVE",
  PAYMENT: "AUTHORISED",
  BANK_TRANSACTION: "AUTHORISED",
  ATTACHMENT: "UPLOADED",
} as const satisfies Readonly<Record<XeroMutationObjectType, string>>);

export const XERO_MUTATION_OPERATIONS = [
  "CREATE_DRAFT",
  "CREATE",
  "UPDATE",
  "AUTHORISE",
  "POST",
  "ALLOCATE",
  "REFUND",
  "UNALLOCATE",
  "REVERSE",
  "VOID",
  "UPLOAD",
] as const;

export type XeroMutationOperation = typeof XERO_MUTATION_OPERATIONS[number];

export const XERO_EXISTING_TARGET_OPERATIONS = Object.freeze([
  "UPDATE", "AUTHORISE", "POST", "ALLOCATE", "REFUND", "REVERSE", "VOID",
] as const satisfies readonly XeroMutationOperation[]);

export function xeroMutationTargetsExistingObject(operation: XeroMutationOperation): boolean {
  return (XERO_EXISTING_TARGET_OPERATIONS as readonly XeroMutationOperation[]).includes(operation);
}

/** The expected persisted Xero state is a transition result, not only an object kind. */
export function expectedXeroMutationReadbackStatus(
  objectType: XeroMutationObjectType,
  operation: XeroMutationOperation,
): string {
  if (operation === "AUTHORISE" &&
      (objectType === "SUPPLIER_BILL" || objectType === "SALES_INVOICE" || objectType === "CREDIT_NOTE")) {
    return "AUTHORISED";
  }
  if ((operation === "ALLOCATE" || operation === "REFUND") && objectType === "CREDIT_NOTE") {
    return "AUTHORISED";
  }
  if (operation === "POST" && objectType === "MANUAL_JOURNAL") return "POSTED";
  if (operation === "VOID") return "VOIDED";
  if (operation === "REVERSE" && (objectType === "PAYMENT" || objectType === "BANK_TRANSACTION")) return "DELETED";
  return XERO_MUTATION_EXPECTED_READBACK_STATUS[objectType];
}

export const XERO_MUTATION_SOURCE_EVIDENCE_TYPES = [
  "AGENT_ASSERTED_UNVERIFIED",
  "SERVER_FINGERPRINTED_EXTRACTION",
  "HOST_ATTESTED_FILE_RECEIPT",
] as const;

export type XeroMutationSourceEvidenceType = typeof XERO_MUTATION_SOURCE_EVIDENCE_TYPES[number];

export const XERO_MUTATION_ALLOWED_OPERATIONS = Object.freeze({
  SUPPLIER_BILL: Object.freeze(["CREATE_DRAFT", "UPDATE", "AUTHORISE", "VOID"] as const),
  SALES_INVOICE: Object.freeze(["CREATE_DRAFT", "UPDATE", "AUTHORISE", "VOID"] as const),
  QUOTE: Object.freeze(["CREATE_DRAFT", "UPDATE"] as const),
  PURCHASE_ORDER: Object.freeze(["CREATE_DRAFT", "UPDATE"] as const),
  CREDIT_NOTE: Object.freeze(["CREATE_DRAFT", "UPDATE", "AUTHORISE", "ALLOCATE", "REFUND", "UNALLOCATE", "VOID"] as const),
  MANUAL_JOURNAL: Object.freeze(["CREATE_DRAFT", "UPDATE", "POST", "VOID"] as const),
  CONTACT: Object.freeze(["CREATE", "UPDATE"] as const),
  ITEM: Object.freeze(["CREATE", "UPDATE"] as const),
  TRACKING_CATEGORY: Object.freeze(["CREATE", "UPDATE"] as const),
  TRACKING_OPTION: Object.freeze(["CREATE", "UPDATE"] as const),
  PAYMENT: Object.freeze(["CREATE", "REVERSE"] as const),
  BANK_TRANSACTION: Object.freeze(["CREATE", "UPDATE", "REVERSE"] as const),
  ATTACHMENT: Object.freeze(["UPLOAD"] as const),
}) satisfies Readonly<Record<XeroMutationObjectType, readonly XeroMutationOperation[]>>;

export type XeroMutationPreparationState = "PREPARED" | "CONSUMED" | "EXPIRED";

export type XeroMutationRequestState =
  | "CONFIRMED"
  | "WRITE_IN_FLIGHT"
  | "WRITE_UNCERTAIN"
  | "READBACK_VERIFIED"
  | "READBACK_MISMATCH"
  | "FAILED_VALIDATION"
  | "PROVIDER_REJECTED";

export interface XeroMutationBindingIdentity {
  actorId: string;
  workspaceId: string;
  tenantId: string;
  installationId: string;
  bindingId: string;
  connectionId: string;
  /** Active-binding epoch captured at prepare time. */
  bindingRevision?: number;
  /** Internal short-lived target id; never the raw target capability. */
  targetSessionId?: string;
}

export interface XeroMutationPreparation extends XeroMutationBindingIdentity {
  preparationId: string;
  objectType: XeroMutationObjectType;
  operation: XeroMutationOperation;
  targetXeroObjectId?: string;
  canonicalPayload: Record<string, unknown>;
  canonicalPayloadHash: string;
  sourceRef?: string;
  sourceUnitKey: string;
  sourceSha256: string;
  sourceEvidenceType: XeroMutationSourceEvidenceType;
  confirmationSummaryHash: string;
  confirmationPhraseHash: string;
  state: XeroMutationPreparationState;
  expiresAt: Date;
  consumedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface XeroMutationRequest extends XeroMutationBindingIdentity {
  mutationRequestId: string;
  preparationId: string;
  requestId: string;
  objectType: XeroMutationObjectType;
  operation: XeroMutationOperation;
  targetXeroObjectId?: string;
  canonicalPayload: Record<string, unknown>;
  canonicalPayloadHash: string;
  sourceRef?: string;
  sourceUnitKey: string;
  sourceSha256: string;
  sourceEvidenceType: XeroMutationSourceEvidenceType;
  confirmationSummaryHash: string;
  /** Immutable server-issued authority evidence; never supplied by the model. */
  authorizationReceipt: Record<string, unknown>;
  state: XeroMutationRequestState;
  xeroObjectId?: string;
  writeReceipt?: Record<string, unknown>;
  /** Independent CAS marker for the single bounded native-idempotency replay. */
  nativeRecoveryClaim?: Record<string, unknown>;
  readbackSnapshot?: Record<string, unknown>;
  readbackSnapshotHash?: string;
  readbackCanonicalPayload?: Record<string, unknown>;
  readbackPayloadHash?: string;
  readbackStatus?: string;
  /** Durable discriminator and exact reason codes for a failed readback gate. */
  readbackMismatchReceipt?: Record<string, unknown>;
  validationReceipt?: Record<string, unknown>;
  providerRejectionReceipt?: Record<string, unknown>;
  confirmedAt: Date;
  writeStartedAt?: Date;
  writeUnknownAt?: Date;
  verifiedAt?: Date;
  validationFailedAt?: Date;
  providerRejectedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateXeroMutationPreparationInput extends XeroMutationBindingIdentity {
  preparationId: string;
  objectType: XeroMutationObjectType;
  operation: XeroMutationOperation;
  targetXeroObjectId?: string;
  canonicalPayload: Record<string, unknown>;
  canonicalPayloadHash: string;
  sourceRef?: string;
  sourceUnitKey: string;
  sourceSha256: string;
  sourceEvidenceType: XeroMutationSourceEvidenceType;
  confirmationSummaryHash: string;
  confirmationPhraseHash: string;
  expiresAt: Date;
  now: Date;
}

export interface ConfirmXeroMutationPreparationInput extends XeroMutationBindingIdentity {
  mutationRequestId: string;
  preparationId: string;
  requestId: string;
  objectType: XeroMutationObjectType;
  operation: XeroMutationOperation;
  targetXeroObjectId?: string;
  canonicalPayload: Record<string, unknown>;
  canonicalPayloadHash: string;
  sourceRef?: string;
  sourceUnitKey: string;
  sourceSha256: string;
  sourceEvidenceType: XeroMutationSourceEvidenceType;
  confirmationSummaryHash: string;
  confirmationPhraseHash: string;
  authorizationReceipt: Record<string, unknown>;
  /** Successful deterministic validation evidence, persisted before provider I/O. */
  successfulValidationReceipt?: Record<string, unknown>;
  /** Autonomous execution atomically consumes the preparation and claims the provider write slot. */
  claimForWrite?: boolean;
  /** Durable authority row that must still be current inside the claim transaction. */
  expectedAuthoritySnapshotRevision?: number;
  expectedAuthoritySnapshotHash?: string;
  /** Exact normalized authority projection repeated under the locked snapshot row. */
  expectedFirmGovernanceClaim?: LedgerFirmGovernanceClaim;
  now: Date;
}

export interface ConfirmXeroMutationPreparationResult {
  request: XeroMutationRequest;
  created: boolean;
}

export interface BoundXeroMutationRequestInput extends XeroMutationBindingIdentity {
  mutationRequestId: string;
  objectType: XeroMutationObjectType;
  operation: XeroMutationOperation;
  targetXeroObjectId?: string;
  canonicalPayloadHash: string;
  sourceRef?: string;
  sourceUnitKey: string;
  sourceSha256: string;
  sourceEvidenceType: XeroMutationSourceEvidenceType;
  now: Date;
}

export type BeginXeroMutationWriteMode = "CALL_PROVIDER" | "RECOVER_ONLY" | "ALREADY_VERIFIED";

export type BeginXeroMutationWriteInput = BoundXeroMutationRequestInput;

export interface BeginXeroMutationWriteResult {
  request: XeroMutationRequest;
  mode: BeginXeroMutationWriteMode;
}

export interface MarkXeroMutationWriteUnknownInput extends BoundXeroMutationRequestInput {
  xeroObjectId?: string;
  writeReceipt?: Record<string, unknown>;
}

/**
 * Durable provider evidence captured after Xero returns an exact object ID but
 * before the mandatory exact-record readback completes. The mutation remains
 * WRITE_IN_FLIGHT while this evidence is persisted.
 */
export interface RecordXeroMutationWriteEvidenceInput extends BoundXeroMutationRequestInput {
  xeroObjectId: string;
  writeReceipt: Record<string, unknown>;
}

export interface CompleteXeroMutationReadbackInput extends BoundXeroMutationRequestInput {
  xeroObjectId: string;
  writeReceipt: Record<string, unknown>;
  readbackSnapshot: Record<string, unknown>;
  readbackSnapshotHash: string;
  readbackCanonicalPayload: Record<string, unknown>;
  readbackPayloadHash: string;
  readbackStatus: string;
}

export interface FailXeroMutationValidationInput extends BoundXeroMutationRequestInput {
  validationReceipt?: Record<string, unknown>;
}

export interface RejectXeroMutationProviderInput extends BoundXeroMutationRequestInput {
  providerRejectionReceipt: Record<string, unknown>;
}
