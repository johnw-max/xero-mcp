import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logging.js";
import { hashObject, stableStringify } from "../src/security/hash.js";
import { Aes256GcmTokenCipher } from "../src/security/tokenCipher.js";

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

describe("security configuration contract", () => {
  it("requires HTTPS public callback URLs in production", () => {
    expect(() =>
      loadConfig(validEnv({
        NODE_ENV: "production",
        PUBLIC_BASE_URL: "http://demo.example.test",
        MCP_ALLOWED_ORIGINS: "https://agent2.zcloak.ai",
      })),
    ).toThrow(/HTTPS|https/i);
  });

  it("accepts a fixed HTTPS callback URL in production", () => {
    const config = loadConfig(
      validEnv({
        NODE_ENV: "production",
        PUBLIC_BASE_URL: "https://demo.example.test",
        MCP_ALLOWED_ORIGINS: "https://agent2.zcloak.ai",
      }),
    );
    expect(config.xero.redirectUri).toBe("https://demo.example.test/oauth/xero/callback");
  });

  it("rejects non-HTTPS browser origins in production", () => {
    expect(() => loadConfig(validEnv({
      NODE_ENV: "production",
      PUBLIC_BASE_URL: "https://demo.example.test",
      MCP_ALLOWED_ORIGINS: "http://127.0.0.1:3000",
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
    const config = loadConfig(validEnv({
      XERO_WRITE_ENABLED: "true",
      XERO_ALLOWED_TENANT_ID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      XERO_SCOPES: "offline_access accounting.settings accounting.contacts accounting.transactions accounting.reports.read",
    }));
    expect(config.xero.scopes).toContain("accounting.transactions");
  });

  it("does not disconnect legacy rollback connections solely for lacking granular payment read", () => {
    const config = loadConfig(validEnv({
      XERO_WRITE_ENABLED: "true",
      XERO_ALLOWED_TENANT_ID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      XERO_SCOPES: "offline_access accounting.settings accounting.contacts accounting.invoices accounting.manualjournals accounting.banktransactions.read accounting.reports.trialbalance.read",
    }));
    expect(config.xero.scopes).not.toContain("accounting.payments.read");
  });

  it("does not treat broad accounting write scopes as a legacy read-only grant", () => {
    expect(() => loadConfig(validEnv({
      XERO_SCOPES: "offline_access accounting.settings accounting.contacts accounting.transactions accounting.reports.read",
    }))).toThrow(/missing required Xero capabilities/i);
  });

  it("rejects write enablement without an exact allowlisted tenant UUID", () => {
    expect(() => loadConfig(validEnv({ XERO_WRITE_ENABLED: "true" }))).toThrow(
      /XERO_ALLOWED_TENANT_ID.*required/i,
    );
  });

  it("accepts write enablement only with an exact tenant UUID", () => {
    const tenantId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const config = loadConfig(validEnv({
      XERO_WRITE_ENABLED: "true",
      XERO_ALLOWED_TENANT_ID: tenantId,
    }));
    expect(config.xeroWriteEnabled).toBe(true);
    expect(config.xeroAllowedTenantId).toBe(tenantId);
  });
});

describe("fixed MCP tool contract", () => {
  it("matches the reviewed forty-three-tool allowlist exactly", () => {
    const configured = JSON.parse(
      readFileSync(new URL("../config/tool-allowlist.json", import.meta.url), "utf8"),
    ).tools as string[];
    const expected = JSON.parse(
      readFileSync(new URL("./contract/expected-tools.json", import.meta.url), "utf8"),
    ) as string[];
    expect([...new Set(configured)].sort()).toEqual([...expected].sort());
    expect(configured).toHaveLength(43);
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
