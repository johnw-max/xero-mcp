import { z } from "zod/v4";
import type { XeroMutationObjectType, XeroMutationOperation } from "./xeroMutation.js";
import type { XeroWriteActionId } from "./xeroWriteActions.js";

const exactUuid = z.string().uuid().transform((value) => value.toLowerCase());
const realDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, "must use YYYY-MM-DD").refine((value) => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().startsWith(value);
}, "must be a real calendar date");
const fixedFourPositive = z.string().regex(/^(?:0|[1-9]\d{0,17})\.\d{4}$/u, "must be a fixed-four decimal")
  .refine((value) => BigInt(value.replace(".", "")) > 0n, "must be greater than zero")
  // The SDK accepts a JavaScript number; keep a value whose fixed-four
  // representation is still exactly round-trippable through that boundary.
  .refine((value) => BigInt(value.replace(".", "")) <= 9_000_000_000_000_000n, "is outside the controlled range");

export const ledgerAdjustmentActionSchema = z.enum([
  "customer_invoice.void",
  "supplier_bill.void",
  "credit_note.authorise",
  "credit_note.allocate",
  "credit_note.refund",
  "credit_note.void",
  "credit_note.unallocate",
  "manual_journal.void",
]);

export type LedgerAdjustmentAction = Extract<XeroWriteActionId, z.infer<typeof ledgerAdjustmentActionSchema>>;

export const voidInvoicePayloadSchema = z.object({
  invoiceId: exactUuid,
  invoiceType: z.enum(["ACCREC", "ACCPAY"]),
  expectedStatus: z.literal("AUTHORISED"),
}).strict();

export const authoriseCreditNotePayloadSchema = z.object({
  creditNoteId: exactUuid,
  creditNoteType: z.enum(["ACCRECCREDIT", "ACCPAYCREDIT"]),
  expectedStatus: z.literal("DRAFT"),
}).strict();

export const allocateCreditNotePayloadSchema = z.object({
  creditNoteId: exactUuid,
  creditNoteType: z.enum(["ACCRECCREDIT", "ACCPAYCREDIT"]),
  targetInvoiceId: exactUuid,
  targetInvoiceType: z.enum(["ACCREC", "ACCPAY"]),
  amount: fixedFourPositive,
  allocationDate: realDate,
  expectedCreditStatus: z.literal("AUTHORISED"),
  expectedTargetStatus: z.literal("AUTHORISED"),
}).strict().superRefine((value, context) => {
  const expectedTargetType = value.creditNoteType === "ACCRECCREDIT" ? "ACCREC" : "ACCPAY";
  if (value.targetInvoiceType !== expectedTargetType) {
    context.addIssue({
      code: "custom",
      path: ["targetInvoiceType"],
      message: "credit-note direction must match the target invoice type",
    });
  }
});

export const refundCreditNotePayloadSchema = z.object({
  creditNoteId: exactUuid,
  creditNoteType: z.enum(["ACCRECCREDIT", "ACCPAYCREDIT"]),
  bankAccountId: exactUuid,
  amount: fixedFourPositive,
  refundDate: realDate,
  expectedStatus: z.literal("AUTHORISED"),
}).strict();

export const voidCreditNotePayloadSchema = z.object({
  creditNoteId: exactUuid,
  creditNoteType: z.enum(["ACCRECCREDIT", "ACCPAYCREDIT"]),
  expectedStatus: z.literal("AUTHORISED"),
}).strict();

export const unallocateCreditNotePayloadSchema = z.object({
  creditNoteId: exactUuid,
  allocationId: exactUuid,
  expectedStatus: z.literal("AUTHORISED"),
}).strict();

export const voidManualJournalPayloadSchema = z.object({
  manualJournalId: exactUuid,
  expectedStatus: z.literal("POSTED"),
}).strict();

export type VoidInvoicePayload = z.infer<typeof voidInvoicePayloadSchema>;
export type AuthoriseCreditNotePayload = z.infer<typeof authoriseCreditNotePayloadSchema>;
export type AllocateCreditNotePayload = z.infer<typeof allocateCreditNotePayloadSchema>;
export type RefundCreditNotePayload = z.infer<typeof refundCreditNotePayloadSchema>;
export type VoidCreditNotePayload = z.infer<typeof voidCreditNotePayloadSchema>;
export type UnallocateCreditNotePayload = z.infer<typeof unallocateCreditNotePayloadSchema>;
export type VoidManualJournalPayload = z.infer<typeof voidManualJournalPayloadSchema>;

export type CanonicalLedgerAdjustmentPayload =
  | VoidInvoicePayload
  | AuthoriseCreditNotePayload
  | AllocateCreditNotePayload
  | RefundCreditNotePayload
  | VoidCreditNotePayload
  | UnallocateCreditNotePayload
  | VoidManualJournalPayload;

export function parseLedgerAdjustmentPayload(
  actionId: LedgerAdjustmentAction,
  value: unknown,
): CanonicalLedgerAdjustmentPayload {
  switch (actionId) {
    case "customer_invoice.void":
      return voidInvoicePayloadSchema.parse({ ...asObject(value), invoiceType: "ACCREC" });
    case "supplier_bill.void":
      return voidInvoicePayloadSchema.parse({ ...asObject(value), invoiceType: "ACCPAY" });
    case "credit_note.authorise":
      return authoriseCreditNotePayloadSchema.parse(value);
    case "credit_note.allocate":
      return allocateCreditNotePayloadSchema.parse(value);
    case "credit_note.refund":
      return refundCreditNotePayloadSchema.parse(value);
    case "credit_note.void":
      return voidCreditNotePayloadSchema.parse(value);
    case "credit_note.unallocate":
      return unallocateCreditNotePayloadSchema.parse({ ...asObject(value), expectedStatus: "AUTHORISED" });
    case "manual_journal.void":
      return voidManualJournalPayloadSchema.parse(value);
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function ledgerAdjustmentObjectType(actionId: LedgerAdjustmentAction): XeroMutationObjectType {
  switch (actionId) {
    case "customer_invoice.void": return "SALES_INVOICE";
    case "supplier_bill.void": return "SUPPLIER_BILL";
    case "credit_note.authorise":
    case "credit_note.allocate":
    case "credit_note.refund":
    case "credit_note.void":
    case "credit_note.unallocate": return "CREDIT_NOTE";
    case "manual_journal.void": return "MANUAL_JOURNAL";
  }
}

export function ledgerAdjustmentOperation(actionId: LedgerAdjustmentAction): XeroMutationOperation {
  switch (actionId) {
    case "credit_note.authorise": return "AUTHORISE";
    case "credit_note.allocate": return "ALLOCATE";
    case "credit_note.refund": return "REFUND";
    case "customer_invoice.void":
    case "supplier_bill.void":
    case "credit_note.void":
    case "manual_journal.void": return "VOID";
    case "credit_note.unallocate": return "UNALLOCATE";
  }
}

export function ledgerAdjustmentTargetId(payload: CanonicalLedgerAdjustmentPayload): string {
  if ("invoiceId" in payload) return payload.invoiceId;
  if ("creditNoteId" in payload) return payload.creditNoteId;
  return payload.manualJournalId;
}

export function ledgerAdjustmentExpectedReadbackStatus(actionId: LedgerAdjustmentAction): "AUTHORISED" | "VOIDED" {
  return actionId === "credit_note.authorise" || actionId === "credit_note.allocate" || actionId === "credit_note.refund"
    ? "AUTHORISED"
    : "VOIDED";
}

/** Converts a sealed fixed-four amount without silently rounding its value. */
export function ledgerAdjustmentAmountToSdkNumber(value: string): number {
  const parsed = fixedFourPositive.parse(value);
  const amount = Number(parsed);
  if (!Number.isFinite(amount) || amount <= 0 || amount.toFixed(4) !== parsed) {
    throw new Error("Ledger-adjustment amount cannot be represented exactly by the Xero SDK number boundary.");
  }
  return amount;
}
