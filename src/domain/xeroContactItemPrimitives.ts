import { randomBytes } from "node:crypto";
import { z } from "zod/v4";
import { AppError } from "../errors.js";
import { hashObject, sha256 } from "../security/hash.js";

const compactText = (maximum: number) => z.string().trim().min(1).max(maximum)
  .transform((value) => value.replace(/\s+/gu, " "));

const email = z.string().trim().email().max(255).transform((value) => value.toLowerCase());

const phoneSchema = z.object({
  phone_type: z.enum(["DEFAULT", "DDI", "MOBILE", "FAX", "OFFICE"]),
  phone_number: compactText(50),
  area_code: compactText(10).optional(),
  country_code: compactText(20).optional(),
}).strict();

const addressSchema = z.object({
  address_type: z.enum(["POBOX", "STREET"]),
  line_1: compactText(500).optional(),
  line_2: compactText(500).optional(),
  line_3: compactText(500).optional(),
  line_4: compactText(500).optional(),
  city: compactText(255).optional(),
  region: compactText(255).optional(),
  postal_code: compactText(50).optional(),
  country: z.string().trim().min(1).max(50).regex(/^[\p{L} .'-]+$/u)
    .transform((value) => value.replace(/\s+/gu, " ")).optional(),
  attention_to: compactText(255).optional(),
}).strict().refine((value) => Object.keys(value).some((key) => key !== "address_type"), {
  message: "an address must contain at least one address field",
});

const phoneArraySchema = z.array(phoneSchema).min(1).max(5).refine(
  (phones) => new Set(phones.map((phone) => phone.phone_type)).size === phones.length,
  "phones must not repeat a phone_type",
);

const addressArraySchema = z.array(addressSchema).min(1).max(2).refine(
  (addresses) => new Set(addresses.map((address) => address.address_type)).size === addresses.length,
  "addresses must not repeat an address_type",
);

const contactFieldsSchema = z.object({
  name: compactText(255).optional(),
  first_name: compactText(255).optional(),
  last_name: compactText(255).optional(),
  email: email.optional(),
  company_number: compactText(50).optional(),
  account_number: compactText(50).optional(),
  phones: phoneArraySchema.optional(),
  addresses: addressArraySchema.optional(),
}).strict();

export const contactCreateSchema = z.object({
  name: compactText(255),
  first_name: compactText(255).optional(),
  last_name: compactText(255).optional(),
  email: email.optional(),
  company_number: compactText(50).optional(),
  account_number: compactText(50).optional(),
  phones: phoneArraySchema.optional(),
  addresses: addressArraySchema.optional(),
}).strict();

const isoTimestamp = z.string().min(1).max(64)
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/, "must be an ISO date-time")
  .refine((value) => Number.isFinite(Date.parse(value)), {
  message: "must be an ISO date-time",
}).transform((value) => new Date(value).toISOString());

export const contactUpdateSchema = z.object({
  contact_id: z.string().uuid(),
  expected_updated_at: isoTimestamp,
  patch: contactFieldsSchema.refine((value) => Object.keys(value).length > 0, {
    message: "contact patch must include at least one reviewed field",
  }),
}).strict();

const fourDecimalMoney = z.number().finite().min(0).max(1_000_000_000).refine(
  (value) => Math.abs(value * 10_000 - Math.round(value * 10_000)) < 1e-7,
  "must have at most four decimal places",
);

const itemDetailsSchema = z.object({
  unit_price: fourDecimalMoney.optional(),
  account_code: compactText(10).optional(),
  tax_type: compactText(100).optional(),
}).strict().refine((value) => Object.keys(value).length > 0, {
  message: "item accounting details must include at least one reviewed field",
});

export const itemCreateSchema = z.object({
  code: compactText(30),
  name: compactText(50).optional(),
  description: compactText(4_000).optional(),
  purchase_description: compactText(4_000).optional(),
  is_sold: z.boolean().default(true),
  is_purchased: z.boolean().default(true),
  sales_details: itemDetailsSchema.optional(),
  purchase_details: itemDetailsSchema.optional(),
}).strict().superRefine((value, context) => {
  if (!value.is_sold && (value.description || value.sales_details)) {
    context.addIssue({
      code: "custom",
      path: [value.description ? "description" : "sales_details"],
      message: "sales fields require is_sold=true",
    });
  }
  if (!value.is_purchased && (value.purchase_description || value.purchase_details)) {
    context.addIssue({
      code: "custom",
      path: [value.purchase_description ? "purchase_description" : "purchase_details"],
      message: "purchase fields require is_purchased=true",
    });
  }
  if (!value.is_sold && !value.is_purchased) {
    context.addIssue({ code: "custom", path: ["is_sold"], message: "an item must remain usable for sale or purchase" });
  }
});

const itemPatchSchema = z.object({
  name: compactText(50).optional(),
  description: compactText(4_000).optional(),
  purchase_description: compactText(4_000).optional(),
  is_sold: z.boolean().optional(),
  is_purchased: z.boolean().optional(),
  sales_details: itemDetailsSchema.optional(),
  purchase_details: itemDetailsSchema.optional(),
}).strict().refine((value) => Object.keys(value).length > 0, {
  message: "item patch must include at least one reviewed field",
});

export const itemUpdateSchema = z.object({
  item_id: z.string().uuid(),
  expected_updated_at: isoTimestamp,
  patch: itemPatchSchema,
}).strict();

export interface SafeContactPhone {
  phoneType: "DEFAULT" | "DDI" | "MOBILE" | "FAX" | "OFFICE";
  phoneNumber: string;
  areaCode?: string;
  countryCode?: string;
}

export interface SafeContactAddress {
  addressType: "POBOX" | "STREET";
  line1?: string;
  line2?: string;
  line3?: string;
  line4?: string;
  city?: string;
  region?: string;
  postalCode?: string;
  country?: string;
  attentionTo?: string;
}

export interface SafeContactTarget {
  name: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  companyNumber?: string;
  accountNumber?: string;
  phones?: SafeContactPhone[];
  addresses?: SafeContactAddress[];
}

export type ContactNumberPreservationEvidence =
  | { kind: "ABSENT" }
  | { kind: "OWNED_NAMESPACE" }
  | { kind: "EXTERNAL_FINGERPRINT"; fingerprint: string };

export interface SafeContactSnapshot extends SafeContactTarget {
  contactId: string;
  externalReference?: string;
  contactNumberEvidence: ContactNumberPreservationEvidence;
  updatedAt: string;
}

export interface NormalizedBusinessKey {
  kind: "COMPANY_NUMBER" | "EMAIL" | "ACCOUNT_NUMBER" | "NAME" | "ITEM_CODE";
  value: string;
}

export interface ContactCreatePrimitive {
  objectType: "CONTACT";
  operation: "CREATE";
  normalizedBusinessKey: NormalizedBusinessKey;
  externalReference: string;
  target: SafeContactTarget;
  canonicalPayload: Record<string, unknown>;
  canonicalPayloadHash: string;
  confirmationPhrase: string;
}

export interface SafeMutationDiff {
  path: string;
  before: unknown;
  after: unknown;
}

export interface SafeContactPatch {
  name?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  companyNumber?: string;
  accountNumber?: string;
  phones?: SafeContactPhone[];
  addresses?: SafeContactAddress[];
}

export interface ContactUpdatePrimitive {
  objectType: "CONTACT";
  operation: "UPDATE";
  contactId: string;
  expectedUpdatedAt: string;
  normalizedBusinessKey: NormalizedBusinessKey;
  before: SafeContactSnapshot;
  patch: SafeContactPatch;
  target: SafeContactTarget;
  diff: SafeMutationDiff[];
  canonicalPayload: Record<string, unknown>;
  canonicalPayloadHash: string;
  confirmationPhrase: string;
}

export interface ContactPrimitiveOptions {
  externalKey: string;
  namespace: string;
  confirmationToken?: string;
}

export interface ContactUpdatePrimitiveOptions {
  confirmationToken?: string;
}

export interface SafeItemDetails {
  unitPrice?: string;
  accountCode?: string;
  taxType?: string;
}

export interface SafeItemTarget {
  code: string;
  name?: string;
  description?: string;
  purchaseDescription?: string;
  isSold: boolean;
  isPurchased: boolean;
  isTrackedAsInventory: false;
  salesDetails?: SafeItemDetails;
  purchaseDetails?: SafeItemDetails;
}

export interface SafeItemSnapshot extends Omit<SafeItemTarget, "isTrackedAsInventory"> {
  itemId: string;
  isTrackedAsInventory: boolean;
  updatedAt: string;
}

export interface ItemCreatePrimitive {
  objectType: "ITEM";
  operation: "CREATE";
  normalizedBusinessKey: NormalizedBusinessKey;
  target: SafeItemTarget;
  canonicalPayload: Record<string, unknown>;
  canonicalPayloadHash: string;
  confirmationPhrase: string;
}

export interface SafeItemPatch {
  name?: string;
  description?: string;
  purchaseDescription?: string;
  isSold?: boolean;
  isPurchased?: boolean;
  salesDetails?: SafeItemDetails;
  purchaseDetails?: SafeItemDetails;
}

export interface ItemUpdatePrimitive {
  objectType: "ITEM";
  operation: "UPDATE";
  itemId: string;
  expectedUpdatedAt: string;
  normalizedBusinessKey: NormalizedBusinessKey;
  before: SafeItemSnapshot;
  patch: SafeItemPatch;
  target: SafeItemTarget;
  diff: SafeMutationDiff[];
  canonicalPayload: Record<string, unknown>;
  canonicalPayloadHash: string;
  confirmationPhrase: string;
}

export interface ItemPrimitiveOptions {
  confirmationToken?: string;
}

function normalizedLookupText(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, "").toLowerCase();
}

function contactBusinessKey(target: SafeContactTarget): NormalizedBusinessKey {
  if (target.companyNumber) return { kind: "COMPANY_NUMBER", value: normalizedLookupText(target.companyNumber) };
  if (target.email) return { kind: "EMAIL", value: target.email.toLowerCase() };
  if (target.accountNumber) return { kind: "ACCOUNT_NUMBER", value: normalizedLookupText(target.accountNumber) };
  return { kind: "NAME", value: target.name.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase() };
}

function contactTarget(input: z.infer<typeof contactCreateSchema>): SafeContactTarget {
  const phones = input.phones?.map((phone) => ({
    phoneType: phone.phone_type,
    phoneNumber: phone.phone_number,
    ...(phone.area_code ? { areaCode: phone.area_code } : {}),
    ...(phone.country_code ? { countryCode: phone.country_code } : {}),
  }));
  const addresses = input.addresses?.map((address) => ({
    addressType: address.address_type,
    ...(address.line_1 ? { line1: address.line_1 } : {}),
    ...(address.line_2 ? { line2: address.line_2 } : {}),
    ...(address.line_3 ? { line3: address.line_3 } : {}),
    ...(address.line_4 ? { line4: address.line_4 } : {}),
    ...(address.city ? { city: address.city } : {}),
    ...(address.region ? { region: address.region } : {}),
    ...(address.postal_code ? { postalCode: address.postal_code } : {}),
    ...(address.country ? { country: address.country } : {}),
    ...(address.attention_to ? { attentionTo: address.attention_to } : {}),
  }));
  return {
    name: input.name,
    ...(input.first_name ? { firstName: input.first_name } : {}),
    ...(input.last_name ? { lastName: input.last_name } : {}),
    ...(input.email ? { email: input.email } : {}),
    ...(input.company_number ? { companyNumber: input.company_number } : {}),
    ...(input.account_number ? { accountNumber: input.account_number } : {}),
    ...(phones?.length ? { phones } : {}),
    ...(addresses?.length ? { addresses } : {}),
  };
}

function contactPatch(input: z.infer<typeof contactFieldsSchema>): SafeContactPatch {
  const phones = input.phones?.map((phone) => ({
    phoneType: phone.phone_type,
    phoneNumber: phone.phone_number,
    ...(phone.area_code ? { areaCode: phone.area_code } : {}),
    ...(phone.country_code ? { countryCode: phone.country_code } : {}),
  }));
  const addresses = input.addresses?.map((address) => ({
    addressType: address.address_type,
    ...(address.line_1 ? { line1: address.line_1 } : {}),
    ...(address.line_2 ? { line2: address.line_2 } : {}),
    ...(address.line_3 ? { line3: address.line_3 } : {}),
    ...(address.line_4 ? { line4: address.line_4 } : {}),
    ...(address.city ? { city: address.city } : {}),
    ...(address.region ? { region: address.region } : {}),
    ...(address.postal_code ? { postalCode: address.postal_code } : {}),
    ...(address.country ? { country: address.country } : {}),
    ...(address.attention_to ? { attentionTo: address.attention_to } : {}),
  }));
  return {
    ...(input.name ? { name: input.name } : {}),
    ...(input.first_name ? { firstName: input.first_name } : {}),
    ...(input.last_name ? { lastName: input.last_name } : {}),
    ...(input.email ? { email: input.email } : {}),
    ...(input.company_number ? { companyNumber: input.company_number } : {}),
    ...(input.account_number ? { accountNumber: input.account_number } : {}),
    ...(phones !== undefined ? { phones } : {}),
    ...(addresses !== undefined ? { addresses } : {}),
  };
}

const safePhoneSnapshotSchema = z.object({
  phoneType: z.enum(["DEFAULT", "DDI", "MOBILE", "FAX", "OFFICE"]),
  phoneNumber: compactText(50),
  areaCode: compactText(10).optional(),
  countryCode: compactText(20).optional(),
}).strict();

const safeAddressSnapshotSchema = z.object({
  addressType: z.enum(["POBOX", "STREET"]),
  line1: compactText(500).optional(),
  line2: compactText(500).optional(),
  line3: compactText(500).optional(),
  line4: compactText(500).optional(),
  city: compactText(255).optional(),
  region: compactText(255).optional(),
  postalCode: compactText(50).optional(),
  country: compactText(50).optional(),
  attentionTo: compactText(255).optional(),
}).strict();

const safeContactPhoneArraySchema = z.array(safePhoneSnapshotSchema).max(5).refine(
  (phones) => new Set(phones.map((phone) => phone.phoneType)).size === phones.length,
  "safe phones must not repeat a phoneType",
);

const safeContactAddressArraySchema = z.array(safeAddressSnapshotSchema).max(2).refine(
  (addresses) => new Set(addresses.map((address) => address.addressType)).size === addresses.length,
  "safe addresses must not repeat an addressType",
);

const contactNumberEvidenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ABSENT") }).strict(),
  z.object({ kind: z.literal("OWNED_NAMESPACE") }).strict(),
  z.object({
    kind: z.literal("EXTERNAL_FINGERPRINT"),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
]);

export const safeContactTargetSchema = z.object({
  name: compactText(255),
  firstName: compactText(255).optional(),
  lastName: compactText(255).optional(),
  email: email.optional(),
  companyNumber: compactText(50).optional(),
  accountNumber: compactText(50).optional(),
  phones: safeContactPhoneArraySchema.optional(),
  addresses: safeContactAddressArraySchema.optional(),
}).strict();

export const safeContactSnapshotSchema = safeContactTargetSchema.extend({
  contactId: z.string().uuid(),
  externalReference: z.string().regex(/^ZC:[a-z][a-z0-9_-]{1,11}:[a-f0-9]{32}$/).optional(),
  contactNumberEvidence: contactNumberEvidenceSchema,
  updatedAt: isoTimestamp,
}).strict().superRefine((value, context) => {
  if (value.contactNumberEvidence.kind === "OWNED_NAMESPACE" && !value.externalReference) {
    context.addIssue({
      code: "custom",
      path: ["externalReference"],
      message: "owned ContactNumber evidence requires the exact namespaced external reference",
    });
  }
  if (value.contactNumberEvidence.kind !== "OWNED_NAMESPACE" && value.externalReference) {
    context.addIssue({
      code: "custom",
      path: ["contactNumberEvidence"],
      message: "externalReference is only valid with owned ContactNumber evidence",
    });
  }
});

function snapshotTarget(snapshot: SafeContactSnapshot): SafeContactTarget {
  const {
    contactId: _contactId,
    externalReference: _externalReference,
    contactNumberEvidence: _contactNumberEvidence,
    updatedAt: _updatedAt,
    ...target
  } = snapshot;
  return target;
}

function mergeContactPatch(before: SafeContactTarget, patch: SafeContactPatch): SafeContactTarget {
  const merged: SafeContactTarget = { ...before, ...patch };
  if (patch.phones) {
    const existingByType = new Map((before.phones ?? []).map((phone) => [phone.phoneType, phone]));
    const replacements = new Map(patch.phones.map((phone) => [
      phone.phoneType,
      { ...existingByType.get(phone.phoneType), ...phone },
    ]));
    merged.phones = [
      ...(before.phones ?? []).filter((phone) => !replacements.has(phone.phoneType)),
      ...replacements.values(),
    ].sort((left, right) => left.phoneType.localeCompare(right.phoneType));
  }
  if (patch.addresses) {
    const existingByType = new Map((before.addresses ?? []).map((address) => [address.addressType, address]));
    const replacements = new Map(patch.addresses.map((address) => [
      address.addressType,
      { ...existingByType.get(address.addressType), ...address },
    ]));
    merged.addresses = [
      ...(before.addresses ?? []).filter((address) => !replacements.has(address.addressType)),
      ...replacements.values(),
    ].sort((left, right) => left.addressType.localeCompare(right.addressType));
  }
  return merged;
}

function mutationDiff(before: Record<string, unknown>, after: Record<string, unknown>): SafeMutationDiff[] {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return keys.flatMap((path) => {
    const left = before[path];
    const right = after[path];
    return hashObject({ value: left }) === hashObject({ value: right })
      ? []
      : [{ path, before: left ?? null, after: right ?? null }];
  });
}

function serverExternalReference(namespace: string, externalKey: string): string {
  const parsedNamespace = z.string().regex(/^[a-z][a-z0-9_-]{1,11}$/).parse(namespace);
  const parsedExternalKey = z.string().trim().min(1).max(512).parse(externalKey);
  const digest = sha256(`xero-contact-external-key:v1:${parsedExternalKey}`).slice(0, 32);
  return `ZC:${parsedNamespace}:${digest}`;
}

function confirmationPhrase(objectType: "CONTACT" | "ITEM", operation: "CREATE" | "UPDATE", token?: string): string {
  const candidate = token ?? randomBytes(8).toString("hex").toUpperCase();
  const parsed = z.string().regex(/^[A-F0-9]{16,32}$/).parse(candidate);
  return `CONFIRM-${objectType}-${operation}-${parsed}`;
}

function itemDetails(input: z.infer<typeof itemDetailsSchema> | undefined): SafeItemDetails | undefined {
  if (!input) return undefined;
  return {
    ...(input.unit_price !== undefined ? { unitPrice: input.unit_price.toFixed(4) } : {}),
    ...(input.account_code ? { accountCode: input.account_code } : {}),
    ...(input.tax_type ? { taxType: input.tax_type } : {}),
  };
}

function itemBusinessKey(code: string): NormalizedBusinessKey {
  return {
    kind: "ITEM_CODE",
    value: code.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase(),
  };
}

const safeItemDetailsSchema = z.object({
  unitPrice: z.string().regex(/^\d+\.\d{4}$/).optional(),
  accountCode: compactText(10).optional(),
  taxType: compactText(100).optional(),
}).strict().refine((value) => Object.keys(value).length > 0, {
  message: "safe item details must contain at least one field",
});

export const safeItemTargetSchema = z.object({
  code: compactText(30),
  name: compactText(50).optional(),
  description: compactText(4_000).optional(),
  purchaseDescription: compactText(4_000).optional(),
  isSold: z.boolean(),
  isPurchased: z.boolean(),
  isTrackedAsInventory: z.literal(false),
  salesDetails: safeItemDetailsSchema.optional(),
  purchaseDetails: safeItemDetailsSchema.optional(),
}).strict().superRefine((value, context) => {
  if (!value.isSold && (value.description || value.salesDetails)) {
    context.addIssue({
      code: "custom",
      path: [value.description ? "description" : "salesDetails"],
      message: "sales description and details require isSold=true",
    });
  }
  if (!value.isPurchased && (value.purchaseDescription || value.purchaseDetails)) {
    context.addIssue({
      code: "custom",
      path: [value.purchaseDescription ? "purchaseDescription" : "purchaseDetails"],
      message: "purchase description and details require isPurchased=true",
    });
  }
  if (!value.isSold && !value.isPurchased) {
    context.addIssue({ code: "custom", path: ["isSold"], message: "a safe item must remain usable for sale or purchase" });
  }
});

export const safeItemSnapshotSchema = z.object({
  itemId: z.string().uuid(),
  code: compactText(30),
  name: compactText(50).optional(),
  description: compactText(4_000).optional(),
  purchaseDescription: compactText(4_000).optional(),
  isSold: z.boolean(),
  isPurchased: z.boolean(),
  isTrackedAsInventory: z.boolean(),
  salesDetails: safeItemDetailsSchema.optional(),
  purchaseDetails: safeItemDetailsSchema.optional(),
  updatedAt: isoTimestamp,
}).strict().superRefine((value, context) => {
  if (!value.isSold && (value.description || value.salesDetails)) {
    context.addIssue({
      code: "custom",
      path: [value.description ? "description" : "salesDetails"],
      message: "sales description and details require isSold=true",
    });
  }
  if (!value.isPurchased && (value.purchaseDescription || value.purchaseDetails)) {
    context.addIssue({
      code: "custom",
      path: [value.purchaseDescription ? "purchaseDescription" : "purchaseDetails"],
      message: "purchase description and details require isPurchased=true",
    });
  }
  if (!value.isSold && !value.isPurchased) {
    context.addIssue({
      code: "custom",
      path: ["isSold"],
      message: "a safe item must remain usable for sale or purchase",
    });
  }
});

function safeItemPatch(input: z.infer<typeof itemPatchSchema>): SafeItemPatch {
  const salesDetails = itemDetails(input.sales_details);
  const purchaseDetails = itemDetails(input.purchase_details);
  return {
    ...(input.name ? { name: input.name } : {}),
    ...(input.description ? { description: input.description } : {}),
    ...(input.purchase_description ? { purchaseDescription: input.purchase_description } : {}),
    ...(input.is_sold !== undefined ? { isSold: input.is_sold } : {}),
    ...(input.is_purchased !== undefined ? { isPurchased: input.is_purchased } : {}),
    ...(salesDetails ? { salesDetails } : {}),
    ...(purchaseDetails ? { purchaseDetails } : {}),
  };
}

function mergeItemDetails(before: SafeItemDetails | undefined, patch: SafeItemDetails | undefined): SafeItemDetails | undefined {
  if (!patch) return before;
  return { ...before, ...patch };
}

function itemSnapshotTarget(snapshot: SafeItemSnapshot): SafeItemTarget {
  const { itemId: _itemId, updatedAt: _updatedAt, isTrackedAsInventory: _tracked, ...fields } = snapshot;
  return { ...fields, isTrackedAsInventory: false };
}

export function prepareContactCreate(rawInput: unknown, options: ContactPrimitiveOptions): ContactCreatePrimitive {
  const input = contactCreateSchema.parse(rawInput);
  const target = contactTarget(input);
  const externalReference = serverExternalReference(options.namespace, options.externalKey);
  const canonicalPayload = {
    schemaVersion: "xero-contact-safe-v1",
    objectType: "CONTACT",
    operation: "CREATE",
    externalReference,
    target,
  };
  return {
    objectType: "CONTACT",
    operation: "CREATE",
    normalizedBusinessKey: contactBusinessKey(target),
    externalReference,
    target,
    canonicalPayload,
    canonicalPayloadHash: hashObject(canonicalPayload),
    confirmationPhrase: confirmationPhrase("CONTACT", "CREATE", options.confirmationToken),
  };
}

export function prepareContactUpdate(
  rawInput: unknown,
  rawExisting: unknown,
  options: ContactUpdatePrimitiveOptions = {},
): ContactUpdatePrimitive {
  const input = contactUpdateSchema.parse(rawInput);
  const before = safeContactSnapshotSchema.parse(rawExisting) as SafeContactSnapshot;
  assertContactCurrentVersion({
    contactId: input.contact_id,
    expectedUpdatedAt: input.expected_updated_at,
  }, before);
  const patch = contactPatch(input.patch);
  const beforeTarget = snapshotTarget(before);
  const target = mergeContactPatch(beforeTarget, patch);
  const diff = mutationDiff(
    beforeTarget as unknown as Record<string, unknown>,
    target as unknown as Record<string, unknown>,
  );
  if (diff.length === 0) {
    throw new AppError("VALIDATION_FAILED", "The contact update does not change any reviewed field.", { httpStatus: 400 });
  }
  const canonicalPayload = {
    schemaVersion: "xero-contact-safe-v1",
    objectType: "CONTACT",
    operation: "UPDATE",
    contactId: before.contactId,
    expectedUpdatedAt: before.updatedAt,
    ...(before.externalReference ? { externalReference: before.externalReference } : {}),
    contactNumberEvidence: before.contactNumberEvidence,
    before: beforeTarget,
    target,
    diff,
  };
  return {
    objectType: "CONTACT",
    operation: "UPDATE",
    contactId: before.contactId,
    expectedUpdatedAt: before.updatedAt,
    normalizedBusinessKey: contactBusinessKey(target),
    before,
    patch,
    target,
    diff,
    canonicalPayload,
    canonicalPayloadHash: hashObject(canonicalPayload),
    confirmationPhrase: confirmationPhrase("CONTACT", "UPDATE", options.confirmationToken),
  };
}

export function prepareItemCreate(rawInput: unknown, options: ItemPrimitiveOptions = {}): ItemCreatePrimitive {
  const input = itemCreateSchema.parse(rawInput);
  const salesDetails = itemDetails(input.sales_details);
  const purchaseDetails = itemDetails(input.purchase_details);
  const target: SafeItemTarget = {
    code: input.code,
    ...(input.name ? { name: input.name } : {}),
    ...(input.description ? { description: input.description } : {}),
    ...(input.purchase_description ? { purchaseDescription: input.purchase_description } : {}),
    isSold: input.is_sold,
    isPurchased: input.is_purchased,
    isTrackedAsInventory: false,
    ...(salesDetails ? { salesDetails } : {}),
    ...(purchaseDetails ? { purchaseDetails } : {}),
  };
  const canonicalPayload = {
    schemaVersion: "xero-untracked-item-safe-v1",
    objectType: "ITEM",
    operation: "CREATE",
    target,
  };
  return {
    objectType: "ITEM",
    operation: "CREATE",
    normalizedBusinessKey: itemBusinessKey(target.code),
    target,
    canonicalPayload,
    canonicalPayloadHash: hashObject(canonicalPayload),
    confirmationPhrase: confirmationPhrase("ITEM", "CREATE", options.confirmationToken),
  };
}

export function prepareItemUpdate(
  rawInput: unknown,
  rawExisting: unknown,
  options: ItemPrimitiveOptions = {},
): ItemUpdatePrimitive {
  const input = itemUpdateSchema.parse(rawInput);
  const before = safeItemSnapshotSchema.parse(rawExisting) as SafeItemSnapshot;
  assertItemCurrentVersion({ itemId: input.item_id, expectedUpdatedAt: input.expected_updated_at }, before);
  if (before.isTrackedAsInventory) {
    throw new AppError("FORBIDDEN", "Tracked inventory items cannot be updated through the safe item primitive.", {
      httpStatus: 403,
    });
  }
  const patch = safeItemPatch(input.patch);
  if (before.isSold && patch.isSold === false) {
    throw new AppError("FORBIDDEN", "The safe item primitive cannot disable an item that is currently sold.", {
      httpStatus: 403,
    });
  }
  if (before.isPurchased && patch.isPurchased === false) {
    throw new AppError("FORBIDDEN", "The safe item primitive cannot disable an item that is currently purchased.", {
      httpStatus: 403,
    });
  }
  const beforeTarget = itemSnapshotTarget(before);
  const mergedSalesDetails = patch.salesDetails
    ? mergeItemDetails(beforeTarget.salesDetails, patch.salesDetails)
    : undefined;
  const mergedPurchaseDetails = patch.purchaseDetails
    ? mergeItemDetails(beforeTarget.purchaseDetails, patch.purchaseDetails)
    : undefined;
  const target: SafeItemTarget = {
    ...beforeTarget,
    ...(patch.name ? { name: patch.name } : {}),
    ...(patch.description ? { description: patch.description } : {}),
    ...(patch.purchaseDescription ? { purchaseDescription: patch.purchaseDescription } : {}),
    ...(patch.isSold !== undefined ? { isSold: patch.isSold } : {}),
    ...(patch.isPurchased !== undefined ? { isPurchased: patch.isPurchased } : {}),
    isTrackedAsInventory: false,
    ...(mergedSalesDetails ? { salesDetails: mergedSalesDetails } : {}),
    ...(mergedPurchaseDetails ? { purchaseDetails: mergedPurchaseDetails } : {}),
  };
  if (!target.isSold && target.description) {
    throw new AppError("VALIDATION_FAILED", "A sales description requires the item to be enabled for sale.", {
      httpStatus: 400,
    });
  }
  if (!target.isPurchased && target.purchaseDescription) {
    throw new AppError("VALIDATION_FAILED", "A purchase description requires the item to be enabled for purchase.", {
      httpStatus: 400,
    });
  }
  if (!target.isSold && target.salesDetails) {
    throw new AppError("VALIDATION_FAILED", "Sales details require the item to be enabled for sale.", { httpStatus: 400 });
  }
  if (!target.isPurchased && target.purchaseDetails) {
    throw new AppError("VALIDATION_FAILED", "Purchase details require the item to be enabled for purchase.", {
      httpStatus: 400,
    });
  }
  const diff = mutationDiff(
    beforeTarget as unknown as Record<string, unknown>,
    target as unknown as Record<string, unknown>,
  );
  if (diff.length === 0) {
    throw new AppError("VALIDATION_FAILED", "The item update does not change any reviewed field.", { httpStatus: 400 });
  }
  const canonicalPayload = {
    schemaVersion: "xero-untracked-item-safe-v1",
    objectType: "ITEM",
    operation: "UPDATE",
    itemId: before.itemId,
    expectedUpdatedAt: before.updatedAt,
    before: beforeTarget,
    target,
    diff,
  };
  return {
    objectType: "ITEM",
    operation: "UPDATE",
    itemId: before.itemId,
    expectedUpdatedAt: before.updatedAt,
    normalizedBusinessKey: itemBusinessKey(before.code),
    before,
    patch,
    target,
    diff,
    canonicalPayload,
    canonicalPayloadHash: hashObject(canonicalPayload),
    confirmationPhrase: confirmationPhrase("ITEM", "UPDATE", options.confirmationToken),
  };
}

export interface ExpectedItemVersion {
  itemId: string;
  expectedUpdatedAt: string;
}

/**
 * Execution contract: rawCurrent must come from a fresh exact-ID Xero GET performed
 * immediately before the write. Reusing the preparation snapshot is not a concurrency check.
 */
export function verifyItemCurrentVersion(
  expected: ExpectedItemVersion | ItemUpdatePrimitive,
  rawCurrent: unknown,
): CurrentVersionVerification {
  const current = safeItemSnapshotSchema.parse(rawCurrent) as SafeItemSnapshot;
  const mismatches: CurrentVersionVerification["mismatches"] = [];
  if (expected.itemId !== current.itemId) mismatches.push("OBJECT_ID");
  if (expected.expectedUpdatedAt !== current.updatedAt) mismatches.push("UPDATED_AT");
  if ("before" in expected) {
    const { itemId: _expectedId, updatedAt: _expectedUpdatedAt, ...expectedContent } = expected.before;
    const { itemId: _currentId, updatedAt: _currentUpdatedAt, ...currentContent } = current;
    if (hashObject(expectedContent) !== hashObject(currentContent)) mismatches.push("CONTENT");
  }
  return { verified: mismatches.length === 0, mismatches };
}

export function assertItemCurrentVersion(
  expected: ExpectedItemVersion | ItemUpdatePrimitive,
  rawCurrent: unknown,
): SafeItemSnapshot {
  const current = safeItemSnapshotSchema.parse(rawCurrent) as SafeItemSnapshot;
  const verification = verifyItemCurrentVersion(expected, current);
  if (verification.mismatches.includes("OBJECT_ID")) {
    throw new AppError("CONFLICT", "The exact Xero ItemID does not match the pre-read item.", { httpStatus: 409 });
  }
  if (verification.mismatches.includes("UPDATED_AT")) {
    throw new AppError("CONFLICT", "The Xero item changed after it was reviewed; read it again before updating.", {
      httpStatus: 409,
    });
  }
  if (verification.mismatches.includes("CONTENT")) {
    throw new AppError("CONFLICT", "The Xero item content changed after it was reviewed; read it again before updating.", {
      httpStatus: 409,
    });
  }
  return current;
}

export interface ExpectedContactVersion {
  contactId: string;
  expectedUpdatedAt: string;
}

export interface CurrentVersionVerification {
  verified: boolean;
  mismatches: Array<"OBJECT_ID" | "UPDATED_AT" | "CONTENT">;
}

/**
 * Execution contract: rawCurrent must come from a fresh exact-ID Xero GET performed
 * immediately before the write, including ContactNumber preservation evidence.
 */
export function verifyContactCurrentVersion(
  expected: ExpectedContactVersion | ContactUpdatePrimitive,
  rawCurrent: unknown,
): CurrentVersionVerification {
  const current = safeContactSnapshotSchema.parse(rawCurrent) as SafeContactSnapshot;
  const mismatches: CurrentVersionVerification["mismatches"] = [];
  if (expected.contactId !== current.contactId) mismatches.push("OBJECT_ID");
  if (expected.expectedUpdatedAt !== current.updatedAt) mismatches.push("UPDATED_AT");
  if ("before" in expected) {
    const expectedContent = {
      ...snapshotTarget(expected.before),
      ...(expected.before.externalReference ? { externalReference: expected.before.externalReference } : {}),
      contactNumberEvidence: expected.before.contactNumberEvidence,
    };
    const currentContent = {
      ...snapshotTarget(current),
      ...(current.externalReference ? { externalReference: current.externalReference } : {}),
      contactNumberEvidence: current.contactNumberEvidence,
    };
    if (hashObject(expectedContent) !== hashObject(currentContent)) mismatches.push("CONTENT");
  }
  return { verified: mismatches.length === 0, mismatches };
}

export function assertContactCurrentVersion(
  expected: ExpectedContactVersion | ContactUpdatePrimitive,
  rawCurrent: unknown,
): SafeContactSnapshot {
  const current = safeContactSnapshotSchema.parse(rawCurrent) as SafeContactSnapshot;
  const verification = verifyContactCurrentVersion(expected, current);
  if (verification.mismatches.includes("OBJECT_ID")) {
    throw new AppError("CONFLICT", "The exact Xero ContactID does not match the pre-read contact.", { httpStatus: 409 });
  }
  if (verification.mismatches.includes("UPDATED_AT")) {
    throw new AppError("CONFLICT", "The Xero contact changed after it was reviewed; read it again before updating.", {
      httpStatus: 409,
    });
  }
  if (verification.mismatches.includes("CONTENT")) {
    throw new AppError("CONFLICT", "The Xero contact content changed after it was reviewed; read it again before updating.", {
      httpStatus: 409,
    });
  }
  return current;
}
