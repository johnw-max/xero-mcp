import { z } from "zod/v4";
import type {
  AccountingDocumentReferenceKind,
  NativeDocumentRoute,
} from "../domain/accountingCase.js";

export const XERO_ACCOUNTING_CASE_BUSINESS_AUTHORITY_PROJECTION_VERSION =
  "xero-accounting-case-business-authority:v4";
export const XERO_REFERENCE_COORDINATE_NORMALIZATION_VERSION = "xero-reference-coordinate:v1";

export type XeroAuthoritativeDocumentProviderField =
  | "INVOICE_NUMBER"
  | "CREDIT_NOTE_NUMBER"
  | "REFERENCE";

export type XeroDocumentCoordinateUniquenessAuthority =
  | "PROVIDER_ENFORCED_UNIQUE"
  | "NON_UNIQUE_EXCLUSIVE_WRITER";

/**
 * Xero's provider identifier and uniqueness promise are independent. Invoice
 * routes use InvoiceNumber and credit routes use CreditNoteNumber, except AR
 * generic labels which use the additional Reference property. AP identifiers
 * remain non-unique even though they use the same native number properties.
 */
export function xeroDocumentCoordinateAuthority(
  route: NativeDocumentRoute,
  referenceKind: AccountingDocumentReferenceKind,
): Readonly<{
  authoritativeProviderField: XeroAuthoritativeDocumentProviderField;
  uniquenessAuthority: XeroDocumentCoordinateUniquenessAuthority;
}> {
  const generic = referenceKind === "GENERIC_RECURRING_REFERENCE";
  const authoritativeProviderField = route === "SALES_INVOICE"
    ? generic ? "REFERENCE" : "INVOICE_NUMBER"
    : route === "SUPPLIER_BILL"
      ? "INVOICE_NUMBER"
      : route === "CUSTOMER_CREDIT"
        ? generic ? "REFERENCE" : "CREDIT_NOTE_NUMBER"
        : "CREDIT_NOTE_NUMBER";
  const uniquenessAuthority = !generic &&
      (route === "SALES_INVOICE" || route === "CUSTOMER_CREDIT")
    ? "PROVIDER_ENFORCED_UNIQUE" as const
    : "NON_UNIQUE_EXCLUSIVE_WRITER" as const;
  return Object.freeze({
    authoritativeProviderField,
    uniquenessAuthority,
  });
}

const routeSchema = z.enum([
  "SALES_INVOICE",
  "SUPPLIER_BILL",
  "CUSTOMER_CREDIT",
  "SUPPLIER_CREDIT",
]);
const receiptHash = z.string().regex(/^[a-f0-9]{64}$/u);

const authorityCoverageSchema = z.object({
  route: routeSchema,
  reference_kind: z.enum(["FORMAL_DOCUMENT_NUMBER", "GENERIC_RECURRING_REFERENCE"]),
  authoritative_provider_field: z.enum(["INVOICE_NUMBER", "CREDIT_NOTE_NUMBER", "REFERENCE"]),
}).strict();

const governedWriterSchema = z.object({
  writer_id: z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/u),
  writer_kind: z.literal("XERO_MCP_INSTALLATION"),
  workspace_id: z.string().trim().min(1).max(255),
  agent_id: z.string().trim().min(1).max(255),
  installation_id: z.string().trim().min(1).max(255),
  coordination_domain_id: z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/u),
}).strict();

const verifiedWriterAuthoritySchema = z.object({
  mode: z.literal("VERIFIED_FIRM_GOVERNANCE"),
  authority_id: z.string().trim().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/u),
  revision: z.number().int().positive(),
  provider_atomic_uniqueness: z.literal(false),
  governance_authority_active: z.literal(true),
  verification_receipt_sha256: receiptHash,
  status_manifest_sha256: receiptHash,
  trust_bundle_sha256: receiptHash,
  expires_at: z.iso.datetime({ offset: true }),
  coverage: z.array(authorityCoverageSchema).min(1).max(8),
  writer_set: z.array(governedWriterSchema).min(1).max(256),
}).strict();

/** Legacy stored/test shape. Production config rejects candidate-supplied profiles. */
const legacyWriterAuthoritySchema = z.object({
  mode: z.literal("EXCLUSIVE_GOVERNED_WRITER"),
  authority_id: z.string().trim().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/u),
  revision: z.number().int().positive(),
  covers_all_tenant_writers: z.literal(true),
  verification_receipt_sha256: receiptHash,
}).strict();

const noWriterAuthoritySchema = z.object({ mode: z.literal("NONE") }).strict();

const recurringSeriesAuthoritySchema = z.object({
  authority_id: z.string().trim().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/u),
  revision: z.number().int().positive(),
  route: routeSchema,
  contact_id: z.string().uuid(),
  reference: z.string().trim().min(1).max(255),
  authoritative_provider_field: z.enum(["INVOICE_NUMBER", "CREDIT_NOTE_NUMBER", "REFERENCE"]),
  normalization_version: z.literal(XERO_REFERENCE_COORDINATE_NORMALIZATION_VERSION),
  occurrence_key: z.literal("DOCUMENT_DATE"),
  verification_receipt_sha256: receiptHash,
  status_manifest_sha256: receiptHash.optional(),
  trust_bundle_sha256: receiptHash.optional(),
  expires_at: z.iso.datetime({ offset: true }).optional(),
}).strict();

const profileSchema = z.object({
  tenant_id: z.string().uuid(),
  writer_authority: z.discriminatedUnion("mode", [
    noWriterAuthoritySchema,
    legacyWriterAuthoritySchema,
    verifiedWriterAuthoritySchema,
  ]),
  recurring_series_authorities: z.array(recurringSeriesAuthoritySchema).max(10_000).default([]),
}).strict().superRefine((profile, context) => {
  const authorityIds = [
    ...(profile.writer_authority.mode !== "NONE"
      ? [profile.writer_authority.authority_id]
      : []),
    ...profile.recurring_series_authorities.map((authority) => authority.authority_id),
  ];
  if (new Set(authorityIds).size !== authorityIds.length) {
    context.addIssue({ code: "custom", message: "business authority IDs must be unique within one tenant" });
  }
  if (profile.writer_authority.mode === "VERIFIED_FIRM_GOVERNANCE") {
    const coverage = profile.writer_authority.coverage.map((item, index) => {
      const expected = xeroDocumentCoordinateAuthority(item.route, item.reference_kind);
      if (expected.uniquenessAuthority !== "NON_UNIQUE_EXCLUSIVE_WRITER" ||
          expected.authoritativeProviderField !== item.authoritative_provider_field) {
        context.addIssue({
          code: "custom",
          path: ["writer_authority", "coverage", index],
          message: "must identify an exact non-unique route/provider-field coordinate",
        });
      }
      return JSON.stringify([item.route, item.reference_kind]);
    });
    if (new Set(coverage).size !== coverage.length) {
      context.addIssue({ code: "custom", path: ["writer_authority", "coverage"], message: "must be unique" });
    }
    const writers = profile.writer_authority.writer_set;
    if (new Set(writers.map((writer) => writer.writer_id)).size !== writers.length ||
        new Set(writers.map((writer) => writer.coordination_domain_id)).size !== 1) {
      context.addIssue({
        code: "custom",
        path: ["writer_authority", "writer_set"],
        message: "writers must be unique and share one coordination domain",
      });
    }
  }
  const coordinates = profile.recurring_series_authorities.map((authority) => JSON.stringify([
    authority.route,
    authority.contact_id.toLowerCase(),
    normalizeXeroBusinessReference(authority.reference),
  ]));
  if (new Set(coordinates).size !== coordinates.length) {
    context.addIssue({ code: "custom", message: "recurring-series coordinates must be unique within one tenant" });
  }
  for (const [index, authority] of profile.recurring_series_authorities.entries()) {
    const expected = xeroDocumentCoordinateAuthority(
      authority.route,
      "GENERIC_RECURRING_REFERENCE",
    ).authoritativeProviderField;
    if (authority.authoritative_provider_field !== expected) {
      context.addIssue({
        code: "custom",
        path: ["recurring_series_authorities", index, "authoritative_provider_field"],
        message: `must be ${expected} for recurring ${authority.route}`,
      });
    }
  }
});

export type XeroAccountingCaseBusinessAuthorityProfile = z.infer<typeof profileSchema>;
export type XeroRecurringSeriesAuthority = z.infer<typeof recurringSeriesAuthoritySchema>;

const projectionSchema = z.object({
  schemaVersion: z.literal(XERO_ACCOUNTING_CASE_BUSINESS_AUTHORITY_PROJECTION_VERSION),
  // Provider projections retain legacy internal fixture compatibility. The
  // deployable profile parser above remains UUID-bound for real Xero tenants.
  tenantId: z.string().min(1).max(255),
  writerAuthority: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("NONE") }).strict(),
    z.object({
      mode: z.literal("LEGACY_UNVERIFIED_EXCLUSIVE_WRITER"),
      authorityId: z.string().min(1),
      revision: z.number().int().positive(),
      coversAllTenantWriters: z.literal(true),
      verificationReceiptSha256: receiptHash,
    }).strict(),
    z.object({
      mode: z.literal("VERIFIED_FIRM_GOVERNANCE"),
      authorityId: z.string().min(1),
      revision: z.number().int().positive(),
      providerAtomicUniqueness: z.literal(false),
      governanceAuthorityActive: z.literal(true),
      verificationReceiptSha256: receiptHash,
      statusManifestSha256: receiptHash,
      trustBundleSha256: receiptHash,
      expiresAt: z.iso.datetime({ offset: true }),
      coverage: z.array(z.object({
        route: routeSchema,
        referenceKind: z.enum(["FORMAL_DOCUMENT_NUMBER", "GENERIC_RECURRING_REFERENCE"]),
        authoritativeProviderField: z.enum(["INVOICE_NUMBER", "CREDIT_NOTE_NUMBER", "REFERENCE"]),
      }).strict()).min(1).max(8),
      writerSet: z.array(z.object({
        writerId: z.string().min(1),
        writerKind: z.literal("XERO_MCP_INSTALLATION"),
        workspaceId: z.string().min(1),
        agentId: z.string().min(1),
        installationId: z.string().min(1),
        coordinationDomainId: z.string().min(1),
      }).strict()).min(1).max(256),
    }).strict(),
  ]),
  recurringSeriesAuthorities: z.array(z.object({
    authorityId: z.string().min(1),
    revision: z.number().int().positive(),
    route: routeSchema,
    contactId: z.string().uuid(),
    normalizedReference: z.string().min(1),
    authoritativeProviderField: z.enum(["INVOICE_NUMBER", "CREDIT_NOTE_NUMBER", "REFERENCE"]),
    normalizationVersion: z.literal(XERO_REFERENCE_COORDINATE_NORMALIZATION_VERSION),
    occurrenceKey: z.literal("DOCUMENT_DATE"),
    verificationReceiptSha256: receiptHash,
    statusManifestSha256: receiptHash.optional(),
    trustBundleSha256: receiptHash.optional(),
    expiresAt: z.iso.datetime({ offset: true }).optional(),
  }).strict()),
}).strict().superRefine((projection, context) => {
  if (projection.writerAuthority.mode === "VERIFIED_FIRM_GOVERNANCE") {
    const coverage = projection.writerAuthority.coverage.map((item, index) => {
      const expected = xeroDocumentCoordinateAuthority(item.route, item.referenceKind);
      if (expected.uniquenessAuthority !== "NON_UNIQUE_EXCLUSIVE_WRITER" ||
          expected.authoritativeProviderField !== item.authoritativeProviderField) {
        context.addIssue({
          code: "custom",
          path: ["writerAuthority", "coverage", index],
          message: "must identify an exact non-unique route/provider-field coordinate",
        });
      }
      return JSON.stringify([item.route, item.referenceKind]);
    });
    if (new Set(coverage).size !== coverage.length) {
      context.addIssue({ code: "custom", path: ["writerAuthority", "coverage"], message: "must be unique" });
    }
    const writers = projection.writerAuthority.writerSet;
    if (new Set(writers.map((writer) => writer.writerId)).size !== writers.length ||
        new Set(writers.map((writer) => writer.coordinationDomainId)).size !== 1) {
      context.addIssue({
        code: "custom",
        path: ["writerAuthority", "writerSet"],
        message: "writers must be unique and share one coordination domain",
      });
    }
  }
  for (const [index, authority] of projection.recurringSeriesAuthorities.entries()) {
    const expected = xeroDocumentCoordinateAuthority(
      authority.route,
      "GENERIC_RECURRING_REFERENCE",
    ).authoritativeProviderField;
    if (authority.authoritativeProviderField !== expected) {
      context.addIssue({
        code: "custom",
        path: ["recurringSeriesAuthorities", index, "authoritativeProviderField"],
        message: `must be ${expected} for recurring ${authority.route}`,
      });
    }
  }
});

export type XeroAccountingCaseBusinessAuthorityProjection = z.infer<typeof projectionSchema>;
export const xeroAccountingCaseBusinessAuthorityProjectionSchema = projectionSchema;

export function normalizeXeroBusinessReference(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleUpperCase("en");
}

export function parseXeroAccountingCaseBusinessAuthorityProfiles(
  raw: unknown,
): readonly XeroAccountingCaseBusinessAuthorityProfile[] {
  const profiles = z.array(profileSchema).parse(raw);
  const tenants = profiles.map((profile) => profile.tenant_id.toLowerCase());
  if (new Set(tenants).size !== tenants.length) {
    throw new Error("Xero Accounting Case business-authority tenant IDs must be unique.");
  }
  return Object.freeze(profiles.map((profile) => Object.freeze(structuredClone(profile))));
}

export function projectXeroAccountingCaseBusinessAuthority(
  tenantId: string,
  profile?: XeroAccountingCaseBusinessAuthorityProfile,
): XeroAccountingCaseBusinessAuthorityProjection {
  if (profile && profile.tenant_id.toLowerCase() !== tenantId.toLowerCase()) {
    throw new Error("Xero Accounting Case business authority is bound to a different tenant.");
  }
  return Object.freeze(projectionSchema.parse({
    schemaVersion: XERO_ACCOUNTING_CASE_BUSINESS_AUTHORITY_PROJECTION_VERSION,
    tenantId,
    writerAuthority: profile
      ? profile.writer_authority.mode === "VERIFIED_FIRM_GOVERNANCE" ? {
          mode: "VERIFIED_FIRM_GOVERNANCE",
          authorityId: profile.writer_authority.authority_id,
          revision: profile.writer_authority.revision,
          providerAtomicUniqueness: false,
          governanceAuthorityActive: true,
          verificationReceiptSha256: profile.writer_authority.verification_receipt_sha256,
          statusManifestSha256: profile.writer_authority.status_manifest_sha256,
          trustBundleSha256: profile.writer_authority.trust_bundle_sha256,
          expiresAt: profile.writer_authority.expires_at,
          coverage: profile.writer_authority.coverage.map((item) => ({
            route: item.route,
            referenceKind: item.reference_kind,
            authoritativeProviderField: item.authoritative_provider_field,
          })),
          writerSet: profile.writer_authority.writer_set.map((writer) => ({
            writerId: writer.writer_id,
            writerKind: writer.writer_kind,
            workspaceId: writer.workspace_id,
            agentId: writer.agent_id,
            installationId: writer.installation_id,
            coordinationDomainId: writer.coordination_domain_id,
          })),
        } : profile.writer_authority.mode === "EXCLUSIVE_GOVERNED_WRITER" ? {
          mode: "LEGACY_UNVERIFIED_EXCLUSIVE_WRITER",
          authorityId: profile.writer_authority.authority_id,
          revision: profile.writer_authority.revision,
          coversAllTenantWriters: true,
          verificationReceiptSha256: profile.writer_authority.verification_receipt_sha256,
        } : { mode: "NONE" }
      : { mode: "NONE" },
    recurringSeriesAuthorities: (profile?.recurring_series_authorities ?? []).map((authority) => ({
      authorityId: authority.authority_id,
      revision: authority.revision,
      route: authority.route,
      contactId: authority.contact_id,
      normalizedReference: normalizeXeroBusinessReference(authority.reference),
      authoritativeProviderField: authority.authoritative_provider_field,
      normalizationVersion: authority.normalization_version,
      occurrenceKey: authority.occurrence_key,
      verificationReceiptSha256: authority.verification_receipt_sha256,
      ...(authority.status_manifest_sha256
        ? { statusManifestSha256: authority.status_manifest_sha256 }
        : {}),
      ...(authority.trust_bundle_sha256
        ? { trustBundleSha256: authority.trust_bundle_sha256 }
        : {}),
      ...(authority.expires_at ? { expiresAt: authority.expires_at } : {}),
    })),
  }));
}

export function parseXeroAccountingCaseBusinessAuthorityProjection(
  raw: unknown,
): XeroAccountingCaseBusinessAuthorityProjection {
  return Object.freeze(projectionSchema.parse(raw));
}

export function findTrustedXeroRecurringSeriesAuthority(
  projection: XeroAccountingCaseBusinessAuthorityProjection,
  coordinate: { route: NativeDocumentRoute; contactId: string; reference: string },
): XeroAccountingCaseBusinessAuthorityProjection["recurringSeriesAuthorities"][number] | undefined {
  const normalizedReference = normalizeXeroBusinessReference(coordinate.reference);
  return projection.recurringSeriesAuthorities.find((authority) =>
    authority.route === coordinate.route &&
    authority.contactId.toLowerCase() === coordinate.contactId.toLowerCase() &&
    authority.normalizedReference === normalizedReference);
}
