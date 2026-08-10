import type {
  QuickBooksAccount,
  QuickBooksBillSnapshot,
  QuickBooksCompanyInfo,
  QuickBooksCustomer,
  QuickBooksItem,
  QuickBooksSupplierBillInput,
  QuickBooksTaxCode,
  QuickBooksVendor,
} from "../providers/quickbooksTypes.js";
import type {
  QuickBooksBillListInput,
  QuickBooksBillListResult,
  QuickBooksExistingBillMatch,
  QuickBooksReferenceValidationResult,
  QuickBooksSearchResult,
} from "../providers/quickbooksProvider.js";
import type {
  QuickBooksReportInput,
  QuickBooksTransactionEntity,
  QuickBooksTransactionListInput,
  QuickBooksTransactionListResult,
} from "../providers/quickbooksProvider.js";
import type { QuickBooksClientManager } from "./clientManager.js";
import type {
  QuickBooksConnectionStatus,
  QuickBooksProviderCapabilities,
  QuickBooksProviderResolver,
  ResolvedQuickBooksProvider,
} from "./service.js";
import { AppError } from "../errors.js";

class BoundQuickBooksProvider implements QuickBooksProviderCapabilities {
  readonly #actorId: string;
  readonly #manager: QuickBooksClientManager;

  constructor(actorId: string, manager: QuickBooksClientManager) {
    this.#actorId = actorId;
    this.#manager = manager;
  }

  getCompany(): Promise<QuickBooksCompanyInfo> {
    return this.#manager.withProvider(this.#actorId, (provider) => provider.getCompany());
  }

  listAccounts(): Promise<QuickBooksAccount[]> {
    return this.#manager.withProvider(this.#actorId, (provider) => provider.listAccounts());
  }

  listTaxCodes(): Promise<QuickBooksTaxCode[]> {
    return this.#manager.withProvider(this.#actorId, (provider) => provider.listTaxCodes());
  }

  searchVendors(search: string, limit?: number): Promise<QuickBooksSearchResult<QuickBooksVendor>> {
    return this.#manager.withProvider(this.#actorId, (provider) => provider.searchVendors(search, limit));
  }

  searchCustomers(search: string, limit?: number): Promise<QuickBooksSearchResult<QuickBooksCustomer>> {
    return this.#manager.withProvider(this.#actorId, (provider) => provider.searchCustomers(search, limit));
  }

  listItems(): Promise<QuickBooksItem[]> {
    return this.#manager.withProvider(this.#actorId, (provider) => provider.listItems());
  }

  listTransactions(input: QuickBooksTransactionListInput): Promise<QuickBooksTransactionListResult> {
    return this.#manager.withProvider(this.#actorId, (provider) => provider.listTransactions(input));
  }

  getTransaction(entity: QuickBooksTransactionEntity, transactionId: string): Promise<Record<string, unknown>> {
    return this.#manager.withProvider(this.#actorId, (provider) => provider.getTransaction(entity, transactionId));
  }

  runReport(input: QuickBooksReportInput): Promise<Record<string, unknown>> {
    return this.#manager.withProvider(this.#actorId, (provider) => provider.runReport(input));
  }

  listBills(input?: QuickBooksBillListInput): Promise<QuickBooksBillListResult> {
    return this.#manager.withProvider(this.#actorId, (provider) => provider.listBills(input));
  }

  getBill(billId: string): Promise<QuickBooksBillSnapshot> {
    return this.#manager.withProvider(this.#actorId, (provider) => provider.getBill(billId));
  }

  findExistingSupplierBills(input: { vendorId: string; docNumber: string }): Promise<QuickBooksExistingBillMatch[]> {
    return this.#manager.withProvider(this.#actorId, (provider) => provider.findExistingSupplierBills(input));
  }

  validateSupplierBill(input: QuickBooksSupplierBillInput): Promise<QuickBooksReferenceValidationResult> {
    return this.#manager.withProvider(this.#actorId, (provider) => provider.validateSupplierBill(input));
  }

  createApprovedSupplierBill(input: QuickBooksSupplierBillInput): Promise<{
    bill: QuickBooksBillSnapshot;
    receipt: Record<string, unknown>;
  }> {
    return this.#manager.withProvider(this.#actorId, (provider) => provider.createApprovedSupplierBill(input));
  }

  getTrialBalance(date?: string): Promise<Record<string, unknown>> {
    return this.#manager.withProvider(this.#actorId, (provider) => provider.getTrialBalance(date));
  }
}

export class ServerBoundQuickBooksProviderResolver implements QuickBooksProviderResolver {
  readonly #manager: QuickBooksClientManager;
  readonly #connectUrl: ((actorId: string) => Promise<{ url: string; expiresAt: Date }>) | undefined;

  constructor(options: {
    manager: QuickBooksClientManager;
    connectUrl?: (actorId: string) => Promise<{ url: string; expiresAt: Date }>;
  }) {
    this.#manager = options.manager;
    this.#connectUrl = options.connectUrl;
  }

  async connectionStatus(actorId: string): Promise<QuickBooksConnectionStatus> {
    const connect = this.#connectUrl ? await this.#connectUrl(actorId) : undefined;
    try {
      const connection = await this.#manager.resolveSingleConnection(actorId);
      return {
        connected: true,
        company: { realmId: connection.realmId, name: connection.companyName },
        scopes: connection.grantedScopes,
        ...(connect ? {
          connectUrl: connect.url,
          connectUrlExpiresAt: connect.expiresAt.toISOString(),
          connectAction: "REPLACE_CURRENT_COMPANY" as const,
        } : {}),
      };
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== "NOT_CONNECTED") {
        throw error;
      }
      return {
        connected: false,
        scopes: [],
        ...(connect ? {
          connectUrl: connect.url,
          connectUrlExpiresAt: connect.expiresAt.toISOString(),
          connectAction: "CONNECT_COMPANY" as const,
        } : {}),
      };
    }
  }

  async resolve(actorId: string): Promise<ResolvedQuickBooksProvider> {
    const connection = await this.#manager.resolveSingleConnection(actorId);
    return {
      realmId: connection.realmId,
      companyName: connection.companyName,
      provider: new BoundQuickBooksProvider(actorId, this.#manager),
    };
  }
}
