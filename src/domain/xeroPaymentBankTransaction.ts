import { z } from "zod/v4";
import { AppError } from "../errors.js";

/**
 * Closed payloads for the R1 payment and spent/received-money slice.
 *
 * A Payment here is only Xero's accounting record against one exact
 * AUTHORISED invoice or bill. It is deliberately not an instruction to a bank,
 * card processor, batch-payment service, or bank-feed provider.
 */
const xeroId = z.string().uuid().transform((value) => value.toLowerCase());

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

const dateOnly = z.string().refine(validDate, "must be a valid YYYY-MM-DD date");
// Canonicalise the instant, not its display offset: `+08:00` and `Z` must not
// produce distinct stale-version payloads for the same Xero UpdatedDateUTC.
const instant = z.string().datetime({ offset: true })
  .refine((value) => !Number.isNaN(new Date(value).getTime()), "must be a valid ISO timestamp")
  .transform((value) => new Date(value).toISOString());
const compactText = (max: number) => z.string().trim().min(1).max(max);

function fixedFour(value: string): string {
  const [whole = "", fraction = ""] = value.split(".");
  return `${whole}.${fraction.padEnd(4, "0")}`;
}

function boundedFixedFour(minimum: bigint, maximum: bigint) {
  return z.string()
    .regex(/^(?:0|[1-9]\d{0,14})(?:\.\d{1,4})?$/u, "must be a non-negative fixed decimal")
    .refine((value) => {
      const [whole = "", fraction = ""] = value.split(".");
      const scaled = BigInt(whole) * 10_000n + BigInt(fraction.padEnd(4, "0"));
      return scaled >= minimum && scaled <= maximum;
    }, "is outside the controlled amount range")
    .transform(fixedFour);
}

const positiveMoney = boundedFixedFour(1n, 9_000_000_000_000_000n);
const positiveQuantity = boundedFixedFour(1n, 10_000_000_000n);
const nonNegativeUnitAmount = boundedFixedFour(0n, 10_000_000_000_000n);
const positiveRate = boundedFixedFour(1n, 10_000_000_000n);
const accountCode = z.string().trim().min(1).max(10);
const taxType = z.string().trim().min(1).max(50);
const trackingOptionIds = z.array(xeroId).max(2).transform((values) => {
  const unique = [...new Set(values)];
  if (unique.length !== values.length) throw new Error("tracking option IDs must be unique");
  return unique.sort();
});

const lineAmountType = z.enum(["EXCLUSIVE", "INCLUSIVE", "NO_TAX"]);
const bankTransactionType = z.enum(["SPEND", "RECEIVE"]);
const paymentInvoiceType = z.enum(["ACCREC", "ACCPAY"]);

export const paymentCreateInputSchema = z.object({
  invoiceId: xeroId,
  invoiceType: paymentInvoiceType,
  bankAccountId: xeroId,
  paymentDate: dateOnly,
  amount: positiveMoney,
  reference: compactText(512).optional(),
}).strict();

export const paymentReverseInputSchema = z.object({
  paymentId: xeroId,
}).strict();

export const bankTransactionLineInputSchema = z.object({
  description: compactText(4_000),
  quantity: positiveQuantity,
  unitAmount: nonNegativeUnitAmount,
  accountCode,
  taxType,
  trackingOptionIds,
}).strict();

const bankTransactionCommonInputSchema = z.object({
  type: bankTransactionType,
  contactId: xeroId,
  bankAccountId: xeroId,
  transactionDate: dateOnly,
  reference: compactText(512),
  lineAmountType,
  currencyRate: positiveRate.optional(),
  lines: z.array(bankTransactionLineInputSchema).min(1).max(50),
}).strict();

export const bankTransactionCreateInputSchema = bankTransactionCommonInputSchema;
export const bankTransactionUpdateInputSchema = bankTransactionCommonInputSchema.extend({
  bankTransactionId: xeroId,
  expectedUpdatedAt: instant,
}).strict();
export const bankTransactionReverseInputSchema = z.object({
  bankTransactionId: xeroId,
}).strict();

export type PaymentCreateInput = z.infer<typeof paymentCreateInputSchema>;
export type PaymentReverseInput = z.infer<typeof paymentReverseInputSchema>;
export type BankTransactionLineInput = z.infer<typeof bankTransactionLineInputSchema>;
export type BankTransactionCreateInput = z.infer<typeof bankTransactionCreateInputSchema>;
export type BankTransactionUpdateInput = z.infer<typeof bankTransactionUpdateInputSchema>;
export type BankTransactionReverseInput = z.infer<typeof bankTransactionReverseInputSchema>;

export interface CanonicalPaymentCreatePayload extends PaymentCreateInput {
  schemaVersion: "xero-payment-bank-transaction:v1";
  objectType: "PAYMENT";
  operation: "CREATE";
}

export interface CanonicalPaymentReversePayload extends PaymentReverseInput {
  schemaVersion: "xero-payment-bank-transaction:v1";
  objectType: "PAYMENT";
  operation: "REVERSE";
}

export interface CanonicalBankTransactionCreatePayload extends BankTransactionCreateInput {
  schemaVersion: "xero-payment-bank-transaction:v1";
  objectType: "BANK_TRANSACTION";
  operation: "CREATE";
}

export interface CanonicalBankTransactionUpdatePayload extends BankTransactionUpdateInput {
  schemaVersion: "xero-payment-bank-transaction:v1";
  objectType: "BANK_TRANSACTION";
  operation: "UPDATE";
}

export interface CanonicalBankTransactionReversePayload extends BankTransactionReverseInput {
  schemaVersion: "xero-payment-bank-transaction:v1";
  objectType: "BANK_TRANSACTION";
  operation: "REVERSE";
}

const canonicalPaymentCreateSchema = paymentCreateInputSchema.extend({
  schemaVersion: z.literal("xero-payment-bank-transaction:v1"),
  objectType: z.literal("PAYMENT"),
  operation: z.literal("CREATE"),
}).strict();

const canonicalPaymentReverseSchema = paymentReverseInputSchema.extend({
  schemaVersion: z.literal("xero-payment-bank-transaction:v1"),
  objectType: z.literal("PAYMENT"),
  operation: z.literal("REVERSE"),
}).strict();

const canonicalBankTransactionCreateSchema = bankTransactionCreateInputSchema.extend({
  schemaVersion: z.literal("xero-payment-bank-transaction:v1"),
  objectType: z.literal("BANK_TRANSACTION"),
  operation: z.literal("CREATE"),
}).strict();

const canonicalBankTransactionUpdateSchema = bankTransactionUpdateInputSchema.extend({
  schemaVersion: z.literal("xero-payment-bank-transaction:v1"),
  objectType: z.literal("BANK_TRANSACTION"),
  operation: z.literal("UPDATE"),
}).strict();

const canonicalBankTransactionReverseSchema = bankTransactionReverseInputSchema.extend({
  schemaVersion: z.literal("xero-payment-bank-transaction:v1"),
  objectType: z.literal("BANK_TRANSACTION"),
  operation: z.literal("REVERSE"),
}).strict();

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  throw new AppError("VALIDATION_FAILED", "The Payment or Bank Transaction payload is invalid.", {
    httpStatus: 422,
    retryable: false,
    details: { providerMutationPossible: false },
  });
}

export function canonicalPaymentCreatePayload(input: unknown): CanonicalPaymentCreatePayload {
  const value = parse(paymentCreateInputSchema, input);
  return {
    schemaVersion: "xero-payment-bank-transaction:v1",
    objectType: "PAYMENT",
    operation: "CREATE",
    ...value,
  };
}

export function canonicalPaymentReversePayload(input: unknown): CanonicalPaymentReversePayload {
  const value = parse(paymentReverseInputSchema, input);
  return {
    schemaVersion: "xero-payment-bank-transaction:v1",
    objectType: "PAYMENT",
    operation: "REVERSE",
    ...value,
  };
}

export function canonicalBankTransactionCreatePayload(input: unknown): CanonicalBankTransactionCreatePayload {
  const value = parse(bankTransactionCreateInputSchema, input);
  return {
    schemaVersion: "xero-payment-bank-transaction:v1",
    objectType: "BANK_TRANSACTION",
    operation: "CREATE",
    ...value,
  };
}

export function canonicalBankTransactionUpdatePayload(input: unknown): CanonicalBankTransactionUpdatePayload {
  const value = parse(bankTransactionUpdateInputSchema, input);
  return {
    schemaVersion: "xero-payment-bank-transaction:v1",
    objectType: "BANK_TRANSACTION",
    operation: "UPDATE",
    ...value,
  };
}

export function canonicalBankTransactionReversePayload(input: unknown): CanonicalBankTransactionReversePayload {
  const value = parse(bankTransactionReverseInputSchema, input);
  return {
    schemaVersion: "xero-payment-bank-transaction:v1",
    objectType: "BANK_TRANSACTION",
    operation: "REVERSE",
    ...value,
  };
}

export function parseCanonicalPaymentCreatePayload(input: unknown): CanonicalPaymentCreatePayload {
  return parse(canonicalPaymentCreateSchema, input);
}

export function parseCanonicalPaymentReversePayload(input: unknown): CanonicalPaymentReversePayload {
  return parse(canonicalPaymentReverseSchema, input);
}

export function parseCanonicalBankTransactionCreatePayload(input: unknown): CanonicalBankTransactionCreatePayload {
  return parse(canonicalBankTransactionCreateSchema, input);
}

export function parseCanonicalBankTransactionUpdatePayload(input: unknown): CanonicalBankTransactionUpdatePayload {
  return parse(canonicalBankTransactionUpdateSchema, input);
}

export function parseCanonicalBankTransactionReversePayload(input: unknown): CanonicalBankTransactionReversePayload {
  return parse(canonicalBankTransactionReverseSchema, input);
}
