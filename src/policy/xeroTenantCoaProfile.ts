import { z } from "zod/v4";
import type { AccountSummary } from "../providers/types.js";
import { hashObject } from "../security/hash.js";
import { XERO_SINGAPORE_ACCOUNTING_CATEGORY_KEYS } from "./xeroSingaporeAccountingPolicy.js";

export const XERO_TENANT_COA_PROFILE_SCHEMA_VERSION = "xero-tenant-coa-profile:v1";
export const XERO_TENANT_COA_BINDING_SCHEMA_VERSION = "xero-tenant-coa-binding:v1";
export const XERO_TENANT_COA_EXECUTION_CONSTRAINTS_SCHEMA_VERSION =
  "xero-tenant-coa-execution-constraints:v1";

const accountClassSchema = z.enum(["ASSET", "EQUITY", "EXPENSE", "LIABILITY", "REVENUE"]);
const categoryAccountSchema = z.object({
  account_id: z.string().uuid(),
  account_code: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,9}$/u),
  expected_type: z.string().trim().min(1).max(64).regex(/^[A-Z][A-Z0-9_]*$/u),
  expected_class: accountClassSchema,
  expected_name: z.string().trim().min(1).max(255).optional(),
  allowed_tax_types: z.array(z.string().trim().min(1).max(100)).min(1)
    .refine((values) => new Set(values).size === values.length, "must contain unique values")
    .optional(),
}).strict();

const categoriesSchema = z.object({
  CONSULTING_REVENUE: categoryAccountSchema,
  OFFICE_SUPPLIES: categoryAccountSchema,
  CLOUD_SUBSCRIPTIONS: categoryAccountSchema,
}).strict();

const profileSchema = z.object({
  profile_id: z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/u),
  revision: z.number().int().positive(),
  tenant_id: z.string().trim().min(1).max(255),
  jurisdiction: z.literal("SG"),
  categories: categoriesSchema,
}).strict().superRefine((profile, context) => {
  const categoryEntries = Object.entries(profile.categories);
  const ids = categoryEntries.map(([, binding]) => binding.account_id);
  const codes = categoryEntries.map(([, binding]) => binding.account_code.toLocaleUpperCase("en"));
  if (new Set(ids).size !== ids.length) {
    context.addIssue({
      code: "custom",
      path: ["categories"],
      message: "account_id values must be unique across semantic categories",
    });
  }
  if (new Set(codes).size !== codes.length) {
    context.addIssue({
      code: "custom",
      path: ["categories"],
      message: "account_code values must be unique across semantic categories",
    });
  }
});

export type XeroTenantCoaProfile = Readonly<z.infer<typeof profileSchema>>;
export type XeroAccountingCategory = typeof XERO_SINGAPORE_ACCOUNTING_CATEGORY_KEYS[number];

const boundCategorySchema = z.object({
  accountingCategory: z.enum(XERO_SINGAPORE_ACCOUNTING_CATEGORY_KEYS),
  accountId: z.string().uuid(),
  accountCode: z.string().min(1).max(10),
  expectedType: z.string().min(1).max(64),
  expectedClass: accountClassSchema,
  expectedName: z.string().min(1).max(255).optional(),
  allowedTaxTypes: z.array(z.string().min(1).max(100)).min(1).optional(),
}).strict();

const bindingWithoutHashSchema = z.object({
  schemaVersion: z.literal(XERO_TENANT_COA_BINDING_SCHEMA_VERSION),
  profileId: z.string().min(1).max(128),
  revision: z.number().int().positive(),
  tenantId: z.string().min(1).max(255),
  jurisdiction: z.literal("SG"),
  categories: z.object({
    CONSULTING_REVENUE: boundCategorySchema,
    OFFICE_SUPPLIES: boundCategorySchema,
    CLOUD_SUBSCRIPTIONS: boundCategorySchema,
  }).strict(),
}).strict();

const bindingSchema = bindingWithoutHashSchema.extend({
  profileHash: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict().superRefine((binding, context) => {
  const { profileHash, ...hashInput } = binding;
  if (profileHash !== hashObject(hashInput)) {
    context.addIssue({ code: "custom", path: ["profileHash"], message: "does not match the canonical profile binding" });
  }
  for (const category of XERO_SINGAPORE_ACCOUNTING_CATEGORY_KEYS) {
    if (binding.categories[category].accountingCategory !== category) {
      context.addIssue({
        code: "custom",
        path: ["categories", category, "accountingCategory"],
        message: "must equal its semantic category key",
      });
    }
  }
});

export type XeroTenantCoaProfileBinding = Readonly<z.infer<typeof bindingSchema>>;

const executionConstraintsWithoutHashSchema = z.object({
  schemaVersion: z.literal(XERO_TENANT_COA_EXECUTION_CONSTRAINTS_SCHEMA_VERSION),
  profileId: z.string().min(1).max(128),
  profileRevision: z.number().int().positive(),
  profileHash: z.string().regex(/^[a-f0-9]{64}$/u),
  tenantId: z.string().min(1).max(255),
  jurisdiction: z.literal("SG"),
  lines: z.array(z.object({
    accountingCategory: z.enum(XERO_SINGAPORE_ACCOUNTING_CATEGORY_KEYS),
    accountId: z.string().uuid(),
    accountCode: z.string().min(1).max(10),
    expectedType: z.string().min(1).max(64),
    expectedClass: accountClassSchema,
    expectedName: z.string().min(1).max(255).optional(),
    allowedTaxTypes: z.array(z.string().min(1).max(100)).min(1).optional(),
  }).strict()).min(1).max(20),
}).strict();

const executionConstraintsSchema = executionConstraintsWithoutHashSchema.extend({
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

export type XeroTenantCoaExecutionConstraints = Readonly<z.infer<typeof executionConstraintsSchema>>;

export class XeroTenantCoaProfileError extends Error {
  constructor(
    readonly reasonCode: string,
    message: string,
    readonly category?: XeroAccountingCategory,
  ) {
    super(message);
    this.name = "XeroTenantCoaProfileError";
  }
}

function normalizedProfile(profile: z.infer<typeof profileSchema>): XeroTenantCoaProfile {
  return Object.freeze(structuredClone(profile)) as XeroTenantCoaProfile;
}

/** Parse deployment-owned profiles once. No public MCP input reaches this boundary. */
export function parseXeroTenantCoaProfiles(raw: unknown): readonly XeroTenantCoaProfile[] {
  const profiles = z.array(profileSchema).parse(raw);
  const coordinates = profiles.map((profile) => `${profile.tenant_id}\u0000${profile.jurisdiction}`);
  if (new Set(coordinates).size !== coordinates.length) {
    throw new Error("Xero COA profiles must have a unique tenant_id + jurisdiction coordinate.");
  }
  const ids = profiles.map((profile) => profile.profile_id);
  if (new Set(ids).size !== ids.length) {
    throw new Error("Xero COA profile_id values must be unique.");
  }
  return Object.freeze(profiles.map(normalizedProfile));
}

export interface XeroTenantCoaProfileRegistry {
  readonly profiles: readonly XeroTenantCoaProfile[];
  resolve(tenantId: string, jurisdiction: string): XeroTenantCoaProfile;
}

export function createXeroTenantCoaProfileRegistry(
  rawProfiles: readonly XeroTenantCoaProfile[],
): XeroTenantCoaProfileRegistry {
  const profiles = parseXeroTenantCoaProfiles(rawProfiles);
  return Object.freeze({
    profiles,
    resolve(tenantId: string, jurisdiction: string) {
      const matches = profiles.filter((profile) =>
        profile.tenant_id === tenantId && profile.jurisdiction === jurisdiction);
      if (matches.length === 0) {
        throw new XeroTenantCoaProfileError(
          "XERO_TENANT_COA_PROFILE_REQUIRED",
          `No server-owned Xero chart-of-accounts profile is configured for tenant ${tenantId} / ${jurisdiction}.`,
        );
      }
      if (matches.length !== 1) {
        throw new XeroTenantCoaProfileError(
          "XERO_TENANT_COA_PROFILE_AMBIGUOUS",
          `More than one Xero chart-of-accounts profile matched tenant ${tenantId} / ${jurisdiction}.`,
        );
      }
      return matches[0]!;
    },
  });
}

function normalizedText(value: string | undefined): string | undefined {
  return value?.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en");
}

function normalizedUpper(value: string | undefined): string | undefined {
  return value?.normalize("NFKC").trim().toLocaleUpperCase("en");
}

function fail(reasonCode: string, category: XeroAccountingCategory, message: string): never {
  throw new XeroTenantCoaProfileError(reasonCode, message, category);
}

/**
 * Bind a configured semantic profile to one complete live Xero account list.
 * AccountID and code are both authority: neither can be inferred from the
 * other, and codes/IDs may not be reused by another provider row.
 */
export function bindXeroTenantCoaProfile(
  profile: XeroTenantCoaProfile,
  accounts: readonly AccountSummary[],
): XeroTenantCoaProfileBinding {
  const categories = Object.fromEntries(XERO_SINGAPORE_ACCOUNTING_CATEGORY_KEYS.map((category) => {
    const configured = profile.categories[category];
    const idMatches = accounts.filter((account) => account.accountId === configured.account_id);
    if (idMatches.length === 0) {
      fail("XERO_COA_ACCOUNT_ID_MISSING", category, `${category} AccountID is absent from the exact Xero account list.`);
    }
    if (idMatches.length !== 1) {
      fail("XERO_COA_ACCOUNT_ID_AMBIGUOUS", category, `${category} AccountID is duplicated in the Xero account list.`);
    }
    const codeMatches = accounts.filter((account) =>
      normalizedUpper(account.code) === normalizedUpper(configured.account_code));
    if (codeMatches.length > 1) {
      fail("XERO_COA_ACCOUNT_CODE_AMBIGUOUS", category, `${category} account code is reused by multiple Xero accounts.`);
    }
    const account = idMatches[0]!;
    if (
      codeMatches.length !== 1 ||
      codeMatches[0]?.accountId !== configured.account_id ||
      account.code !== configured.account_code
    ) {
      fail("XERO_COA_ACCOUNT_BINDING_MISMATCH", category, `${category} AccountID and code no longer identify the same Xero account.`);
    }
    if (account.status !== "ACTIVE") {
      fail("XERO_COA_ACCOUNT_INACTIVE", category, `${category} Xero account is not explicitly ACTIVE.`);
    }
    if (account.type === "BANK" || Boolean(account.systemAccount)) {
      fail("XERO_COA_ACCOUNT_PROTECTED", category, `${category} resolves to a bank or system-protected Xero account.`);
    }
    if (normalizedUpper(account.type) !== configured.expected_type) {
      fail("XERO_COA_ACCOUNT_TYPE_MISMATCH", category, `${category} Xero account type differs from the server-owned profile.`);
    }
    if (normalizedUpper(account.class) !== configured.expected_class) {
      fail("XERO_COA_ACCOUNT_CLASS_MISMATCH", category, `${category} Xero account class differs from the server-owned profile.`);
    }
    if (configured.expected_name && normalizedText(account.name) !== normalizedText(configured.expected_name)) {
      fail("XERO_COA_ACCOUNT_NAME_MISMATCH", category, `${category} Xero account name differs from the server-owned profile.`);
    }
    return [category, Object.freeze({
      accountingCategory: category,
      accountId: configured.account_id,
      accountCode: configured.account_code,
      expectedType: configured.expected_type,
      expectedClass: configured.expected_class,
      ...(configured.expected_name ? { expectedName: configured.expected_name } : {}),
      ...(configured.allowed_tax_types
        ? { allowedTaxTypes: Object.freeze([...configured.allowed_tax_types]) }
        : {}),
    })];
  })) as z.infer<typeof bindingWithoutHashSchema>["categories"];
  const hashInput = bindingWithoutHashSchema.parse({
    schemaVersion: XERO_TENANT_COA_BINDING_SCHEMA_VERSION,
    profileId: profile.profile_id,
    revision: profile.revision,
    tenantId: profile.tenant_id,
    jurisdiction: profile.jurisdiction,
    categories,
  });
  return Object.freeze(structuredClone(bindingSchema.parse({
    ...hashInput,
    profileHash: hashObject(hashInput),
  }))) as XeroTenantCoaProfileBinding;
}

export function parseXeroTenantCoaProfileBinding(raw: unknown): XeroTenantCoaProfileBinding {
  return Object.freeze(structuredClone(bindingSchema.parse(raw))) as XeroTenantCoaProfileBinding;
}

/**
 * Produce the ordered, server-only semantic constraints carried from the
 * compiled Case to the last account read immediately before a Provider permit.
 * The constraints hash prevents an internal bridge from silently swapping a
 * category or expected account semantic while retaining the profile hash.
 */
export function createXeroTenantCoaExecutionConstraints(
  rawBinding: XeroTenantCoaProfileBinding,
  lineCategories: readonly XeroAccountingCategory[],
): XeroTenantCoaExecutionConstraints {
  const binding = parseXeroTenantCoaProfileBinding(rawBinding);
  const hashInput = executionConstraintsWithoutHashSchema.parse({
    schemaVersion: XERO_TENANT_COA_EXECUTION_CONSTRAINTS_SCHEMA_VERSION,
    profileId: binding.profileId,
    profileRevision: binding.revision,
    profileHash: binding.profileHash,
    tenantId: binding.tenantId,
    jurisdiction: binding.jurisdiction,
    lines: lineCategories.map((category) => binding.categories[category]),
  });
  return Object.freeze(structuredClone(executionConstraintsSchema.parse({
    ...hashInput,
    constraintsHash: hashObject(hashInput),
  }))) as XeroTenantCoaExecutionConstraints;
}

export function parseXeroTenantCoaExecutionConstraints(raw: unknown): XeroTenantCoaExecutionConstraints {
  return Object.freeze(structuredClone(executionConstraintsSchema.parse(raw))) as XeroTenantCoaExecutionConstraints;
}

/**
 * Reconcile the immutable server constraints with one fresh complete Xero
 * account list. This is intentionally independent of Agent-facing schemas and
 * is reusable by invoice and credit-note adapters at their final permit edge.
 */
export function assertXeroTenantCoaExecutionConstraints(input: {
  constraints: XeroTenantCoaExecutionConstraints;
  tenantId: string;
  accounts: readonly AccountSummary[];
  lines: readonly { accountId: string | undefined; accountCode: string; taxType: string }[];
}): void {
  const constraints = parseXeroTenantCoaExecutionConstraints(input.constraints);
  if (constraints.tenantId !== input.tenantId) {
    throw new XeroTenantCoaProfileError(
      "XERO_TENANT_COA_EXECUTION_TENANT_MISMATCH",
      "The server-owned COA execution constraints do not belong to the active Xero tenant.",
    );
  }
  if (constraints.lines.length !== input.lines.length) {
    throw new XeroTenantCoaProfileError(
      "XERO_TENANT_COA_EXECUTION_LINE_COUNT_MISMATCH",
      "The server-owned COA execution constraints do not cover every prepared line exactly once.",
    );
  }
  for (const [index, sealed] of constraints.lines.entries()) {
    const requested = input.lines[index]!;
    const category = sealed.accountingCategory;
    if (requested.accountId !== sealed.accountId || requested.accountCode !== sealed.accountCode) {
      fail(
        "XERO_COA_EXECUTION_ACCOUNT_BINDING_MISMATCH",
        category,
        `${category} prepared AccountID/code differs from its sealed server-owned constraint.`,
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
        "XERO_COA_EXECUTION_ACCOUNT_BINDING_DRIFT",
        category,
        `${category} no longer has one exact live AccountID/code binding at the Provider permit edge.`,
      );
    }
    if (account.status !== "ACTIVE" || account.type === "BANK" || Boolean(account.systemAccount)) {
      fail(
        "XERO_COA_EXECUTION_ACCOUNT_INELIGIBLE",
        category,
        `${category} is inactive, bank-backed, or system-protected at the Provider permit edge.`,
      );
    }
    if (normalizedUpper(account.type) !== sealed.expectedType ||
        normalizedUpper(account.class) !== sealed.expectedClass ||
        (sealed.expectedName && normalizedText(account.name) !== normalizedText(sealed.expectedName))) {
      fail(
        "XERO_COA_EXECUTION_ACCOUNT_SEMANTICS_DRIFT",
        category,
        `${category} type, class, or name drifted from its server-owned semantic profile.`,
      );
    }
    if (sealed.allowedTaxTypes && !sealed.allowedTaxTypes.includes(requested.taxType)) {
      fail(
        "XERO_COA_EXECUTION_TAX_TYPE_NOT_ALLOWED",
        category,
        `${category} no longer permits the prepared TaxType.`,
      );
    }
  }
}

export function xeroTenantCoaCategoryBinding(
  binding: XeroTenantCoaProfileBinding,
  category: string,
) {
  if (!XERO_SINGAPORE_ACCOUNTING_CATEGORY_KEYS.includes(category as XeroAccountingCategory)) {
    throw new XeroTenantCoaProfileError(
      "ACCOUNTING_CATEGORY_POLICY_UNKNOWN",
      `Accounting category ${category} is not present in the Xero tenant COA profile.`,
    );
  }
  return binding.categories[category as XeroAccountingCategory];
}
