import {
  LEDGER_CONTROL_KERNEL_VERSION,
  type LedgerAutonomousAuthorizationReceipt,
} from "../../src/control-kernel/ledgerControlKernel.js";
import type { XeroAutonomousWriteAction } from "../../src/policy/xeroAutonomousActions.js";
import { hashObject } from "../../src/security/hash.js";
import {
  issueXeroProviderWritePermit,
  type XeroProviderWriteAdapterOperation,
} from "../../src/security/xeroProviderWritePermit.js";
import type { RequestContext } from "../../src/security/requestContext.js";

const WORKSPACE_ID = "workspace-provider-test";
const SUBJECT_ID = "user-provider-test";
const AGENT_ID = "agent-provider-test";
const INSTALLATION_ID = "installation-provider-test";
const BINDING_ID = "binding-provider-test";
const BINDING_REVISION = 3;
const TARGET_SESSION_ID = "target-session-provider-test";

const ACTION_BY_ADAPTER_OPERATION = Object.freeze({
  "XeroAccountingProvider.createDraftSupplierBill": "supplier_bill.create_draft",
  "XeroAccountingProvider.createDraftSalesInvoice": "customer_invoice.create_draft",
  "XeroControlledMutationProvider.createQuoteDraft": "quote.create_draft",
  "XeroControlledMutationProvider.createPurchaseOrderDraft": "purchase_order.create_draft",
  "XeroCreditNoteManualJournalProvider.createCreditNoteDraft": "credit_note.create_draft",
  "XeroCreditNoteManualJournalProvider.createManualJournalDraft": "manual_journal.create_draft",
  "XeroContactItemMutationProvider.createContact": "contact.create_basic",
  "XeroContactItemMutationProvider.updateContact": "contact.update_basic",
  "XeroContactItemMutationProvider.createItem": "item.create_basic_untracked",
  "XeroContactItemMutationProvider.updateItem": "item.update_basic_untracked",
} as const satisfies Readonly<Record<XeroProviderWriteAdapterOperation, XeroAutonomousWriteAction>>);

export function providerWriteTestContext(connectionId: string): RequestContext {
  return Object.freeze({
    requestId: "request-provider-test",
    actorId: `${WORKSPACE_ID}:user:${SUBJECT_ID}`,
    workspaceId: WORKSPACE_ID,
    subjectType: "USER" as const,
    subjectId: SUBJECT_ID,
    userId: SUBJECT_ID,
    agentId: AGENT_ID,
    oauthInstallationId: INSTALLATION_ID,
    bindingId: BINDING_ID,
    connectionId,
    bindingRevision: BINDING_REVISION,
    targetSessionHash: "f".repeat(64),
    targetSessionId: TARGET_SESSION_ID,
    targetSessionExpiresAt: new Date("2099-01-01T00:00:00.000Z"),
    scopes: Object.freeze(["xero.read", "xero.draft.write"]),
    roles: Object.freeze([] as string[]),
    authn: Object.freeze({
      issuer: "https://broker.provider.test",
      subject: `user:${SUBJECT_ID}`,
      audience: "https://xero-mcp.provider.test/mcp",
      tokenId: "token-provider-test",
    }),
    legacyDemo: false as const,
  });
}

export function issueProviderWriteTestPermit(input: Readonly<{
  adapterOperation: XeroProviderWriteAdapterOperation;
  mutationRequestId: string;
  canonicalPayload: unknown;
  tenantId: string;
  connectionId: string;
  context?: RequestContext;
}>) {
  const context = input.context ?? providerWriteTestContext(input.connectionId);
  const canonicalPayloadHash = hashObject(input.canonicalPayload);
  const unsigned = {
    receiptType: "LEDGER_AUTONOMOUS_AUTHORIZATION" as const,
    kernelVersion: LEDGER_CONTROL_KERNEL_VERSION,
    actionId: ACTION_BY_ADAPTER_OPERATION[input.adapterOperation],
    providerId: "xero",
    tenantId: input.tenantId,
    actorId: context.actorId,
    workspaceId: context.workspaceId as string,
    agentId: context.agentId as string,
    installationId: context.oauthInstallationId as string,
    bindingId: context.bindingId as string,
    bindingRevision: context.bindingRevision as number,
    connectionId: input.connectionId,
    targetSessionId: context.targetSessionId as string,
    delegationId: "delegation-provider-test",
    delegationRevision: 1,
    canonicalPayloadHash,
    sourceRevisionHash: "a".repeat(64),
    caseVersion: 0,
    authoritySnapshotRevision: 1,
    authoritySnapshotHash: "d".repeat(64),
    deterministicValidationReceiptHash: "b".repeat(64),
    providerCapabilityReceiptHash: "c".repeat(64),
    issuedAt: "2026-08-13T00:00:00.000Z",
  };
  const receipt: LedgerAutonomousAuthorizationReceipt = Object.freeze({
    ...unsigned,
    receiptHash: hashObject(unsigned),
  });
  return issueXeroProviderWritePermit({
    adapterOperation: input.adapterOperation,
    request: {
      mutationRequestId: input.mutationRequestId,
      canonicalPayloadHash,
      authorizationReceipt: receipt as unknown as Record<string, unknown>,
    },
  });
}
