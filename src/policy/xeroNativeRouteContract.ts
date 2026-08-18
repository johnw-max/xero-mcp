import type {
  AccountingCaseTarget,
  NativeDocumentFact,
  NativeDocumentRoute,
} from "../domain/accountingCase.js";

/**
 * The compiler and the Xero adapter must agree on one released input surface.
 * A source fact may contain more evidence than an adapter can express, but it
 * must never become AUTO_EXECUTE when the selected native route would discard
 * a field or require one that is absent.
 */
export const XERO_NATIVE_ROUTE_CONTRACT_VERSION = "xero-native-route-contract-v1";

export type XeroNativeRouteContractReason =
  | "INVOICE_DUE_DATE_REQUIRED"
  | "CREDIT_NOTE_DUE_DATE_UNSUPPORTED"
  | "CREDIT_NOTE_CURRENCY_RATE_UNSUPPORTED"
  | "FOREIGN_CREDIT_NOTE_UNSUPPORTED"
  | "FOREIGN_INVOICE_RATE_REQUIRED";

export interface XeroNativeRouteContractDecision {
  route: NativeDocumentRoute;
  adapterCanPrepare: boolean;
  reasonCodes: XeroNativeRouteContractReason[];
}

function routeFor(fact: Pick<NativeDocumentFact, "documentKind" | "counterpartyRole">): NativeDocumentRoute {
  if (fact.documentKind === "INVOICE") {
    return fact.counterpartyRole === "CUSTOMER" ? "SALES_INVOICE" : "SUPPLIER_BILL";
  }
  return fact.counterpartyRole === "CUSTOMER" ? "CUSTOMER_CREDIT" : "SUPPLIER_CREDIT";
}

export function evaluateXeroNativeRouteContract(
  fact: Pick<NativeDocumentFact, "documentKind" | "counterpartyRole" | "dueDate" | "currency" | "invoiceRate">,
  target: Pick<AccountingCaseTarget, "baseCurrency">,
): XeroNativeRouteContractDecision {
  const reasonCodes: XeroNativeRouteContractReason[] = [];
  if (fact.documentKind === "INVOICE") {
    if (!fact.dueDate) reasonCodes.push("INVOICE_DUE_DATE_REQUIRED");
    if (fact.currency !== target.baseCurrency && !fact.invoiceRate) {
      reasonCodes.push("FOREIGN_INVOICE_RATE_REQUIRED");
    }
  } else {
    // The released Xero credit-note adapter has no due-date or CurrencyRate
    // fields.  Silently dropping either would break the sealed preparation,
    // so foreign credits remain an explicit unsupported route for now.
    if (fact.dueDate) reasonCodes.push("CREDIT_NOTE_DUE_DATE_UNSUPPORTED");
    if (fact.invoiceRate) reasonCodes.push("CREDIT_NOTE_CURRENCY_RATE_UNSUPPORTED");
    if (fact.currency !== target.baseCurrency) reasonCodes.push("FOREIGN_CREDIT_NOTE_UNSUPPORTED");
  }
  return {
    route: routeFor(fact),
    adapterCanPrepare: reasonCodes.length === 0,
    reasonCodes: [...new Set(reasonCodes)].sort((left, right) => left.localeCompare(right)),
  };
}
