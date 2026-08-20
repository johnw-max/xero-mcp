import { AppError } from "../errors.js";
import { classifyXeroWriteException } from "./xeroWriteOutcome.js";
import type {
  ContactCreatePrimitive,
  ContactUpdatePrimitive,
  ItemCreatePrimitive,
  ItemUpdatePrimitive,
  NormalizedBusinessKey,
  SafeContactSnapshot,
  SafeItemSnapshot,
} from "../domain/xeroContactItemPrimitives.js";
import {
  mapContactCreateToXero,
  mapContactUpdateToXero,
  mapItemCreateToXero,
  mapItemUpdateToXero,
  mapSafeContactReadback,
  mapSafeItemReadback,
  verifyContactReadback,
  verifyItemReadback,
} from "./xeroContactItemMapper.js";
import type { AccountingPrincipal } from "./types.js";
import type { XeroClientManager } from "./xeroClientManager.js";
import type { LedgerProviderWritePermit } from "../control-kernel/ledgerProviderWritePermit.js";

export interface ContactItemWriteReceipt {
  objectId: string;
  receipt: Record<string, unknown>;
}

export interface ContactItemReadbackVerification<T> {
  verified: boolean;
  snapshot?: T;
  mismatches: string[];
}

export interface ContactItemMutationProvider {
  contactDuplicateExists(
    principal: AccountingPrincipal,
    externalReference: string | undefined,
    businessKeys: readonly NormalizedBusinessKey[],
    excludeContactId?: string,
  ): Promise<boolean>;
  itemCodeExists(principal: AccountingPrincipal, code: string): Promise<boolean>;
  getContactExact(principal: AccountingPrincipal, contactId: string): Promise<SafeContactSnapshot | undefined>;
  getItemExact(principal: AccountingPrincipal, itemId: string): Promise<SafeItemSnapshot | undefined>;
  createContact(
    principal: AccountingPrincipal,
    prepared: ContactCreatePrimitive,
    idempotencyKey: string,
    providerWritePermit?: LedgerProviderWritePermit,
  ): Promise<ContactItemWriteReceipt>;
  updateContact(
    principal: AccountingPrincipal,
    prepared: ContactUpdatePrimitive,
    idempotencyKey: string,
    providerWritePermit?: LedgerProviderWritePermit,
  ): Promise<ContactItemWriteReceipt>;
  createItem(
    principal: AccountingPrincipal,
    prepared: ItemCreatePrimitive,
    idempotencyKey: string,
    providerWritePermit?: LedgerProviderWritePermit,
  ): Promise<ContactItemWriteReceipt>;
  updateItem(
    principal: AccountingPrincipal,
    prepared: ItemUpdatePrimitive,
    idempotencyKey: string,
    providerWritePermit?: LedgerProviderWritePermit,
  ): Promise<ContactItemWriteReceipt>;
  readAndVerifyContact(
    principal: AccountingPrincipal,
    objectId: string,
    prepared: ContactCreatePrimitive | ContactUpdatePrimitive,
  ): Promise<ContactItemReadbackVerification<SafeContactSnapshot>>;
  readAndVerifyItem(
    principal: AccountingPrincipal,
    objectId: string,
    prepared: ItemCreatePrimitive | ItemUpdatePrimitive,
  ): Promise<ContactItemReadbackVerification<SafeItemSnapshot>>;
}

type ProviderRecord = Record<string, unknown>;
type SdkStatusError = {
  status?: unknown;
  statusCode?: unknown;
  response?: { status?: unknown; statusCode?: unknown };
};

function providerRecord(value: unknown): ProviderRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as ProviderRecord : undefined;
}

function statusOf(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as SdkStatusError;
  const value = candidate.response?.statusCode ?? candidate.response?.status ??
    candidate.statusCode ?? candidate.status;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function rejected(message: string, validationErrorCount?: number): AppError {
  return new AppError("PROVIDER_ERROR", message, {
    httpStatus: 422,
    retryable: false,
    details: {
      writeOutcome: "DEFINITELY_REJECTED",
      ...(validationErrorCount !== undefined ? { validationErrorCount } : {}),
    },
  });
}

function unknown(message: string, cause?: unknown): AppError {
  return new AppError("WRITE_RESULT_UNKNOWN", message, {
    httpStatus: 502,
    retryable: false,
    ...(cause ? { cause } : {}),
  });
}

function validationErrors(value: unknown): unknown[] {
  const record = providerRecord(value);
  return Array.isArray(record?.validationErrors) ? record.validationErrors : [];
}

function providerRejectedObject(value: unknown): boolean {
  const record = providerRecord(value);
  return record?.hasErrors === true || validationErrors(value).length > 0;
}

function headerRequestId(response: unknown): string | undefined {
  const record = providerRecord(response);
  const headers = providerRecord(record?.headers);
  const value = headers?.["xero-correlation-id"] ?? headers?.["x-request-id"];
  return typeof value === "string" && value.length <= 512 ? value : undefined;
}

function exactUuid(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(value)) {
    return undefined;
  }
  return value.toLowerCase();
}

function normalizeCompact(value: unknown): string | undefined {
  return typeof value === "string"
    ? value.normalize("NFKC").trim().replace(/\s+/gu, "").toLowerCase()
    : undefined;
}

function normalizeName(value: unknown): string | undefined {
  return typeof value === "string"
    ? value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase()
    : undefined;
}

function rawBusinessValue(raw: ProviderRecord, key: NormalizedBusinessKey): string | undefined {
  switch (key.kind) {
    case "COMPANY_NUMBER": return normalizeCompact(raw.companyNumber);
    case "EMAIL": return typeof raw.emailAddress === "string" ? raw.emailAddress.trim().toLowerCase() : undefined;
    case "ACCOUNT_NUMBER": return normalizeCompact(raw.accountNumber);
    case "NAME": return normalizeName(raw.name);
    case "ITEM_CODE": return normalizeName(raw.code);
    default: {
      // Exhaustive by construction, not by convention: a business-key kind
      // this switch does not handle must never fall through to `undefined`,
      // because `undefined === key.value` is always false, which would make
      // contactDuplicateExists's full-pagination scan silently report "no
      // duplicate found" for every contact on every page. Adding a 6th
      // NormalizedBusinessKey kind without a matching case here fails to
      // compile (the `never` assignment below); reaching this branch at
      // runtime despite that -- e.g. via an `as`-cast producer -- fails loudly
      // instead of returning a value that reads as "checked, and clean".
      const unreachable: never = key.kind;
      throw new AppError(
        "CONFIGURATION_ERROR",
        `Contact duplicate detection has no raw-value extraction for business key kind "${String(unreachable)}".`,
        { httpStatus: 500 },
      );
    }
  }
}

/**
 * Xero transport for the controlled Contact/Item slice. All searches use
 * structured SDK arguments and local exact matching; no caller-controlled
 * `where` expression ever reaches Xero.
 */
export class XeroContactItemMutationProvider implements ContactItemMutationProvider {
  constructor(
    private readonly manager: XeroClientManager,
    private readonly contactNamespace: string,
  ) {}

  async contactDuplicateExists(
    principal: AccountingPrincipal,
    externalReference: string | undefined,
    businessKeys: readonly NormalizedBusinessKey[],
    excludeContactId?: string,
  ): Promise<boolean> {
    if (businessKeys.length === 0 || businessKeys.some((key) => key.kind === "ITEM_CODE" || key.value.length === 0)) {
      throw new AppError("VALIDATION_FAILED", "At least one exact Contact business key is required.", {
        httpStatus: 400,
      });
    }
    return this.manager.withClient(principal, async (client, connection) => {
      const pageSize = 100;
      for (let page = 1; page <= 100; page += 1) {
        const response = await client.accountingApi.getContacts(
          connection.tenantId,
          undefined,
          undefined,
          "ContactID ASC",
          undefined,
          page,
          true,
          false,
          undefined,
          pageSize,
        );
        const contacts = response.body?.contacts;
        if (!Array.isArray(contacts)) {
          throw new AppError("PROVIDER_ERROR", "Xero returned an incomplete contact duplicate scan.", {
            httpStatus: 502,
            retryable: true,
          });
        }
        for (const value of contacts) {
          const raw = providerRecord(value);
          if (!raw) {
            throw new AppError("PROVIDER_ERROR", "Xero returned a malformed contact duplicate scan.", {
              httpStatus: 502,
            });
          }
          if (excludeContactId && exactUuid(raw.contactID) === exactUuid(excludeContactId)) continue;
          if (
            (externalReference !== undefined && raw.contactNumber === externalReference) ||
            businessKeys.some((key) => rawBusinessValue(raw, key) === key.value)
          ) {
            return true;
          }
        }
        if (contacts.length < pageSize) return false;
      }
      throw new AppError("PROVIDER_ERROR", "The bounded contact duplicate scan did not reach a complete final page.", {
        httpStatus: 502,
        retryable: true,
      });
    });
  }

  async itemCodeExists(principal: AccountingPrincipal, code: string): Promise<boolean> {
    return this.manager.withClient(principal, async (client, connection) => {
      try {
        const response = await client.accountingApi.getItem(connection.tenantId, code, 4);
        const items = response.body?.items;
        if (!Array.isArray(items)) {
          throw new AppError("PROVIDER_ERROR", "Xero returned an incomplete item duplicate check.", { httpStatus: 502 });
        }
        return items.some((value) => normalizeName(providerRecord(value)?.code) === normalizeName(code));
      } catch (error) {
        if (error instanceof AppError) throw error;
        if (statusOf(error) === 404) return false;
        throw new AppError("PROVIDER_ERROR", "The exact Xero item code could not be checked.", {
          httpStatus: 502,
          retryable: true,
          cause: error,
        });
      }
    });
  }

  async getContactExact(principal: AccountingPrincipal, contactId: string): Promise<SafeContactSnapshot | undefined> {
    const raw = await this.#getContactRawExact(principal, contactId);
    return raw ? mapSafeContactReadback(raw, { namespace: this.contactNamespace }) : undefined;
  }

  async getItemExact(principal: AccountingPrincipal, itemId: string): Promise<SafeItemSnapshot | undefined> {
    const raw = await this.#getItemRawExact(principal, itemId);
    return raw ? mapSafeItemReadback(raw) : undefined;
  }

  async createContact(
    principal: AccountingPrincipal,
    prepared: ContactCreatePrimitive,
    idempotencyKey: string,
    providerWritePermit?: LedgerProviderWritePermit,
  ): Promise<ContactItemWriteReceipt> {
    const xeroPayload = { contacts: [mapContactCreateToXero(prepared)] } as never;
    return this.manager.withWriteClient(principal, {
      permit: providerWritePermit,
      adapterOperation: "XeroContactItemMutationProvider.createContact",
      actionId: "contact.create_basic",
      mutationRequestId: idempotencyKey,
      providerIdempotencyKey: idempotencyKey,
      canonicalPayload: prepared.canonicalPayload,
    }, async (client, connection) => {
      try {
        const response = await client.accountingApi.createContacts(
          connection.tenantId,
          xeroPayload,
          true,
          idempotencyKey,
        );
        const created = response.body?.contacts?.[0];
        if (providerRejectedObject(created)) {
          throw rejected("Xero rejected the contact creation.", validationErrors(created).length);
        }
        const objectId = exactUuid(created?.contactID);
        if (!objectId) throw unknown("Xero returned no exact ContactID; recovery is required.");
        return {
          objectId,
          receipt: {
            operation: "CREATE_CONTACT",
            contactId: objectId,
            ...(headerRequestId(response.response) ? { providerRequestId: headerRequestId(response.response) } : {}),
          },
        };
      } catch (error) {
        if (error instanceof AppError) throw error;
        if (classifyXeroWriteException(error) === "UNKNOWN") {
          throw unknown("The Xero contact creation result is unknown.", error);
        }
        throw rejected("Xero rejected the contact creation.");
      }
    });
  }

  async updateContact(
    principal: AccountingPrincipal,
    prepared: ContactUpdatePrimitive,
    idempotencyKey: string,
    providerWritePermit?: LedgerProviderWritePermit,
  ): Promise<ContactItemWriteReceipt> {
    const xeroPayload = { contacts: [mapContactUpdateToXero(prepared)] } as never;
    return this.manager.withWriteClient(principal, {
      permit: providerWritePermit,
      adapterOperation: "XeroContactItemMutationProvider.updateContact",
      actionId: "contact.update_basic",
      mutationRequestId: idempotencyKey,
      providerIdempotencyKey: idempotencyKey,
      canonicalPayload: prepared.canonicalPayload,
    }, async (client, connection) => {
      try {
        const response = await client.accountingApi.updateContact(
          connection.tenantId,
          prepared.contactId,
          xeroPayload,
          idempotencyKey,
        );
        const updated = response.body?.contacts?.[0];
        if (providerRejectedObject(updated)) {
          throw rejected("Xero rejected the contact update.", validationErrors(updated).length);
        }
        const objectId = exactUuid(updated?.contactID);
        if (!objectId) throw unknown("Xero returned no exact ContactID after update; recovery is required.");
        if (objectId !== prepared.contactId.toLowerCase()) throw unknown("Xero returned a different ContactID after update.");
        return {
          objectId,
          receipt: {
            operation: "UPDATE_CONTACT",
            contactId: objectId,
            ...(headerRequestId(response.response) ? { providerRequestId: headerRequestId(response.response) } : {}),
          },
        };
      } catch (error) {
        if (error instanceof AppError) throw error;
        if (classifyXeroWriteException(error) === "UNKNOWN") {
          throw unknown("The Xero contact update result is unknown.", error);
        }
        throw rejected("Xero rejected the contact update.");
      }
    });
  }

  async createItem(
    principal: AccountingPrincipal,
    prepared: ItemCreatePrimitive,
    idempotencyKey: string,
    providerWritePermit?: LedgerProviderWritePermit,
  ): Promise<ContactItemWriteReceipt> {
    const xeroPayload = { items: [mapItemCreateToXero(prepared)] } as never;
    return this.manager.withWriteClient(principal, {
      permit: providerWritePermit,
      adapterOperation: "XeroContactItemMutationProvider.createItem",
      actionId: "item.create_basic_untracked",
      mutationRequestId: idempotencyKey,
      providerIdempotencyKey: idempotencyKey,
      canonicalPayload: prepared.canonicalPayload,
    }, async (client, connection) => {
      try {
        const response = await client.accountingApi.createItems(
          connection.tenantId,
          xeroPayload,
          true,
          4,
          idempotencyKey,
        );
        const created = response.body?.items?.[0];
        if (providerRejectedObject(created)) {
          throw rejected("Xero rejected the item creation.", validationErrors(created).length);
        }
        const objectId = exactUuid(created?.itemID);
        if (!objectId) throw unknown("Xero returned no exact ItemID; recovery is required.");
        return {
          objectId,
          receipt: {
            operation: "CREATE_ITEM",
            itemId: objectId,
            ...(headerRequestId(response.response) ? { providerRequestId: headerRequestId(response.response) } : {}),
          },
        };
      } catch (error) {
        if (error instanceof AppError) throw error;
        if (classifyXeroWriteException(error) === "UNKNOWN") {
          throw unknown("The Xero item creation result is unknown.", error);
        }
        throw rejected("Xero rejected the item creation.");
      }
    });
  }

  async updateItem(
    principal: AccountingPrincipal,
    prepared: ItemUpdatePrimitive,
    idempotencyKey: string,
    providerWritePermit?: LedgerProviderWritePermit,
  ): Promise<ContactItemWriteReceipt> {
    const xeroPayload = { items: [mapItemUpdateToXero(prepared)] } as never;
    return this.manager.withWriteClient(principal, {
      permit: providerWritePermit,
      adapterOperation: "XeroContactItemMutationProvider.updateItem",
      actionId: "item.update_basic_untracked",
      mutationRequestId: idempotencyKey,
      providerIdempotencyKey: idempotencyKey,
      canonicalPayload: prepared.canonicalPayload,
    }, async (client, connection) => {
      try {
        const response = await client.accountingApi.updateItem(
          connection.tenantId,
          prepared.itemId,
          xeroPayload,
          4,
          idempotencyKey,
        );
        const updated = response.body?.items?.[0];
        if (providerRejectedObject(updated)) {
          throw rejected("Xero rejected the item update.", validationErrors(updated).length);
        }
        const objectId = exactUuid(updated?.itemID);
        if (!objectId) throw unknown("Xero returned no exact ItemID after update; recovery is required.");
        if (objectId !== prepared.itemId.toLowerCase()) throw unknown("Xero returned a different ItemID after update.");
        return {
          objectId,
          receipt: {
            operation: "UPDATE_ITEM",
            itemId: objectId,
            ...(headerRequestId(response.response) ? { providerRequestId: headerRequestId(response.response) } : {}),
          },
        };
      } catch (error) {
        if (error instanceof AppError) throw error;
        if (classifyXeroWriteException(error) === "UNKNOWN") {
          throw unknown("The Xero item update result is unknown.", error);
        }
        throw rejected("Xero rejected the item update.");
      }
    });
  }

  async readAndVerifyContact(
    principal: AccountingPrincipal,
    objectId: string,
    prepared: ContactCreatePrimitive | ContactUpdatePrimitive,
  ): Promise<ContactItemReadbackVerification<SafeContactSnapshot>> {
    const raw = await this.#getContactRawExact(principal, objectId);
    if (!raw) return { verified: false, mismatches: ["readback.invalid"] };
    return prepared.operation === "CREATE"
      ? verifyContactReadback(prepared, raw, { namespace: this.contactNamespace, expectedCreatedId: objectId })
      : verifyContactReadback(prepared, raw, { namespace: this.contactNamespace });
  }

  async readAndVerifyItem(
    principal: AccountingPrincipal,
    objectId: string,
    prepared: ItemCreatePrimitive | ItemUpdatePrimitive,
  ): Promise<ContactItemReadbackVerification<SafeItemSnapshot>> {
    const raw = await this.#getItemRawExact(principal, objectId);
    if (!raw) return { verified: false, mismatches: ["readback.invalid"] };
    return prepared.operation === "CREATE"
      ? verifyItemReadback(prepared, raw, { expectedCreatedId: objectId })
      : verifyItemReadback(prepared, raw);
  }

  async #getContactRawExact(principal: AccountingPrincipal, contactId: string): Promise<unknown | undefined> {
    return this.manager.withClient(principal, async (client, connection) => {
      try {
        const response = await client.accountingApi.getContact(connection.tenantId, contactId);
        const exact = response.body?.contacts?.find((value) => exactUuid(value.contactID) === exactUuid(contactId));
        if (!exact) return undefined;
        const status = providerRecord(exact)?.contactStatus;
        if (status !== "ACTIVE") return undefined;
        return exact;
      } catch (error) {
        if (statusOf(error) === 404) return undefined;
        throw error;
      }
    });
  }

  async #getItemRawExact(principal: AccountingPrincipal, itemId: string): Promise<unknown | undefined> {
    return this.manager.withClient(principal, async (client, connection) => {
      try {
        const response = await client.accountingApi.getItem(connection.tenantId, itemId, 4);
        return response.body?.items?.find((value) => exactUuid(value.itemID) === exactUuid(itemId));
      } catch (error) {
        if (statusOf(error) === 404) return undefined;
        throw error;
      }
    });
  }
}
