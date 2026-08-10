import type { PostingRequest, PostingState, XeroPostingDocumentType } from "../domain/models.js";

export const ACTIVE_XERO_DUPLICATE_STATES = [
  "VALIDATED",
  "DRAFT_READBACK_VERIFIED",
  "APPROVAL_PENDING",
  "APPROVED",
  "AUTHORISING",
  "AUTHORISED_READBACK_VERIFIED",
  "WRITE_RESULT_UNKNOWN",
  "READBACK_MISMATCH",
  "REJECTED",
] as const satisfies readonly PostingState[];

const activeStates = new Set<PostingState>(ACTIVE_XERO_DUPLICATE_STATES);

export interface XeroSupplierPostingIdentity {
  documentType: XeroPostingDocumentType;
  contactId?: string;
  normalizedReference?: string;
}

function normalizedNonEmpty(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : undefined;
}

export function xeroSupplierPostingIdentity(
  providerPayload: Record<string, unknown>,
): XeroSupplierPostingIdentity {
  const contact = providerPayload.contact;
  const nestedContactId = contact && typeof contact === "object" && !Array.isArray(contact)
    ? (contact as Record<string, unknown>).contactId
    : undefined;
  const contactId = normalizedNonEmpty(providerPayload.contactId) ?? normalizedNonEmpty(nestedContactId);
  const normalizedReference = normalizedNonEmpty(providerPayload.reference);
  const rawDocumentType = providerPayload.invoiceType ?? providerPayload.type;
  const documentType: XeroPostingDocumentType = rawDocumentType === "ACCREC" ? "ACCREC" : "ACCPAY";
  return {
    documentType,
    ...(contactId ? { contactId } : {}),
    ...(normalizedReference ? { normalizedReference } : {}),
  };
}

export function isActiveXeroDuplicateState(state: PostingState): boolean {
  return activeStates.has(state);
}

export function isXeroPostingDuplicate(
  posting: PostingRequest,
  candidate: {
    tenantId: string;
    sourceSha256: string;
    documentType?: XeroPostingDocumentType;
    contactId?: string;
    normalizedReference?: string;
  },
): boolean {
  if (
    posting.tenantId !== candidate.tenantId ||
    !isActiveXeroDuplicateState(posting.state)
  ) {
    return false;
  }
  // One source document cannot be interpreted into both AP and AR. This guard
  // is deliberately global across document types.
  if (posting.sourceSha256 === candidate.sourceSha256) return true;
  // Xero ACCREC Reference is an additional customer reference, not the unique
  // invoice number. Only ACCPAY treats contact + supplier reference as a hard
  // business-document identity.
  const candidateDocumentType = candidate.documentType ?? "ACCPAY";
  if (candidateDocumentType !== "ACCPAY") return false;
  if (!candidate.contactId || !candidate.normalizedReference) return false;
  const existing = xeroSupplierPostingIdentity(posting.providerPayload);
  return existing.documentType === "ACCPAY" &&
    existing.contactId === candidate.contactId &&
    existing.normalizedReference === candidate.normalizedReference;
}
