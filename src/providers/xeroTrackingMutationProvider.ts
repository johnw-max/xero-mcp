import type { XeroClient } from "xero-node";
import { AppError } from "../errors.js";
import { hashObject } from "../security/hash.js";
import type { LedgerProviderWritePermit } from "../control-kernel/ledgerProviderWritePermit.js";
import { classifyXeroWriteException } from "./xeroWriteOutcome.js";
import type { AccountingPrincipal } from "./types.js";
import type { XeroClientManager } from "./xeroClientManager.js";
import {
  TRACKING_ADAPTER_OPERATIONS,
  type TrackingActionId,
  type TrackingCanonicalPayload,
  type TrackingCategoryCreateCanonicalPayload,
  type TrackingCategoryUpdateCanonicalPayload,
  type TrackingOptionCreateCanonicalPayload,
  type TrackingOptionUpdateCanonicalPayload,
} from "../domain/xeroTrackingCanonical.js";

export type TrackingAdapterOperation = typeof TRACKING_ADAPTER_OPERATIONS[TrackingActionId];

/**
 * Provider-facing authority for one tracking mutation.  This local contract is
 * intentionally typed and narrow while the shared Accounting Case permit
 * registry is being integrated by the release owner.  The integration seam is
 * the `permit` field passed to `withWriteClient`, not a second approval flow.
 */
type LegacyTrackingProviderWritePermit = Readonly<{
  readonly providerId: "xero";
  readonly actionId: TrackingActionId;
  readonly adapterOperation: TrackingAdapterOperation;
  readonly mutationRequestId: string;
  readonly canonicalPayloadHash: string;
  readonly tenantId: string;
  readonly authorizationReceipt?: Readonly<Record<string, unknown>>;
}>;

/** Shared Case permits are opaque; the legacy structural form remains test-only compatibility. */
export type TrackingProviderWritePermit = LedgerProviderWritePermit | LegacyTrackingProviderWritePermit;

export interface TrackingProviderWriteAuthorization {
  readonly permit: TrackingProviderWritePermit;
  readonly adapterOperation: TrackingAdapterOperation;
  readonly actionId: TrackingActionId;
  readonly mutationRequestId: string;
  readonly providerIdempotencyKey: string;
  readonly canonicalPayload: TrackingCanonicalPayload;
}

type TrackingAccountingApi = Pick<XeroClient["accountingApi"],
  | "getTrackingCategories"
  | "getTrackingCategory"
  | "createTrackingCategory"
  | "updateTrackingCategory"
  | "createTrackingOptions"
  | "updateTrackingOptions"
>;

export interface TrackingWriteClient {
  readonly accountingApi: TrackingAccountingApi;
}

export interface TrackingWriteConnection {
  readonly tenantId: string;
}

export interface TrackingMutationManager {
  withClient?<T>(
    principal: AccountingPrincipal,
    action: (client: TrackingWriteClient, connection: TrackingWriteConnection) => Promise<T>,
  ): Promise<T>;
  withWriteClient<T>(
    principal: AccountingPrincipal,
    authorization: TrackingProviderWriteAuthorization,
    action: (client: TrackingWriteClient, connection: TrackingWriteConnection) => Promise<T>,
  ): Promise<T>;
}

export interface TrackingProviderReceipt {
  readonly receiptType: "XERO_TRACKING_PROVIDER_RECEIPT";
  readonly providerId: "xero";
  readonly actionId: TrackingActionId;
  readonly mutationRequestId: string;
  readonly idempotencyKey: string;
  readonly tenantId: string;
  readonly objectId: string;
  readonly parentCategoryId?: string;
  readonly providerCorrelationId?: string;
  readonly authorizationReceiptHash?: string;
}

export interface TrackingReadback {
  readonly objectId: string;
  readonly parentCategoryId?: string;
  readonly name: string;
  readonly status: "ACTIVE";
}

export interface TrackingProviderWriteResult {
  readonly actionId: TrackingActionId;
  readonly tenantId: string;
  readonly objectId: string;
  readonly parentCategoryId?: string;
  readonly name: string;
  readonly status: "ACTIVE";
  readonly receipt: TrackingProviderReceipt;
}

export interface TrackingProviderWriteEvidence {
  readonly objectId: string;
  readonly receipt: TrackingProviderReceipt;
}

export type RecordTrackingProviderWriteEvidence = (evidence: TrackingProviderWriteEvidence) => Promise<void>;

interface RawTrackingOption {
  readonly trackingOptionID?: unknown;
  readonly name?: unknown;
  readonly status?: unknown;
  readonly trackingCategoryID?: unknown;
}

interface RawTrackingCategory {
  readonly trackingCategoryID?: unknown;
  readonly name?: unknown;
  readonly status?: unknown;
  readonly options?: readonly RawTrackingOption[];
}

interface TrackingCategoriesBody {
  readonly trackingCategories?: readonly RawTrackingCategory[];
}

interface TrackingOptionsBody {
  readonly options?: readonly RawTrackingOption[];
}

interface SdkResponse<TBody = unknown> {
  readonly response?: { readonly headers?: unknown };
  readonly body?: TBody;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}

function providerRequestId(response: SdkResponse): string | undefined {
  const headers = asRecord(response.response?.headers);
  if (!headers) return undefined;
  for (const key of ["xero-correlation-id", "x-request-id", "x-correlation-id"]) {
    const value = headers[key] ?? headers[key.toUpperCase()];
    if (typeof value === "string" && value.trim().length > 0 && value.length <= 512) return value;
  }
  return undefined;
}

function uuid(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(trimmed)
    ? trimmed
    : undefined;
}

function sameUuid(value: unknown, expected: string): boolean {
  return uuid(value) === uuid(expected);
}

function status(value: unknown): string | undefined {
  return typeof value === "string" ? value.toUpperCase() : undefined;
}

function name(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function providerHasErrors(value: unknown): boolean {
  const record = asRecord(value);
  if (!record) return false;
  const direct = record.validationErrors ?? record.ValidationErrors;
  return record.hasErrors === true || record.HasErrors === true || (Array.isArray(direct) && direct.length > 0);
}

function providerValidationErrorCount(value: unknown): number {
  const record = asRecord(value);
  if (!record) return 0;
  const errors = record.validationErrors ?? record.ValidationErrors;
  return Array.isArray(errors) ? errors.length : 0;
}

function providerRejected(message: string, details: Record<string, unknown> = {}): AppError {
  return new AppError("PROVIDER_ERROR", message, {
    httpStatus: 422,
    retryable: false,
    details: {
      ...details,
      writeOutcome: "DEFINITELY_REJECTED",
      providerMutationPossible: false,
    },
  });
}

function preflightUnavailable(message: string, cause: unknown): AppError {
  return new AppError("PROVIDER_ERROR", message, {
    httpStatus: 503,
    retryable: true,
    cause,
    details: {
      phase: "TRACKING_PREFLIGHT",
      providerMutationPossible: false,
      reasonCodes: ["TRACKING_PREFLIGHT_UNAVAILABLE"],
      recoveryAction: "RETRY_AFTER_PROVIDER_RECOVERS",
    },
  });
}

function preflightConflict(message: string, details: Record<string, unknown> = {}): AppError {
  return new AppError("CONFLICT", message, {
    httpStatus: 409,
    retryable: false,
    details: {
      ...details,
      phase: "TRACKING_PREFLIGHT",
      providerMutationPossible: false,
      writeOutcome: "DEFINITELY_REJECTED",
    },
  });
}

function preflightNotFound(message: string, details: Record<string, unknown> = {}): AppError {
  return new AppError("NOT_FOUND", message, {
    httpStatus: 404,
    retryable: false,
    details: {
      ...details,
      phase: "TRACKING_PREFLIGHT",
      providerMutationPossible: false,
    },
  });
}

function writeUnknown(message: string, cause?: unknown, details: Record<string, unknown> = {}): AppError {
  return new AppError("WRITE_RESULT_UNKNOWN", message, {
    httpStatus: 502,
    retryable: false,
    ...(cause === undefined ? {} : { cause }),
    details: {
      ...details,
      providerMutationPossible: true,
      recoveryAction: "READBACK_RECOVERY_ONLY",
    },
  });
}

function readbackMismatch(message: string, details: Record<string, unknown> = {}): AppError {
  return new AppError("READBACK_MISMATCH", message, {
    httpStatus: 502,
    retryable: false,
    details: {
      ...details,
      providerMutationPossible: true,
      recoveryAction: "READBACK_RECOVERY_ONLY",
    },
  });
}

function requestId(value: string): string {
  if (!/^[A-Za-z0-9._:-]{8,128}$/u.test(value) || value.trim() !== value) {
    throw new AppError("VALIDATION_FAILED", "Tracking mutation idempotency key is invalid.", {
      httpStatus: 422,
      details: { path: "idempotencyKey", providerMutationPossible: false },
    });
  }
  return value;
}

function assertPermit(
  permit: TrackingProviderWritePermit,
  actionId: TrackingActionId,
  payload: TrackingCanonicalPayload,
  idempotencyKey: string,
): void {
  // A real Case permit is opaque and is consumed atomically by
  // XeroClientManager.withWriteClient. Only the foundation-test compatibility
  // form has inspectable claims at this adapter layer.
  if (!("actionId" in permit)) return;
  const expectedAdapterOperation = TRACKING_ADAPTER_OPERATIONS[actionId];
  if (
    !permit ||
    permit.providerId !== "xero" ||
    permit.actionId !== actionId ||
    permit.adapterOperation !== expectedAdapterOperation ||
    permit.mutationRequestId !== idempotencyKey ||
    permit.canonicalPayloadHash !== hashObject(payload) ||
    typeof permit.tenantId !== "string" ||
    permit.tenantId.trim().length === 0
  ) {
    throw new AppError("FORBIDDEN", "The tracking provider write is not authorised by an exact typed permit.", {
      httpStatus: 403,
      details: {
        failureLayer: "TRACKING_PROVIDER_PERMIT",
        reasonCodes: ["TRACKING_PERMIT_MISMATCH"],
        providerMutationPossible: false,
      },
    });
  }
}

function trackingCategories(value: unknown): readonly RawTrackingCategory[] | undefined {
  const body = asRecord(value) as TrackingCategoriesBody | undefined;
  return body && Array.isArray(body.trackingCategories) ? body.trackingCategories : undefined;
}

function trackingOptions(value: unknown): readonly RawTrackingOption[] | undefined {
  const body = asRecord(value) as TrackingOptionsBody | undefined;
  return body && Array.isArray(body.options) ? body.options : undefined;
}

export class XeroTrackingMutationProvider {
  readonly #manager: TrackingMutationManager;

  constructor(manager: TrackingMutationManager | XeroClientManager) {
    // XeroClientManager is the shared runtime owner.  Its permit union is
    // extended by the root integration; this independent foundation keeps the
    // adapter contract compile-safe without changing that shared registry.
    this.#manager = manager as unknown as TrackingMutationManager;
  }

  /** Read-only deterministic validation used before the durable write claim. */
  async validatePreflight(
    principal: AccountingPrincipal,
    payload: TrackingCanonicalPayload,
  ): Promise<void> {
    await this.#withReadClient(principal, async (api, tenantId) => {
      switch (payload.actionId) {
        case "tracking_category.create": {
          const listed = await this.#listCategories(api, tenantId);
          this.#assertUniqueActiveCategoryName(listed, payload.name);
          return;
        }
        case "tracking_category.update": {
          const target = await this.#exactCategoryPreflight(api, tenantId, payload.trackingCategoryId);
          this.#requireActiveCategory(target, payload.trackingCategoryId);
          const listed = await this.#listCategories(api, tenantId);
          this.#assertUniqueActiveCategoryName(listed, payload.name, payload.trackingCategoryId);
          return;
        }
        case "tracking_option.create": {
          const parent = await this.#exactCategoryPreflight(api, tenantId, payload.trackingCategoryId);
          this.#requireActiveCategory(parent, payload.trackingCategoryId);
          const listed = await this.#listCategories(api, tenantId);
          const listedParent = this.#findCategory(listed, payload.trackingCategoryId);
          if (!listedParent) {
            throw preflightNotFound("The exact tracking category was not present in the preflight list.", {
              trackingCategoryId: payload.trackingCategoryId,
            });
          }
          this.#assertUniqueActiveOptionName(listedParent, payload.name);
          return;
        }
        case "tracking_option.update": {
          const parent = await this.#exactCategoryPreflight(api, tenantId, payload.trackingCategoryId);
          this.#requireActiveCategory(parent, payload.trackingCategoryId);
          this.#requireActiveOption(parent, payload.trackingCategoryId, payload.trackingOptionId);
          const listed = await this.#listCategories(api, tenantId);
          const listedParent = this.#findCategory(listed, payload.trackingCategoryId);
          if (!listedParent) {
            throw preflightNotFound("The exact tracking category was not present in the preflight list.", {
              trackingCategoryId: payload.trackingCategoryId,
            });
          }
          this.#assertUniqueActiveOptionName(listedParent, payload.name, payload.trackingOptionId);
          return;
        }
      }
    });
  }

  /** Exact same-ID GET used after receipt persistence and for GET-only recovery. */
  async readAndVerify(
    principal: AccountingPrincipal,
    payload: TrackingCanonicalPayload,
    objectId: string,
  ): Promise<TrackingReadback> {
    return this.#withReadClient(principal, (api, tenantId) =>
      payload.actionId === "tracking_category.create" || payload.actionId === "tracking_category.update"
        ? this.#readCategoryBack(api, tenantId, objectId, payload.name)
        : this.#readOptionBack(api, tenantId, payload.trackingCategoryId, objectId, payload.name));
  }

  async createCategory(
    principal: AccountingPrincipal,
    payload: TrackingCategoryCreateCanonicalPayload,
    idempotencyKey: string,
    permit: TrackingProviderWritePermit,
    recordWriteEvidence?: RecordTrackingProviderWriteEvidence,
  ): Promise<TrackingProviderWriteResult> {
    return this.#run(principal, payload, idempotencyKey, permit, recordWriteEvidence, async (api, tenantId, persist) => {
      const listed = await this.#listCategories(api, tenantId);
      this.#assertUniqueActiveCategoryName(listed, payload.name);
      const response = await this.#mutate("tracking_category.create", async () =>
        api.createTrackingCategory(tenantId, { name: payload.name }, idempotencyKey));
      const created = this.#createdCategory(response);
      const correlationId = providerRequestId(response);
      await persist({
        objectId: created.objectId,
        ...(correlationId === undefined ? {} : { providerCorrelationId: correlationId }),
      });
      return {
        objectId: created.objectId,
        name: payload.name,
        ...(correlationId === undefined ? {} : { providerCorrelationId: correlationId }),
      };
    });
  }

  async updateCategory(
    principal: AccountingPrincipal,
    payload: TrackingCategoryUpdateCanonicalPayload,
    idempotencyKey: string,
    permit: TrackingProviderWritePermit,
    recordWriteEvidence?: RecordTrackingProviderWriteEvidence,
  ): Promise<TrackingProviderWriteResult> {
    return this.#run(principal, payload, idempotencyKey, permit, recordWriteEvidence, async (api, tenantId, persist) => {
      const target = await this.#exactCategoryPreflight(api, tenantId, payload.trackingCategoryId);
      this.#requireActiveCategory(target, payload.trackingCategoryId);
      const listed = await this.#listCategories(api, tenantId);
      this.#assertUniqueActiveCategoryName(listed, payload.name, payload.trackingCategoryId);
      const response = await this.#mutate("tracking_category.update", async () =>
        api.updateTrackingCategory(tenantId, payload.trackingCategoryId, { name: payload.name }, idempotencyKey));
      const updated = this.#updatedCategory(response, payload.trackingCategoryId);
      const correlationId = providerRequestId(response);
      await persist({
        objectId: updated.objectId,
        ...(correlationId === undefined ? {} : { providerCorrelationId: correlationId }),
      });
      return {
        objectId: updated.objectId,
        name: payload.name,
        ...(correlationId === undefined ? {} : { providerCorrelationId: correlationId }),
      };
    });
  }

  async createOption(
    principal: AccountingPrincipal,
    payload: TrackingOptionCreateCanonicalPayload,
    idempotencyKey: string,
    permit: TrackingProviderWritePermit,
    recordWriteEvidence?: RecordTrackingProviderWriteEvidence,
  ): Promise<TrackingProviderWriteResult> {
    return this.#run(principal, payload, idempotencyKey, permit, recordWriteEvidence, async (api, tenantId, persist) => {
      const parent = await this.#exactCategoryPreflight(api, tenantId, payload.trackingCategoryId);
      this.#requireActiveCategory(parent, payload.trackingCategoryId);
      const listed = await this.#listCategories(api, tenantId);
      const listedParent = this.#findCategory(listed, payload.trackingCategoryId);
      if (!listedParent) {
        throw preflightNotFound("The exact tracking category was not present in the preflight list.", {
          trackingCategoryId: payload.trackingCategoryId,
        });
      }
      this.#assertUniqueActiveOptionName(listedParent, payload.name);
      const response = await this.#mutate("tracking_option.create", async () =>
        api.createTrackingOptions(tenantId, payload.trackingCategoryId, { name: payload.name }, idempotencyKey));
      const created = this.#createdOption(response, payload.trackingCategoryId);
      const correlationId = providerRequestId(response);
      await persist({
        objectId: created.objectId,
        parentCategoryId: payload.trackingCategoryId,
        ...(correlationId === undefined ? {} : { providerCorrelationId: correlationId }),
      });
      return {
        objectId: created.objectId,
        parentCategoryId: payload.trackingCategoryId,
        name: payload.name,
        ...(correlationId === undefined ? {} : { providerCorrelationId: correlationId }),
      };
    });
  }

  async updateOption(
    principal: AccountingPrincipal,
    payload: TrackingOptionUpdateCanonicalPayload,
    idempotencyKey: string,
    permit: TrackingProviderWritePermit,
    recordWriteEvidence?: RecordTrackingProviderWriteEvidence,
  ): Promise<TrackingProviderWriteResult> {
    return this.#run(principal, payload, idempotencyKey, permit, recordWriteEvidence, async (api, tenantId, persist) => {
      const parent = await this.#exactCategoryPreflight(api, tenantId, payload.trackingCategoryId);
      this.#requireActiveCategory(parent, payload.trackingCategoryId);
      this.#requireActiveOption(parent, payload.trackingCategoryId, payload.trackingOptionId);
      const listed = await this.#listCategories(api, tenantId);
      const listedParent = this.#findCategory(listed, payload.trackingCategoryId);
      if (!listedParent) {
        throw preflightNotFound("The exact tracking category was not present in the preflight list.", {
          trackingCategoryId: payload.trackingCategoryId,
        });
      }
      this.#assertUniqueActiveOptionName(listedParent, payload.name, payload.trackingOptionId);
      const response = await this.#mutate("tracking_option.update", async () =>
        api.updateTrackingOptions(
          tenantId,
          payload.trackingCategoryId,
          payload.trackingOptionId,
          { name: payload.name },
          idempotencyKey,
        ));
      const updated = this.#updatedOption(response, payload.trackingCategoryId, payload.trackingOptionId);
      const correlationId = providerRequestId(response);
      await persist({
        objectId: updated.objectId,
        parentCategoryId: payload.trackingCategoryId,
        ...(correlationId === undefined ? {} : { providerCorrelationId: correlationId }),
      });
      return {
        objectId: updated.objectId,
        parentCategoryId: payload.trackingCategoryId,
        name: payload.name,
        ...(correlationId === undefined ? {} : { providerCorrelationId: correlationId }),
      };
    });
  }

  async #run<TPayload extends TrackingCanonicalPayload>(
    principal: AccountingPrincipal,
    payload: TPayload,
    idempotencyKeyInput: string,
    permit: TrackingProviderWritePermit,
    recordWriteEvidence: RecordTrackingProviderWriteEvidence | undefined,
    operation: (api: TrackingAccountingApi, tenantId: string, persist: (evidence: {
      objectId: string;
      parentCategoryId?: string;
      providerCorrelationId?: string;
    }) => Promise<void>) => Promise<{
      objectId: string;
      parentCategoryId?: string;
      name: string;
      providerCorrelationId?: string;
    }>,
  ): Promise<TrackingProviderWriteResult> {
    const idempotencyKey = requestId(idempotencyKeyInput);
    const actionId = payload.actionId;
    assertPermit(permit, actionId, payload, idempotencyKey);
    const adapterOperation = TRACKING_ADAPTER_OPERATIONS[actionId];
    const authorization: TrackingProviderWriteAuthorization = {
      permit,
      adapterOperation,
      actionId,
      mutationRequestId: idempotencyKey,
      providerIdempotencyKey: idempotencyKey,
      canonicalPayload: payload,
    };
    return this.#manager.withWriteClient(principal, authorization, async (client, connection) => {
      if ("tenantId" in permit && connection.tenantId !== permit.tenantId) {
        throw new AppError("FORBIDDEN", "The tracking write permit targets a different Xero tenant.", {
          httpStatus: 403,
          details: {
            failureLayer: "TRACKING_PROVIDER_PERMIT",
            reasonCodes: ["TRACKING_TENANT_MISMATCH"],
            providerMutationPossible: false,
          },
        });
      }
      const receiptFor = (evidence: {
        objectId: string;
        parentCategoryId?: string;
        providerCorrelationId?: string;
      }): TrackingProviderReceipt => ({
          receiptType: "XERO_TRACKING_PROVIDER_RECEIPT",
          providerId: "xero",
          actionId,
          mutationRequestId: idempotencyKey,
          idempotencyKey,
          tenantId: connection.tenantId,
          objectId: evidence.objectId,
          ...(evidence.parentCategoryId ? { parentCategoryId: evidence.parentCategoryId } : {}),
          ...(evidence.providerCorrelationId ? { providerCorrelationId: evidence.providerCorrelationId } : {}),
          ...("authorizationReceipt" in permit && permit.authorizationReceipt
            ? { authorizationReceiptHash: hashObject(permit.authorizationReceipt) }
            : {}),
        });
      let receipt: TrackingProviderReceipt | undefined;
      const persist = async (evidence: {
        objectId: string;
        parentCategoryId?: string;
        providerCorrelationId?: string;
      }): Promise<void> => {
        receipt = receiptFor(evidence);
        await recordWriteEvidence?.({ objectId: evidence.objectId, receipt });
      };
      const result = await operation(client.accountingApi, connection.tenantId, persist);
      receipt ??= receiptFor(result);
      return {
        actionId,
        tenantId: connection.tenantId,
        objectId: result.objectId,
        ...(result.parentCategoryId ? { parentCategoryId: result.parentCategoryId } : {}),
        name: result.name,
        status: "ACTIVE",
        receipt,
      };
    });
  }

  async #withReadClient<T>(
    principal: AccountingPrincipal,
    action: (api: TrackingAccountingApi, tenantId: string) => Promise<T>,
  ): Promise<T> {
    if (!this.#manager.withClient) {
      throw new AppError("CONFIGURATION_ERROR", "The tracking provider has no read-only client seam.", {
        httpStatus: 503,
      });
    }
    return this.#manager.withClient(principal, (client, connection) =>
      action(client.accountingApi, connection.tenantId));
  }

  async #listCategories(
    api: TrackingAccountingApi,
    tenantId: string,
  ): Promise<readonly RawTrackingCategory[]> {
    let response: SdkResponse<TrackingCategoriesBody>;
    try {
      response = await api.getTrackingCategories(tenantId, undefined, "Name ASC", true);
    } catch (error) {
      throw preflightUnavailable("Xero tracking categories could not be read before mutation.", error);
    }
    const values = trackingCategories(response.body);
    if (!values) throw preflightUnavailable("Xero returned a malformed tracking-category preflight response.", undefined);
    return values;
  }

  async #exactCategoryPreflight(
    api: TrackingAccountingApi,
    tenantId: string,
    categoryId: string,
  ): Promise<RawTrackingCategory> {
    let response: SdkResponse<TrackingCategoriesBody>;
    try {
      response = await api.getTrackingCategory(tenantId, categoryId);
    } catch (error) {
      throw preflightUnavailable("The exact Xero tracking category could not be read before mutation.", error);
    }
    const values = trackingCategories(response.body);
    if (!values) throw preflightUnavailable("Xero returned a malformed exact tracking-category response.", undefined);
    const exact = this.#findCategory(values, categoryId);
    if (!exact) throw preflightNotFound("The exact Xero tracking category was not found.", { trackingCategoryId: categoryId });
    return exact;
  }

  async #readCategoryBack(
    api: TrackingAccountingApi,
    tenantId: string,
    categoryId: string,
    expectedName: string,
  ): Promise<TrackingReadback> {
    let response: SdkResponse<TrackingCategoriesBody>;
    try {
      response = await api.getTrackingCategory(tenantId, categoryId);
    } catch (error) {
      throw writeUnknown("The tracking-category mutation was accepted but exact readback is uncertain.", error, {
        objectId: categoryId,
      });
    }
    const values = trackingCategories(response.body);
    if (!values) throw writeUnknown("Xero returned a malformed tracking-category readback.", undefined, { objectId: categoryId });
    const exact = this.#findCategory(values, categoryId);
    if (!exact) throw writeUnknown("The tracking category is absent from exact readback; recovery is required.", undefined, { objectId: categoryId });
    const actualName = name(exact.name);
    const actualStatus = status(exact.status);
    if (actualName !== expectedName || actualStatus !== "ACTIVE") {
      throw readbackMismatch("The tracking-category readback did not match the requested ACTIVE name.", {
        objectId: categoryId,
        expectedName,
        actualName,
        expectedStatus: "ACTIVE",
        actualStatus,
      });
    }
    return { objectId: categoryId, name: expectedName, status: "ACTIVE" };
  }

  async #readOptionBack(
    api: TrackingAccountingApi,
    tenantId: string,
    categoryId: string,
    optionId: string,
    expectedName: string,
  ): Promise<TrackingReadback> {
    let response: SdkResponse<TrackingCategoriesBody>;
    try {
      response = await api.getTrackingCategory(tenantId, categoryId);
    } catch (error) {
      throw writeUnknown("The tracking-option mutation was accepted but exact readback is uncertain.", error, {
        objectId: optionId,
        parentCategoryId: categoryId,
      });
    }
    const values = trackingCategories(response.body);
    if (!values) throw writeUnknown("Xero returned a malformed tracking-option readback.", undefined, { objectId: optionId });
    const parent = this.#findCategory(values, categoryId);
    if (!parent) throw writeUnknown("The tracking-option parent is absent from exact readback; recovery is required.", undefined, {
      objectId: optionId,
      parentCategoryId: categoryId,
    });
    const option = this.#findOption(parent, optionId);
    if (!option) throw writeUnknown("The tracking option is absent from exact readback; recovery is required.", undefined, {
      objectId: optionId,
      parentCategoryId: categoryId,
    });
    const actualName = name(option.name);
    const actualStatus = status(option.status);
    if (
      actualName !== expectedName ||
      actualStatus !== "ACTIVE" ||
      (option.trackingCategoryID !== undefined && !sameUuid(option.trackingCategoryID, categoryId))
    ) {
      throw readbackMismatch("The tracking-option readback did not match the requested ACTIVE name and parent.", {
        objectId: optionId,
        parentCategoryId: categoryId,
        expectedName,
        actualName,
        expectedStatus: "ACTIVE",
        actualStatus,
      });
    }
    return { objectId: optionId, parentCategoryId: categoryId, name: expectedName, status: "ACTIVE" };
  }

  async #mutate<T>(actionId: TrackingActionId, mutation: () => Promise<T>): Promise<T> {
    try {
      return await mutation();
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (classifyXeroWriteException(error) === "DEFINITELY_REJECTED") {
        throw providerRejected(`Xero rejected the ${actionId} tracking mutation.`, {
          actionId,
          validationErrorCount: providerValidationErrorCount(asRecord(error)?.response ?? asRecord(error)?.body),
        });
      }
      throw writeUnknown(`The ${actionId} tracking mutation result is unknown and requires recovery.`, error, { actionId });
    }
  }

  #createdCategory(response: SdkResponse<TrackingCategoriesBody>): { objectId: string } {
    if (providerHasErrors(response.body)) {
      throw providerRejected("Xero rejected the tracking-category create.", {
        validationErrorCount: providerValidationErrorCount(response.body),
      });
    }
    const record = trackingCategories(response.body)?.[0];
    const objectId = uuid(record?.trackingCategoryID);
    if (!objectId) throw writeUnknown("Xero returned no exact tracking-category ID after create.");
    return { objectId };
  }

  #updatedCategory(response: SdkResponse<TrackingCategoriesBody>, expectedId: string): { objectId: string } {
    if (providerHasErrors(response.body)) {
      throw providerRejected("Xero rejected the tracking-category update.", {
        validationErrorCount: providerValidationErrorCount(response.body),
      });
    }
    const record = trackingCategories(response.body)?.[0];
    const objectId = uuid(record?.trackingCategoryID);
    if (!objectId || !sameUuid(objectId, expectedId)) {
      throw writeUnknown("Xero returned no same-ID tracking-category update result; recovery is required.", undefined, {
        expectedObjectId: expectedId,
      });
    }
    return { objectId };
  }

  #createdOption(response: SdkResponse<TrackingOptionsBody>, parentCategoryId: string): { objectId: string } {
    if (providerHasErrors(response.body)) {
      throw providerRejected("Xero rejected the tracking-option create.", {
        validationErrorCount: providerValidationErrorCount(response.body),
      });
    }
    const record = trackingOptions(response.body)?.[0];
    const objectId = uuid(record?.trackingOptionID);
    if (!objectId) throw writeUnknown("Xero returned no exact tracking-option ID after create.");
    if (record?.trackingCategoryID !== undefined && !sameUuid(record.trackingCategoryID, parentCategoryId)) {
      throw writeUnknown("Xero returned a tracking option bound to a different category; recovery is required.", undefined, {
        objectId,
        expectedParentCategoryId: parentCategoryId,
      });
    }
    return { objectId };
  }

  #updatedOption(
    response: SdkResponse<TrackingOptionsBody>,
    parentCategoryId: string,
    expectedId: string,
  ): { objectId: string } {
    if (providerHasErrors(response.body)) {
      throw providerRejected("Xero rejected the tracking-option update.", {
        validationErrorCount: providerValidationErrorCount(response.body),
      });
    }
    const record = trackingOptions(response.body)?.[0];
    const objectId = uuid(record?.trackingOptionID);
    if (!objectId || !sameUuid(objectId, expectedId)) {
      throw writeUnknown("Xero returned no same-ID tracking-option update result; recovery is required.", undefined, {
        expectedObjectId: expectedId,
      });
    }
    if (record?.trackingCategoryID !== undefined && !sameUuid(record.trackingCategoryID, parentCategoryId)) {
      throw writeUnknown("Xero returned a tracking option bound to a different category; recovery is required.", undefined, {
        objectId,
        expectedParentCategoryId: parentCategoryId,
      });
    }
    return { objectId };
  }

  #findCategory(
    categories: readonly RawTrackingCategory[],
    categoryId: string,
  ): RawTrackingCategory | undefined {
    return categories.find((candidate) => sameUuid(candidate.trackingCategoryID, categoryId));
  }

  #findOption(category: RawTrackingCategory, optionId: string): RawTrackingOption | undefined {
    return (category.options ?? []).find((candidate) => sameUuid(candidate.trackingOptionID, optionId));
  }

  #requireActiveCategory(category: RawTrackingCategory, categoryId: string): void {
    if (status(category.status) !== "ACTIVE") {
      throw preflightConflict("Only an ACTIVE tracking category can be changed or used as an option parent.", {
        trackingCategoryId: categoryId,
        expectedStatus: "ACTIVE",
        actualStatus: status(category.status),
      });
    }
  }

  #requireActiveOption(category: RawTrackingCategory, categoryId: string, optionId: string): RawTrackingOption {
    const option = this.#findOption(category, optionId);
    if (!option) throw preflightNotFound("The exact Xero tracking option was not found in its parent category.", {
      trackingCategoryId: categoryId,
      trackingOptionId: optionId,
    });
    if (status(option.status) !== "ACTIVE") {
      throw preflightConflict("Only an ACTIVE tracking option can be renamed.", {
        trackingCategoryId: categoryId,
        trackingOptionId: optionId,
        expectedStatus: "ACTIVE",
        actualStatus: status(option.status),
      });
    }
    if (option.trackingCategoryID !== undefined && !sameUuid(option.trackingCategoryID, categoryId)) {
      throw preflightConflict("The tracking option does not belong to the exact requested category.", {
        trackingCategoryId: categoryId,
        trackingOptionId: optionId,
      });
    }
    return option;
  }

  #assertUniqueActiveCategoryName(
    categories: readonly RawTrackingCategory[],
    requestedName: string,
    ignoredCategoryId?: string,
  ): void {
    const wanted = requestedName.trim().toLocaleLowerCase();
    const duplicate = categories.find((candidate) =>
      status(candidate.status) === "ACTIVE" &&
      name(candidate.name)?.trim().toLocaleLowerCase() === wanted &&
      (ignoredCategoryId === undefined || !sameUuid(candidate.trackingCategoryID, ignoredCategoryId)),
    );
    if (duplicate) throw preflightConflict("An ACTIVE tracking category with that name already exists.", {
      requestedName,
      conflictingObjectId: uuid(duplicate.trackingCategoryID),
    });
  }

  #assertUniqueActiveOptionName(
    category: RawTrackingCategory,
    requestedName: string,
    ignoredOptionId?: string,
  ): void {
    const wanted = requestedName.trim().toLocaleLowerCase();
    const duplicate = (category.options ?? []).find((candidate) =>
      status(candidate.status) === "ACTIVE" &&
      name(candidate.name)?.trim().toLocaleLowerCase() === wanted &&
      (ignoredOptionId === undefined || !sameUuid(candidate.trackingOptionID, ignoredOptionId)),
    );
    if (duplicate) throw preflightConflict("An ACTIVE tracking option with that name already exists in this category.", {
      requestedName,
      trackingCategoryId: uuid(category.trackingCategoryID),
      conflictingObjectId: uuid(duplicate.trackingOptionID),
    });
  }
}
