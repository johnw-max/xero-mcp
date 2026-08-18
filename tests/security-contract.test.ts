import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logging.js";
import { hashObject, sha256, stableStringify } from "../src/security/hash.js";
import { Aes256GcmTokenCipher } from "../src/security/tokenCipher.js";
import { createXeroBuildIdentity, xeroBuildIdentityHash } from "../src/xeroRelease.js";
import {
  testXeroBusinessAuthorityProfile,
} from "./helpers/xeroTenantCoaProfile.js";

/**
 * ADR-002 retains `XERO_TENANT_COA_PROFILES_JSON` and its legacy schema
 * (`src/policy/xeroTenantCoaProfile.ts`) purely for deployment compatibility
 * -- config.ts still parses it, but it no longer gates any write. This
 * fixture only needs to satisfy that legacy schema's own shape; it carries
 * no live behaviour any more.
 */
function testXeroTenantCoaProfile(tenantId: string, revision = 1) {
  return {
    profile_id: `test-sg-coa-${tenantId}`,
    revision,
    tenant_id: tenantId,
    jurisdiction: "SG" as const,
    categories: {
      CONSULTING_REVENUE: {
        account_id: "33333333-3333-4333-8333-333333333333",
        account_code: "200",
        expected_type: "REVENUE",
        expected_class: "REVENUE",
      },
      OFFICE_SUPPLIES: {
        account_id: "33333333-3333-4333-8333-333333333353",
        account_code: "453",
        expected_type: "EXPENSE",
        expected_class: "EXPENSE",
      },
      CLOUD_SUBSCRIPTIONS: {
        account_id: "33333333-3333-4333-8333-333333333385",
        account_code: "485",
        expected_type: "EXPENSE",
        expected_class: "EXPENSE",
      },
    },
  };
}

function validEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    HOST: "127.0.0.1",
    PORT: "3000",
    PUBLIC_BASE_URL: "http://127.0.0.1:3000",
    DATABASE_URL: "postgres://test:test@127.0.0.1:5432/test",
    MCP_BEARER_TOKEN: "m".repeat(48),
    MCP_ALLOWED_ORIGINS: "http://127.0.0.1:3000",
    MCP_ALLOWED_HOSTS: "127.0.0.1:3000",
    REQUEST_BODY_LIMIT_BYTES: "1048576",
    XERO_CLIENT_ID: "test-client",
    XERO_CLIENT_SECRET: "test-secret",
    XERO_SCOPES: "openid profile email offline_access accounting.settings.read accounting.settings accounting.contacts.read accounting.contacts accounting.invoices.read accounting.invoices accounting.payments.read accounting.manualjournals.read accounting.manualjournals accounting.banktransactions.read accounting.reports.trialbalance.read",
    TOKEN_ENCRYPTION_KEY_B64: Buffer.alloc(32, 7).toString("base64"),
    XERO_MUTATION_CONFIRMATION_KEY_B64: Buffer.alloc(32, 8).toString("base64"),
    DEMO_ACTOR_ID: "qa-actor",
    LOG_LEVEL: "debug",
    ...overrides,
  };
}

const AUTONOMOUS_TENANT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const UNPROFILED_TEST_TENANT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const testBuildIdentity = createXeroBuildIdentity({
  acceptanceSourceSha256: "a".repeat(64),
  releaseSourceManifestSha256: "b".repeat(64),
  sourceArchiveSha256: "c".repeat(64),
  sourceBundleManifestSha256: "d".repeat(64),
  approvedControlCatalogSha256: "e".repeat(64),
});

function standingDelegations(): string {
  return JSON.stringify([{
    delegation_id: "work-xero-agent-v1",
    revision: 1,
    status: "ACTIVE",
    workspace_id: "workspace-test",
    agent_id: "agent-test",
    installation_id: "installation-test",
    tenant_id: AUTONOMOUS_TENANT_ID,
    action_ids: ["supplier_bill.create_draft"],
  }]);
}

function autonomousWriteEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const configured = validEnv({
    NODE_ENV: "test",
    PUBLIC_BASE_URL: "https://xero-mcp.example.test",
    MCP_ALLOWED_ORIGINS: "https://agent2.zcloak.ai",
    MCP_ALLOWED_HOSTS: "xero-mcp.example.test",
    XERO_WRITE_ENABLED: "true",
    XERO_AUTHORITY_REVISION: "1",
    XERO_TARGET_SESSION_REQUIRED: "true",
    XERO_STANDING_DELEGATIONS_JSON: standingDelegations(),
    XERO_TENANT_COA_PROFILES_JSON: JSON.stringify([testXeroTenantCoaProfile(AUTONOMOUS_TENANT_ID)]),
    XERO_ACCOUNTING_CASE_BUSINESS_AUTHORITIES_JSON: JSON.stringify([
      testXeroBusinessAuthorityProfile(AUTONOMOUS_TENANT_ID),
    ]),
    MCP_OAUTH_BROKER_ENABLED: "true",
    PERSONAL_POC_ONLY: "true",
    HOST_OAUTH_CLIENTS_JSON: JSON.stringify([{
      name: "Agent2",
      client_id: "agent2-accounting-mcp",
      client_secret: "a".repeat(32),
      redirect_uris: ["https://agent2.zcloak.ai/api/mcp/accounting-mcp/oauth/callback"],
    }]),
    OAUTH_TOKEN_HASH_KEY_B64: Buffer.alloc(32, 9).toString("base64"),
    OAUTH_COOKIE_STATE_KEY_B64: Buffer.alloc(32, 10).toString("base64"),
    ...overrides,
  });
  return {
    ...configured,
    XERO_STANDING_DELEGATIONS_CONFIG_SHA256:
      overrides.XERO_STANDING_DELEGATIONS_CONFIG_SHA256 ??
      sha256(configured.XERO_STANDING_DELEGATIONS_JSON ?? "[]"),
    XERO_EXPECTED_AUTHORITY_SNAPSHOT_SHA256:
      overrides.XERO_EXPECTED_AUTHORITY_SNAPSHOT_SHA256 ?? "1".repeat(64),
    // Firm-governance exclusive-writer authority is no longer a deployment
    // precondition for any write action (src/config.ts no longer derives
    // `firmGovernanceRequired` from any delegated action), so every
    // deployment's expected governance hash is the fixed "NOT_REQUIRED"
    // sentinel regardless of which actions are delegated.
    XERO_EXPECTED_FIRM_GOVERNANCE_AGGREGATE_SHA256:
      overrides.XERO_EXPECTED_FIRM_GOVERNANCE_AGGREGATE_SHA256 ?? "NOT_REQUIRED",
  };
}

describe("security configuration contract", () => {
  it("requires HTTPS public callback URLs in production", () => {
    expect(() =>
      loadConfig(validEnv({
        NODE_ENV: "production",
        PUBLIC_BASE_URL: "http://demo.example.test",
        MCP_ALLOWED_ORIGINS: "https://agent2.zcloak.ai",
        XERO_BUILD_IDENTITY_JSON: JSON.stringify(testBuildIdentity),
      })),
    ).toThrow(/HTTPS|https/i);
  });

  it("accepts a fixed HTTPS callback URL in production", () => {
    const config = loadConfig(
      validEnv({
        NODE_ENV: "production",
        PUBLIC_BASE_URL: "https://demo.example.test",
        MCP_ALLOWED_ORIGINS: "https://agent2.zcloak.ai",
        XERO_BUILD_IDENTITY_JSON: JSON.stringify(testBuildIdentity),
      }),
    );
    expect(config.xero.redirectUri).toBe("https://demo.example.test/oauth/xero/callback");
  });

  it("requires a contract-valid accepted build identity in production", () => {
    expect(() => loadConfig(validEnv({
      NODE_ENV: "production",
      PUBLIC_BASE_URL: "https://demo.example.test",
      MCP_ALLOWED_ORIGINS: "https://agent2.zcloak.ai",
    }))).toThrow("XERO_BUILD_IDENTITY_JSON is required in production");
    expect(() => loadConfig(validEnv({
      NODE_ENV: "production",
      PUBLIC_BASE_URL: "https://demo.example.test",
      MCP_ALLOWED_ORIGINS: "https://agent2.zcloak.ai",
      XERO_BUILD_IDENTITY_JSON: JSON.stringify({ ...testBuildIdentity, toolsetHash: "f".repeat(64) }),
    }))).toThrow("XERO_BUILD_IDENTITY_CONTRACT_MISMATCH");
    const config = loadConfig(validEnv({
      NODE_ENV: "production",
      PUBLIC_BASE_URL: "https://demo.example.test",
      MCP_ALLOWED_ORIGINS: "https://agent2.zcloak.ai",
      XERO_BUILD_IDENTITY_JSON: JSON.stringify(testBuildIdentity),
    }));
    expect(config.xeroBuildIdentity).toEqual(testBuildIdentity);
    expect(xeroBuildIdentityHash(config.xeroBuildIdentity!)).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("rejects non-HTTPS browser origins in production", () => {
    expect(() => loadConfig(validEnv({
      NODE_ENV: "production",
      PUBLIC_BASE_URL: "https://demo.example.test",
      MCP_ALLOWED_ORIGINS: "http://127.0.0.1:3000",
      XERO_BUILD_IDENTITY_JSON: JSON.stringify(testBuildIdentity),
    }))).toThrow(/MCP_ALLOWED_ORIGINS.*HTTPS/i);
  });

  it("accepts only exact HTTP(S) origins for the browser CORS allowlist", () => {
    const config = loadConfig(validEnv({
      MCP_ALLOWED_ORIGINS: "https://agent2.zcloak.ai,http://127.0.0.1:3000",
    }));
    expect(config.allowedOrigins).toEqual(["https://agent2.zcloak.ai", "http://127.0.0.1:3000"]);
  });

  it.each([
    "*",
    "null",
    "https://*.zcloak.ai",
    "https://agent2.zcloak.ai/",
    "https://agent2.zcloak.ai/path",
    "https://agent2.zcloak.ai?debug=true",
    "https://agent2.zcloak.ai#fragment",
    "https://operator:password@agent2.zcloak.ai",
  ])("rejects a non-exact or credential-risk CORS origin: %s", (allowedOrigin) => {
    expect(() => loadConfig(validEnv({ MCP_ALLOWED_ORIGINS: allowedOrigin }))).toThrow(
      /exact HTTP\(S\) origin|wildcards|credentials|paths/i,
    );
  });

  it.each([
    "https://demo.example.test/prefix",
    "https://demo.example.test?next=callback",
    "https://demo.example.test#fragment",
    "https://operator:password@demo.example.test",
  ])("rejects a production public base URL that is not an origin: %s", (publicBaseUrl) => {
    expect(() => loadConfig(validEnv({
      NODE_ENV: "production",
      PUBLIC_BASE_URL: publicBaseUrl,
      MCP_ALLOWED_ORIGINS: "https://agent2.zcloak.ai",
      XERO_BUILD_IDENTITY_JSON: JSON.stringify(testBuildIdentity),
    }))).toThrow(
      /origin|path|query|fragment|userinfo/i,
    );
  });

  it("keeps Xero writes disabled by default", () => {
    const config = loadConfig(validEnv());
    expect(config.xeroWriteEnabled).toBe(false);
    expect(config.xeroAllowedTenantId).toBeUndefined();
  });

  it("accepts a genuinely read-only Xero scope bundle while writes are disabled", () => {
    const config = loadConfig(validEnv({
      XERO_SCOPES: "offline_access accounting.settings.read accounting.contacts.read accounting.invoices.read accounting.payments.read accounting.manualjournals.read accounting.banktransactions.read accounting.reports.trialbalance.read",
    }));
    expect(config.xeroWriteEnabled).toBe(false);
    expect(config.xero.scopes).not.toContain("accounting.invoices");
    expect(config.xero.scopes).not.toContain("accounting.contacts");
    expect(config.xero.scopes).not.toContain("accounting.settings");
  });

  it("still rejects a read-only Xero scope bundle when controlled writes are enabled", () => {
    expect(() => loadConfig(validEnv({
      XERO_WRITE_ENABLED: "true",
      XERO_ALLOWED_TENANT_ID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      XERO_SCOPES: "offline_access accounting.settings.read accounting.contacts.read accounting.invoices.read accounting.payments.read accounting.manualjournals.read accounting.banktransactions.read accounting.reports.trialbalance.read",
    }))).toThrow(/missing required Xero capabilities/i);
  });

  it.each([
    ["offline refresh", "openid profile email accounting.settings accounting.contacts accounting.invoices accounting.manualjournals accounting.banktransactions.read accounting.reports.trialbalance.read"],
    ["invoice drafts", "offline_access accounting.settings accounting.contacts accounting.manualjournals accounting.banktransactions.read accounting.reports.trialbalance.read"],
    ["item writes", "offline_access accounting.settings.read accounting.contacts accounting.invoices accounting.manualjournals accounting.banktransactions.read accounting.reports.trialbalance.read"],
    ["contact writes", "offline_access accounting.settings accounting.contacts.read accounting.invoices accounting.manualjournals accounting.banktransactions.read accounting.reports.trialbalance.read"],
    ["manual-journal drafts", "offline_access accounting.settings accounting.contacts accounting.invoices accounting.manualjournals.read accounting.banktransactions.read accounting.reports.trialbalance.read"],
    ["bank transactions", "offline_access accounting.settings accounting.contacts accounting.invoices accounting.manualjournals accounting.reports.trialbalance.read"],
    ["trial balance", "offline_access accounting.settings accounting.contacts accounting.invoices accounting.manualjournals accounting.banktransactions.read"],
  ])("rejects write-enabled OAuth configuration missing the %s capability", (_capability, scopes) => {
    expect(() => loadConfig(validEnv({
      XERO_WRITE_ENABLED: "true",
      XERO_ALLOWED_TENANT_ID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      XERO_SCOPES: scopes,
    }))).toThrow(/missing required Xero capabilities/i);
  });

  it("accepts deprecated broad scopes only as compatibility equivalents", () => {
    const config = loadConfig(autonomousWriteEnv({
      XERO_SCOPES: "offline_access accounting.settings accounting.contacts accounting.transactions accounting.reports.read",
    }));
    expect(config.xero.scopes).toContain("accounting.transactions");
  });

  it("does not disconnect legacy rollback connections solely for lacking granular payment read", () => {
    const config = loadConfig(autonomousWriteEnv({
      XERO_SCOPES: "offline_access accounting.settings accounting.contacts accounting.invoices accounting.manualjournals accounting.banktransactions.read accounting.reports.trialbalance.read",
    }));
    expect(config.xero.scopes).not.toContain("accounting.payments.read");
  });

  it("does not treat broad accounting write scopes as a legacy read-only grant", () => {
    expect(() => loadConfig(validEnv({
      XERO_SCOPES: "offline_access accounting.settings accounting.contacts accounting.transactions accounting.reports.read",
    }))).toThrow(/missing required Xero capabilities/i);
  });

  it("rejects autonomous write enablement without the OAuth Broker", () => {
    expect(() => loadConfig(validEnv({ XERO_WRITE_ENABLED: "true" }))).toThrow(
      /MCP_OAUTH_BROKER_ENABLED=true.*required/i,
    );
  });

  it("rejects Broker writes without a required target session", () => {
    expect(() => loadConfig(autonomousWriteEnv({ XERO_TARGET_SESSION_REQUIRED: "false" }))).toThrow(
      /XERO_TARGET_SESSION_REQUIRED=true.*required/i,
    );
  });

  it("rejects Broker writes without an active standing delegation", () => {
    expect(() => loadConfig(autonomousWriteEnv({ XERO_STANDING_DELEGATIONS_JSON: "[]" }))).toThrow(
      /active Xero standing delegation.*required/i,
    );
  });

  it("binds autonomous startup to exact standing-delegation bytes and an explicit revision", () => {
    const environment = autonomousWriteEnv();
    const config = loadConfig(environment);
    expect(config.xeroStandingDelegationsConfigSha256).toBe(
      sha256(environment.XERO_STANDING_DELEGATIONS_JSON!),
    );
    expect(() => loadConfig(autonomousWriteEnv({
      XERO_STANDING_DELEGATIONS_CONFIG_SHA256: "",
    }))).toThrow(/explicit XERO_AUTHORITY_REVISION.*XERO_STANDING_DELEGATIONS_CONFIG_SHA256/u);
    expect(() => loadConfig(autonomousWriteEnv({
      XERO_STANDING_DELEGATIONS_CONFIG_SHA256: "f".repeat(64),
    }))).toThrow(/does not match the exact XERO_STANDING_DELEGATIONS_JSON bytes/u);
    expect(() => loadConfig(autonomousWriteEnv({
      XERO_AUTHORITY_REVISION: undefined,
    }))).toThrow(/explicit XERO_AUTHORITY_REVISION/u);
  });

  // ADR-002: a per-tenant chart-of-accounts profile is no longer a write-startup
  // precondition -- account and tax coordinates are declared by the caller and
  // verified against the target tenant's live chart of accounts at prepare and
  // execution time instead. These two cases used to assert startup rejection;
  // they are inverted here to prove the removed gate stays removed.
  it.each([
    ["active standing-delegation tenant", {
      XERO_TENANT_COA_PROFILES_JSON: "[]",
    }, AUTONOMOUS_TENANT_ID],
    ["Accounting Case test tenant", {
      XERO_ACCOUNTING_CASE_TEST_TENANT_IDS: UNPROFILED_TEST_TENANT_ID,
      XERO_ACCOUNTING_CASE_BUSINESS_AUTHORITIES_JSON: JSON.stringify([
        testXeroBusinessAuthorityProfile(AUTONOMOUS_TENANT_ID),
        testXeroBusinessAuthorityProfile(UNPROFILED_TEST_TENANT_ID),
      ]),
    }, UNPROFILED_TEST_TENANT_ID],
  ] as const)("allows write startup when the %s has no server-owned COA profile", (
    _label,
    overrides,
    tenantIdWithNoCoaProfile,
  ) => {
    const config = loadConfig(autonomousWriteEnv(overrides));
    expect(config.xeroWriteEnabled).toBe(true);
    expect(config.xeroTenantCoaProfiles.some((profile) =>
      profile.tenant_id === tenantIdWithNoCoaProfile)).toBe(false);
  });

  it("does not require tenant COA profiles while provider writes are disabled", () => {
    const config = loadConfig(validEnv({
      XERO_ACCOUNTING_CASE_TEST_TENANT_IDS: UNPROFILED_TEST_TENANT_ID,
      XERO_TENANT_COA_PROFILES_JSON: "[]",
    }));
    expect(config.xeroWriteEnabled).toBe(false);
    expect(config.xeroAccountingCaseTestTenantIds).toEqual([UNPROFILED_TEST_TENANT_ID]);
    expect(config.xeroTenantCoaProfiles).toEqual([]);
  });

  /**
   * Superseded deliberately. This previously required exclusive-writer
   * authority before a deployment holding a supplier_bill.create_draft or
   * credit_note.create_draft delegation could even start, on the correct
   * observation that Xero does not enforce uniqueness on ACCPAY bill numbers
   * or (for the supplier direction) credit-note numbers.
   *
   * The requirement is now removed outright, both here and at write time in
   * xeroAccountingCaseService (see `PROVIDER_BUSINESS_COORDINATE_ATOMICITY_UNPROVEN`,
   * which no longer exists). The residual it guarded -- another writer
   * creating the same coordinate in Xero -- is carried by controls that cost
   * nothing to provision and already run on every create: the provider
   * coordinate-history lookup, our own durable coordinate reservation, the
   * idempotency identity, receipt plus exact readback, and the fact that every
   * write here is a DRAFT an accountant reviews in Xero before it posts. No
   * deployment needs Ed25519 governance artifacts to start writing any
   * Accounting Case document, including supplier bills and credit notes.
   */
  it.each([
    "customer_invoice.create_draft",
    "supplier_bill.create_draft",
    "credit_note.create_draft",
  ])("starts a %s delegation without provisioned exclusive-writer authority", (actionId) => {
    const delegations = JSON.parse(standingDelegations()) as Array<Record<string, unknown>>;
    delegations[0] = { ...delegations[0], action_ids: [actionId] };
    const config = loadConfig(autonomousWriteEnv({
      XERO_STANDING_DELEGATIONS_JSON: JSON.stringify(delegations),
      XERO_ACCOUNTING_CASE_BUSINESS_AUTHORITIES_JSON: "[]",
    }));
    expect(config.xeroWriteEnabled).toBe(true);
  });

  it("accepts write enablement only with Broker, target and an exact standing delegation", () => {
    const config = loadConfig(autonomousWriteEnv());
    expect(config.xeroWriteEnabled).toBe(true);
    expect(config.xeroAllowedTenantId).toBeUndefined();
    expect(config.xeroTargetSessionRequired).toBe(true);
    expect(config.xeroStandingDelegations).toEqual([
      expect.objectContaining({
        providerId: "xero",
        agentId: "agent-test",
        installationId: "installation-test",
        tenantIds: [AUTONOMOUS_TENANT_ID],
        actionIds: ["supplier_bill.create_draft"],
      }),
    ]);
  });
});

describe("fixed MCP tool contract", () => {
  it("matches the reviewed twenty-eight-tool Accounting Case allowlist exactly", () => {
    const configured = JSON.parse(
      readFileSync(new URL("../config/tool-allowlist.json", import.meta.url), "utf8"),
    ).tools as string[];
    const expected = JSON.parse(
      readFileSync(new URL("./contract/expected-tools.json", import.meta.url), "utf8"),
    ) as string[];
    expect([...new Set(configured)].sort()).toEqual([...expected].sort());
    expect(configured).toHaveLength(28);
    expect(configured).toEqual(expect.arrayContaining([
      "xero_prepare_accounting_case",
      "xero_execute_accounting_case",
      "xero_get_accounting_case_status",
    ]));
  });
});

describe("payload hash contract", () => {
  const approved = {
    tenantId: "tenant-a",
    invoiceId: "invoice-a",
    contactId: "contact-a",
    invoiceDate: "2026-08-03",
    currency: "SGD",
    lines: [
      {
        description: "Synthetic software subscription",
        quantity: "1",
        unitAmount: "109.00",
        accountCode: "404",
        taxType: "OUTPUT2",
      },
    ],
  };

  it("is deterministic across object key insertion order", () => {
    const reordered = {
      lines: approved.lines,
      currency: approved.currency,
      invoiceDate: approved.invoiceDate,
      contactId: approved.contactId,
      invoiceId: approved.invoiceId,
      tenantId: approved.tenantId,
    };
    expect(stableStringify(reordered)).toBe(stableStringify(approved));
    expect(hashObject(reordered)).toBe(hashObject(approved));
  });

  it.each([
    ["tenant", { ...approved, tenantId: "tenant-b" }],
    ["invoice", { ...approved, invoiceId: "invoice-b" }],
    ["contact", { ...approved, contactId: "contact-b" }],
    ["currency", { ...approved, currency: "USD" }],
    [
      "amount",
      { ...approved, lines: [{ ...approved.lines[0], unitAmount: "10900.00" }] },
    ],
    ["tax", { ...approved, lines: [{ ...approved.lines[0], taxType: "NONE" }] }],
    ["account", { ...approved, lines: [{ ...approved.lines[0], accountCode: "999" }] }],
  ])("changes when approved %s changes", (_label, mutated) => {
    expect(hashObject(mutated)).not.toBe(hashObject(approved));
  });
});

describe("token encryption", () => {
  it("round-trips only with the same connection context", () => {
    const cipher = new Aes256GcmTokenCipher(Buffer.alloc(32, 3));
    const ciphertext = cipher.encrypt('{"refresh_token":"qa-only"}', "connection-a");
    expect(cipher.decrypt(ciphertext, "connection-a")).toBe('{"refresh_token":"qa-only"}');
    expect(() => cipher.decrypt(ciphertext, "connection-b")).toThrow();
  });

  it("uses a fresh nonce for repeated plaintext", () => {
    const cipher = new Aes256GcmTokenCipher(Buffer.alloc(32, 4));
    const first = cipher.encrypt("same token set", "connection-a");
    const second = cipher.encrypt("same token set", "connection-a");
    expect(first).not.toBe(second);
  });
});

describe("structured logging redaction", () => {
  it("does not print secret sentinels from keys, nested values, or messages", () => {
    const output: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((value) => output.push(String(value)));
    const errorSpy = vi.spyOn(console, "error").mockImplementation((value) => output.push(String(value)));
    try {
      const logger = createLogger({ logLevel: "debug" });
      logger.info("provider callback failed code=QA_MESSAGE_SECRET_4F8C", {
        accessToken: "QA_KEY_SECRET_7A91",
        upstreamMessage: "Bearer QA_VALUE_SECRET_1D22",
        nested: { refresh_token: "QA_NESTED_SECRET_99B0" },
      });
      logger.error("safe constant error", { clientSecret: "QA_ERROR_SECRET_2AB1" });
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }

    const rendered = output.join("\n");
    expect(rendered).not.toContain("QA_MESSAGE_SECRET_4F8C");
    expect(rendered).not.toContain("QA_KEY_SECRET_7A91");
    expect(rendered).not.toContain("QA_VALUE_SECRET_1D22");
    expect(rendered).not.toContain("QA_NESTED_SECRET_99B0");
    expect(rendered).not.toContain("QA_ERROR_SECRET_2AB1");
    expect(rendered).toContain("[REDACTED]");
  });
});
