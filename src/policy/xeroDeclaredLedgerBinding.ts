import { z } from "zod/v4";
import type { AccountSummary, TaxRateSummary } from "../providers/types.js";
import { hashObject } from "../security/hash.js";

/**
 * Live-ledger binding for the coordinates a caller explicitly declared.
 *
 * This module replaces the deployment-owned semantic chart-of-accounts profile.
 * The MCP no longer decides which account or tax code a transaction belongs to;
 * it only proves that the account code and tax type the caller declared exist,
 * are ACTIVE and postable in the *target tenant's live data*, and it reads the
 * tenant's real tax rate rather than trusting a caller-declared percentage.
 *
 * Everything here is verification against live provider reads. There is no
 * jurisdiction rule, category vocabulary, or tax-semantic mapping.
 */

export const XERO_DECLARED_LEDGER_BINDING_SCHEMA_VERSION = "xero-declared-ledger-binding:v1";
export const XERO_DECLARED_LEDGER_EXECUTION_CONSTRAINTS_SCHEMA_VERSION =
  "xero-declared-ledger-execution-constraints:v1";

/** Xero-native account code shape accepted on the public write contract. */
export const XERO_DECLARED_ACCOUNT_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,9}$/u;
/** Xero-native TaxType shape accepted on the public write contract. */
export const XERO_DECLARED_TAX_TYPE_PATTERN = /^[A-Za-z0-9_]{1,50}$/u;

const accountClassSchema = z.enum(["ASSET", "EQUITY", "EXPENSE", "LIABILITY", "REVENUE"]);

export type XeroLedgerAccountClass = z.infer<typeof accountClassSchema>;

const boundAccountSchema = z.object({
  declaredCode: z.string().min(1).max(10),
  accountId: z.string().uuid(),
  accountCode: z.string().min(1).max(10),
  accountType: z.string().min(1).max(64),
  accountClass: accountClassSchema,
  accountName: z.string().min(1).max(255).optional(),
}).strict();

const boundTaxRateSchema = z.object({
  taxType: z.string().min(1).max(50),
  effectiveTaxRateBps: z.number().int().min(0).max(10_000),
  canApplyToRevenue: z.boolean(),
  canApplyToExpenses: z.boolean(),
  canApplyToAssets: z.boolean(),
  canApplyToLiabilities: z.boolean(),
  canApplyToEquity: z.boolean(),
}).strict();

const unresolvedSchema = z.object({
  declared: z.string().min(1).max(50),
  reasonCode: z.string().min(1).max(64),
}).strict();

const bindingWithoutHashSchema = z.object({
  schemaVersion: z.literal(XERO_DECLARED_LEDGER_BINDING_SCHEMA_VERSION),
  tenantId: z.string().min(1).max(255),
  /** Tenant country code. Informational evidence only; nothing branches on it. */
  jurisdiction: z.string().min(1).max(16),
  accounts: z.array(boundAccountSchema).max(500),
  taxRates: z.array(boundTaxRateSchema).max(500),
  unresolvedAccountCodes: z.array(unresolvedSchema).max(500),
  unresolvedTaxTypes: z.array(unresolvedSchema).max(500),
}).strict();

const bindingSchema = bindingWithoutHashSchema.extend({
  bindingHash: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict().superRefine((binding, context) => {
  const { bindingHash, ...hashInput } = binding;
  if (bindingHash !== hashObject(hashInput)) {
    context.addIssue({
      code: "custom",
      path: ["bindingHash"],
      message: "does not match the canonical declared-ledger binding",
    });
  }
});

export type XeroDeclaredLedgerBinding = Readonly<z.infer<typeof bindingSchema>>;
export type XeroDeclaredLedgerAccount = Readonly<z.infer<typeof boundAccountSchema>>;
export type XeroDeclaredLedgerTaxRate = Readonly<z.infer<typeof boundTaxRateSchema>>;

const constraintsWithoutHashSchema = z.object({
  schemaVersion: z.literal(XERO_DECLARED_LEDGER_EXECUTION_CONSTRAINTS_SCHEMA_VERSION),
  bindingHash: z.string().regex(/^[a-f0-9]{64}$/u),
  tenantId: z.string().min(1).max(255),
  lines: z.array(z.object({
    accountId: z.string().uuid(),
    accountCode: z.string().min(1).max(10),
    expectedType: z.string().min(1).max(64),
    expectedClass: accountClassSchema,
    expectedName: z.string().min(1).max(255).optional(),
    expectedTaxType: z.string().min(1).max(50),
  }).strict()).min(1).max(20),
}).strict();

const constraintsSchema = constraintsWithoutHashSchema.extend({
  constraintsHash: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict().superRefine((constraints, context) => {
  const { constraintsHash, ...hashInput } = constraints;
  if (constraintsHash !== hashObject(hashInput)) {
    context.addIssue({
      code: "custom",
      path: ["constraintsHash"],
      message: "does not match the canonical server-owned execution constraints",
    });
  }
});

export type XeroDeclaredLedgerExecutionConstraints = Readonly<z.infer<typeof constraintsSchema>>;

export class XeroDeclaredLedgerBindingError extends Error {
  constructor(
    readonly reasonCode: string,
    message: string,
    readonly declared?: string,
  ) {
    super(message);
    this.name = "XeroDeclaredLedgerBindingError";
  }
}

function normalizedUpper(value: string | undefined): string | undefined {
  return value?.normalize("NFKC").trim().toLocaleUpperCase("en");
}

function normalizedName(value: string | undefined): string | undefined {
  return value?.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en");
}

function knownAccountClass(value: string | undefined): XeroLedgerAccountClass | undefined {
  const normalized = normalizedUpper(value);
  switch (normalized) {
    case "ASSET":
    case "EQUITY":
    case "EXPENSE":
    case "LIABILITY":
    case "REVENUE":
      return normalized;
    default:
      return undefined;
  }
}

/** Parse a Xero percentage string ("9.0000") into integer basis points. */
export function xeroTaxRateBasisPoints(value: string | undefined): number | undefined {
  if (value === undefined || value !== value.trim()) return undefined;
  const match = /^(\d{1,3})(?:\.(\d{1,4}))?$/u.exec(value);
  if (!match?.[1]) return undefined;
  const scaledFour = (BigInt(match[1]) * 10_000n) + BigInt((match[2] ?? "").padEnd(4, "0"));
  if (scaledFour % 100n !== 0n) return undefined;
  const basisPoints = Number(scaledFour / 100n);
  return basisPoints >= 0 && basisPoints <= 10_000 ? basisPoints : undefined;
}

export function xeroTaxRateAppliesToAccountClass(
  taxRate: XeroDeclaredLedgerTaxRate,
  accountClass: XeroLedgerAccountClass,
): boolean {
  switch (accountClass) {
    case "ASSET": return taxRate.canApplyToAssets;
    case "EQUITY": return taxRate.canApplyToEquity;
    case "EXPENSE": return taxRate.canApplyToExpenses;
    case "LIABILITY": return taxRate.canApplyToLiabilities;
    case "REVENUE": return taxRate.canApplyToRevenue;
  }
}

function resolveDeclaredAccount(
  declaredCode: string,
  accounts: readonly AccountSummary[],
): { account: z.infer<typeof boundAccountSchema> } | { reasonCode: string } {
  const normalized = normalizedUpper(declaredCode);
  const matches = accounts.filter((account) => normalizedUpper(account.code) === normalized);
  if (matches.length === 0) return { reasonCode: "DECLARED_ACCOUNT_NOT_FOUND" };
  if (matches.length > 1) return { reasonCode: "DECLARED_ACCOUNT_AMBIGUOUS" };
  const account = matches[0]!;
  if (account.status !== "ACTIVE") return { reasonCode: "DECLARED_ACCOUNT_NOT_POSTABLE" };
  if (account.type === "BANK" || Boolean(account.systemAccount)) {
    return { reasonCode: "DECLARED_ACCOUNT_NOT_POSTABLE" };
  }
  const accountClass = knownAccountClass(account.class);
  const accountType = normalizedUpper(account.type);
  if (!account.accountId || !account.code || !accountClass || !accountType) {
    return { reasonCode: "DECLARED_ACCOUNT_NOT_POSTABLE" };
  }
  return {
    account: {
      declaredCode: normalized!,
      accountId: account.accountId,
      accountCode: account.code,
      accountType,
      accountClass,
      ...(account.name ? { accountName: account.name } : {}),
    },
  };
}

function resolveDeclaredTaxType(
  declaredTaxType: string,
  taxRates: readonly TaxRateSummary[],
): { taxRate: z.infer<typeof boundTaxRateSchema> } | { reasonCode: string } {
  const matches = taxRates.filter((taxRate) =>
    taxRate.taxType === declaredTaxType && taxRate.status === "ACTIVE");
  if (matches.length === 0) return { reasonCode: "DECLARED_TAX_TYPE_NOT_FOUND" };
  if (matches.length > 1) return { reasonCode: "DECLARED_TAX_TYPE_AMBIGUOUS" };
  const selected = matches[0]!;
  const effective = xeroTaxRateBasisPoints(selected.effectiveRate);
  const display = xeroTaxRateBasisPoints(selected.displayTaxRate);
  if (effective === undefined || display === undefined) {
    return { reasonCode: "DECLARED_TAX_RATE_EVIDENCE_MISSING" };
  }
  if (effective !== display) return { reasonCode: "DECLARED_TAX_RATE_EVIDENCE_INCONSISTENT" };
  // Applicability is proven per dimension, not as a complete set. A provider
  // that reports only the flags relevant to a rate still proves the one that
  // matters, and an absent flag is read as "not applicable" rather than as
  // missing evidence -- the account-class check below is what actually decides,
  // and it stays fail-closed either way. Demanding all five would reject a
  // legitimate revenue rate for saying nothing about equity.
  if (
    selected.canApplyToRevenue === undefined &&
    selected.canApplyToExpenses === undefined &&
    selected.canApplyToAssets === undefined &&
    selected.canApplyToLiabilities === undefined &&
    selected.canApplyToEquity === undefined
  ) return { reasonCode: "DECLARED_TAX_APPLICABILITY_EVIDENCE_MISSING" };
  return {
    taxRate: {
      taxType: declaredTaxType,
      effectiveTaxRateBps: effective,
      canApplyToRevenue: selected.canApplyToRevenue === true,
      canApplyToExpenses: selected.canApplyToExpenses === true,
      canApplyToAssets: selected.canApplyToAssets === true,
      canApplyToLiabilities: selected.canApplyToLiabilities === true,
      canApplyToEquity: selected.canApplyToEquity === true,
    },
  };
}

/**
 * Bind one complete live Xero account list and tax-rate list to the exact
 * coordinates a Case declared. Unresolved declarations are recorded rather than
 * thrown so the accounting policy can emit deterministic per-line reason codes
 * and the Case blocks with zero provider writes.
 */
export function bindXeroDeclaredLedger(input: Readonly<{
  tenantId: string;
  jurisdiction: string;
  accountCodes: readonly string[];
  taxTypes: readonly string[];
  accounts: readonly AccountSummary[];
  taxRates: readonly TaxRateSummary[];
}>): XeroDeclaredLedgerBinding {
  const declaredCodes = [...new Set(input.accountCodes.map((code) => normalizedUpper(code)!))]
    .sort((left, right) => left.localeCompare(right));
  const declaredTaxTypes = [...new Set(input.taxTypes)]
    .sort((left, right) => left.localeCompare(right));
  const accounts: Array<z.infer<typeof boundAccountSchema>> = [];
  const unresolvedAccountCodes: Array<z.infer<typeof unresolvedSchema>> = [];
  for (const declaredCode of declaredCodes) {
    const resolved = resolveDeclaredAccount(declaredCode, input.accounts);
    if ("account" in resolved) accounts.push(resolved.account);
    else unresolvedAccountCodes.push({ declared: declaredCode, reasonCode: resolved.reasonCode });
  }
  const taxRates: Array<z.infer<typeof boundTaxRateSchema>> = [];
  const unresolvedTaxTypes: Array<z.infer<typeof unresolvedSchema>> = [];
  for (const declaredTaxType of declaredTaxTypes) {
    const resolved = resolveDeclaredTaxType(declaredTaxType, input.taxRates);
    if ("taxRate" in resolved) taxRates.push(resolved.taxRate);
    else unresolvedTaxTypes.push({ declared: declaredTaxType, reasonCode: resolved.reasonCode });
  }
  const distinctAccountIds = new Set(accounts.map((account) => account.accountId));
  if (distinctAccountIds.size !== accounts.length) {
    throw new XeroDeclaredLedgerBindingError(
      "DECLARED_ACCOUNT_AMBIGUOUS",
      "Two declared account codes resolve to the same live Xero account.",
    );
  }
  const hashInput = bindingWithoutHashSchema.parse({
    schemaVersion: XERO_DECLARED_LEDGER_BINDING_SCHEMA_VERSION,
    tenantId: input.tenantId,
    jurisdiction: input.jurisdiction,
    accounts,
    taxRates,
    unresolvedAccountCodes,
    unresolvedTaxTypes,
  });
  return Object.freeze(structuredClone(bindingSchema.parse({
    ...hashInput,
    bindingHash: hashObject(hashInput),
  }))) as XeroDeclaredLedgerBinding;
}

export function parseXeroDeclaredLedgerBinding(raw: unknown): XeroDeclaredLedgerBinding {
  return Object.freeze(structuredClone(bindingSchema.parse(raw))) as XeroDeclaredLedgerBinding;
}

export function xeroDeclaredLedgerAccount(
  binding: XeroDeclaredLedgerBinding,
  declaredCode: string,
): XeroDeclaredLedgerAccount | undefined {
  const normalized = normalizedUpper(declaredCode);
  return binding.accounts.find((account) => account.declaredCode === normalized);
}

export function xeroDeclaredLedgerAccountReason(
  binding: XeroDeclaredLedgerBinding,
  declaredCode: string,
): string {
  const normalized = normalizedUpper(declaredCode);
  return binding.unresolvedAccountCodes.find((entry) => entry.declared === normalized)?.reasonCode ??
    "DECLARED_ACCOUNT_NOT_FOUND";
}

export function xeroDeclaredLedgerTaxRate(
  binding: XeroDeclaredLedgerBinding,
  taxType: string,
): XeroDeclaredLedgerTaxRate | undefined {
  return binding.taxRates.find((taxRate) => taxRate.taxType === taxType);
}

export function xeroDeclaredLedgerTaxTypeReason(
  binding: XeroDeclaredLedgerBinding,
  taxType: string,
): string {
  return binding.unresolvedTaxTypes.find((entry) => entry.declared === taxType)?.reasonCode ??
    "DECLARED_TAX_TYPE_NOT_FOUND";
}

/** Require the exact bound account for an already-eligible compiled line. */
export function requireXeroDeclaredLedgerAccount(
  binding: XeroDeclaredLedgerBinding,
  declaredCode: string,
): XeroDeclaredLedgerAccount {
  const account = xeroDeclaredLedgerAccount(binding, declaredCode);
  if (!account) {
    throw new XeroDeclaredLedgerBindingError(
      xeroDeclaredLedgerAccountReason(binding, declaredCode),
      `Declared account code ${declaredCode} is not bound to an exact live Xero account.`,
      declaredCode,
    );
  }
  return account;
}

/**
 * Produce the ordered, server-only constraints carried from the compiled Case
 * to the last account read immediately before a provider write permit. The
 * constraints hash prevents an internal bridge from silently swapping a
 * declared account or tax type while retaining the binding hash.
 */
export function createXeroDeclaredLedgerExecutionConstraints(
  rawBinding: XeroDeclaredLedgerBinding,
  lines: readonly Readonly<{ accountCode: string; taxType: string }>[],
): XeroDeclaredLedgerExecutionConstraints {
  const binding = parseXeroDeclaredLedgerBinding(rawBinding);
  const hashInput = constraintsWithoutHashSchema.parse({
    schemaVersion: XERO_DECLARED_LEDGER_EXECUTION_CONSTRAINTS_SCHEMA_VERSION,
    bindingHash: binding.bindingHash,
    tenantId: binding.tenantId,
    lines: lines.map((line) => {
      const account = requireXeroDeclaredLedgerAccount(binding, line.accountCode);
      return {
        accountId: account.accountId,
        accountCode: account.accountCode,
        expectedType: account.accountType,
        expectedClass: account.accountClass,
        ...(account.accountName ? { expectedName: account.accountName } : {}),
        expectedTaxType: line.taxType,
      };
    }),
  });
  return Object.freeze(structuredClone(constraintsSchema.parse({
    ...hashInput,
    constraintsHash: hashObject(hashInput),
  }))) as XeroDeclaredLedgerExecutionConstraints;
}

export function parseXeroDeclaredLedgerExecutionConstraints(
  raw: unknown,
): XeroDeclaredLedgerExecutionConstraints {
  return Object.freeze(structuredClone(constraintsSchema.parse(raw))) as
    XeroDeclaredLedgerExecutionConstraints;
}

function fail(reasonCode: string, accountCode: string, message: string): never {
  throw new XeroDeclaredLedgerBindingError(reasonCode, message, accountCode);
}

/**
 * Reconcile the immutable server constraints with one fresh complete Xero
 * account list at the provider permit edge. This is intentionally independent
 * of Agent-facing schemas and is reused by invoice and credit-note adapters.
 */
export function assertXeroDeclaredLedgerExecutionConstraints(input: {
  constraints: XeroDeclaredLedgerExecutionConstraints;
  tenantId: string;
  accounts: readonly AccountSummary[];
  lines: readonly { accountId: string | undefined; accountCode: string; taxType: string }[];
}): void {
  const constraints = parseXeroDeclaredLedgerExecutionConstraints(input.constraints);
  if (constraints.tenantId !== input.tenantId) {
    throw new XeroDeclaredLedgerBindingError(
      "XERO_DECLARED_LEDGER_EXECUTION_TENANT_MISMATCH",
      "The server-owned ledger execution constraints do not belong to the active Xero tenant.",
    );
  }
  if (constraints.lines.length !== input.lines.length) {
    throw new XeroDeclaredLedgerBindingError(
      "XERO_DECLARED_LEDGER_EXECUTION_LINE_COUNT_MISMATCH",
      "The server-owned ledger execution constraints do not cover every prepared line exactly once.",
    );
  }
  for (const [index, sealed] of constraints.lines.entries()) {
    const requested = input.lines[index]!;
    const accountCode = sealed.accountCode;
    if (requested.accountId !== sealed.accountId || requested.accountCode !== sealed.accountCode) {
      fail(
        "XERO_DECLARED_EXECUTION_ACCOUNT_BINDING_MISMATCH",
        accountCode,
        `Account ${accountCode} prepared AccountID/code differs from its sealed server-owned constraint.`,
      );
    }
    const idMatches = input.accounts.filter((account) => account.accountId === sealed.accountId);
    const codeMatches = input.accounts.filter((account) =>
      normalizedUpper(account.code) === normalizedUpper(sealed.accountCode));
    const account = idMatches.length === 1 && codeMatches.length === 1 &&
      codeMatches[0]?.accountId === sealed.accountId && idMatches[0]?.code === sealed.accountCode
      ? idMatches[0]
      : undefined;
    if (!account) {
      fail(
        "XERO_DECLARED_EXECUTION_ACCOUNT_BINDING_DRIFT",
        accountCode,
        `Account ${accountCode} no longer has one exact live AccountID/code binding at the provider permit edge.`,
      );
    }
    if (account.status !== "ACTIVE" || account.type === "BANK" || Boolean(account.systemAccount)) {
      fail(
        "XERO_DECLARED_EXECUTION_ACCOUNT_INELIGIBLE",
        accountCode,
        `Account ${accountCode} is inactive, bank-backed, or system-protected at the provider permit edge.`,
      );
    }
    if (normalizedUpper(account.type) !== sealed.expectedType ||
        normalizedUpper(account.class) !== sealed.expectedClass ||
        (sealed.expectedName && normalizedName(account.name) !== normalizedName(sealed.expectedName))) {
      fail(
        "XERO_DECLARED_EXECUTION_ACCOUNT_SEMANTICS_DRIFT",
        accountCode,
        `Account ${accountCode} type, class, or name drifted from its sealed live binding.`,
      );
    }
    if (requested.taxType !== sealed.expectedTaxType) {
      fail(
        "XERO_DECLARED_EXECUTION_TAX_TYPE_MISMATCH",
        accountCode,
        `Account ${accountCode} no longer carries the declared TaxType sealed by this Case.`,
      );
    }
  }
}
