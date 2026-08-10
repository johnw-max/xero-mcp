import { describe, expect, it, vi } from "vitest";
import { InMemoryAccountingRepository } from "../src/db/inMemoryRepository.js";
import type { ResolvedMcpAccessToken } from "../src/domain/models.js";
import type {
  ContactCreatePrimitive,
  ContactUpdatePrimitive,
  ItemCreatePrimitive,
  ItemUpdatePrimitive,
  SafeContactSnapshot,
  SafeItemSnapshot,
} from "../src/domain/xeroContactItemPrimitives.js";
import {
  prepareContactCreateMutationSchema,
  prepareItemCreateMutationSchema,
  prepareItemUpdateMutationSchema,
} from "../src/domain/xeroContactItemMutationSchemas.js";
import { executePreparedXeroMutationSchema } from "../src/domain/xeroControlledMutationSchemas.js";
import { AppError } from "../src/errors.js";
import type {
  ContactItemMutationProvider,
  ContactItemReadbackVerification,
  ContactItemWriteReceipt,
} from "../src/providers/xeroContactItemMutationProvider.js";
import type { AccountingPrincipal, ActorTenantContext, ConnectionSummary } from "../src/providers/types.js";
import {
  createLegacySharedBearerRequestContext,
  createOAuthRequestContext,
  type RequestContext,
} from "../src/security/requestContext.js";
import { hashObject } from "../src/security/hash.js";
import { XeroContactItemMutationService } from "../src/services/xeroContactItemMutationService.js";
import { XeroMutationService } from "../src/services/xeroMutationService.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const contactId = "22222222-2222-4222-8222-222222222222";
const itemId = "33333333-3333-4333-8333-333333333333";
const now = "2026-08-07T10:00:00.000Z";

function mutationId(preparationId: string): string {
  return `xmr_${hashObject({ preparationId }).slice(0, 32)}`;
}

interface RuntimeProvider {
  connectionStatus(principal: AccountingPrincipal): Promise<ConnectionSummary>;
  resolveContext(principal: AccountingPrincipal): Promise<ActorTenantContext>;
}

class FakeMutationProvider implements ContactItemMutationProvider {
  contactDuplicate = false;
  itemDuplicate = false;
  providerFailure?: "REJECTED" | "UNKNOWN";
  mismatch = false;
  contactSnapshot?: SafeContactSnapshot;
  itemSnapshot?: SafeItemSnapshot;
  lastContactUpdate?: ContactUpdatePrimitive;
  beforeReadback?: () => Promise<void>;

  readonly createContactCalls = vi.fn();
  readonly updateContactCalls = vi.fn();
  readonly createItemCalls = vi.fn();
  readonly updateItemCalls = vi.fn();

  async contactDuplicateExists(): Promise<boolean> {
    return this.contactDuplicate;
  }

  async itemCodeExists(): Promise<boolean> {
    return this.itemDuplicate;
  }

  async getContactExact(): Promise<SafeContactSnapshot | undefined> {
    return this.contactSnapshot;
  }

  async getItemExact(): Promise<SafeItemSnapshot | undefined> {
    return this.itemSnapshot;
  }

  async createContact(
    _principal: AccountingPrincipal,
    prepared: ContactCreatePrimitive,
  ): Promise<ContactItemWriteReceipt> {
    this.createContactCalls(prepared);
    this.#maybeFail();
    this.contactSnapshot = {
      ...prepared.target,
      contactId,
      externalReference: prepared.externalReference,
      contactNumberEvidence: { kind: "OWNED_NAMESPACE" },
      updatedAt: now,
    };
    return { objectId: contactId, receipt: { operation: "CREATE_CONTACT", contactId } };
  }

  async updateContact(
    _principal: AccountingPrincipal,
    prepared: ContactUpdatePrimitive,
  ): Promise<ContactItemWriteReceipt> {
    this.updateContactCalls(prepared);
    this.lastContactUpdate = prepared;
    this.#maybeFail();
    this.contactSnapshot = { ...prepared.target, contactId, ...(prepared.before.externalReference
      ? { externalReference: prepared.before.externalReference }
      : {}), contactNumberEvidence: prepared.before.contactNumberEvidence, updatedAt: now };
    return { objectId: contactId, receipt: { operation: "UPDATE_CONTACT", contactId } };
  }

  async createItem(
    _principal: AccountingPrincipal,
    prepared: ItemCreatePrimitive,
  ): Promise<ContactItemWriteReceipt> {
    this.createItemCalls(prepared);
    this.#maybeFail();
    this.itemSnapshot = { ...prepared.target, itemId, updatedAt: now };
    return { objectId: itemId, receipt: { operation: "CREATE_ITEM", itemId } };
  }

  async updateItem(
    _principal: AccountingPrincipal,
    prepared: ItemUpdatePrimitive,
  ): Promise<ContactItemWriteReceipt> {
    this.updateItemCalls(prepared);
    this.#maybeFail();
    this.itemSnapshot = { ...prepared.target, itemId, updatedAt: now };
    return { objectId: itemId, receipt: { operation: "UPDATE_ITEM", itemId } };
  }

  async readAndVerifyContact(
    _principal: AccountingPrincipal,
    _objectId: string,
    _prepared: ContactCreatePrimitive | ContactUpdatePrimitive,
  ): Promise<ContactItemReadbackVerification<SafeContactSnapshot>> {
    await this.beforeReadback?.();
    if (!this.contactSnapshot) return { verified: false, mismatches: ["readback.invalid"] };
    return this.mismatch
      ? { verified: false, snapshot: { ...this.contactSnapshot, name: "Wrong name" }, mismatches: ["target"] }
      : { verified: true, snapshot: this.contactSnapshot, mismatches: [] };
  }

  async readAndVerifyItem(
    _principal: AccountingPrincipal,
    _objectId: string,
    _prepared: ItemCreatePrimitive | ItemUpdatePrimitive,
  ): Promise<ContactItemReadbackVerification<SafeItemSnapshot>> {
    await this.beforeReadback?.();
    if (!this.itemSnapshot) return { verified: false, mismatches: ["readback.invalid"] };
    return this.mismatch
      ? { verified: false, snapshot: { ...this.itemSnapshot, name: "Wrong name" }, mismatches: ["target"] }
      : { verified: true, snapshot: this.itemSnapshot, mismatches: [] };
  }

  #maybeFail(): void {
    if (this.providerFailure === "REJECTED") {
      throw new AppError("PROVIDER_ERROR", "Xero rejected the mutation.", {
        httpStatus: 422,
        retryable: false,
        details: { writeOutcome: "DEFINITELY_REJECTED", validationErrorCount: 1 },
      });
    }
    if (this.providerFailure === "UNKNOWN") {
      throw new AppError("WRITE_RESULT_UNKNOWN", "The Xero mutation result is unknown.", {
        httpStatus: 502,
        retryable: false,
      });
    }
  }
}

function harness(options: {
  writeEnabled?: boolean;
  oauthBound?: boolean;
  omitAllowedTenantId?: boolean;
} = {}) {
  const repository = new InMemoryAccountingRepository();
  const legacy = createLegacySharedBearerRequestContext({
    actorId: "workspace-test:user:user-test",
    audience: "https://mcp.example.test/mcp",
  });
  const context: RequestContext = options.oauthBound
    ? createOAuthRequestContext({
        issuer: "https://mcp.example.test",
        resolvedToken: {
          tokenId: "token-test",
          clientId: "agent2-accounting-mcp",
          resource: "https://mcp.example.test/mcp",
          audience: "https://mcp.example.test/mcp",
          grantedScopes: ["xero.read", "xero.draft.write"],
          issuedAt: new Date("2026-08-07T00:00:00.000Z"),
          expiresAt: new Date("2030-01-01T00:00:00.000Z"),
          installationId: "installation-test",
          bindingId: "binding-test",
          connectionId: "connection-test",
          bindingRevision: 1,
          authorizationId: "authorization-test",
          workspaceId: "workspace-test",
          subjectType: "USER",
          subjectId: "user-test",
          agentId: "agent-test",
          policyId: "policy-test",
          tenantId,
        } satisfies ResolvedMcpAccessToken,
      })
    : {
        ...legacy,
        connectionId: "connection-test",
        scopes: Object.freeze(["xero.read", "xero.draft.write"]),
      };
  if (options.oauthBound) {
    vi.spyOn(repository, "resolveAgentConnectionBinding").mockResolvedValue({
      installationId: "installation-test",
      bindingId: "binding-test",
      workspaceId: "workspace-test",
      subjectType: "USER",
      subjectId: "user-test",
      agentId: "agent-test",
      connectionId: "connection-test",
      bindingRevision: 1,
      authorizationId: "authorization-test",
      tenantId,
      tenantName: "Demo Org",
      policyId: "policy-test",
    });
  }
  const mutations = new XeroMutationService(repository, {
    confirmationSecret: "test-confirmation-secret-that-is-at-least-32-bytes",
    unsafeAllowLegacyContextForTests: true,
    legacyBindingForTests: {
      actorId: context.actorId,
      workspaceId: "workspace-test",
      tenantId,
      installationId: "installation-test",
      bindingId: "binding-test",
      connectionId: "connection-test",
    },
  });
  const runtime: RuntimeProvider = {
    connectionStatus: vi.fn(async () => ({
      connected: true,
      tenant: { id: tenantId, name: "Demo Org" },
      scopes: ["accounting.contacts", "accounting.settings"],
    })),
    resolveContext: vi.fn(async () => ({ actorId: context.actorId, tenantId, tenantName: "Demo Org" })),
  };
  const provider = new FakeMutationProvider();
  const service = new XeroContactItemMutationService(runtime, provider, mutations, {
    xeroWriteEnabled: options.writeEnabled ?? true,
    ...(options.omitAllowedTenantId ? {} : { xeroAllowedTenantId: tenantId }),
    contactNamespace: "zcacct",
  });
  return { context, provider, repository, service };
}

describe("XeroContactItemMutationService", () => {
  it("uses the exact OAuth Broker binding when the legacy tenant allowlist is intentionally empty", async () => {
    const broker = harness({ oauthBound: true, omitAllowedTenantId: true });
    const prepared = await broker.service.prepareContactCreate(broker.context, {
      source_ref: "work-material:contact-broker-empty-allowlist",
      source_unit_key: "row:broker-empty-allowlist",
      name: "Broker Bound Contact",
      email: "accounts@broker-bound.example",
    });
    await expect(broker.service.createContact(broker.context, {
      preparation_id: prepared.preparation_id,
      request_id: "contact-broker-empty-allowlist",
      confirmation_phrase: prepared.confirmation_phrase,
    })).resolves.toMatchObject({ state: "READBACK_VERIFIED", xero_object_id: contactId });
    expect(broker.provider.createContactCalls).toHaveBeenCalledTimes(1);
  });

  it("prepares, confirms, creates and exactly reads back one Contact idempotently", async () => {
    const { context, provider, service } = harness();
    const prepared = await service.prepareContactCreate(context, {
      source_ref: "work-material:contact-001",
      source_unit_key: "row:1",
      name: "Northwind Singapore",
      email: "accounts@northwind.example",
      phones: [{ phone_type: "OFFICE", phone_number: "+65 6123 4567" }],
    });
    expect(prepared).toMatchObject({
      state: "PREPARED",
      object_type: "CONTACT",
      operation: "CREATE",
      execution_allowed_before_confirmation: false,
      proposal: { operation: "CREATE", target: { name: "Northwind Singapore" } },
    });

    const execution = {
      preparation_id: prepared.preparation_id,
      request_id: "contact-create-001",
      confirmation_phrase: prepared.confirmation_phrase,
    };
    await expect(service.createContact(context, execution)).resolves.toMatchObject({
      state: "READBACK_VERIFIED",
      object_type: "CONTACT",
      operation: "CREATE",
      xero_object_id: contactId,
    });
    await expect(service.createContact(context, execution)).resolves.toMatchObject({
      state: "READBACK_VERIFIED",
      xero_object_id: contactId,
    });
    expect(provider.createContactCalls).toHaveBeenCalledTimes(1);
  });

  it("fresh-reads a Contact at prepare and execute while preserving an external ContactNumber", async () => {
    const { context, provider, service } = harness();
    provider.contactSnapshot = {
      contactId,
      name: "Northwind Singapore",
      email: "old@northwind.example",
      contactNumberEvidence: { kind: "EXTERNAL_FINGERPRINT", fingerprint: "a".repeat(64) },
      updatedAt: now,
    };
    const prepared = await service.prepareContactUpdate(context, {
      source_ref: "work-material:contact-update-001",
      source_unit_key: "row:1",
      source_sha256: "b".repeat(64),
      contact_id: contactId,
      patch: { email: "new@northwind.example" },
    });
    expect(prepared).toMatchObject({
      object_type: "CONTACT",
      operation: "UPDATE",
      proposal: {
        contactNumberEvidence: { kind: "EXTERNAL_FINGERPRINT", fingerprint: "a".repeat(64) },
        target: { email: "new@northwind.example" },
      },
      source: { sha256: "b".repeat(64), evidence_type: "AGENT_ASSERTED_UNVERIFIED" },
    });

    await expect(service.updateContact(context, {
      preparation_id: prepared.preparation_id,
      request_id: "contact-update-001",
      confirmation_phrase: prepared.confirmation_phrase,
    })).resolves.toMatchObject({
      state: "READBACK_VERIFIED",
      operation: "UPDATE",
      xero_object_id: contactId,
    });
    expect(provider.lastContactUpdate?.before.contactNumberEvidence).toEqual({
      kind: "EXTERNAL_FINGERPRINT",
      fingerprint: "a".repeat(64),
    });
    expect(provider.lastContactUpdate?.before.externalReference).toBeUndefined();
  });

  it("creates and updates only a basic untracked Item with fresh-version protection", async () => {
    const { context, provider, service } = harness();
    const createPreparation = await service.prepareItemCreate(context, {
      source_ref: "work-material:item-create-001",
      source_unit_key: "row:1",
      code: "CONSULT-01",
      name: "Consulting hour",
      description: "Professional services",
    });
    await expect(service.createItem(context, {
      preparation_id: createPreparation.preparation_id,
      request_id: "item-create-001",
      confirmation_phrase: createPreparation.confirmation_phrase,
    })).resolves.toMatchObject({
      state: "READBACK_VERIFIED",
      object_type: "ITEM",
      operation: "CREATE",
      xero_object_id: itemId,
      status: "UNTRACKED",
    });

    provider.itemSnapshot = {
      itemId,
      code: "CONSULT-01",
      name: "Consulting hour",
      description: "Professional services",
      isSold: true,
      isPurchased: true,
      isTrackedAsInventory: false,
      updatedAt: now,
    };
    const updatePreparation = await service.prepareItemUpdate(context, {
      source_ref: "work-material:item-update-001",
      source_unit_key: "row:1",
      item_id: itemId,
      patch: { description: "Updated professional services" },
    });
    await expect(service.updateItem(context, {
      preparation_id: updatePreparation.preparation_id,
      request_id: "item-update-001",
      confirmation_phrase: updatePreparation.confirmation_phrase,
    })).resolves.toMatchObject({
      state: "READBACK_VERIFIED",
      object_type: "ITEM",
      operation: "UPDATE",
      xero_object_id: itemId,
    });
    expect(provider.createItemCalls).toHaveBeenCalledTimes(1);
    expect(provider.updateItemCalls).toHaveBeenCalledTimes(1);
  });

  it("does not call Xero for a wrong confirmation phrase or a closed write gate", async () => {
    const wrong = harness();
    const prepared = await wrong.service.prepareContactCreate(wrong.context, {
      source_ref: "work-material:contact-wrong-phrase",
      source_unit_key: "row:1",
      name: "Wrong Phrase Limited",
    });
    await expect(wrong.service.createContact(wrong.context, {
      preparation_id: prepared.preparation_id,
      request_id: "contact-wrong-phrase",
      confirmation_phrase: `${prepared.confirmation_phrase}-WRONG`,
    })).rejects.toMatchObject({ code: "APPROVAL_INVALID" });
    expect(wrong.provider.createContactCalls).not.toHaveBeenCalled();

    const closed = harness({ writeEnabled: false });
    const closedPreparation = await closed.service.prepareItemCreate(closed.context, {
      source_ref: "work-material:item-write-gate",
      source_unit_key: "row:1",
      code: "GATE-01",
      name: "Closed gate item",
    });
    await expect(closed.service.createItem(closed.context, {
      preparation_id: closedPreparation.preparation_id,
      request_id: "item-write-gate-closed",
      confirmation_phrase: closedPreparation.confirmation_phrase,
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(closed.provider.createItemCalls).not.toHaveBeenCalled();

    const legacyWithoutAllowlist = harness({ omitAllowedTenantId: true });
    const legacyPrepared = await legacyWithoutAllowlist.service.prepareContactCreate(
      legacyWithoutAllowlist.context,
      {
        source_ref: "work-material:contact-legacy-no-allowlist",
        source_unit_key: "row:legacy-no-allowlist",
        name: "Legacy No Allowlist Limited",
      },
    );
    await expect(legacyWithoutAllowlist.service.createContact(legacyWithoutAllowlist.context, {
      preparation_id: legacyPrepared.preparation_id,
      request_id: "contact-legacy-no-allowlist",
      confirmation_phrase: legacyPrepared.confirmation_phrase,
    })).rejects.toMatchObject({
      code: "FORBIDDEN",
      details: { denyReasons: expect.arrayContaining(["WRITE_TENANT_NOT_ALLOWED"]) },
    });
    expect(legacyWithoutAllowlist.provider.createContactCalls).not.toHaveBeenCalled();
  });

  it("blocks exact duplicates both at preparation and immediately before create", async () => {
    const initial = harness();
    initial.provider.contactDuplicate = true;
    await expect(initial.service.prepareContactCreate(initial.context, {
      source_ref: "work-material:contact-duplicate-initial",
      source_unit_key: "row:1",
      name: "Duplicate Limited",
    })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    const raced = harness();
    const prepared = await raced.service.prepareItemCreate(raced.context, {
      source_ref: "work-material:item-duplicate-race",
      source_unit_key: "row:1",
      code: "DUP-01",
      name: "Duplicate race item",
    });
    raced.provider.itemDuplicate = true;
    await expect(raced.service.createItem(raced.context, {
      preparation_id: prepared.preparation_id,
      request_id: "item-duplicate-race",
      confirmation_phrase: prepared.confirmation_phrase,
    })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(raced.provider.createItemCalls).not.toHaveBeenCalled();
    await expect(raced.repository.getXeroMutationRequest(mutationId(prepared.preparation_id))).resolves.toMatchObject({
      state: "FAILED_VALIDATION",
      validationReceipt: { reason: "DUPLICATE", objectType: "ITEM", operation: "CREATE" },
    });
  });

  it("fresh-reads immediately before update and records a stale object without writing", async () => {
    const { context, provider, repository, service } = harness();
    provider.itemSnapshot = {
      itemId,
      code: "STALE-01",
      name: "Before",
      isSold: true,
      isPurchased: true,
      isTrackedAsInventory: false,
      updatedAt: now,
    };
    const prepared = await service.prepareItemUpdate(context, {
      source_ref: "work-material:item-stale",
      source_unit_key: "row:1",
      item_id: itemId,
      patch: { name: "After" },
    });
    provider.itemSnapshot = {
      ...provider.itemSnapshot,
      name: "Changed elsewhere",
      updatedAt: "2026-08-07T10:05:00.000Z",
    };
    await expect(service.updateItem(context, {
      preparation_id: prepared.preparation_id,
      request_id: "item-stale-update",
      confirmation_phrase: prepared.confirmation_phrase,
    })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(provider.updateItemCalls).not.toHaveBeenCalled();
    await expect(repository.getXeroMutationRequest(mutationId(prepared.preparation_id))).resolves.toMatchObject({
      state: "FAILED_VALIDATION",
      validationReceipt: { reason: "STALE_VERSION", objectType: "ITEM", operation: "UPDATE" },
    });
  });

  it("separates a definite provider rejection from an unknown write outcome", async () => {
    const rejected = harness();
    rejected.provider.providerFailure = "REJECTED";
    const rejectedPreparation = await rejected.service.prepareContactCreate(rejected.context, {
      source_ref: "work-material:contact-provider-rejected",
      source_unit_key: "row:1",
      name: "Rejected Contact",
    });
    await expect(rejected.service.createContact(rejected.context, {
      preparation_id: rejectedPreparation.preparation_id,
      request_id: "contact-provider-rejected",
      confirmation_phrase: rejectedPreparation.confirmation_phrase,
    })).rejects.toMatchObject({ code: "PROVIDER_ERROR", retryable: false });
    await expect(rejected.repository.getXeroMutationRequest(
      mutationId(rejectedPreparation.preparation_id),
    )).resolves.toMatchObject({
      state: "PROVIDER_REJECTED",
      providerRejectionReceipt: { writeOutcome: "DEFINITELY_REJECTED" },
    });

    const unknown = harness();
    unknown.provider.providerFailure = "UNKNOWN";
    const unknownPreparation = await unknown.service.prepareItemCreate(unknown.context, {
      source_ref: "work-material:item-provider-unknown",
      source_unit_key: "row:1",
      code: "UNKNOWN-01",
      name: "Unknown Item",
    });
    await expect(unknown.service.createItem(unknown.context, {
      preparation_id: unknownPreparation.preparation_id,
      request_id: "item-provider-unknown",
      confirmation_phrase: unknownPreparation.confirmation_phrase,
    })).rejects.toMatchObject({ code: "WRITE_RESULT_UNKNOWN" });
    await expect(unknown.repository.getXeroMutationRequest(
      mutationId(unknownPreparation.preparation_id),
    )).resolves.toMatchObject({ state: "WRITE_UNCERTAIN" });
  });

  it("persists a readback mismatch and never reports the mutation as verified", async () => {
    const { context, provider, repository, service } = harness();
    provider.mismatch = true;
    const prepared = await service.prepareContactCreate(context, {
      source_ref: "work-material:contact-readback-mismatch",
      source_unit_key: "row:1",
      name: "Expected Contact",
    });
    await expect(service.createContact(context, {
      preparation_id: prepared.preparation_id,
      request_id: "contact-readback-mismatch",
      confirmation_phrase: prepared.confirmation_phrase,
    })).rejects.toMatchObject({ code: "READBACK_MISMATCH" });
    await expect(repository.getXeroMutationRequest(mutationId(prepared.preparation_id))).resolves.toMatchObject({
      state: "READBACK_MISMATCH",
      xeroObjectId: contactId,
      writeReceipt: { operation: "CREATE_CONTACT", contactId },
    });
  });

  it("durably stores the exact ID and receipt before starting the provider readback", async () => {
    const { context, provider, repository, service } = harness();
    const prepared = await service.prepareItemCreate(context, {
      source_ref: "work-material:item-evidence-order",
      source_unit_key: "row:1",
      code: "ORDER-01",
      name: "Evidence order",
    });
    provider.beforeReadback = async () => {
      await expect(repository.getXeroMutationRequest(mutationId(prepared.preparation_id))).resolves.toMatchObject({
        state: "WRITE_IN_FLIGHT",
        xeroObjectId: itemId,
        writeReceipt: { operation: "CREATE_ITEM", itemId },
      });
    };
    await expect(service.createItem(context, {
      preparation_id: prepared.preparation_id,
      request_id: "item-evidence-order",
      confirmation_phrase: prepared.confirmation_phrase,
    })).resolves.toMatchObject({ state: "READBACK_VERIFIED", xero_object_id: itemId });
  });

  it("rejects W2 accounting defaults, prices, tracking, sensitive Contact fields and execution payloads", () => {
    expect(prepareItemCreateMutationSchema.safeParse({
      source_ref: "work-material:item-w2-create",
      source_unit_key: "row:1",
      code: "W2-01",
      sales_details: { unit_price: 99, account_code: "200", tax_type: "OUTPUT" },
    }).success).toBe(false);
    expect(prepareItemUpdateMutationSchema.safeParse({
      source_ref: "work-material:item-w2-update",
      source_unit_key: "row:1",
      item_id: itemId,
      patch: { unit_price: 99, is_tracked_as_inventory: true },
    }).success).toBe(false);
    expect(prepareContactCreateMutationSchema.safeParse({
      source_ref: "work-material:contact-sensitive",
      source_unit_key: "row:1",
      name: "Sensitive Contact",
      bank_account_details: "do-not-accept",
      tax_number: "do-not-accept",
    }).success).toBe(false);
    expect(executePreparedXeroMutationSchema.safeParse({
      preparation_id: `xmp_${"a".repeat(32)}`,
      request_id: "strict-execute-001",
      confirmation_phrase: "CONFIRM-EXACT",
      status: "ACTIVE",
      payload: { attacker: true },
    }).success).toBe(false);
  });
});
