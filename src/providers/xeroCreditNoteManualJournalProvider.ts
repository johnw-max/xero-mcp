import type { AccountingPrincipal } from "./types.js";
import type { XeroClientManager } from "./xeroClientManager.js";
import type {
  CanonicalCreditNoteDraftPayload,
  CanonicalManualJournalDraftPayload,
} from "../domain/xeroCreditNoteManualJournalDraft.js";
import {
  toXeroCreditNoteCreatePayload,
  toXeroManualJournalCreatePayload,
  verifyCreditNoteDraftReadback,
  verifyManualJournalDraftReadback,
  type CreditNoteDraftReadbackSnapshot,
  type DraftReadbackVerificationResult,
  type ManualJournalDraftReadbackSnapshot,
} from "./xeroCreditNoteManualJournalDraft.js";
import { mapItemSummary, type ItemSummary } from "./xeroExtendedReadMapper.js";
import { AppError } from "../errors.js";
import { classifyXeroWriteException } from "./xeroWriteOutcome.js";

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
  ): Promise<XeroCreditNoteManualJournalCreateReceipt>;
  readAndVerifyCreditNoteDraft(
    principal: AccountingPrincipal,
    creditNoteId: string,
    expected: CanonicalCreditNoteDraftPayload,
  ): Promise<DraftReadbackVerificationResult<CreditNoteDraftReadbackSnapshot, CanonicalCreditNoteDraftPayload>>;
  createManualJournalDraft(
    principal: AccountingPrincipal,
    payload: CanonicalManualJournalDraftPayload,
    idempotencyKey: string,
  ): Promise<XeroCreditNoteManualJournalCreateReceipt>;
  readAndVerifyManualJournalDraft(
    principal: AccountingPrincipal,
    manualJournalId: string,
    expected: CanonicalManualJournalDraftPayload,
  ): Promise<DraftReadbackVerificationResult<ManualJournalDraftReadbackSnapshot, CanonicalManualJournalDraftPayload>>;
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

function sameUuid(left: string | undefined, right: string): boolean {
  return typeof left === "string" && left.toLowerCase() === right.toLowerCase();
}

/**
 * Xero transport for the two ledger-adjustment drafts. Create and exact GET
 * are separate so an uncertain transport outcome can never be retried as a
 * fresh write without first entering the mutation recovery state.
 */
export class XeroCreditNoteManualJournalProvider implements CreditNoteManualJournalWriteProvider {
  constructor(private readonly manager: XeroClientManager) {}

  async createCreditNoteDraft(
    principal: AccountingPrincipal,
    payload: CanonicalCreditNoteDraftPayload,
    idempotencyKey: string,
  ): Promise<XeroCreditNoteManualJournalCreateReceipt> {
    return this.manager.withClient(principal, async (client, connection) => {
      try {
        const created = await client.accountingApi.createCreditNotes(
          connection.tenantId,
          toXeroCreditNoteCreatePayload(payload),
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

  async createManualJournalDraft(
    principal: AccountingPrincipal,
    payload: CanonicalManualJournalDraftPayload,
    idempotencyKey: string,
  ): Promise<XeroCreditNoteManualJournalCreateReceipt> {
    return this.manager.withClient(principal, async (client, connection) => {
      try {
        const created = await client.accountingApi.createManualJournals(
          connection.tenantId,
          toXeroManualJournalCreatePayload(payload),
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
