import { z } from "zod/v4";
import type {
  ContactCreatePrimitive,
  ContactNumberPreservationEvidence,
  ContactUpdatePrimitive,
  ItemCreatePrimitive,
  ItemUpdatePrimitive,
  SafeContactAddress,
  SafeContactPhone,
  SafeContactSnapshot,
  SafeContactTarget,
  SafeItemDetails,
  SafeItemSnapshot,
  SafeItemTarget,
} from "../domain/xeroContactItemPrimitives.js";
import {
  safeContactSnapshotSchema,
  safeItemSnapshotSchema,
} from "../domain/xeroContactItemPrimitives.js";
import { sha256, stableStringify } from "../security/hash.js";

type ProviderObject = Record<string, unknown>;

export interface XeroSafePhonePayload {
  phoneType: SafeContactPhone["phoneType"];
  phoneNumber: string;
  phoneAreaCode?: string;
  phoneCountryCode?: string;
}

export interface XeroSafeAddressPayload {
  addressType: SafeContactAddress["addressType"];
  addressLine1?: string;
  addressLine2?: string;
  addressLine3?: string;
  addressLine4?: string;
  city?: string;
  region?: string;
  postalCode?: string;
  country?: string;
  attentionTo?: string;
}

export interface XeroSafeContactPayload {
  contactID?: string;
  contactNumber?: string;
  name?: string;
  firstName?: string;
  lastName?: string;
  emailAddress?: string;
  companyNumber?: string;
  accountNumber?: string;
  phones?: XeroSafePhonePayload[];
  addresses?: XeroSafeAddressPayload[];
}

export interface ContactReadbackOptions {
  /** The caller must supply an exact, full Contact GET; an omitted ContactNumber is treated as confirmed absent. */
  namespace: string;
}

export interface ContactCreateReadbackOptions extends ContactReadbackOptions {
  /** Exact ContactID returned by the create call and used for the subsequent full GET. */
  expectedCreatedId: string;
}

export interface ItemCreateReadbackOptions {
  /** Exact ItemID returned by the create call and used for the subsequent exact-ID GET. */
  expectedCreatedId: string;
}

export interface XeroSafeItemDetailsPayload {
  unitPrice?: number;
  accountCode?: string;
  taxType?: string;
}

export interface XeroSafeItemPayload {
  itemID?: string;
  code: string;
  name?: string;
  description?: string;
  purchaseDescription?: string;
  isSold?: boolean;
  isPurchased?: boolean;
  isTrackedAsInventory?: false;
  salesDetails?: XeroSafeItemDetailsPayload;
  purchaseDetails?: XeroSafeItemDetailsPayload;
}

export interface PrimitiveVerification<T> {
  verified: boolean;
  snapshot?: T;
  mismatches: string[];
}

function providerObject(value: unknown): ProviderObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as ProviderObject
    : undefined;
}

function boundedString(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const compact = value.trim().replace(/\s+/gu, " ");
  return compact.length > 0 && compact.length <= maximum ? compact : undefined;
}

function providerTimestamp(value: ProviderObject): string | undefined {
  const candidate = value.updatedDateUTC ?? value.updatedDateUTCString;
  if (candidate instanceof Date && Number.isFinite(candidate.getTime())) return candidate.toISOString();
  if (typeof candidate !== "string" || candidate.length === 0) return undefined;
  const dotNet = /^\/Date\((-?\d+)/.exec(candidate)?.[1];
  const parsed = new Date(dotNet ? Number(dotNet) : candidate);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : undefined;
}

function normalizedNamespace(namespace: string): string | undefined {
  return /^[a-z][a-z0-9_-]{1,11}$/.test(namespace) ? namespace : undefined;
}

function safeExternalReference(value: unknown, namespace: string): string | undefined {
  const parsedNamespace = normalizedNamespace(namespace);
  if (!parsedNamespace || typeof value !== "string") return undefined;
  return new RegExp(`^ZC:${parsedNamespace}:[a-f0-9]{32}$`).test(value) ? value : undefined;
}

function safeContactNumberProjection(value: unknown, namespace: string): {
  externalReference?: string;
  evidence: ContactNumberPreservationEvidence;
} | undefined {
  if (value === undefined || value === null || value === "") {
    return { evidence: { kind: "ABSENT" } };
  }
  if (
    typeof value !== "string" ||
    value.length > 255 ||
    value.trim().length === 0 ||
    /[\u0000-\u001F\u007F]/u.test(value)
  ) {
    return undefined;
  }
  const externalReference = safeExternalReference(value, namespace);
  if (externalReference) {
    return {
      externalReference,
      evidence: { kind: "OWNED_NAMESPACE" },
    };
  }
  return {
    evidence: {
      kind: "EXTERNAL_FINGERPRINT",
      fingerprint: sha256(`xero-contact-number-preservation:v1:${value}`),
    },
  };
}

function toProviderPhone(phone: SafeContactPhone): XeroSafePhonePayload {
  return {
    phoneType: phone.phoneType,
    phoneNumber: phone.phoneNumber,
    ...(phone.areaCode ? { phoneAreaCode: phone.areaCode } : {}),
    ...(phone.countryCode ? { phoneCountryCode: phone.countryCode } : {}),
  };
}

function toProviderAddress(address: SafeContactAddress): XeroSafeAddressPayload {
  return {
    addressType: address.addressType,
    ...(address.line1 ? { addressLine1: address.line1 } : {}),
    ...(address.line2 ? { addressLine2: address.line2 } : {}),
    ...(address.line3 ? { addressLine3: address.line3 } : {}),
    ...(address.line4 ? { addressLine4: address.line4 } : {}),
    ...(address.city ? { city: address.city } : {}),
    ...(address.region ? { region: address.region } : {}),
    ...(address.postalCode ? { postalCode: address.postalCode } : {}),
    ...(address.country ? { country: address.country } : {}),
    ...(address.attentionTo ? { attentionTo: address.attentionTo } : {}),
  };
}

function toProviderContactTarget(target: SafeContactTarget): XeroSafeContactPayload {
  return {
    name: target.name,
    ...(target.firstName ? { firstName: target.firstName } : {}),
    ...(target.lastName ? { lastName: target.lastName } : {}),
    ...(target.email ? { emailAddress: target.email } : {}),
    ...(target.companyNumber ? { companyNumber: target.companyNumber } : {}),
    ...(target.accountNumber ? { accountNumber: target.accountNumber } : {}),
    ...(target.phones ? { phones: target.phones.map(toProviderPhone) } : {}),
    ...(target.addresses ? { addresses: target.addresses.map(toProviderAddress) } : {}),
  };
}

export function mapContactCreateToXero(prepared: ContactCreatePrimitive): XeroSafeContactPayload {
  return {
    ...toProviderContactTarget(prepared.target),
    contactNumber: prepared.externalReference,
  };
}

export function mapContactUpdateToXero(prepared: ContactUpdatePrimitive): XeroSafeContactPayload {
  const patch = prepared.patch;
  return {
    contactID: prepared.contactId,
    ...(patch.name ? { name: patch.name } : {}),
    ...(patch.firstName ? { firstName: patch.firstName } : {}),
    ...(patch.lastName ? { lastName: patch.lastName } : {}),
    ...(patch.email ? { emailAddress: patch.email } : {}),
    ...(patch.companyNumber ? { companyNumber: patch.companyNumber } : {}),
    ...(patch.accountNumber ? { accountNumber: patch.accountNumber } : {}),
    ...(patch.phones !== undefined ? { phones: (prepared.target.phones ?? []).map(toProviderPhone) } : {}),
    ...(patch.addresses !== undefined ? { addresses: (prepared.target.addresses ?? []).map(toProviderAddress) } : {}),
  };
}

function safePhone(value: unknown): SafeContactPhone | undefined {
  const phone = providerObject(value);
  const phoneType = boundedString(phone?.phoneType, 16);
  const phoneNumber = boundedString(phone?.phoneNumber, 50);
  if (!phone || !phoneNumber || !phoneType || !["DEFAULT", "DDI", "MOBILE", "FAX", "OFFICE"].includes(phoneType)) {
    return undefined;
  }
  const areaCode = boundedString(phone.phoneAreaCode, 10);
  const countryCode = boundedString(phone.phoneCountryCode, 20);
  return {
    phoneType: phoneType as SafeContactPhone["phoneType"],
    phoneNumber,
    ...(areaCode ? { areaCode } : {}),
    ...(countryCode ? { countryCode } : {}),
  };
}

function safeAddress(value: unknown): SafeContactAddress | undefined {
  const address = providerObject(value);
  const addressType = boundedString(address?.addressType, 16);
  if (!address || !addressType || !["POBOX", "STREET"].includes(addressType)) return undefined;
  const line1 = boundedString(address.addressLine1, 500);
  const line2 = boundedString(address.addressLine2, 500);
  const line3 = boundedString(address.addressLine3, 500);
  const line4 = boundedString(address.addressLine4, 500);
  const city = boundedString(address.city, 255);
  const region = boundedString(address.region, 255);
  const postalCode = boundedString(address.postalCode, 50);
  const country = boundedString(address.country, 50);
  const attentionTo = boundedString(address.attentionTo, 255);
  return {
    addressType: addressType as SafeContactAddress["addressType"],
    ...(line1 ? { line1 } : {}),
    ...(line2 ? { line2 } : {}),
    ...(line3 ? { line3 } : {}),
    ...(line4 ? { line4 } : {}),
    ...(city ? { city } : {}),
    ...(region ? { region } : {}),
    ...(postalCode ? { postalCode } : {}),
    ...(country ? { country } : {}),
    ...(attentionTo ? { attentionTo } : {}),
  };
}

function strictMappedArray<T>(
  input: unknown,
  mapper: (value: unknown) => T | undefined,
): { valid: boolean; values?: T[] } {
  if (input === undefined) return { valid: true };
  if (!Array.isArray(input)) return { valid: false };
  const values: T[] = [];
  for (const entry of input) {
    const mapped = mapper(entry);
    if (!mapped) return { valid: false };
    values.push(mapped);
  }
  return { valid: true, ...(values.length > 0 ? { values } : {}) };
}

function sortedContactTarget(target: SafeContactTarget): SafeContactTarget {
  return {
    ...target,
    ...(target.phones ? {
      phones: [...target.phones].sort((left, right) => `${left.phoneType}:${left.phoneNumber}`.localeCompare(`${right.phoneType}:${right.phoneNumber}`)),
    } : {}),
    ...(target.addresses ? {
      addresses: [...target.addresses].sort((left, right) => left.addressType.localeCompare(right.addressType)),
    } : {}),
  };
}

export function mapSafeContactReadback(raw: unknown, options: ContactReadbackOptions): SafeContactSnapshot | undefined {
  const contact = providerObject(raw);
  const contactId = boundedString(contact?.contactID, 128);
  const name = boundedString(contact?.name, 255);
  const updatedAt = contact ? providerTimestamp(contact) : undefined;
  if (!contact || !contactId || !z.string().uuid().safeParse(contactId).success || !name || !updatedAt) return undefined;
  const firstName = boundedString(contact.firstName, 255);
  const lastName = boundedString(contact.lastName, 255);
  const emailValue = boundedString(contact.emailAddress, 255)?.toLowerCase();
  const companyNumber = boundedString(contact.companyNumber, 50);
  const accountNumber = boundedString(contact.accountNumber, 50);
  const contactNumber = safeContactNumberProjection(contact.contactNumber, options.namespace);
  const phones = strictMappedArray(contact.phones, safePhone);
  const addresses = strictMappedArray(contact.addresses, safeAddress);
  if (!contactNumber || !phones.valid || !addresses.valid) return undefined;
  const candidate = {
    contactId,
    ...sortedContactTarget({
      name,
      ...(firstName ? { firstName } : {}),
      ...(lastName ? { lastName } : {}),
      ...(emailValue ? { email: emailValue } : {}),
      ...(companyNumber ? { companyNumber } : {}),
      ...(accountNumber ? { accountNumber } : {}),
      ...(phones.values ? { phones: phones.values } : {}),
      ...(addresses.values ? { addresses: addresses.values } : {}),
    }),
    ...(contactNumber.externalReference ? { externalReference: contactNumber.externalReference } : {}),
    contactNumberEvidence: contactNumber.evidence,
    updatedAt,
  };
  const parsed = safeContactSnapshotSchema.safeParse(candidate);
  return parsed.success ? parsed.data as SafeContactSnapshot : undefined;
}

function targetFromSnapshot(snapshot: SafeContactSnapshot): SafeContactTarget {
  const {
    contactId: _contactId,
    externalReference: _externalReference,
    contactNumberEvidence: _contactNumberEvidence,
    updatedAt: _updatedAt,
    ...target
  } = snapshot;
  return sortedContactTarget(target);
}

export function verifyContactReadback(
  prepared: ContactCreatePrimitive,
  raw: unknown,
  options: ContactCreateReadbackOptions,
): PrimitiveVerification<SafeContactSnapshot>;
export function verifyContactReadback(
  prepared: ContactUpdatePrimitive,
  raw: unknown,
  options: ContactReadbackOptions,
): PrimitiveVerification<SafeContactSnapshot>;
export function verifyContactReadback(
  prepared: ContactCreatePrimitive | ContactUpdatePrimitive,
  raw: unknown,
  options: ContactReadbackOptions | ContactCreateReadbackOptions,
): PrimitiveVerification<SafeContactSnapshot> {
  const snapshot = mapSafeContactReadback(raw, options);
  if (!snapshot) return { verified: false, mismatches: ["readback.invalid"] };
  const mismatches: string[] = [];
  if (prepared.operation === "CREATE") {
    const expectedCreatedId = "expectedCreatedId" in options
      ? boundedString(options.expectedCreatedId, 128)
      : undefined;
    if (!expectedCreatedId || !z.string().uuid().safeParse(expectedCreatedId).success) {
      mismatches.push("expectedCreatedId");
    } else if (snapshot.contactId !== expectedCreatedId) {
      mismatches.push("contactId");
    }
    if (snapshot.externalReference !== prepared.externalReference) mismatches.push("externalReference");
  }
  if (prepared.operation === "UPDATE" && snapshot.contactId !== prepared.contactId) mismatches.push("contactId");
  if (
    prepared.operation === "UPDATE" &&
    prepared.before.externalReference &&
    snapshot.externalReference !== prepared.before.externalReference
  ) {
    mismatches.push("externalReference");
  }
  if (
    prepared.operation === "UPDATE" &&
    stableStringify(snapshot.contactNumberEvidence) !== stableStringify(prepared.before.contactNumberEvidence)
  ) {
    mismatches.push("contactNumber");
  }
  if (stableStringify(targetFromSnapshot(snapshot)) !== stableStringify(sortedContactTarget(prepared.target))) {
    mismatches.push("target");
  }
  return { verified: mismatches.length === 0, snapshot, mismatches };
}

function toProviderItemDetails(details: SafeItemDetails): XeroSafeItemDetailsPayload {
  return {
    ...(details.unitPrice !== undefined ? { unitPrice: Number(details.unitPrice) } : {}),
    ...(details.accountCode ? { accountCode: details.accountCode } : {}),
    ...(details.taxType ? { taxType: details.taxType } : {}),
  };
}

function toProviderItemTarget(target: SafeItemTarget): XeroSafeItemPayload {
  return {
    code: target.code,
    ...(target.name ? { name: target.name } : {}),
    ...(target.description ? { description: target.description } : {}),
    ...(target.purchaseDescription ? { purchaseDescription: target.purchaseDescription } : {}),
    isSold: target.isSold,
    isPurchased: target.isPurchased,
    isTrackedAsInventory: false,
    ...(target.salesDetails ? { salesDetails: toProviderItemDetails(target.salesDetails) } : {}),
    ...(target.purchaseDetails ? { purchaseDetails: toProviderItemDetails(target.purchaseDetails) } : {}),
  };
}

export function mapItemCreateToXero(prepared: ItemCreatePrimitive): XeroSafeItemPayload {
  return toProviderItemTarget(prepared.target);
}

export function mapItemUpdateToXero(prepared: ItemUpdatePrimitive): XeroSafeItemPayload {
  const patch = prepared.patch;
  return {
    itemID: prepared.itemId,
    code: prepared.before.code,
    isTrackedAsInventory: false,
    ...(patch.name ? { name: patch.name } : {}),
    ...(patch.description ? { description: patch.description } : {}),
    ...(patch.purchaseDescription ? { purchaseDescription: patch.purchaseDescription } : {}),
    ...(patch.isSold !== undefined ? { isSold: patch.isSold } : {}),
    ...(patch.isPurchased !== undefined ? { isPurchased: patch.isPurchased } : {}),
    ...(patch.salesDetails ? {
      salesDetails: toProviderItemDetails(prepared.target.salesDetails ?? patch.salesDetails),
    } : {}),
    ...(patch.purchaseDetails ? {
      purchaseDetails: toProviderItemDetails(prepared.target.purchaseDetails ?? patch.purchaseDetails),
    } : {}),
  };
}

function safeDecimal(value: unknown): string | undefined {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim().length > 0
      ? Number(value)
      : Number.NaN;
  return Number.isFinite(parsed) ? parsed.toFixed(4) : undefined;
}

function safeItemDetails(value: unknown): SafeItemDetails | undefined {
  const details = providerObject(value);
  if (!details) return undefined;
  const unitPrice = safeDecimal(details.unitPrice);
  const accountCode = boundedString(details.accountCode, 10);
  const taxType = boundedString(details.taxType, 100);
  if (unitPrice === undefined && !accountCode && !taxType) return undefined;
  return {
    ...(unitPrice !== undefined ? { unitPrice } : {}),
    ...(accountCode ? { accountCode } : {}),
    ...(taxType ? { taxType } : {}),
  };
}

export function mapSafeItemReadback(raw: unknown): SafeItemSnapshot | undefined {
  const item = providerObject(raw);
  const itemId = boundedString(item?.itemID, 128);
  const code = boundedString(item?.code, 30);
  const updatedAt = item ? providerTimestamp(item) : undefined;
  if (
    !item ||
    !itemId ||
    !z.string().uuid().safeParse(itemId).success ||
    !code ||
    !updatedAt ||
    typeof item.isSold !== "boolean" ||
    typeof item.isPurchased !== "boolean" ||
    typeof item.isTrackedAsInventory !== "boolean"
  ) {
    return undefined;
  }
  const name = boundedString(item.name, 50);
  const description = boundedString(item.description, 4_000);
  const purchaseDescription = boundedString(item.purchaseDescription, 4_000);
  const salesDetails = safeItemDetails(item.salesDetails);
  const purchaseDetails = safeItemDetails(item.purchaseDetails);
  const candidate = {
    itemId,
    code,
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
    ...(purchaseDescription ? { purchaseDescription } : {}),
    isSold: item.isSold,
    isPurchased: item.isPurchased,
    isTrackedAsInventory: item.isTrackedAsInventory,
    ...(salesDetails ? { salesDetails } : {}),
    ...(purchaseDetails ? { purchaseDetails } : {}),
    updatedAt,
  };
  const parsed = safeItemSnapshotSchema.safeParse(candidate);
  return parsed.success ? parsed.data as SafeItemSnapshot : undefined;
}

function targetFromItemSnapshot(snapshot: SafeItemSnapshot): Record<string, unknown> {
  const { itemId: _itemId, updatedAt: _updatedAt, ...target } = snapshot;
  return target as unknown as Record<string, unknown>;
}

export function verifyItemReadback(
  prepared: ItemCreatePrimitive,
  raw: unknown,
  options: ItemCreateReadbackOptions,
): PrimitiveVerification<SafeItemSnapshot>;
export function verifyItemReadback(
  prepared: ItemUpdatePrimitive,
  raw: unknown,
): PrimitiveVerification<SafeItemSnapshot>;
export function verifyItemReadback(
  prepared: ItemCreatePrimitive | ItemUpdatePrimitive,
  raw: unknown,
  options?: ItemCreateReadbackOptions,
): PrimitiveVerification<SafeItemSnapshot> {
  const snapshot = mapSafeItemReadback(raw);
  if (!snapshot) return { verified: false, mismatches: ["readback.invalid"] };
  const mismatches: string[] = [];
  if (prepared.operation === "CREATE") {
    const expectedCreatedId = boundedString(options?.expectedCreatedId, 128);
    if (!expectedCreatedId || !z.string().uuid().safeParse(expectedCreatedId).success) {
      mismatches.push("expectedCreatedId");
    } else if (snapshot.itemId !== expectedCreatedId) {
      mismatches.push("itemId");
    }
  }
  if (prepared.operation === "UPDATE" && snapshot.itemId !== prepared.itemId) mismatches.push("itemId");
  if (stableStringify(targetFromItemSnapshot(snapshot)) !== stableStringify(prepared.target)) mismatches.push("target");
  return { verified: mismatches.length === 0, snapshot, mismatches };
}
