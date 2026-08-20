import { describe, expect, it, vi } from "vitest";
import { hashObject } from "../src/security/hash.js";
import {
  canonicalTrackingCategoryCreatePayload,
  canonicalTrackingCategoryUpdatePayload,
  canonicalTrackingOptionCreatePayload,
  canonicalTrackingOptionUpdatePayload,
  TRACKING_ADAPTER_OPERATIONS,
} from "../src/domain/xeroTrackingCanonical.js";
import {
  trackingCategoryCreateSchema,
  trackingCategoryUpdateSchema,
  trackingOptionCreateSchema,
  trackingOptionUpdateSchema,
} from "../src/domain/xeroTrackingMutationSchemas.js";
import {
  XeroTrackingMutationProvider,
  type TrackingMutationManager,
  type TrackingProviderWritePermit,
  type TrackingWriteClient,
} from "../src/providers/xeroTrackingMutationProvider.js";

const TENANT_ID = "tenant-tracking-foundation";
const CATEGORY_ID = "11111111-1111-4111-8111-111111111111";
const CATEGORY_2_ID = "22222222-2222-4222-8222-222222222222";
const OPTION_ID = "33333333-3333-4333-8333-333333333333";
const OPTION_2_ID = "44444444-4444-4444-8444-444444444444";
const CREATED_CATEGORY_ID = "55555555-5555-4555-8555-555555555555";
const CREATED_OPTION_ID = "66666666-6666-4666-8666-666666666666";

type Category = {
  trackingCategoryID: string;
  name: string;
  status: "ACTIVE" | "ARCHIVED";
  options: Array<{
    trackingOptionID: string;
    name: string;
    status: "ACTIVE" | "ARCHIVED";
    trackingCategoryID: string;
  }>;
};

function categoryState(): Category[] {
  return [{
    trackingCategoryID: CATEGORY_ID,
    name: "Department",
    status: "ACTIVE",
    options: [{
      trackingOptionID: OPTION_ID,
      name: "East",
      status: "ACTIVE",
      trackingCategoryID: CATEGORY_ID,
    }],
  }];
}

function response<T>(body: T) {
  return { body, response: { headers: { "xero-correlation-id": "corr-tracking-001" } } };
}

function permit(actionId: keyof typeof TRACKING_ADAPTER_OPERATIONS, payload: unknown, key: string): TrackingProviderWritePermit {
  return {
    providerId: "xero",
    actionId,
    adapterOperation: TRACKING_ADAPTER_OPERATIONS[actionId],
    mutationRequestId: key,
    canonicalPayloadHash: hashObject(payload),
    tenantId: TENANT_ID,
    authorizationReceipt: { receiptType: "test-authority", actionId, mutationRequestId: key },
  };
}

function managerWithState(options: {
  state?: Category[];
  preflightError?: unknown;
  mutationError?: unknown;
} = {}): {
  manager: TrackingMutationManager;
  state: Category[];
  calls: { list: number; exact: number; mutation: number };
} {
  const state = options.state ?? categoryState();
  const calls = { list: 0, exact: 0, mutation: 0 };
  let nextCategoryId = CREATED_CATEGORY_ID;
  let nextOptionId = CREATED_OPTION_ID;
  const api = {
    getTrackingCategories: vi.fn(async () => {
      calls.list += 1;
      if (options.preflightError) throw options.preflightError;
      return response({ trackingCategories: structuredClone(state) });
    }),
    getTrackingCategory: vi.fn(async (_tenantId: string, id: string) => {
      calls.exact += 1;
      const found = state.find((candidate) => candidate.trackingCategoryID.toLowerCase() === id.toLowerCase());
      return response({ trackingCategories: found ? [structuredClone(found)] : [] });
    }),
    createTrackingCategory: vi.fn(async (_tenantId: string, input: { name?: string }) => {
      calls.mutation += 1;
      if (options.mutationError) throw options.mutationError;
      const created: Category = {
        trackingCategoryID: nextCategoryId,
        name: input.name ?? "",
        status: "ACTIVE",
        options: [],
      };
      state.push(created);
      nextCategoryId = CATEGORY_2_ID;
      return response({ trackingCategories: [structuredClone(created)] });
    }),
    updateTrackingCategory: vi.fn(async (_tenantId: string, id: string, input: { name?: string }) => {
      calls.mutation += 1;
      if (options.mutationError) throw options.mutationError;
      const found = state.find((candidate) => candidate.trackingCategoryID === id);
      if (found) found.name = input.name ?? found.name;
      return response({ trackingCategories: found ? [structuredClone(found)] : [] });
    }),
    createTrackingOptions: vi.fn(async (_tenantId: string, categoryId: string, input: { name?: string }) => {
      calls.mutation += 1;
      if (options.mutationError) throw options.mutationError;
      const parent = state.find((candidate) => candidate.trackingCategoryID === categoryId);
      const created = {
        trackingOptionID: nextOptionId,
        name: input.name ?? "",
        status: "ACTIVE" as const,
        trackingCategoryID: categoryId,
      };
      parent?.options.push(created);
      return response({ options: [structuredClone(created)] });
    }),
    updateTrackingOptions: vi.fn(async (_tenantId: string, categoryId: string, optionId: string, input: { name?: string }) => {
      calls.mutation += 1;
      if (options.mutationError) throw options.mutationError;
      const parent = state.find((candidate) => candidate.trackingCategoryID === categoryId);
      const found = parent?.options.find((candidate) => candidate.trackingOptionID === optionId);
      if (found) found.name = input.name ?? found.name;
      return response({ options: found ? [structuredClone(found)] : [] });
    }),
  };
  const manager: TrackingMutationManager = {
    withWriteClient: async <T>(_principal, _authorization, action) =>
      action({ accountingApi: api } as unknown as TrackingWriteClient, { tenantId: TENANT_ID }),
  };
  return { manager, state, calls };
}

describe("tracking mutation schemas and canonical payloads", () => {
  it("allows only bounded names and exact IDs, rejecting lifecycle or move fields", () => {
    expect(trackingCategoryCreateSchema.safeParse({ name: "  Region  " }).data).toEqual({ name: "Region" });
    expect(trackingCategoryCreateSchema.safeParse({ name: "Department", status: "ACTIVE" }).success).toBe(false);
    expect(trackingCategoryUpdateSchema.safeParse({
      trackingCategoryId: CATEGORY_ID,
      name: "Renamed",
      archive: true,
    }).success).toBe(false);
    expect(trackingOptionUpdateSchema.safeParse({
      trackingCategoryId: CATEGORY_ID,
      trackingOptionId: OPTION_ID,
      name: "Renamed",
      moveToCategoryId: CATEGORY_2_ID,
    }).success).toBe(false);
    expect(trackingOptionCreateSchema.safeParse({ trackingCategoryId: CATEGORY_ID, name: "x".repeat(101) }).success).toBe(false);
  });

  it("produces strict canonical payloads with normalized UUIDs", () => {
    expect(canonicalTrackingCategoryCreatePayload({ name: "Region" })).toEqual({
      actionId: "tracking_category.create",
      name: "Region",
    });
    expect(canonicalTrackingCategoryUpdatePayload({ trackingCategoryId: CATEGORY_ID.toUpperCase(), name: "Region" }).trackingCategoryId)
      .toBe(CATEGORY_ID);
    expect(canonicalTrackingOptionCreatePayload({ trackingCategoryId: CATEGORY_ID, name: "West" })).toMatchObject({
      actionId: "tracking_option.create",
      trackingCategoryId: CATEGORY_ID,
    });
    expect(canonicalTrackingOptionUpdatePayload({ trackingCategoryId: CATEGORY_ID, trackingOptionId: OPTION_ID, name: "West" })).toMatchObject({
      actionId: "tracking_option.update",
      trackingOptionId: OPTION_ID,
    });
  });
});

describe("XeroTrackingMutationProvider", () => {
  it("uses the correct Xero method and returns a correlated receipt before Case-owned readback", async () => {
    const fixture = managerWithState();
    const provider = new XeroTrackingMutationProvider(fixture.manager);
    const payload = canonicalTrackingCategoryCreatePayload({ name: "Region" });
    const result = await provider.createCategory("principal", payload, "tracking-create-001", permit("tracking_category.create", payload, "tracking-create-001"));
    expect(result.objectId).toBe(CREATED_CATEGORY_ID);
    expect(result.receipt).toMatchObject({
      receiptType: "XERO_TRACKING_PROVIDER_RECEIPT",
      actionId: "tracking_category.create",
      mutationRequestId: "tracking-create-001",
      idempotencyKey: "tracking-create-001",
      tenantId: TENANT_ID,
      objectId: CREATED_CATEGORY_ID,
      providerCorrelationId: "corr-tracking-001",
    });
    expect(fixture.calls.list).toBe(1);
    expect(fixture.calls.exact).toBe(0);
    expect(fixture.calls.mutation).toBe(1);
  });

  it("rejects case-insensitive ACTIVE duplicates without a provider mutation", async () => {
    const fixture = managerWithState();
    const provider = new XeroTrackingMutationProvider(fixture.manager);
    const payload = canonicalTrackingCategoryCreatePayload({ name: " department " });
    await expect(provider.createCategory("principal", payload, "tracking-create-002", permit("tracking_category.create", payload, "tracking-create-002")))
      .rejects.toMatchObject({ code: "CONFLICT" });
    expect(fixture.calls.mutation).toBe(0);
  });

  it("requires ACTIVE parent and option for exact option rename", async () => {
    const fixture = managerWithState({ state: [{
      ...categoryState()[0],
      options: [{ ...categoryState()[0].options[0], status: "ARCHIVED" }],
    }] });
    const provider = new XeroTrackingMutationProvider(fixture.manager);
    const payload = canonicalTrackingOptionUpdatePayload({ trackingCategoryId: CATEGORY_ID, trackingOptionId: OPTION_ID, name: "East 2" });
    await expect(provider.updateOption("principal", payload, "tracking-update-001", permit("tracking_option.update", payload, "tracking-update-001")))
      .rejects.toMatchObject({ code: "CONFLICT" });
    expect(fixture.calls.mutation).toBe(0);
  });

  it("keeps transport failure in preflight retryable and outside WRITE_RESULT_UNKNOWN", async () => {
    const fixture = managerWithState({ preflightError: Object.assign(new Error("offline"), { code: "ETIMEDOUT" }) });
    const provider = new XeroTrackingMutationProvider(fixture.manager);
    const payload = canonicalTrackingCategoryCreatePayload({ name: "Region" });
    await expect(provider.createCategory("principal", payload, "tracking-create-003", permit("tracking_category.create", payload, "tracking-create-003")))
      .rejects.toMatchObject({ code: "PROVIDER_ERROR", retryable: true });
  });

  it("classifies an uncertain mutation as WRITE_RESULT_UNKNOWN", async () => {
    const fixture = managerWithState({ mutationError: Object.assign(new Error("socket reset"), { code: "ECONNRESET" }) });
    const provider = new XeroTrackingMutationProvider(fixture.manager);
    const payload = canonicalTrackingCategoryCreatePayload({ name: "Region" });
    await expect(provider.createCategory("principal", payload, "tracking-create-004", permit("tracking_category.create", payload, "tracking-create-004")))
      .rejects.toMatchObject({ code: "WRITE_RESULT_UNKNOWN" });
  });
});
