import { AppError } from "../../src/errors.js";
import type { CreateDraftSupplierBillInput } from "../../src/domain/schemas.js";
import type {
  AccountingPrincipal,
  ProviderWriteResult,
  SupplierBillSnapshot,
} from "../../src/providers/types.js";
import {
  SyntheticXeroAccountingProvider,
  type ProviderCallEvidence,
} from "./syntheticXeroAccountingProvider.js";

export type SyntheticDraftFaultProfile =
  | "NONE"
  | "DRAFT_TIMEOUT_AFTER_COMMIT"
  | "DRAFT_READBACK_MISMATCH";

export interface SyntheticDraftProviderRecord {
  providerRecordId: string;
  requestId: string;
  idempotencyKey: string;
  status: "DRAFT";
  bill: SupplierBillSnapshot;
  committedAt: string;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function principalEvidence(principal: AccountingPrincipal): ProviderCallEvidence["principal"] {
  if (typeof principal === "string") return { actorId: principal, scopes: [] };
  return {
    actorId: principal.actorId,
    ...(principal.workspaceId ? { workspaceId: principal.workspaceId } : {}),
    ...(principal.subjectType ? { subjectType: principal.subjectType } : {}),
    ...(principal.subjectId ? { subjectId: principal.subjectId } : {}),
    ...(principal.agentId ? { agentId: principal.agentId } : {}),
    ...(principal.oauthInstallationId ? { oauthInstallationId: principal.oauthInstallationId } : {}),
    ...(principal.bindingId ? { bindingId: principal.bindingId } : {}),
    ...(principal.connectionId ? { connectionId: principal.connectionId } : {}),
    scopes: [...principal.scopes],
    legacyDemo: principal.legacyDemo,
  };
}

function fixedFour(value: number): string {
  return value.toFixed(4);
}

function providerUuid(index: number): string {
  return `90000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function lineUuid(recordIndex: number, lineIndex: number): string {
  return `91000000-0000-4000-8000-${String(recordIndex * 100 + lineIndex + 1).padStart(12, "0")}`;
}

/**
 * Synthetic-only write Provider used by the controlled-write P0 harness.
 *
 * It extends the read-only fixture Provider so production AccountingService
 * validation still reads the pinned contacts, accounts, tax types, and tenant.
 * No network client is present in this class.
 */
export class SyntheticXeroWriteProvider extends SyntheticXeroAccountingProvider {
  readonly #records = new Map<string, SyntheticDraftProviderRecord>();
  readonly #idempotencyIndex = new Map<string, string>();
  readonly #isWriteGateOpen: () => boolean;
  #nextFault: SyntheticDraftFaultProfile = "NONE";
  #createCallCount = 0;
  #readbackCallCount = 0;
  #authoriseCallCount = 0;

  constructor(fixture: unknown, isWriteGateOpen: () => boolean) {
    super(fixture);
    this.#isWriteGateOpen = isWriteGateOpen;
  }

  override get writeAttempts(): number {
    return this.#createCallCount;
  }

  get readbackCalls(): number {
    return this.#readbackCallCount;
  }

  get authoriseAttempts(): number {
    return this.#authoriseCallCount;
  }

  get records(): SyntheticDraftProviderRecord[] {
    return [...this.#records.values()].map(clone);
  }

  armNextDraftFault(profile: Exclude<SyntheticDraftFaultProfile, "NONE">): void {
    if (this.#nextFault !== "NONE") {
      throw new Error(`Synthetic Provider fault ${this.#nextFault} is already armed.`);
    }
    this.#nextFault = profile;
  }

  #recordCall(
    method: ProviderCallEvidence["method"],
    principal: AccountingPrincipal,
    input: Record<string, unknown>,
    outputEvidence?: Record<string, unknown>,
  ): void {
    this.calls.push({
      sequence: this.calls.length + 1,
      method,
      principal: principalEvidence(principal),
      boundTenantId: this.tenantId,
      input: clone(input),
      ...(outputEvidence ? { outputEvidence: clone(outputEvidence) } : {}),
    });
  }

  #buildBill(input: CreateDraftSupplierBillInput, invoiceId: string, recordIndex: number): SupplierBillSnapshot {
    const lines = input.lines.map((line, index) => {
      const lineAmount = line.quantity * line.unit_amount;
      return {
        lineItemId: lineUuid(recordIndex, index),
        description: line.description,
        quantity: fixedFour(line.quantity),
        unitAmount: fixedFour(line.unit_amount),
        lineAmount: fixedFour(lineAmount),
        taxAmount: "0.0000",
        accountCode: line.account_code,
        taxType: line.tax_type,
      };
    });
    const subTotal = input.lines.reduce((sum, line) => sum + line.quantity * line.unit_amount, 0);
    return {
      tenantId: this.tenantId,
      invoiceId,
      type: "ACCPAY",
      status: "DRAFT",
      contact: {
        contactId: input.contact_id,
        name: "Horizon Business Services Limited",
      },
      invoiceNumber: input.reference,
      invoiceDate: input.invoice_date,
      dueDate: input.due_date,
      currency: input.currency,
      lineAmountType: input.line_amount_type,
      subTotal: fixedFour(subTotal),
      totalTax: "0.0000",
      total: fixedFour(subTotal),
      amountDue: fixedFour(subTotal),
      amountPaid: "0.0000",
      amountCredited: "0.0000",
      lines,
      lineItemCount: lines.length,
      linesTruncated: false,
      attachmentsKnown: true,
      hasAttachments: false,
      updatedAt: "2026-08-06T00:00:00.000Z",
    };
  }

  override async createDraftSupplierBill(
    principal: AccountingPrincipal,
    input: CreateDraftSupplierBillInput,
    idempotencyKey: string,
  ): Promise<ProviderWriteResult> {
    if (!this.#isWriteGateOpen()) {
      throw new AppError("FORBIDDEN", "The synthetic P0 write gate is closed.", { httpStatus: 403 });
    }
    this.#createCallCount += 1;
    const existingId = this.#idempotencyIndex.get(idempotencyKey);
    if (existingId) {
      const existing = this.#records.get(existingId);
      if (!existing) throw new Error("Synthetic Provider idempotency index is corrupt.");
      this.#recordCall("createDraftSupplierBill", principal, {
        requestId: input.request_id,
        idempotencyKey,
        providerIdempotentReplay: true,
      }, { invoiceId: existing.providerRecordId, committedRecordCount: this.#records.size });
      return {
        bill: clone(existing.bill),
        receipt: {
          operation: "CREATE_DRAFT_PROVIDER_IDEMPOTENT_REPLAY",
          invoiceId: existing.providerRecordId,
        },
      };
    }

    const recordIndex = this.#records.size + 1;
    const invoiceId = providerUuid(recordIndex);
    const bill = this.#buildBill(input, invoiceId, recordIndex);
    const record: SyntheticDraftProviderRecord = {
      providerRecordId: invoiceId,
      requestId: input.request_id,
      idempotencyKey,
      status: "DRAFT",
      bill: clone(bill),
      committedAt: "2026-08-06T00:00:00.000Z",
    };
    this.#records.set(invoiceId, record);
    this.#idempotencyIndex.set(idempotencyKey, invoiceId);
    const fault = this.#nextFault;
    this.#nextFault = "NONE";
    this.#recordCall("createDraftSupplierBill", principal, {
      requestId: input.request_id,
      idempotencyKey,
      fault,
    }, { invoiceId, committedRecordCount: this.#records.size });

    if (fault === "DRAFT_TIMEOUT_AFTER_COMMIT") {
      throw new AppError(
        "WRITE_RESULT_UNKNOWN",
        "Synthetic Provider committed the DRAFT but the response timed out.",
        { httpStatus: 502, retryable: false, details: { invoiceId } },
      );
    }
    if (fault === "DRAFT_READBACK_MISMATCH") {
      return {
        bill: { ...clone(bill), currency: bill.currency === "HKD" ? "USD" : "HKD" },
        receipt: { operation: "CREATE_DRAFT_MISMATCH_FIXTURE", invoiceId },
      };
    }
    return {
      bill: clone(bill),
      receipt: { operation: "CREATE_DRAFT_SYNTHETIC", invoiceId },
    };
  }

  override async getSupplierBill(
    principal: AccountingPrincipal,
    invoiceId: string,
  ): Promise<SupplierBillSnapshot> {
    const record = this.#records.get(invoiceId);
    if (!record) return super.getSupplierBill(principal, invoiceId);
    this.#readbackCallCount += 1;
    this.#recordCall("getSupplierBill", principal, { invoiceId }, {
      found: true,
      source: "synthetic_write_record_ledger",
    });
    return clone(record.bill);
  }

  override async authoriseSupplierBill(
    principal: AccountingPrincipal,
    invoiceId: string,
    idempotencyKey: string,
  ): Promise<ProviderWriteResult> {
    this.#authoriseCallCount += 1;
    this.#recordCall("authoriseSupplierBill", principal, { invoiceId, idempotencyKey }, {
      blocked: true,
    });
    throw new AppError("FORBIDDEN", "AUTHORISE is forbidden in the controlled-write P0 harness.", {
      httpStatus: 403,
    });
  }
}
