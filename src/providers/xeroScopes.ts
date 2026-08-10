export interface XeroScopeCapability {
  capability: string;
  anyOf: readonly string[];
}

export const BROKER_MCP_SCOPES = ["xero.read", "xero.draft.write"] as const;
export type BrokerMcpScope = (typeof BROKER_MCP_SCOPES)[number];

const BROKER_OFFLINE_REFRESH_CAPABILITY: XeroScopeCapability = {
  capability: "offline token refresh",
  anyOf: ["offline_access"],
};

const BROKER_SETTINGS_READ_CAPABILITY: XeroScopeCapability = {
  capability: "organisation, account, and tax settings read",
  anyOf: ["accounting.settings.read", "accounting.settings"],
};

const BROKER_CONTACT_READ_CAPABILITY: XeroScopeCapability = {
  capability: "contact read",
  anyOf: ["accounting.contacts.read", "accounting.contacts"],
};

const BROKER_TRIAL_BALANCE_READ_CAPABILITY: XeroScopeCapability = {
  capability: "trial balance read",
  anyOf: ["accounting.reports.trialbalance.read", "accounting.reports.read"],
};

const BROKER_BASE_XERO_SCOPE_CAPABILITIES: readonly XeroScopeCapability[] = [
  BROKER_OFFLINE_REFRESH_CAPABILITY,
] as const;

const BROKER_INVOICE_READ_CAPABILITY: XeroScopeCapability = {
  capability: "invoice read",
  anyOf: [
    "accounting.invoices.read",
    "accounting.invoices",
    "accounting.transactions.read",
    "accounting.transactions",
  ],
};

const BROKER_DRAFT_WRITE_CAPABILITY: XeroScopeCapability = {
  capability: "draft invoice, bill, credit-note, quote, and purchase-order write",
  anyOf: ["accounting.invoices", "accounting.transactions"],
};

const BROKER_MANUAL_JOURNAL_WRITE_CAPABILITY: XeroScopeCapability = {
  capability: "manual journal draft write",
  anyOf: ["accounting.manualjournals", "accounting.transactions"],
};

const BROKER_CONTACT_WRITE_CAPABILITY: XeroScopeCapability = {
  capability: "contact create and update",
  anyOf: ["accounting.contacts"],
};

const BROKER_ITEM_WRITE_CAPABILITY: XeroScopeCapability = {
  capability: "item create and update",
  anyOf: ["accounting.settings"],
};

const BROKER_PAYMENT_READ_CAPABILITY: XeroScopeCapability = {
  capability: "payment history read",
  anyOf: ["accounting.payments.read", "accounting.transactions.read", "accounting.transactions"],
};

const BROKER_MANUAL_JOURNAL_READ_CAPABILITY: XeroScopeCapability = {
  capability: "manual journal read",
  anyOf: [
    "accounting.manualjournals.read",
    "accounting.manualjournals",
    "accounting.transactions.read",
    "accounting.transactions",
  ],
};

const BROKER_BANK_TRANSACTION_READ_CAPABILITY: XeroScopeCapability = {
  capability: "bank transaction read",
  anyOf: [
    "accounting.banktransactions.read",
    "accounting.banktransactions",
    "accounting.transactions.read",
    "accounting.transactions",
  ],
};

// This baseline is also used by the OAuth-off legacy rollback path. It must be
// able to serve the complete released controlled-write surface, while granular
// payment history keeps its earlier rollback-compatible optional treatment.
// Deprecated broad scopes remain accepted as migration compatibility
// equivalents for invoices/manual journals only; they never stand in for
// contact or settings writes.
export const REQUIRED_XERO_SCOPE_CAPABILITIES: readonly XeroScopeCapability[] = [
  BROKER_OFFLINE_REFRESH_CAPABILITY,
  BROKER_DRAFT_WRITE_CAPABILITY,
  BROKER_ITEM_WRITE_CAPABILITY,
  BROKER_CONTACT_WRITE_CAPABILITY,
  BROKER_MANUAL_JOURNAL_WRITE_CAPABILITY,
  BROKER_BANK_TRANSACTION_READ_CAPABILITY,
  BROKER_TRIAL_BALANCE_READ_CAPABILITY,
] as const;

const LEGACY_STRICT_SETTINGS_READ_CAPABILITY: XeroScopeCapability = {
  capability: "organisation, account, and tax settings read",
  anyOf: ["accounting.settings.read"],
};

const LEGACY_STRICT_CONTACT_READ_CAPABILITY: XeroScopeCapability = {
  capability: "contact read",
  anyOf: ["accounting.contacts.read"],
};

const LEGACY_STRICT_INVOICE_READ_CAPABILITY: XeroScopeCapability = {
  capability: "invoice read",
  anyOf: ["accounting.invoices.read", "accounting.transactions.read"],
};

const LEGACY_STRICT_PAYMENT_READ_CAPABILITY: XeroScopeCapability = {
  capability: "payment history read",
  anyOf: ["accounting.payments.read", "accounting.transactions.read"],
};

const LEGACY_STRICT_MANUAL_JOURNAL_READ_CAPABILITY: XeroScopeCapability = {
  capability: "manual journal read",
  anyOf: ["accounting.manualjournals.read", "accounting.transactions.read"],
};

const LEGACY_STRICT_BANK_TRANSACTION_READ_CAPABILITY: XeroScopeCapability = {
  capability: "bank transaction read",
  anyOf: ["accounting.banktransactions.read", "accounting.transactions.read"],
};

const LEGACY_STRICT_TRIAL_BALANCE_READ_CAPABILITY: XeroScopeCapability = {
  capability: "trial balance read",
  anyOf: ["accounting.reports.trialbalance.read", "accounting.reports.read"],
};

export const REQUIRED_READ_ONLY_XERO_SCOPE_CAPABILITIES: readonly XeroScopeCapability[] = [
  BROKER_OFFLINE_REFRESH_CAPABILITY,
  LEGACY_STRICT_SETTINGS_READ_CAPABILITY,
  LEGACY_STRICT_CONTACT_READ_CAPABILITY,
  LEGACY_STRICT_INVOICE_READ_CAPABILITY,
  LEGACY_STRICT_PAYMENT_READ_CAPABILITY,
  LEGACY_STRICT_MANUAL_JOURNAL_READ_CAPABILITY,
  LEGACY_STRICT_BANK_TRANSACTION_READ_CAPABILITY,
  LEGACY_STRICT_TRIAL_BALANCE_READ_CAPABILITY,
] as const;

export function missingXeroScopeCapabilities(
  grantedScopes: readonly string[],
  writeEnabled = true,
): XeroScopeCapability[] {
  const granted = new Set(grantedScopes);
  const required = writeEnabled
    ? REQUIRED_XERO_SCOPE_CAPABILITIES
    : REQUIRED_READ_ONLY_XERO_SCOPE_CAPABILITIES;
  return required.filter((requirement) =>
    !requirement.anyOf.some((scope) => granted.has(scope)),
  );
}

export function describeMissingXeroScopeCapabilities(
  grantedScopes: readonly string[],
  writeEnabled = true,
): string[] {
  return missingXeroScopeCapabilities(grantedScopes, writeEnabled)
    .map((requirement) => requirement.capability);
}

export function unexpectedLegacyXeroWriteScopes(grantedScopes: readonly string[]): string[] {
  return [...new Set(grantedScopes)].filter((scope) =>
    scope.startsWith("accounting.") && !scope.endsWith(".read")
  );
}

export function describeLegacyXeroScopePolicyProblems(
  grantedScopes: readonly string[],
  writeEnabled: boolean,
): string[] {
  const missing = describeMissingXeroScopeCapabilities(grantedScopes, writeEnabled);
  if (writeEnabled) return missing;
  return [
    ...missing,
    ...unexpectedLegacyXeroWriteScopes(grantedScopes)
      .map((scope) => `unexpected accounting write scope ${scope}`),
  ];
}

/** Selects the exact scopes used by the legacy OAuth flow, not merely a config upper bound. */
export function leastPrivilegeXeroScopesForLegacy(
  configuredXeroScopes: readonly string[],
  writeEnabled: boolean,
): string[] {
  const configured = new Set(configuredXeroScopes);
  if (writeEnabled) {
    const missing = missingXeroScopeCapabilities(configuredXeroScopes, true);
    if (missing.length > 0) {
      throw new Error(
        `Configured Xero scopes cannot satisfy legacy writes: ${missing.map((item) => item.capability).join(", ")}`,
      );
    }
    return [...configured];
  }

  const selected: string[] = [];
  const add = (scope: string) => {
    if (configured.has(scope) && !selected.includes(scope)) selected.push(scope);
  };
  const choose = (capability: XeroScopeCapability) => {
    const match = capability.anyOf.find((scope) => configured.has(scope));
    if (match && !selected.includes(match)) selected.push(match);
  };
  for (const identityScope of ["openid", "profile", "email"]) add(identityScope);
  for (const capability of REQUIRED_READ_ONLY_XERO_SCOPE_CAPABILITIES) choose(capability);
  const missing = missingXeroScopeCapabilities(selected, false);
  if (missing.length > 0) {
    throw new Error(
      `Configured Xero scopes cannot satisfy legacy reads: ${missing.map((item) => item.capability).join(", ")}`,
    );
  }
  return selected;
}

/**
 * Maps the host-facing MCP scopes to the least-privilege Xero scopes needed by
 * the broker. The deprecated broad Xero scopes remain accepted so an existing
 * connection can be migrated without silently losing access.
 *
 * Callers must validate that requestedMcpScopes contains only
 * BROKER_MCP_SCOPES. Unknown host scopes are deliberately not ignored by the
 * broker service.
 */
export function missingBrokerXeroScopeCapabilities(
  grantedXeroScopes: readonly string[],
  requestedMcpScopes: readonly BrokerMcpScope[],
): XeroScopeCapability[] {
  const required = [...BROKER_BASE_XERO_SCOPE_CAPABILITIES];
  const requested = new Set(requestedMcpScopes);

  if (requested.has("xero.read")) {
    required.push(BROKER_SETTINGS_READ_CAPABILITY);
    required.push(BROKER_CONTACT_READ_CAPABILITY);
    required.push(BROKER_TRIAL_BALANCE_READ_CAPABILITY);
    required.push(BROKER_INVOICE_READ_CAPABILITY);
    required.push(BROKER_PAYMENT_READ_CAPABILITY);
    required.push(BROKER_MANUAL_JOURNAL_READ_CAPABILITY);
    required.push(BROKER_BANK_TRANSACTION_READ_CAPABILITY);
  }
  if (requested.has("xero.draft.write")) {
    required.push(BROKER_DRAFT_WRITE_CAPABILITY);
    required.push(BROKER_MANUAL_JOURNAL_WRITE_CAPABILITY);
    required.push(BROKER_CONTACT_WRITE_CAPABILITY);
    required.push(BROKER_ITEM_WRITE_CAPABILITY);
  }

  const granted = new Set(grantedXeroScopes);
  return required.filter((requirement) =>
    !requirement.anyOf.some((scope) => granted.has(scope)),
  );
}

/**
 * Chooses the narrowest configured Xero consent bundle for the Host-facing
 * Broker grant. A read-only MCP installation must not silently request Xero's
 * invoice-write scope merely because the deployment can support draft writes.
 */
export function leastPrivilegeXeroScopesForBroker(
  configuredXeroScopes: readonly string[],
  requestedMcpScopes: readonly BrokerMcpScope[],
): string[] {
  const configured = new Set(configuredXeroScopes);
  const requested = new Set(requestedMcpScopes);
  const selected: string[] = [];
  const add = (scope: string) => {
    if (configured.has(scope) && !selected.includes(scope)) selected.push(scope);
  };
  const choose = (capability: XeroScopeCapability) => {
    const match = capability.anyOf.find((scope) => configured.has(scope));
    if (match && !selected.includes(match)) selected.push(match);
  };

  for (const identityScope of ["openid", "profile", "email"]) add(identityScope);
  choose(BROKER_OFFLINE_REFRESH_CAPABILITY);
  if (requested.has("xero.draft.write")) {
    choose(BROKER_ITEM_WRITE_CAPABILITY);
    choose(BROKER_CONTACT_WRITE_CAPABILITY);
  }
  else if (requested.has("xero.read")) {
    choose(BROKER_SETTINGS_READ_CAPABILITY);
    choose(BROKER_CONTACT_READ_CAPABILITY);
  }
  if (requested.has("xero.read")) choose(BROKER_TRIAL_BALANCE_READ_CAPABILITY);
  if (requested.has("xero.draft.write")) {
    choose(BROKER_DRAFT_WRITE_CAPABILITY);
    choose(BROKER_MANUAL_JOURNAL_WRITE_CAPABILITY);
  }
  else if (requested.has("xero.read")) choose(BROKER_INVOICE_READ_CAPABILITY);
  if (requested.has("xero.read")) choose(BROKER_PAYMENT_READ_CAPABILITY);
  if (requested.has("xero.read") && !requested.has("xero.draft.write")) {
    choose(BROKER_MANUAL_JOURNAL_READ_CAPABILITY);
  }
  if (requested.has("xero.read")) choose(BROKER_BANK_TRANSACTION_READ_CAPABILITY);

  const missing = missingBrokerXeroScopeCapabilities(selected, requestedMcpScopes);
  if (missing.length > 0) {
    throw new Error(
      `Configured Xero scopes cannot satisfy the Broker grant: ${missing.map((item) => item.capability).join(", ")}`,
    );
  }
  return selected;
}
