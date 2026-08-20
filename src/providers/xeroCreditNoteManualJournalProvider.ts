import type { AccountingPrincipal } from "./types.js";
import type { XeroClientManager } from "./xeroClientManager.js";
import type {
  CanonicalCreditNoteDraftPayload,
  CanonicalManualJournalDraftPayload,
} from "../domain/xeroCreditNoteManualJournalDraft.js";
import {
  toXeroCreditNoteCreatePayload,
  toXeroCreditNoteUpdatePayload,
  toXeroManualJournalCreatePayload,
  toXeroManualJournalUpdatePayload,
  verifyCreditNoteDraftReadback,
  verifyManualJournalDraftReadback,
  type CreditNoteDraftReadbackSnapshot,
  type DraftReadbackVerificationResult,
  type ManualJournalDraftReadbackSnapshot,
} from "./xeroCreditNoteManualJournalDraft.js";
import { mapItemSummary, type ItemSummary } from "./xeroExtendedReadMapper.js";
import { AppError } from "../errors.js";
import { classifyXeroWriteException } from "./xeroWriteOutcome.js";
import type { LedgerProviderWritePermit } from "../control-kernel/ledgerProviderWritePermit.js";
import { xeroProviderInstant } from "./xeroProviderDate.js";

export interface XeroCreditNoteManualJournalCreateReceipt {
  objectId: string;
  receipt: Record<string, unknown>;
}

export interface TrackingOptionResolution {
  requestedIds: string[];
  matchedIds: string[];
  complete: boolean;
}

export interface CreditNoteManualJournalWriteProvider {
  createCreditNoteDraft(
    principal: AccountingPrincipal,
    payload: CanonicalCreditNoteDraftPayload,
    idempotencyKey: string,
    providerWritePermit?: LedgerProviderWritePermit,
  ): Promise<XeroCreditNoteManualJournalCreateReceipt>;
  readAndVerifyCreditNoteDraft(
    principal: AccountingPrincipal,
    creditNoteId: string,
    expected: CanonicalCreditNoteDraftPayload,
  ): Promise<DraftReadbackVerificationResult<CreditNoteDraftReadbackSnapshot, CanonicalCreditNoteDraftPayload>>;
  updateCreditNoteDraft(
    principal: AccountingPrincipal,
    creditNoteId: string,
    expectedUpdatedAt: string,
    payload: CanonicalCreditNoteDraftPayload,
    idempotencyKey: string,
    providerWritePermit?: LedgerProviderWritePermit,
  ): Promise<XeroCreditNoteManualJournalCreateReceipt>;
  createManualJournalDraft(
    principal: AccountingPrincipal,
    payload: CanonicalManualJournalDraftPayload,
    idempotencyKey: string,
    providerWritePermit?: LedgerProviderWritePermit,
  ): Promise<XeroCreditNoteManualJournalCreateReceipt>;
  readAndVerifyManualJournalDraft(
    principal: AccountingPrincipal,
    manualJournalId: string,
    expected: CanonicalManualJournalDraftPayload,
  ): Promise<DraftReadbackVerificationResult<ManualJournalDraftReadbackSnapshot, CanonicalManualJournalDraftPayload>>;
  updateManualJournalDraft(
    principal: AccountingPrincipal,
    manualJournalId: string,
    expectedUpdatedAt: string,
    payload: CanonicalManualJournalDraftPayload,
    idempotencyKey: string,
    providerWritePermit?: LedgerProviderWritePermit,
  ): Promise<XeroCreditNoteManualJournalCreateReceipt>;
  getItemByCode(principal: AccountingPrincipal, code: string): Promise<ItemSummary | undefined>;
  resolveTrackingOptionIds(
    principal: AccountingPrincipal,
    requestedIds: readonly string[],
  ): Promise<TrackingOptionResolution>;
}

type SdkResponse = { headers?: unknown };

function providerRequestId(response: SdkResponse): string | undefined {
  if (!response.headers || typeof response.headers !== "object") return undefined;
  const headers = response.headers as Record<string, unknown>;
  const value = headers["xero-correlation-id"] ?? headers["x-request-id"];
  return typeof value === "string" && value.length <= 512 ? value : undefined;
}

function providerValidationErrors(value: unknown): unknown[] {
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  return Array.isArray(record.validationErrors) ? record.validationErrors : [];
}

function providerHasErrors(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  return (value as Record<string, unknown>).hasErrors === true || providerValidationErrors(value).length > 0;
}

function providerRejected(message: string, details?: Record<string, unknown>): AppError {
  return new AppError("PROVIDER_ERROR", message, {
    httpStatus: 422,
    retryable: false,
    details: { ...details, writeOutcome: "DEFINITELY_REJECTED" },
  });
}

function writeUnknown(message: string, error?: unknown): AppError {
  return new AppError("WRITE_RESULT_UNKNOWN", message, {
    httpStatus: 502,
    retryable: false,
    ...(error ? { cause: error } : {}),
  });
}

function targetUnavailable(objectType: "CreditNote" | "ManualJournal", cause?: unknown): AppError {
  return new AppError("PROVIDER_ERROR", `The exact Xero ${objectType} target could not be confirmed before update.`, {
    httpStatus: 503,
    retryable: true,
    ...(cause ? { cause } : {}),
    details: {
      providerMutationPossible: false,
      reasonCodes: ["EXACT_DRAFT_TARGET_UNAVAILABLE"],
    },
  });
}

function sameUuid(left: string | undefined, right: string): boolean {
  return typeof left === "string" && left.toLowerCase() === right.toLowerCase();
}

function targetUuid(value: string, objectType: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new AppError("VALIDATION_FAILED", `The ${objectType} update target must be an exact UUID.`, {
      httpStatus: 422,
    });
  }
  return value.toLowerCase();
}

function expectedIsoInstant(value: string, objectType: string): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T[^\s]+(?:Z|[+-]\d{2}:\d{2})$/u.test(value) ||
    Number.isNaN(new Date(value).getTime())
  ) {
    throw new AppError("VALIDATION_FAILED", `The ${objectType} update expectedUpdatedAt must be an ISO datetime.`, {
      httpStatus: 422,
      details: { providerMutationPossible: false, path: "expectedUpdatedAt" },
    });
  }
  return value;
}

function providerInstant(value: unknown): number | undefined {
  const legacy = xeroProviderInstant(value);
  if (legacy) return legacy.getTime();
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value.getTime();
  if (typeof value !== "string") return undefined;
  if (!/^\d{4}-\d{2}-\d{2}T[^\s]+(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.getTime();
}

function staleDraftVersion(
  objectType: "CreditNote" | "ManualJournal",
  objectId: string,
  expectedUpdatedAt: string,
  actualUpdatedAt: unknown,
): AppError {
  const actualInstant = providerInstant(actualUpdatedAt);
  return new AppError("CONFLICT", `The Xero ${objectType} changed after the draft was prepared.`, {
    httpStatus: 409,
    retryable: false,
    details: {
      objectId,
      expectedUpdatedAt,
      ...(actualInstant !== undefined ? { actualUpdatedAt: new Date(actualInstant).toISOString() } : {}),
      reasonCodes: ["STALE_DRAFT_VERSION"],
      writeOutcome: "DEFINITELY_REJECTED",
      providerMutationPossible: false,
    },
  });
}

function exactCreditNote(
  body: unknown,
  creditNoteId: string,
): Record<string, unknown> | undefined {
  if (!body || typeof body !== "object") return undefined;
  const creditNotes = (body as { creditNotes?: unknown }).creditNotes;
  if (!Array.isArray(creditNotes)) return undefined;
  const candidate = creditNotes.find((entry) => {
    if (!entry || typeof entry !== "object") return false;
    return sameUuid((entry as { creditNoteID?: unknown }).creditNoteID as string | undefined, creditNoteId);
  });
  return candidate && typeof candidate === "object" && !Array.isArray(candidate)
    ? candidate as Record<string, unknown>
    : undefined;
}

function exactManualJournal(
  body: unknown,
  manualJournalId: string,
): Record<string, unknown> | undefined {
  if (!body || typeof body !== "object") return undefined;
  const manualJournals = (body as { manualJournals?: unknown }).manualJournals;
  if (!Array.isArray(manualJournals)) return undefined;
  const candidate = manualJournals.find((entry) => {
    if (!entry || typeof entry !== "object") return false;
    return sameUuid((entry as { manualJournalID?: unknown }).manualJournalID as string | undefined, manualJournalId);
  });
  return candidate && typeof candidate === "object" && !Array.isArray(candidate)
    ? candidate as Record<string, unknown>
    : undefined;
}

/**
 * Xero transport for the two ledger-adjustment drafts. Create/update and exact
 * GET are kept explicit so an uncertain transport outcome can never be retried
 * as a fresh write without first entering the mutation recovery state.
 */
export class XeroCreditNoteManualJournalProvider implements CreditNoteManualJournalWriteProvider {
  constructor(private readonly manager: XeroClientManager) {}

  async createCreditNoteDraft(
    principal: AccountingPrincipal,
    payload: CanonicalCreditNoteDraftPayload,
    idempotencyKey: string,
    providerWritePermit?: LedgerProviderWritePermit,
  ): Promise<XeroCreditNoteManualJournalCreateReceipt> {
    const xeroPayload = toXeroCreditNoteCreatePayload(payload);
    return this.manager.withWriteClient(principal, {
      permit: providerWritePermit,
      adapterOperation: "XeroCreditNoteManualJournalProvider.createCreditNoteDraft",
      actionId: "credit_note.create_draft",
      mutationRequestId: idempotencyKey,
      providerIdempotencyKey: idempotencyKey,
      canonicalPayload: payload,
    }, async (client, connection) => {
      try {
        const created = await client.accountingApi.createCreditNotes(
          connection.tenantId,
          xeroPayload,
          true,
          4,
          idempotencyKey,
        );
        const creditNote = created.body?.creditNotes?.[0];
        if (providerHasErrors(creditNote)) {
          throw providerRejected("Xero rejected the credit-note draft.", {
            validationErrorCount: providerValidationErrors(creditNote).length,
          });
        }
        if (!creditNote?.creditNoteID) {
          throw writeUnknown("Xero returned no CreditNoteID; recovery is required.");
        }
        const requestId = providerRequestId(created.response);
        return {
          objectId: creditNote.creditNoteID,
          receipt: {
            operation: "CREATE_CREDIT_NOTE_DRAFT",
            creditNoteId: creditNote.creditNoteID,
            ...(requestId ? { providerRequestId: requestId } : {}),
          },
        };
      } catch (error) {
        if (error instanceof AppError) throw error;
        if (classifyXeroWriteException(error) === "UNKNOWN") {
          throw writeUnknown("The Xero credit-note result is unknown and requires recovery.", error);
        }
        throw providerRejected("Xero rejected the credit-note draft.");
      }
    });
  }

  async readAndVerifyCreditNoteDraft(
    principal: AccountingPrincipal,
    creditNoteId: string,
    expected: CanonicalCreditNoteDraftPayload,
  ): Promise<DraftReadbackVerificationResult<CreditNoteDraftReadbackSnapshot, CanonicalCreditNoteDraftPayload>> {
    return this.manager.withClient(principal, async (client, connection) => {
      const response = await client.accountingApi.getCreditNote(connection.tenantId, creditNoteId, 4);
      const raw = response.body?.creditNotes?.find((candidate) => sameUuid(candidate.creditNoteID, creditNoteId));
      if (!raw) {
        throw new AppError("NOT_FOUND", "The created Xero credit note could not be read back.", { httpStatus: 404 });
      }
      return verifyCreditNoteDraftReadback(creditNoteId, expected, raw);
    });
  }

  async updateCreditNoteDraft(
    principal: AccountingPrincipal,
    creditNoteId: string,
    expectedUpdatedAt: string,
    payload: CanonicalCreditNoteDraftPayload,
    idempotencyKey: string,
    providerWritePermit?: LedgerProviderWritePermit,
  ): Promise<XeroCreditNoteManualJournalCreateReceipt> {
    const targetId = targetUuid(creditNoteId, "CreditNote");
    const expectedInstant = expectedIsoInstant(expectedUpdatedAt, "CreditNote");
    const xeroPayload = toXeroCreditNoteUpdatePayload(targetId, payload);
    const replacementNote = xeroPayload.creditNotes?.[0];
    if (!replacementNote) {
      throw writeUnknown("The controlled Credit Note replacement could not be constructed.");
    }
    const authorizationPayload = {
      targetXeroObjectId: targetId,
      expectedUpdatedAt,
      replacement: payload,
    };

    return this.manager.withWriteClient(principal, {
      permit: providerWritePermit,
      adapterOperation: "XeroCreditNoteManualJournalProvider.updateCreditNoteDraft",
      actionId: "credit_note.update_draft",
      mutationRequestId: idempotencyKey,
      providerIdempotencyKey: idempotencyKey,
      canonicalPayload: authorizationPayload,
    }, async (client, connection) => {
      try {
        // The target is read on the write-capable client immediately before
        // mutation. This both proves same-ID targeting and closes the DRAFT /
        // credit-type precondition without trusting a caller-provided type.
        let beforeResponse: { body?: unknown };
        try {
          beforeResponse = await client.accountingApi.getCreditNote(
            connection.tenantId,
            targetId,
            4,
          );
        } catch (error) {
          if (classifyXeroWriteException(error) === "DEFINITELY_REJECTED") {
            throw providerRejected("Xero rejected the exact CreditNote target preflight.", {
              objectId: targetId,
              providerMutationPossible: false,
            });
          }
          // No mutation has been attempted yet, so a transport/unknown GET
          // outcome is retryable target-unavailability, never WRITE_RESULT_UNKNOWN.
          throw targetUnavailable("CreditNote", error);
        }
        const before = exactCreditNote(beforeResponse.body, targetId);
        if (!before) {
          throw new AppError("NOT_FOUND", "The requested Xero credit note was not found.", { httpStatus: 404 });
        }
        if (providerHasErrors(before)) {
          throw providerRejected("Xero returned validation errors for the credit-note update target.", {
            objectId: targetId,
            validationErrorCount: providerValidationErrors(before).length,
          });
        }
        if (before.status !== "DRAFT") {
          throw providerRejected("Only a DRAFT Xero credit note can be replaced.", {
            objectId: targetId,
            expectedStatus: "DRAFT",
            actualStatus: before.status,
          });
        }
        if (before.type !== payload.creditNoteType) {
          throw providerRejected("A credit-note update cannot change the original credit-note type.", {
            objectId: targetId,
            expectedType: payload.creditNoteType,
            actualType: before.type,
          });
        }
        const actualUpdatedAt = before.updatedDateUTC ?? before.updatedDateUTCString;
        if (providerInstant(actualUpdatedAt) !== new Date(expectedInstant).getTime()) {
          throw staleDraftVersion("CreditNote", targetId, expectedUpdatedAt, actualUpdatedAt);
        }

        const updated = await client.accountingApi.updateCreditNote(
          connection.tenantId,
          targetId,
          xeroPayload,
          4,
          idempotencyKey,
        );
        const updatedCandidate = updated.body?.creditNotes?.[0];
        if (providerHasErrors(updatedCandidate)) {
          throw providerRejected("Xero rejected the credit-note draft replacement.", {
            objectId: targetId,
            validationErrorCount: providerValidationErrors(updatedCandidate).length,
          });
        }
        const updatedNote = exactCreditNote(updated.body, targetId);
        if (!updatedNote) {
          throw writeUnknown("Xero returned no same-ID CreditNote result; recovery is required.");
        }
        if (updatedNote.status !== undefined && updatedNote.status !== "DRAFT") {
          throw writeUnknown("Xero returned a non-DRAFT CreditNote after update; recovery is required.", {
            objectId: targetId,
          });
        }

        const requestId = providerRequestId(updated.response);
        return {
          objectId: targetId,
          receipt: {
            operation: "UPDATE_CREDIT_NOTE_DRAFT",
            creditNoteId: targetId,
            status: "DRAFT",
            ...(requestId ? { providerRequestId: requestId } : {}),
          },
        };
      } catch (error) {
        if (error instanceof AppError) throw error;
        if (classifyXeroWriteException(error) === "UNKNOWN") {
          throw writeUnknown("The Xero credit-note draft update result is unknown and requires recovery.", error);
        }
        throw providerRejected("Xero rejected the credit-note draft replacement.");
      }
    });
  }

  async createManualJournalDraft(
    principal: AccountingPrincipal,
    payload: CanonicalManualJournalDraftPayload,
    idempotencyKey: string,
    providerWritePermit?: LedgerProviderWritePermit,
  ): Promise<XeroCreditNoteManualJournalCreateReceipt> {
    const xeroPayload = toXeroManualJournalCreatePayload(payload);
    return this.manager.withWriteClient(principal, {
      permit: providerWritePermit,
      adapterOperation: "XeroCreditNoteManualJournalProvider.createManualJournalDraft",
      actionId: "manual_journal.create_draft",
      mutationRequestId: idempotencyKey,
      providerIdempotencyKey: idempotencyKey,
      canonicalPayload: payload,
    }, async (client, connection) => {
      try {
        const created = await client.accountingApi.createManualJournals(
          connection.tenantId,
          xeroPayload,
          true,
          idempotencyKey,
        );
        const journal = created.body?.manualJournals?.[0];
        if (providerHasErrors(journal)) {
          throw providerRejected("Xero rejected the manual-journal draft.", {
            validationErrorCount: providerValidationErrors(journal).length,
          });
        }
        if (!journal?.manualJournalID) {
          throw writeUnknown("Xero returned no ManualJournalID; recovery is required.");
        }
        const requestId = providerRequestId(created.response);
        return {
          objectId: journal.manualJournalID,
          receipt: {
            operation: "CREATE_MANUAL_JOURNAL_DRAFT",
            manualJournalId: journal.manualJournalID,
            ...(requestId ? { providerRequestId: requestId } : {}),
          },
        };
      } catch (error) {
        if (error instanceof AppError) throw error;
        if (classifyXeroWriteException(error) === "UNKNOWN") {
          throw writeUnknown("The Xero manual-journal result is unknown and requires recovery.", error);
        }
        throw providerRejected("Xero rejected the manual-journal draft.");
      }
    });
  }

  async readAndVerifyManualJournalDraft(
    principal: AccountingPrincipal,
    manualJournalId: string,
    expected: CanonicalManualJournalDraftPayload,
  ): Promise<DraftReadbackVerificationResult<ManualJournalDraftReadbackSnapshot, CanonicalManualJournalDraftPayload>> {
    return this.manager.withClient(principal, async (client, connection) => {
      const response = await client.accountingApi.getManualJournal(connection.tenantId, manualJournalId);
      const raw = response.body?.manualJournals?.find(
        (candidate) => sameUuid(candidate.manualJournalID, manualJournalId),
      );
      if (!raw) {
        throw new AppError("NOT_FOUND", "The created Xero manual journal could not be read back.", { httpStatus: 404 });
      }
      return verifyManualJournalDraftReadback(manualJournalId, expected, raw);
    });
  }

  async updateManualJournalDraft(
    principal: AccountingPrincipal,
    manualJournalId: string,
    expectedUpdatedAt: string,
    payload: CanonicalManualJournalDraftPayload,
    idempotencyKey: string,
    providerWritePermit?: LedgerProviderWritePermit,
  ): Promise<XeroCreditNoteManualJournalCreateReceipt> {
    const targetId = targetUuid(manualJournalId, "ManualJournal");
    const expectedInstant = expectedIsoInstant(expectedUpdatedAt, "ManualJournal");
    const xeroPayload = toXeroManualJournalUpdatePayload(targetId, payload);
    const replacementJournal = xeroPayload.manualJournals?.[0];
    if (!replacementJournal) {
      throw writeUnknown("The controlled Manual Journal replacement could not be constructed.");
    }
    const authorizationPayload = {
      targetXeroObjectId: targetId,
      expectedUpdatedAt,
      replacement: payload,
    };

    return this.manager.withWriteClient(principal, {
      permit: providerWritePermit,
      adapterOperation: "XeroCreditNoteManualJournalProvider.updateManualJournalDraft",
      actionId: "manual_journal.update_draft",
      mutationRequestId: idempotencyKey,
      providerIdempotencyKey: idempotencyKey,
      canonicalPayload: authorizationPayload,
    }, async (client, connection) => {
      try {
        // Same-ID GET on the write client is mandatory immediately before the
        // replacement, so a posted/deleted journal can never be overwritten.
        let beforeResponse: { body?: unknown };
        try {
          beforeResponse = await client.accountingApi.getManualJournal(
            connection.tenantId,
            targetId,
          );
        } catch (error) {
          if (classifyXeroWriteException(error) === "DEFINITELY_REJECTED") {
            throw providerRejected("Xero rejected the exact ManualJournal target preflight.", {
              objectId: targetId,
              providerMutationPossible: false,
            });
          }
          // No mutation has been attempted yet, so a transport/unknown GET
          // outcome is retryable target-unavailability, never WRITE_RESULT_UNKNOWN.
          throw targetUnavailable("ManualJournal", error);
        }
        const before = exactManualJournal(beforeResponse.body, targetId);
        if (!before) {
          throw new AppError("NOT_FOUND", "The requested Xero manual journal was not found.", { httpStatus: 404 });
        }
        if (providerHasErrors(before)) {
          throw providerRejected("Xero returned validation errors for the manual-journal update target.", {
            objectId: targetId,
            validationErrorCount: providerValidationErrors(before).length,
          });
        }
        if (before.status !== "DRAFT") {
          throw providerRejected("Only a DRAFT Xero manual journal can be replaced.", {
            objectId: targetId,
            expectedStatus: "DRAFT",
            actualStatus: before.status,
          });
        }
        const actualUpdatedAt = before.updatedDateUTC ?? before.updatedDateUTCString;
        if (providerInstant(actualUpdatedAt) !== new Date(expectedInstant).getTime()) {
          throw staleDraftVersion("ManualJournal", targetId, expectedUpdatedAt, actualUpdatedAt);
        }

        const updated = await client.accountingApi.updateManualJournal(
          connection.tenantId,
          targetId,
          xeroPayload,
          idempotencyKey,
        );
        const updatedCandidate = updated.body?.manualJournals?.[0];
        if (providerHasErrors(updatedCandidate)) {
          throw providerRejected("Xero rejected the manual-journal draft replacement.", {
            objectId: targetId,
            validationErrorCount: providerValidationErrors(updatedCandidate).length,
          });
        }
        const updatedJournal = exactManualJournal(updated.body, targetId);
        if (!updatedJournal) {
          throw writeUnknown("Xero returned no same-ID ManualJournal result; recovery is required.");
        }
        if (updatedJournal.status !== undefined && updatedJournal.status !== "DRAFT") {
          throw writeUnknown("Xero returned a non-DRAFT ManualJournal after update; recovery is required.", {
            objectId: targetId,
          });
        }

        const requestId = providerRequestId(updated.response);
        return {
          objectId: targetId,
          receipt: {
            operation: "UPDATE_MANUAL_JOURNAL_DRAFT",
            manualJournalId: targetId,
            status: "DRAFT",
            ...(requestId ? { providerRequestId: requestId } : {}),
          },
        };
      } catch (error) {
        if (error instanceof AppError) throw error;
        if (classifyXeroWriteException(error) === "UNKNOWN") {
          throw writeUnknown("The Xero manual-journal draft update result is unknown and requires recovery.", error);
        }
        throw providerRejected("Xero rejected the manual-journal draft replacement.");
      }
    });
  }

  async getItemByCode(principal: AccountingPrincipal, code: string): Promise<ItemSummary | undefined> {
    return this.manager.withClient(principal, async (client, connection) => {
      const response = await client.accountingApi.getItem(connection.tenantId, code, 4);
      const exact = response.body?.items?.find((item) => item.code === code);
      return mapItemSummary(exact);
    });
  }

  async resolveTrackingOptionIds(
    principal: AccountingPrincipal,
    requestedIds: readonly string[],
  ): Promise<TrackingOptionResolution> {
    const unique = [...new Set(requestedIds.map((id) => id.toLowerCase()))];
    if (unique.length === 0) return { requestedIds: [], matchedIds: [], complete: true };
    return this.manager.withClient(principal, async (client, connection) => {
      const response = await client.accountingApi.getTrackingCategories(connection.tenantId, undefined, undefined, false);
      const available = new Set<string>();
      for (const category of response.body?.trackingCategories ?? []) {
        for (const option of category.options ?? []) {
          if (option.trackingOptionID) available.add(option.trackingOptionID.toLowerCase());
        }
      }
      const matchedIds = unique.filter((id) => available.has(id));
      return { requestedIds: unique, matchedIds, complete: matchedIds.length === unique.length };
    });
  }
}
