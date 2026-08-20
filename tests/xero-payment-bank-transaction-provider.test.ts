import { describe, expect, it, vi } from "vitest";
import {
  canonicalBankTransactionCreatePayload,
  canonicalBankTransactionReversePayload,
  canonicalBankTransactionUpdatePayload,
  canonicalPaymentCreatePayload,
  canonicalPaymentReversePayload,
} from "../src/domain/xeroPaymentBankTransaction.js";
import { XeroPaymentBankTransactionProvider } from "../src/providers/xeroPaymentBankTransactionProvider.js";
import type { XeroClientManager } from "../src/providers/xeroClientManager.js";
import {
  issueProviderWriteTestPermit,
  providerWriteTestContext,
} from "./helpers/xeroProviderPermit.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const connectionId = "connection-payment-bank-provider-test";
const invoiceId = "22222222-2222-4222-8222-222222222222";
const paymentId = "33333333-3333-4333-8333-333333333333";
const bankAccountId = "44444444-4444-4444-8444-444444444444";
const contactId = "55555555-5555-4555-8555-555555555555";
const expenseAccountId = "66666666-6666-4666-8666-666666666666";
const trackingCategoryId = "77777777-7777-4777-8777-777777777777";
const trackingOptionId = "88888888-8888-4888-8888-888888888888";
const bankTransactionId = "99999999-9999-4999-8999-999999999999";
const principal = providerWriteTestContext(connectionId);

function response(body: unknown) {
  return { body, response: { headers: { "xero-correlation-id": "corr-payment-bank" } } };
}

function managerFor(api: Record<string, unknown>, authorizations: unknown[] = []): XeroClientManager {
  return {
    withWriteClient: async (_principal: unknown, authorization: unknown, action: (client: unknown, connection: unknown) => unknown) => {
      authorizations.push(authorization);
      return action({ accountingApi: api }, { tenantId, connectionId });
    },
    withClient: async (_principal: unknown, action: (client: unknown, connection: unknown) => unknown) =>
      action({ accountingApi: api }, { tenantId, connectionId }),
  } as unknown as XeroClientManager;
}

function accounts() {
  return [{
    accountID: bankAccountId,
    code: "090",
    type: "BANK",
    status: "ACTIVE",
    enablePaymentsToAccount: true,
  }, {
    accountID: expenseAccountId,
    code: "400",
    type: "EXPENSE",
    status: "ACTIVE",
  }];
}

function bankRaw(overrides: Record<string, unknown> = {}) {
  return {
    bankTransactionID: bankTransactionId,
    type: "SPEND",
    status: "AUTHORISED",
    contact: { contactID: contactId },
    bankAccount: { accountID: bankAccountId },
    isReconciled: false,
    date: "2026-08-20",
    reference: "EXP-20260820",
    lineAmountTypes: "Exclusive",
    lineItems: [{
      description: "Workspace rent",
      quantity: 1,
      unitAmount: 125.5,
      accountID: expenseAccountId,
      accountCode: "400",
      taxType: "INPUT",
      tracking: [{ trackingCategoryID: trackingCategoryId, trackingOptionID: trackingOptionId }],
    }],
    updatedDateUTC: new Date("2026-08-20T00:00:00.000Z"),
    ...overrides,
  };
}

describe("XeroPaymentBankTransactionProvider", () => {
  it("records only one exact AUTHORISED Invoice payment, sends no external-bank fields, and leaves readback GET-only", async () => {
    const payload = canonicalPaymentCreatePayload({
      invoiceId,
      invoiceType: "ACCREC",
      bankAccountId,
      paymentDate: "2026-08-20",
      amount: "125.5",
      reference: "RCPT-20260820",
    });
    const getInvoices = vi.fn().mockResolvedValue(response({ invoices: [{
      invoiceID: invoiceId,
      type: "ACCREC",
      status: "AUTHORISED",
      amountDue: 200,
    }] }));
    const getAccounts = vi.fn().mockResolvedValue(response({ accounts: accounts() }));
    const createPayment = vi.fn().mockResolvedValue(response({ payments: [{ paymentID: paymentId }] }));
    const getPayment = vi.fn().mockResolvedValue(response({ payments: [{
      paymentID: paymentId,
      status: "AUTHORISED",
      paymentType: "ACCRECPAYMENT",
      invoice: { invoiceID: invoiceId },
      account: { accountID: bankAccountId },
      date: "2026-08-20",
      amount: 125.5,
      reference: "RCPT-20260820",
    }] }));
    const authorizations: unknown[] = [];
    const provider = new XeroPaymentBankTransactionProvider(managerFor({ getInvoices, getAccounts, createPayment, getPayment }, authorizations));
    const key = "payment-create-001";
    const permit = issueProviderWriteTestPermit({
      adapterOperation: "XeroPaymentBankTransactionProvider.createPayment",
      mutationRequestId: key,
      canonicalPayload: payload,
      tenantId,
      connectionId,
    });

    await expect(provider.createPayment(principal, payload, key, permit)).resolves.toMatchObject({
      objectId: paymentId,
      receipt: { operation: "CREATE_PAYMENT_RECORD", objectId: paymentId },
    });
    expect(createPayment).toHaveBeenCalledWith(tenantId, {
      invoice: { invoiceID: invoiceId },
      account: { accountID: bankAccountId },
      date: "2026-08-20",
      amount: 125.5,
      reference: "RCPT-20260820",
    }, key);
    expect(getPayment).not.toHaveBeenCalled();
    expect(authorizations[0]).toMatchObject({
      actionId: "payment.create",
      adapterOperation: "XeroPaymentBankTransactionProvider.createPayment",
      mutationRequestId: key,
      providerIdempotencyKey: key,
      canonicalPayload: payload,
    });
    await expect(provider.readAndVerifyPayment(principal, paymentId, payload)).resolves.toMatchObject({
      paymentId,
      status: "AUTHORISED",
      amount: "125.5000",
    });
  });

  it("rejects insufficient Invoice amount before creating a Payment", async () => {
    const payload = canonicalPaymentCreatePayload({
      invoiceId,
      invoiceType: "ACCREC",
      bankAccountId,
      paymentDate: "2026-08-20",
      amount: "201",
    });
    const createPayment = vi.fn();
    const provider = new XeroPaymentBankTransactionProvider(managerFor({
      getInvoices: vi.fn().mockResolvedValue(response({ invoices: [{
        invoiceID: invoiceId,
        type: "ACCREC",
        status: "AUTHORISED",
        amountDue: 200,
      }] })),
      getAccounts: vi.fn().mockResolvedValue(response({ accounts: accounts() })),
      createPayment,
    }));
    await expect(provider.createPayment(principal, payload, "payment-create-amount", {} as never)).rejects.toMatchObject({
      code: "CONFLICT",
      details: expect.objectContaining({ providerMutationPossible: false }),
    });
    expect(createPayment).not.toHaveBeenCalled();
  });

  it("uses Xero DELETED only as a soft Payment reversal and proves it via a separate same-ID GET", async () => {
    const payload = canonicalPaymentReversePayload({ paymentId });
    const getPayment = vi.fn()
      .mockResolvedValueOnce(response({ payments: [{
        paymentID: paymentId,
        status: "AUTHORISED",
        paymentType: "ACCPAYPAYMENT",
      }] }))
      .mockResolvedValueOnce(response({ payments: [{ paymentID: paymentId, status: "DELETED" }] }));
    const deletePayment = vi.fn().mockResolvedValue(response({ payments: [{
      paymentID: paymentId,
      status: "DELETED",
    }] }));
    const provider = new XeroPaymentBankTransactionProvider(managerFor({ getPayment, deletePayment }));
    const key = "payment-reverse-001";
    const permit = issueProviderWriteTestPermit({
      adapterOperation: "XeroPaymentBankTransactionProvider.reversePayment",
      mutationRequestId: key,
      canonicalPayload: payload,
      tenantId,
      connectionId,
    });
    await expect(provider.reversePayment(principal, payload, key, permit)).resolves.toMatchObject({
      objectId: paymentId,
      receipt: { reversalModel: "XERO_STATUS_DELETED_SOFT_REVERSAL" },
    });
    expect(deletePayment).toHaveBeenCalledWith(tenantId, paymentId, { status: "DELETED" }, key);
    await expect(provider.readAndVerifyPayment(principal, paymentId, payload)).resolves.toEqual({
      paymentId,
      status: "DELETED",
    });
  });

  it("creates one SPEND/RECEIVE ledger record with no bank-feed or reconciliation fields, then verifies by a separate GET", async () => {
    const payload = canonicalBankTransactionCreatePayload({
      type: "SPEND",
      contactId,
      bankAccountId,
      transactionDate: "2026-08-20",
      reference: "EXP-20260820",
      lineAmountType: "EXCLUSIVE",
      lines: [{
        description: "Workspace rent",
        quantity: "1",
        unitAmount: "125.5",
        accountCode: "400",
        taxType: "INPUT",
        trackingOptionIds: [trackingOptionId],
      }],
    });
    const createBankTransactions = vi.fn().mockResolvedValue(response({ bankTransactions: [{
      bankTransactionID: bankTransactionId,
      status: "AUTHORISED",
    }] }));
    const getBankTransaction = vi.fn().mockResolvedValue(response({ bankTransactions: [bankRaw()] }));
    const provider = new XeroPaymentBankTransactionProvider(managerFor({
      getContact: vi.fn().mockResolvedValue(response({ contacts: [{ contactID: contactId, contactStatus: "ACTIVE" }] })),
      getAccounts: vi.fn().mockResolvedValue(response({ accounts: accounts() })),
      getTaxRates: vi.fn().mockResolvedValue(response({ taxRates: [{ taxType: "INPUT", status: "ACTIVE" }] })),
      getTrackingCategories: vi.fn().mockResolvedValue(response({ trackingCategories: [{
        trackingCategoryID: trackingCategoryId,
        status: "ACTIVE",
        options: [{ trackingOptionID: trackingOptionId, status: "ACTIVE" }],
      }] })),
      createBankTransactions,
      getBankTransaction,
    }));
    const key = "bank-create-001";
    const permit = issueProviderWriteTestPermit({
      adapterOperation: "XeroPaymentBankTransactionProvider.createBankTransaction",
      mutationRequestId: key,
      canonicalPayload: payload,
      tenantId,
      connectionId,
    });
    await expect(provider.createBankTransaction(principal, payload, key, permit)).resolves.toMatchObject({
      objectId: bankTransactionId,
      receipt: { operation: "CREATE_BANK_TRANSACTION" },
    });
    const body = createBankTransactions.mock.calls[0]?.[1] as { bankTransactions?: Array<Record<string, unknown>> };
    expect(body.bankTransactions?.[0]).toMatchObject({
      type: "SPEND",
      status: "AUTHORISED",
      contact: { contactID: contactId },
      bankAccount: { accountID: bankAccountId },
      lineItems: [expect.objectContaining({ accountID: expenseAccountId, accountCode: "400", taxType: "INPUT" })],
    });
    expect(body.bankTransactions?.[0]).not.toHaveProperty("isReconciled");
    expect(body.bankTransactions?.[0]).not.toHaveProperty("bankTransfer");
    expect(body.bankTransactions?.[0]).not.toHaveProperty("feed");
    expect(getBankTransaction).not.toHaveBeenCalled();
    await expect(provider.readAndVerifyBankTransaction(principal, bankTransactionId, payload)).resolves.toMatchObject({
      bankTransactionId,
      status: "AUTHORISED",
    });
  });

  it("does exact same-ID/type/version preflight and full replacement for a Bank Transaction", async () => {
    const payload = canonicalBankTransactionUpdatePayload({
      bankTransactionId,
      expectedUpdatedAt: "2026-08-20T08:00:00.000+08:00",
      type: "SPEND",
      contactId,
      bankAccountId,
      transactionDate: "2026-08-20",
      reference: "EXP-20260820",
      lineAmountType: "EXCLUSIVE",
      lines: [{
        description: "Workspace rent",
        quantity: "1",
        unitAmount: "125.5",
        accountCode: "400",
        taxType: "INPUT",
        trackingOptionIds: [trackingOptionId],
      }],
    });
    expect(payload.expectedUpdatedAt).toBe("2026-08-20T00:00:00.000Z");
    const getBankTransaction = vi.fn()
      .mockResolvedValueOnce(response({ bankTransactions: [bankRaw()] }))
      .mockResolvedValueOnce(response({ bankTransactions: [bankRaw()] }));
    const updateBankTransaction = vi.fn().mockResolvedValue(response({ bankTransactions: [bankRaw()] }));
    const provider = new XeroPaymentBankTransactionProvider(managerFor({
      getBankTransaction,
      getContact: vi.fn().mockResolvedValue(response({ contacts: [{ contactID: contactId, contactStatus: "ACTIVE" }] })),
      getAccounts: vi.fn().mockResolvedValue(response({ accounts: accounts() })),
      getTaxRates: vi.fn().mockResolvedValue(response({ taxRates: [{ taxType: "INPUT", status: "ACTIVE" }] })),
      getTrackingCategories: vi.fn().mockResolvedValue(response({ trackingCategories: [{
        trackingCategoryID: trackingCategoryId,
        status: "ACTIVE",
        options: [{ trackingOptionID: trackingOptionId, status: "ACTIVE" }],
      }] })),
      updateBankTransaction,
    }));
    const key = "bank-update-001";
    const authorizationPayload = {
      targetXeroObjectId: bankTransactionId,
      expectedUpdatedAt: payload.expectedUpdatedAt,
      replacement: payload,
    };
    const permit = issueProviderWriteTestPermit({
      adapterOperation: "XeroPaymentBankTransactionProvider.updateBankTransaction",
      mutationRequestId: key,
      canonicalPayload: authorizationPayload,
      tenantId,
      connectionId,
    });
    await expect(provider.updateBankTransaction(principal, payload, key, permit)).resolves.toMatchObject({
      objectId: bankTransactionId,
      receipt: { operation: "UPDATE_BANK_TRANSACTION" },
    });
    expect(updateBankTransaction).toHaveBeenCalledWith(tenantId, bankTransactionId, {
      bankTransactions: [expect.objectContaining({
        bankTransactionID: bankTransactionId,
        type: "SPEND",
        status: "AUTHORISED",
        contact: { contactID: contactId },
        bankAccount: { accountID: bankAccountId },
        lineItems: [expect.objectContaining({ accountID: expenseAccountId, tracking: [{ trackingOptionID: trackingOptionId }] })],
      })],
    }, 4, key);
    await expect(provider.readAndVerifyBankTransaction(principal, bankTransactionId, payload)).resolves.toMatchObject({
      bankTransactionId,
      status: "AUTHORISED",
      type: "SPEND",
    });
  });

  it("soft-reverses an exact unreconciled Bank Transaction to DELETED and verifies by a separate GET", async () => {
    const payload = canonicalBankTransactionReversePayload({ bankTransactionId });
    const getBankTransaction = vi.fn()
      .mockResolvedValueOnce(response({ bankTransactions: [bankRaw()] }))
      .mockResolvedValueOnce(response({ bankTransactions: [bankRaw({ status: "DELETED" })] }));
    const updateBankTransaction = vi.fn().mockResolvedValue(response({ bankTransactions: [bankRaw({ status: "DELETED" })] }));
    const provider = new XeroPaymentBankTransactionProvider(managerFor({ getBankTransaction, updateBankTransaction }));
    const key = "bank-reverse-001";
    const permit = issueProviderWriteTestPermit({
      adapterOperation: "XeroPaymentBankTransactionProvider.reverseBankTransaction",
      mutationRequestId: key,
      canonicalPayload: payload,
      tenantId,
      connectionId,
    });
    await expect(provider.reverseBankTransaction(principal, payload, key, permit)).resolves.toMatchObject({
      objectId: bankTransactionId,
      receipt: { operation: "REVERSE_BANK_TRANSACTION", reversalModel: "XERO_STATUS_DELETED_SOFT_REVERSAL" },
    });
    expect(updateBankTransaction).toHaveBeenCalledWith(tenantId, bankTransactionId, {
      bankTransactions: [{ bankTransactionID: bankTransactionId, status: "DELETED" }],
    }, 4, key);
    expect(getBankTransaction).toHaveBeenCalledTimes(1);
    await expect(provider.readAndVerifyBankTransactionReversal(principal, bankTransactionId, payload)).resolves.toEqual({
      bankTransactionId,
      status: "DELETED",
    });
  });

  it("refuses a reconciled or reconciliation-unknown Bank Transaction before status mutation", async () => {
    const payload = canonicalBankTransactionReversePayload({ bankTransactionId });
    const updateBankTransaction = vi.fn();
    const provider = new XeroPaymentBankTransactionProvider(managerFor({
      getBankTransaction: vi.fn().mockResolvedValue(response({ bankTransactions: [bankRaw({ isReconciled: true })] })),
      updateBankTransaction,
    }));
    const permit = issueProviderWriteTestPermit({
      adapterOperation: "XeroPaymentBankTransactionProvider.reverseBankTransaction",
      mutationRequestId: "bank-reverse-reconciled",
      canonicalPayload: payload,
      tenantId,
      connectionId,
    });
    await expect(provider.reverseBankTransaction(principal, payload, "bank-reverse-reconciled", permit)).rejects.toMatchObject({
      code: "CONFLICT",
      details: expect.objectContaining({ reasonCodes: ["FINAL_RECONCILIATION_EXCLUDED"] }),
    });
    expect(updateBankTransaction).not.toHaveBeenCalled();
  });
});
