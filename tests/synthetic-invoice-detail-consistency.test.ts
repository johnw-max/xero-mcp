import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { InvoiceType } from "../src/domain/schemas.js";
import type { AccountingPrincipal } from "../src/providers/types.js";
import {
  SYNTHETIC_CONNECTION_ID,
  SyntheticXeroAccountingProvider,
} from "../harness/lib/syntheticXeroAccountingProvider.js";

const fixturePath = resolve(import.meta.dirname, "../harness/fixtures/xero/synthetic-ledger.json");

const principal: AccountingPrincipal = {
  actorId: "accountant-synthetic-detail-consistency",
  workspaceId: "workspace-synthetic-detail-consistency",
  subjectType: "USER",
  subjectId: "accountant-synthetic-detail-consistency",
  agentId: "agent-synthetic-detail-consistency",
  oauthInstallationId: "installation-synthetic-detail-consistency",
  bindingId: "binding-synthetic-detail-consistency",
  connectionId: SYNTHETIC_CONNECTION_ID,
  scopes: ["xero.read"],
};

describe("synthetic Xero invoice list/detail consistency", () => {
  it("can read exact, type-compatible detail for every invoice a normal Agent may list", async () => {
    const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as unknown;
    const provider = new SyntheticXeroAccountingProvider(fixture);

    for (const type of ["ACCPAY", "ACCREC"] satisfies InvoiceType[]) {
      const listed = await provider.listInvoices(principal, {
        type,
        page: 1,
        page_size: 100,
        order: "DATE_DESC",
      });

      for (const summary of listed.invoices) {
        let detail;
        try {
          detail = await provider.getInvoice(principal, summary.invoiceId, summary.type);
        } catch (error) {
          const code = error && typeof error === "object" && "code" in error ? String(error.code) : "UNKNOWN";
          throw new Error(
            `Listed ${summary.type} invoice ${summary.invoiceId} exact detail read failed with ${code}.`,
            { cause: error },
          );
        }

        expect(detail).toMatchObject(summary);
        expect(detail.type).toBe(summary.type);
        expect(detail.tenantId).toBe(provider.tenantId);

        if (summary.type === "ACCPAY") {
          await expect(provider.getSupplierBill(principal, summary.invoiceId)).resolves.toEqual(detail);
        }
      }
    }
  });
});
