import type {
  AccountingCaseOperation,
  AccountingCaseTarget,
  CommercialDocumentFact,
  CommercialDocumentRoute,
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

/**
 * Exhaustive by construction, not a hand-maintained list: this object
 * literal is checked against `Record<NativeDocumentRoute, true>`, so a
 * NativeDocumentRoute member missing a key here is a compile error, not
 * something a reviewer has to notice. Used by isNativeDocumentRoute() below
 * -- a positive test for the four routes that belong to the GL-duplicate /
 * firm-governance machinery, so that a future route family (a third one,
 * beyond this and CommercialDocumentRoute) short-circuits out of that
 * machinery by default instead of silently falling into it.
 */
const NATIVE_DOCUMENT_ROUTES: Readonly<Record<NativeDocumentRoute, true>> = Object.freeze({
  SALES_INVOICE: true,
  SUPPLIER_BILL: true,
  CUSTOMER_CREDIT: true,
  SUPPLIER_CREDIT: true,
});

export function isNativeDocumentRoute(
  route: AccountingCaseOperation["nativeRoute"],
): route is NativeDocumentRoute {
  return route in NATIVE_DOCUMENT_ROUTES;
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

/**
 * Field-compatibility rules for the commercial-document (quote / purchase
 * order) route family. This is a separate function, not a widened
 * evaluateXeroNativeRouteContract, because CommercialDocumentRoute is a
 * disjoint type from NativeDocumentRoute -- see the doc comment on
 * CommercialDocumentRoute for why. The invalid-combination cases are
 * rejected explicitly (QUOTE x SUPPLIER, PURCHASE_ORDER x CUSTOMER) rather
 * than picked by ternary fallthrough, and adding a third documentKind here
 * without a new case fails to compile.
 */
export type XeroCommercialDocumentRouteContractReason =
  | "QUOTE_COUNTERPARTY_MUST_BE_CUSTOMER"
  | "PURCHASE_ORDER_COUNTERPARTY_MUST_BE_SUPPLIER"
  | "QUOTE_EXPIRY_DATE_REQUIRED";

export interface XeroCommercialDocumentRouteContractDecision {
  route: CommercialDocumentRoute;
  adapterCanPrepare: boolean;
  reasonCodes: XeroCommercialDocumentRouteContractReason[];
}

export function evaluateXeroCommercialDocumentRouteContract(
  fact: Pick<CommercialDocumentFact, "documentKind" | "counterpartyRole" | "expiryDate">,
): XeroCommercialDocumentRouteContractDecision {
  const reasonCodes: XeroCommercialDocumentRouteContractReason[] = [];
  switch (fact.documentKind) {
    case "QUOTE":
      if (fact.counterpartyRole !== "CUSTOMER") reasonCodes.push("QUOTE_COUNTERPARTY_MUST_BE_CUSTOMER");
      if (!fact.expiryDate) reasonCodes.push("QUOTE_EXPIRY_DATE_REQUIRED");
      break;
    case "PURCHASE_ORDER":
      if (fact.counterpartyRole !== "SUPPLIER") reasonCodes.push("PURCHASE_ORDER_COUNTERPARTY_MUST_BE_SUPPLIER");
      break;
    default: {
      const unreachable: never = fact.documentKind;
      throw new Error(`Unhandled commercial document kind: ${String(unreachable)}`);
    }
  }
  return {
    route: fact.documentKind,
    adapterCanPrepare: reasonCodes.length === 0,
    reasonCodes: [...new Set(reasonCodes)].sort((left, right) => left.localeCompare(right)),
  };
}
