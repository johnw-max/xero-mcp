import { z } from "zod/v4";
import { AppError } from "../errors.js";
import { hashObject } from "../security/hash.js";
import {
  safeContactSnapshotSchema,
  safeContactTargetSchema,
  safeItemSnapshotSchema,
  safeItemTargetSchema,
  type ContactCreatePrimitive,
  type ContactUpdatePrimitive,
  type ItemCreatePrimitive,
  type ItemUpdatePrimitive,
  type NormalizedBusinessKey,
  type SafeContactAddress,
  type SafeContactPatch,
  type SafeContactPhone,
  type SafeContactSnapshot,
  type SafeContactTarget,
  type SafeItemDetails,
  type SafeItemPatch,
  type SafeItemSnapshot,
  type SafeItemTarget,
  type SafeMutationDiff,
} from "./xeroContactItemPrimitives.js";

const diffSchema = z.array(z.object({
  path: z.string().min(1).max(64),
  before: z.unknown(),
  after: z.unknown(),
}).strict()).min(1).max(32);

const contactNumberEvidenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ABSENT") }).strict(),
  z.object({ kind: z.literal("OWNED_NAMESPACE") }).strict(),
  z.object({ kind: z.literal("EXTERNAL_FINGERPRINT"), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
]);

const contactCreateCanonicalSchema = z.object({
  schemaVersion: z.literal("xero-contact-safe-v1"),
  objectType: z.literal("CONTACT"),
  operation: z.literal("CREATE"),
  externalReference: z.string().regex(/^ZC:[a-z][a-z0-9_-]{1,11}:[a-f0-9]{32}$/),
  target: safeContactTargetSchema,
}).strict();

const contactUpdateCanonicalSchema = z.object({
  schemaVersion: z.literal("xero-contact-safe-v1"),
  objectType: z.literal("CONTACT"),
  operation: z.literal("UPDATE"),
  contactId: z.string().uuid(),
  expectedUpdatedAt: z.string().datetime({ offset: true }),
  externalReference: z.string().regex(/^ZC:[a-z][a-z0-9_-]{1,11}:[a-f0-9]{32}$/).optional(),
  contactNumberEvidence: contactNumberEvidenceSchema,
  before: safeContactTargetSchema,
  target: safeContactTargetSchema,
  diff: diffSchema,
}).strict();

const itemCreateCanonicalSchema = z.object({
  schemaVersion: z.literal("xero-untracked-item-safe-v1"),
  objectType: z.literal("ITEM"),
  operation: z.literal("CREATE"),
  target: safeItemTargetSchema,
}).strict();

const itemUpdateCanonicalSchema = z.object({
  schemaVersion: z.literal("xero-untracked-item-safe-v1"),
  objectType: z.literal("ITEM"),
  operation: z.literal("UPDATE"),
  itemId: z.string().uuid(),
  expectedUpdatedAt: z.string().datetime({ offset: true }),
  before: safeItemTargetSchema,
  target: safeItemTargetSchema,
  diff: diffSchema,
}).strict();

function normalized(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, "").toLowerCase();
}

function contactBusinessKey(target: z.infer<typeof safeContactTargetSchema>): NormalizedBusinessKey {
  if (target.companyNumber) return { kind: "COMPANY_NUMBER", value: normalized(target.companyNumber) };
  if (target.email) return { kind: "EMAIL", value: target.email.toLowerCase() };
  if (target.accountNumber) return { kind: "ACCOUNT_NUMBER", value: normalized(target.accountNumber) };
  return { kind: "NAME", value: target.name.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase() };
}

function itemBusinessKey(code: string): NormalizedBusinessKey {
  return { kind: "ITEM_CODE", value: code.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase() };
}

function parseOrFail<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new AppError("VALIDATION_FAILED", "The persisted Xero mutation payload is invalid.", { httpStatus: 409 });
  }
  return parsed.data;
}

function paths(diff: readonly SafeMutationDiff[]): Set<string> {
  return new Set(diff.map((entry) => entry.path));
}

type ParsedContactTarget = z.infer<typeof safeContactTargetSchema>;
type ParsedContactPhone = NonNullable<ParsedContactTarget["phones"]>[number];
type ParsedContactAddress = NonNullable<ParsedContactTarget["addresses"]>[number];

function contactPhone(input: ParsedContactPhone): SafeContactPhone {
  return {
    phoneType: input.phoneType,
    phoneNumber: input.phoneNumber,
    ...(input.areaCode !== undefined ? { areaCode: input.areaCode } : {}),
    ...(input.countryCode !== undefined ? { countryCode: input.countryCode } : {}),
  };
}

function contactAddress(input: ParsedContactAddress): SafeContactAddress {
  return {
    addressType: input.addressType,
    ...(input.line1 !== undefined ? { line1: input.line1 } : {}),
    ...(input.line2 !== undefined ? { line2: input.line2 } : {}),
    ...(input.line3 !== undefined ? { line3: input.line3 } : {}),
    ...(input.line4 !== undefined ? { line4: input.line4 } : {}),
    ...(input.city !== undefined ? { city: input.city } : {}),
    ...(input.region !== undefined ? { region: input.region } : {}),
    ...(input.postalCode !== undefined ? { postalCode: input.postalCode } : {}),
    ...(input.country !== undefined ? { country: input.country } : {}),
    ...(input.attentionTo !== undefined ? { attentionTo: input.attentionTo } : {}),
  };
}

function contactTarget(input: z.infer<typeof safeContactTargetSchema>): SafeContactTarget {
  return {
    name: input.name,
    ...(input.firstName !== undefined ? { firstName: input.firstName } : {}),
    ...(input.lastName !== undefined ? { lastName: input.lastName } : {}),
    ...(input.email !== undefined ? { email: input.email } : {}),
    ...(input.companyNumber !== undefined ? { companyNumber: input.companyNumber } : {}),
    ...(input.accountNumber !== undefined ? { accountNumber: input.accountNumber } : {}),
    ...(input.phones !== undefined ? { phones: input.phones.map(contactPhone) } : {}),
    ...(input.addresses !== undefined ? { addresses: input.addresses.map(contactAddress) } : {}),
  };
}

function itemDetails(input: z.infer<typeof safeItemTargetSchema>["salesDetails"]): SafeItemDetails | undefined {
  if (input === undefined) return undefined;
  return {
    ...(input.unitPrice !== undefined ? { unitPrice: input.unitPrice } : {}),
    ...(input.accountCode !== undefined ? { accountCode: input.accountCode } : {}),
    ...(input.taxType !== undefined ? { taxType: input.taxType } : {}),
  };
}

function itemTarget(input: z.infer<typeof safeItemTargetSchema>): SafeItemTarget {
  const salesDetails = itemDetails(input.salesDetails);
  const purchaseDetails = itemDetails(input.purchaseDetails);
  return {
    code: input.code,
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.purchaseDescription !== undefined ? { purchaseDescription: input.purchaseDescription } : {}),
    isSold: input.isSold,
    isPurchased: input.isPurchased,
    isTrackedAsInventory: false,
    ...(salesDetails !== undefined ? { salesDetails } : {}),
    ...(purchaseDetails !== undefined ? { purchaseDetails } : {}),
  };
}

function mutationDiff(input: z.infer<typeof diffSchema>): SafeMutationDiff[] {
  return input.map((entry) => ({ path: entry.path, before: entry.before, after: entry.after }));
}

export function parseCanonicalContactCreatePrimitive(input: unknown): ContactCreatePrimitive {
  const canonicalPayload = parseOrFail(contactCreateCanonicalSchema, input);
  const target = contactTarget(canonicalPayload.target);
  return {
    objectType: "CONTACT",
    operation: "CREATE",
    normalizedBusinessKey: contactBusinessKey(target),
    externalReference: canonicalPayload.externalReference,
    target,
    canonicalPayload,
    canonicalPayloadHash: hashObject(canonicalPayload),
    confirmationPhrase: "CONFIRM-CONTACT-CREATE-0000000000000000",
  };
}

export function parseCanonicalContactUpdatePrimitive(input: unknown): ContactUpdatePrimitive {
  const canonicalPayload = parseOrFail(contactUpdateCanonicalSchema, input);
  const diff = mutationDiff(canonicalPayload.diff);
  const target = contactTarget(canonicalPayload.target);
  const changed = paths(diff);
  const patch: SafeContactPatch = {
    ...(changed.has("name") ? { name: target.name } : {}),
    ...(changed.has("firstName") && target.firstName !== undefined ? { firstName: target.firstName } : {}),
    ...(changed.has("lastName") && target.lastName !== undefined ? { lastName: target.lastName } : {}),
    ...(changed.has("email") && target.email !== undefined ? { email: target.email } : {}),
    ...(changed.has("companyNumber") && target.companyNumber !== undefined
      ? { companyNumber: target.companyNumber } : {}),
    ...(changed.has("accountNumber") && target.accountNumber !== undefined
      ? { accountNumber: target.accountNumber } : {}),
    ...(changed.has("phones") ? { phones: target.phones ?? [] } : {}),
    ...(changed.has("addresses") ? { addresses: target.addresses ?? [] } : {}),
  };
  const parsedBefore = parseOrFail(safeContactSnapshotSchema, {
    ...canonicalPayload.before,
    contactId: canonicalPayload.contactId,
    ...(canonicalPayload.externalReference ? { externalReference: canonicalPayload.externalReference } : {}),
    contactNumberEvidence: canonicalPayload.contactNumberEvidence,
    updatedAt: canonicalPayload.expectedUpdatedAt,
  });
  const before: SafeContactSnapshot = {
    ...contactTarget(parsedBefore),
    contactId: parsedBefore.contactId,
    ...(parsedBefore.externalReference !== undefined ? { externalReference: parsedBefore.externalReference } : {}),
    contactNumberEvidence: parsedBefore.contactNumberEvidence,
    updatedAt: parsedBefore.updatedAt,
  };
  return {
    objectType: "CONTACT",
    operation: "UPDATE",
    contactId: canonicalPayload.contactId,
    expectedUpdatedAt: canonicalPayload.expectedUpdatedAt,
    normalizedBusinessKey: contactBusinessKey(target),
    before,
    patch,
    target,
    diff,
    canonicalPayload,
    canonicalPayloadHash: hashObject(canonicalPayload),
    confirmationPhrase: "CONFIRM-CONTACT-UPDATE-0000000000000000",
  };
}

export function parseCanonicalItemCreatePrimitive(input: unknown): ItemCreatePrimitive {
  const canonicalPayload = parseOrFail(itemCreateCanonicalSchema, input);
  const target = itemTarget(canonicalPayload.target);
  return {
    objectType: "ITEM",
    operation: "CREATE",
    normalizedBusinessKey: itemBusinessKey(target.code),
    target,
    canonicalPayload,
    canonicalPayloadHash: hashObject(canonicalPayload),
    confirmationPhrase: "CONFIRM-ITEM-CREATE-0000000000000000",
  };
}

export function parseCanonicalItemUpdatePrimitive(input: unknown): ItemUpdatePrimitive {
  const canonicalPayload = parseOrFail(itemUpdateCanonicalSchema, input);
  const diff = mutationDiff(canonicalPayload.diff);
  const target = itemTarget(canonicalPayload.target);
  const changed = paths(diff);
  const patch: SafeItemPatch = {
    ...(changed.has("name") && target.name !== undefined ? { name: target.name } : {}),
    ...(changed.has("description") && target.description !== undefined
      ? { description: target.description } : {}),
    ...(changed.has("purchaseDescription") && target.purchaseDescription !== undefined
      ? { purchaseDescription: target.purchaseDescription } : {}),
    ...(changed.has("isSold") ? { isSold: target.isSold } : {}),
    ...(changed.has("isPurchased") ? { isPurchased: target.isPurchased } : {}),
  };
  const parsedBefore = parseOrFail(safeItemSnapshotSchema, {
    ...canonicalPayload.before,
    itemId: canonicalPayload.itemId,
    updatedAt: canonicalPayload.expectedUpdatedAt,
  });
  const beforeTarget = itemTarget({ ...parsedBefore, isTrackedAsInventory: false });
  const before: SafeItemSnapshot = {
    ...beforeTarget,
    itemId: parsedBefore.itemId,
    isTrackedAsInventory: parsedBefore.isTrackedAsInventory,
    updatedAt: parsedBefore.updatedAt,
  };
  return {
    objectType: "ITEM",
    operation: "UPDATE",
    itemId: canonicalPayload.itemId,
    expectedUpdatedAt: canonicalPayload.expectedUpdatedAt,
    normalizedBusinessKey: itemBusinessKey(target.code),
    before,
    patch,
    target,
    diff,
    canonicalPayload,
    canonicalPayloadHash: hashObject(canonicalPayload),
    confirmationPhrase: "CONFIRM-ITEM-UPDATE-0000000000000000",
  };
}
