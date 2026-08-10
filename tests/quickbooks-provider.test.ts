import { describe, expect, it, vi } from "vitest";
import type { QuickBooksApiClient, QuickBooksRequestOptions } from "../src/providers/quickbooksClient.js";
import { QuickBooksAccountingProvider } from "../src/providers/quickbooksProvider.js";
import type { QuickBooksSupplierBillInput } from "../src/providers/quickbooksTypes.js";

const input: QuickBooksSupplierBillInput = {
  requestId: "zc.bill.case-001",
  sourceRef: "invoice-case-001.pdf",
  sourceSha256: "a".repeat(64),
  vendorId: "56",
  txnDate: "2026-08-05",
  dueDate: "2026-09-04",
  docNumber: "INV-CASE-001",
  currencyCode: "SGD",
  memo: "Approved supplier invoice",
  globalTaxCalculation: "TaxExcluded",
  invoiceTotal: "129.60",
  taxTotal: "9.60",
  lines: [
    { accountId: "7", amount: "100.00", description: "Bookkeeping subscription", taxCodeId: "3" },
    { accountId: "8", amount: "20.00", description: "Support", taxCodeId: "3" },
  ],
};

function fixtureBill(privateNote = `Approved supplier invoice\nzCloak source=invoice-case-001.pdf; sha256=${"a".repeat(64)}`) {
  return {
    Id: "145",
    SyncToken: "0",
    VendorRef: { value: "56", name: "Acme Pte Ltd" },
    TxnDate: "2026-08-05",
    DueDate: "2026-09-04",
    DocNumber: "INV-CASE-001",
    CurrencyRef: { value: "SGD" },
    GlobalTaxCalculation: "TaxExcluded",
    TotalAmt: 129.6,
    Balance: 129.6,
    TxnTaxDetail: { TotalTax: 9.6 },
    PrivateNote: privateNote,
    Line: [
      {
        Id: "1",
        Amount: 100,
        Description: "Bookkeeping subscription",
        DetailType: "AccountBasedExpenseLineDetail",
        AccountBasedExpenseLineDetail: {
          AccountRef: { value: "7", name: "Subscriptions" },
          TaxCodeRef: { value: "3", name: "GST" },
        },
      },
      {
        Id: "2",
        Amount: 20,
        Description: "Support",
        DetailType: "AccountBasedExpenseLineDetail",
        AccountBasedExpenseLineDetail: {
          AccountRef: { value: "8", name: "Professional fees" },
          TaxCodeRef: { value: "3", name: "GST" },
        },
      },
    ],
    MetaData: { LastUpdatedTime: "2026-08-05T08:00:00+08:00" },
  };
}

function providerWithRequest(readback = fixtureBill()) {
  const request = vi.fn(async (path: string, options: QuickBooksRequestOptions = {}) => {
    if (path === "/vendor/56") return { Vendor: { Id: "56", Active: true } };
    if (path === "/account/7") return { Account: { Id: "7", Active: true } };
    if (path === "/account/8") return { Account: { Id: "8", Active: true } };
    if (path === "/taxcode/3") return { TaxCode: { Id: "3", Active: true } };
    if (path === "/bill" && options.method === "POST") return { Bill: { Id: "145" }, time: "2026-08-05T00:00:00Z" };
    if (path === "/bill/145") return { Bill: readback };
    throw new Error(`Unexpected request ${path}`);
  });
  const client = { realmId: "934145", request, query: vi.fn() } as unknown as QuickBooksApiClient;
  return { provider: new QuickBooksAccountingProvider(client), request };
}

describe("QuickBooks accounting provider", () => {
  it("supports bounded customer, transaction, exact-record, item, and report reads", async () => {
    const query = vi.fn(async (statement: string) => {
      if (statement.startsWith("SELECT * FROM Customer")) {
        return { QueryResponse: { Customer: [
          { Id: "9", DisplayName: "Amy's Bird Sanctuary", PrimaryEmailAddr: { Address: "amy@example.com" } },
          { Id: "10", DisplayName: "Bob's Garage" },
        ] } };
      }
      if (statement.startsWith("SELECT * FROM Item")) {
        return { QueryResponse: { Item: [{ Id: "3", Name: "Design services", Active: true }] } };
      }
      if (statement.startsWith("SELECT * FROM Invoice")) {
        return { QueryResponse: { Invoice: [{ Id: "130", TxnDate: "2026-08-01", TotalAmt: 250 }], totalCount: 1 } };
      }
      throw new Error(`Unexpected query ${statement}`);
    });
    const request = vi.fn(async (path: string) => {
      if (path === "/invoice/130") return { Invoice: { Id: "130", TotalAmt: 250 } };
      if (path === "/reports/ProfitAndLoss") return { Header: { ReportName: "ProfitAndLoss" }, Rows: {} };
      throw new Error(`Unexpected request ${path}`);
    });
    const client = { realmId: "934145", request, query } as unknown as QuickBooksApiClient;
    const provider = new QuickBooksAccountingProvider(client);

    await expect(provider.searchCustomers("amy", 10)).resolves.toMatchObject({
      records: [{ Id: "9" }],
      searchWindow: { complete: true, stoppedReason: "source_exhausted", scanned: 2 },
    });
    await expect(provider.listItems()).resolves.toMatchObject([{ Id: "3" }]);
    await expect(provider.listTransactions({
      entity: "Invoice",
      dateFrom: "2026-08-01",
      dateTo: "2026-08-31",
    })).resolves.toMatchObject({
      entity: "Invoice",
      records: [{ Id: "130" }],
      pagination: { returned: 1, totalCount: 1, hasNextPage: false },
    });
    await expect(provider.getTransaction("Invoice", "130")).resolves.toMatchObject({ Id: "130" });
    await expect(provider.runReport({
      report: "ProfitAndLoss",
      startDate: "2026-01-01",
      endDate: "2026-06-30",
      accountingMethod: "Accrual",
    })).resolves.toMatchObject({ Header: { ReportName: "ProfitAndLoss" } });

    expect(query).toHaveBeenCalledWith(
      "SELECT * FROM Invoice WHERE TxnDate >= '2026-08-01' AND TxnDate <= '2026-08-31' ORDERBY TxnDate DESC STARTPOSITION 1 MAXRESULTS 25",
    );
    expect(request).toHaveBeenCalledWith("/reports/ProfitAndLoss", {
      query: { start_date: "2026-01-01", end_date: "2026-06-30", accounting_method: "Accrual" },
    });
  });

  it("filters customer activity, supports historical report dates, and bounds large report results", async () => {
    const query = vi.fn(async () => ({ QueryResponse: { Invoice: [{ Id: "130" }] } }));
    const request = vi.fn(async (path: string, options: QuickBooksRequestOptions = {}) => {
      if (path === "/reports/AgedReceivables") {
        return {
          Header: { ReportName: "GeneralLedgerDetail" },
          Rows: { Row: Array.from({ length: 5_000 }, (_, index) => ({ ColData: [{ value: String(index) }] })) },
        };
      }
      throw new Error(`Unexpected request ${path} ${JSON.stringify(options)}`);
    });
    const client = { realmId: "934145", request, query } as unknown as QuickBooksApiClient;
    const provider = new QuickBooksAccountingProvider(client);

    await provider.listTransactions({ entity: "Invoice", customerId: "9", openOnly: true });
    expect(query).toHaveBeenCalledWith(
      "SELECT * FROM Invoice WHERE CustomerRef = '9' AND Balance > '0' ORDERBY TxnDate DESC STARTPOSITION 1 MAXRESULTS 25",
    );

    const report = await provider.runReport({
      report: "AgedReceivables",
      asOfDate: "2026-07-31",
      customerId: "9",
      maxRows: 250,
      view: "both",
    });
    expect(request).toHaveBeenCalledWith("/reports/AgedReceivables", {
      query: { report_date: "2026-07-31", customer: "9" },
    });
    expect(report).toMatchObject({
      zcloakReportWindow: { maxRows: 250, returnedRows: 250, totalRows: 5_000, truncated: true },
    });
    expect(((report.Rows as { Row: unknown[] }).Row)).toHaveLength(250);
  });

  it("pages item master data instead of silently stopping at 1000 records", async () => {
    const firstPage = Array.from({ length: 1_000 }, (_, index) => ({ Id: String(index + 1), Name: `Item ${index + 1}` }));
    const query = vi.fn(async (statement: string) => {
      if (statement.includes("STARTPOSITION 1 ")) return { QueryResponse: { Item: firstPage } };
      if (statement.includes("STARTPOSITION 1001 ")) return { QueryResponse: { Item: [{ Id: "1001", Name: "Final item" }] } };
      throw new Error(`Unexpected query ${statement}`);
    });
    const client = { realmId: "934145", request: vi.fn(), query } as unknown as QuickBooksApiClient;
    const provider = new QuickBooksAccountingProvider(client);

    await expect(provider.listItems()).resolves.toHaveLength(1_001);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("finds an existing QuickBooks Bill by exact vendor and normalized supplier document number", async () => {
    const query = vi.fn().mockResolvedValue({ QueryResponse: { Bill: [
      { Id: "900", VendorRef: { value: "56" }, DocNumber: "INV-001", TxnDate: "2026-08-05", TotalAmt: 100 },
      { Id: "901", VendorRef: { value: "77" }, DocNumber: "INV-001", TotalAmt: 25 },
    ] } });
    const client = { realmId: "934145", request: vi.fn(), query } as unknown as QuickBooksApiClient;
    const provider = new QuickBooksAccountingProvider(client);

    await expect(provider.findExistingSupplierBills({ vendorId: "56", docNumber: " inv-001 " }))
      .resolves.toEqual([{ billId: "900", vendorId: "56", docNumber: "INV-001", txnDate: "2026-08-05", total: "100.00" }]);
    expect(query).toHaveBeenCalledWith("SELECT * FROM Bill WHERE DocNumber = 'inv-001' MAXRESULTS 100");
  });

  it("continues vendor search beyond the first 1000 records and matches words in either order", async () => {
    const firstPage = Array.from({ length: 1_000 }, (_, index) => ({ Id: String(index + 1), DisplayName: `Vendor ${index + 1}` }));
    const query = vi.fn(async (statement: string) => {
      if (statement.includes("STARTPOSITION 1 ")) return { QueryResponse: { Vendor: firstPage } };
      if (statement.includes("STARTPOSITION 1001 ")) {
        return { QueryResponse: { Vendor: [{ Id: "1001", DisplayName: "Hicks Hardware" }] } };
      }
      throw new Error(`Unexpected query ${statement}`);
    });
    const client = { realmId: "934145", request: vi.fn(), query } as unknown as QuickBooksApiClient;
    const provider = new QuickBooksAccountingProvider(client);

    await expect(provider.searchVendors("Hardware Hicks", 10)).resolves.toMatchObject({
      records: [{ Id: "1001" }],
      searchWindow: { complete: true, stoppedReason: "source_exhausted", scanned: 1_001 },
    });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("returns found vendors with explicit scan-limit evidence instead of discarding partial matches", async () => {
    const pages = Array.from({ length: 10 }, (_, pageIndex) => Array.from({ length: 1_000 }, (_, index) => ({
      Id: String(pageIndex * 1_000 + index + 1),
      DisplayName: pageIndex === 1 && index === 0 ? "Needle Supplier" : `Vendor ${pageIndex}-${index}`,
    })));
    const query = vi.fn(async (statement: string) => {
      const match = /STARTPOSITION (\d+)/u.exec(statement);
      const start = Number(match?.[1] ?? 1);
      return { QueryResponse: { Vendor: pages[(start - 1) / 1_000] } };
    });
    const client = { realmId: "934145", request: vi.fn(), query } as unknown as QuickBooksApiClient;
    const provider = new QuickBooksAccountingProvider(client);

    await expect(provider.searchVendors("Needle Supplier", 10)).resolves.toMatchObject({
      records: [{ Id: "1001" }],
      searchWindow: {
        requestedLimit: 10,
        returned: 1,
        scanned: 10_000,
        complete: false,
        stoppedReason: "scan_limit",
      },
    });
  });

  it("validates references, writes once with requestid, and returns exact verified readback", async () => {
    const { provider, request } = providerWithRequest();

    const result = await provider.createApprovedSupplierBill(input);

    expect(result.bill).toMatchObject({
      billId: "145",
      realmId: "934145",
      paymentStatus: "OPEN",
      vendor: { id: "56", name: "Acme Pte Ltd" },
      txnDate: "2026-08-05",
      currencyCode: "SGD",
      total: "129.60",
      totalTax: "9.60",
      lines: [
        { amount: "100.00", account: { id: "7" }, taxCode: { id: "3" } },
        { amount: "20.00", account: { id: "8" } },
      ],
    });
    expect(result.receipt).toMatchObject({
      provider: "quickbooks-online",
      realmId: "934145",
      billId: "145",
      requestId: "zc.bill.case-001",
      verified: true,
    });
    expect(request).toHaveBeenCalledWith("/bill", expect.objectContaining({
      method: "POST",
      requestId: "zc.bill.case-001",
      isWrite: true,
    }));
    expect(request.mock.calls.at(-1)?.[0]).toBe("/bill/145");
  });

  it("rejects a readback that lost the source-document marker", async () => {
    const { provider } = providerWithRequest(fixtureBill("Approved supplier invoice"));

    await expect(provider.createApprovedSupplierBill(input)).rejects.toMatchObject({
      code: "READBACK_MISMATCH",
    });
  });

  it("rejects a readback that changed an approved header or tax field", async () => {
    const changed = fixtureBill();
    changed.CurrencyRef = { value: "USD" };
    const { provider } = providerWithRequest(changed);

    await expect(provider.createApprovedSupplierBill(input)).rejects.toMatchObject({
      code: "READBACK_MISMATCH",
      message: expect.stringContaining("currency"),
    });
  });

  it("does not call QuickBooks when local bill validation fails", async () => {
    const { provider, request } = providerWithRequest();

    await expect(provider.createApprovedSupplierBill({ ...input, sourceSha256: "not-a-hash" }))
      .rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(request).not.toHaveBeenCalled();
  });
});
