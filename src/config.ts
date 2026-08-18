import { z } from "zod/v4";
import { missingXeroScopeCapabilities } from "./providers/xeroScopes.js";
import {
  XERO_AUTONOMOUS_WRITE_ACTIONS,
  type XeroAutonomousWriteAction,
} from "./policy/xeroAutonomousActions.js";
import type { LedgerStandingDelegation } from "./control-kernel/ledgerControlKernel.js";
import {
  parseXeroBuildIdentity,
  type XeroBuildIdentity,
} from "./xeroRelease.js";
import {
  parseXeroTenantCoaProfiles,
  type XeroTenantCoaProfile,
} from "./policy/xeroTenantCoaProfile.js";
import {
  parseXeroAccountingCaseBusinessAuthorityProfiles,
  type XeroAccountingCaseBusinessAuthorityProfile,
} from "./policy/xeroBusinessCoordinateAuthority.js";
import type { XeroExternalGovernanceExpectedHashes } from
  "./policy/xeroExternalGovernanceAuthority.js";
import { sha256 } from "./security/hash.js";

const nonEmptyCsv = z.string().transform((value, context) => {
  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (entries.length === 0) {
    context.addIssue({ code: "custom", message: "must include at least one entry" });
    return z.NEVER;
  }

  return entries;
});

const exactOriginCsv = nonEmptyCsv.superRefine((entries, context) => {
  entries.forEach((entry, index) => {
    let parsed: URL;
    try {
      parsed = new URL(entry);
    } catch {
      context.addIssue({ code: "custom", path: [index], message: "must be an exact HTTP(S) origin" });
      return;
    }
    if (
      entry === "*" ||
      entry.includes("*") ||
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.origin !== entry
    ) {
      context.addIssue({
        code: "custom",
        path: [index],
        message: "must be an exact HTTP(S) origin without wildcards, credentials, paths, query, or fragments",
      });
    }
  });
});

const base64Key = z.string().regex(/^(?:[A-Za-z0-9+/]{4}){10}[A-Za-z0-9+/]{3}=$/, "must use canonical base64").refine(
  (value) => {
    try {
      return Buffer.from(value, "base64").length === 32;
    } catch {
      return false;
    }
  },
  "must be a base64-encoded 32-byte key",
);

const booleanFlag = z.enum(["true", "false"]).default("false").transform((value) => value === "true");
const optionalUuid = z.preprocess(
  (value) => typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().trim().uuid().optional(),
);
const optionalSha256 = z.preprocess(
  (value) => typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().regex(/^[a-f0-9]{64}$/u).optional(),
);
const optionalGovernanceAggregateIdentity = z.preprocess(
  (value) => typeof value === "string" && value.trim() === "" ? undefined : value,
  z.union([z.string().regex(/^[a-f0-9]{64}$/u), z.literal("NOT_REQUIRED")]).optional(),
);

const optionalUuidCsv = z.string().default("").transform((value, context) => {
  const entries = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  const parsed = z.array(z.string().uuid()).safeParse(entries);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      context.addIssue({ code: "custom", path: issue.path, message: issue.message });
    }
    return z.NEVER;
  }
  if (new Set(parsed.data).size !== parsed.data.length) {
    context.addIssue({ code: "custom", message: "must contain unique tenant IDs" });
    return z.NEVER;
  }
  return parsed.data;
});

const xeroTenantCoaProfilesJson = z.string().default("[]").transform((raw, context) => {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw) as unknown;
  } catch {
    context.addIssue({ code: "custom", message: "must be a valid JSON array" });
    return z.NEVER;
  }
  try {
    return parseXeroTenantCoaProfiles(decoded);
  } catch (error) {
    context.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : "must contain valid tenant COA profiles",
    });
    return z.NEVER;
  }
});

const xeroAccountingCaseBusinessAuthoritiesJson = z.string().default("[]").transform((raw, context) => {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw) as unknown;
  } catch {
    context.addIssue({ code: "custom", message: "must be a valid JSON array" });
    return z.NEVER;
  }
  try {
    return parseXeroAccountingCaseBusinessAuthorityProfiles(decoded);
  } catch (error) {
    context.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : "must contain valid Accounting Case business authorities",
    });
    return z.NEVER;
  }
});

export const MCP_OAUTH_SCOPES = ["xero.read", "xero.draft.write"] as const;
export type McpOAuthScope = (typeof MCP_OAUTH_SCOPES)[number];

const xeroStandingDelegationRecordSchema = z.object({
  delegation_id: z.string().trim().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/u),
  revision: z.number().int().positive(),
  status: z.enum(["ACTIVE", "REVOKED"]).default("ACTIVE"),
  workspace_id: z.string().trim().min(1).max(255),
  agent_id: z.string().trim().min(1).max(255),
  installation_id: z.string().trim().min(1).max(255),
  tenant_id: z.string().trim().uuid(),
  action_ids: z.array(z.enum(XERO_AUTONOMOUS_WRITE_ACTIONS)).min(1)
    .refine((values) => new Set(values).size === values.length, "must contain unique action IDs"),
  expires_at: z.iso.datetime({ offset: true }).optional(),
}).strict();

const xeroStandingDelegationsJson = z.string().default("[]").transform((raw, context) => {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw) as unknown;
  } catch {
    context.addIssue({ code: "custom", message: "must be a valid JSON array" });
    return z.NEVER;
  }
  const parsed = z.array(xeroStandingDelegationRecordSchema).safeParse(decoded);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      context.addIssue({
        code: "custom",
        path: issue.path,
        message: issue.message,
      });
    }
    return z.NEVER;
  }
  const ids = parsed.data.map((item) => item.delegation_id);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: "custom", message: "delegation_id values must be unique" });
    return z.NEVER;
  }
  return parsed.data.map((item): LedgerStandingDelegation => ({
    delegationId: item.delegation_id,
    revision: item.revision,
    status: item.status,
    providerId: "xero",
    workspaceId: item.workspace_id,
    agentId: item.agent_id,
    installationId: item.installation_id,
    tenantIds: [item.tenant_id],
    actionIds: item.action_ids as readonly XeroAutonomousWriteAction[],
    ...(item.action_ids.some((actionId) => [
      "customer_invoice.create_draft",
      "supplier_bill.create_draft",
      "credit_note.create_draft",
    ].includes(actionId)) ? { firmGovernanceRequired: true } : {}),
    ...(item.expires_at ? { expiresAt: new Date(item.expires_at) } : {}),
  }));
});

export interface McpOAuthHostClient {
  name: string;
  clientId: string;
  clientSecret: string;
  redirectUris: string[];
}

interface McpOAuthBrokerBaseConfig {
  issuer: string;
  resourceUri: string;
  protectedResourceUris: readonly string[];
  authorizationPath: "/authorize";
  tokenPath: "/token";
  revocationPath: "/revoke";
  authorizationEndpoint: string;
  tokenEndpoint: string;
  revocationEndpoint: string;
  scopes: readonly McpOAuthScope[];
  personalPocOnly: boolean;
  /**
   * Early-UAT mode: one registered Host client may create multiple isolated
   * installation grants. The Host credential identifies the application, not
   * a human; each grant receives a server-generated installation subject.
   */
  sharedTestUsers?: boolean;
}

export type McpOAuthBrokerConfig = McpOAuthBrokerBaseConfig & (
  | {
      enabled: false;
    }
  | {
      enabled: true;
      hostClients: McpOAuthHostClient[];
      missingResourceCompatClientIds: readonly string[];
      manualReturnClientIds: readonly string[];
      accessTokenTtlSeconds: number;
      refreshTokenTtlSeconds: number;
      authorizationCodeTtlSeconds: number;
      browserFlowTtlSeconds: number;
      tokenHashKey: Buffer;
      cookieStateKey: Buffer;
    }
);

const brokerHostClientSchema = z.object({
  name: z.string().trim().min(1).max(128),
  client_id: z.string().trim().min(1).max(256),
  client_secret: z.string().min(32),
  redirect_uris: z.array(z.string().superRefine((value, context) => {
    let redirectUri: URL;
    try {
      redirectUri = new URL(value);
    } catch {
      context.addIssue({ code: "custom", message: "must be an absolute HTTPS URL" });
      return;
    }

    if (redirectUri.protocol !== "https:") {
      context.addIssue({ code: "custom", message: "must use HTTPS" });
    }
    if (value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
      context.addIssue({ code: "custom", message: "cannot contain whitespace or control characters" });
    }
    if (value.includes("*")) {
      context.addIssue({ code: "custom", message: "must be exact and cannot contain wildcards" });
    }
    const authority = value.slice(value.indexOf("//") + 2).split(/[/?#]/u, 1)[0] ?? "";
    if (redirectUri.username || redirectUri.password || authority.includes("@")) {
      context.addIssue({ code: "custom", message: "cannot contain userinfo" });
    }
    if (value.includes("#")) {
      context.addIssue({ code: "custom", message: "cannot contain a fragment" });
    }
  })).min(1),
}).strict();

const brokerHostClientsSchema = z.array(brokerHostClientSchema).min(1).superRefine((clients, context) => {
  const names = new Set<string>();
  const clientIds = new Set<string>();
  const clientSecrets = new Set<string>();

  clients.forEach((client, index) => {
    const normalizedName = client.name.toLocaleLowerCase("en-US");
    if (names.has(normalizedName)) {
      context.addIssue({
        code: "custom",
        path: [index, "name"],
        message: "must be unique",
      });
    }
    names.add(normalizedName);

    if (clientIds.has(client.client_id)) {
      context.addIssue({
        code: "custom",
        path: [index, "client_id"],
        message: "must be unique",
      });
    }
    clientIds.add(client.client_id);

    if (clientSecrets.has(client.client_secret)) {
      context.addIssue({
        code: "custom",
        path: [index, "client_secret"],
        message: "must not be shared by multiple clients",
      });
    }
    clientSecrets.add(client.client_secret);

    const redirectUris = new Set<string>();
    client.redirect_uris.forEach((redirectUri, redirectIndex) => {
      if (redirectUris.has(redirectUri)) {
        context.addIssue({
          code: "custom",
          path: [index, "redirect_uris", redirectIndex],
          message: "must be unique within a client",
        });
      }
      redirectUris.add(redirectUri);
    });
  });
});

const brokerTtlSchema = z.object({
  OAUTH_ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(1).max(900).default(900),
  OAUTH_REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().min(1).max(2_592_000).default(2_592_000),
  OAUTH_AUTH_CODE_TTL_SECONDS: z.coerce.number().int().min(1).max(300).default(300),
  OAUTH_BROWSER_FLOW_TTL_SECONDS: z.coerce.number().int().min(1).max(600).default(600),
});

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  PUBLIC_BASE_URL: z.string().url().transform((value) => value.replace(/\/$/, "")),
  DATABASE_URL: z.string().min(1),
  MCP_BEARER_TOKEN: z.string().min(32),
  MCP_ALLOWED_ORIGINS: exactOriginCsv,
  MCP_ALLOWED_HOSTS: nonEmptyCsv,
  REQUEST_BODY_LIMIT_BYTES: z.coerce.number().int().min(1_024).max(5_242_880).default(1_048_576),
  XERO_CLIENT_ID: z.string().min(1),
  XERO_CLIENT_SECRET: z.string().min(1),
  XERO_SCOPES: z.string().transform((value) => [...new Set(value.split(/\s+/).filter(Boolean))]),
  XERO_WRITE_ENABLED: booleanFlag,
  XERO_AUTHORITY_REVISION: z.coerce.number().int().positive().default(1),
  XERO_STANDING_DELEGATIONS_JSON: xeroStandingDelegationsJson,
  XERO_STANDING_DELEGATIONS_CONFIG_SHA256: optionalSha256,
  XERO_EXPECTED_AUTHORITY_SNAPSHOT_SHA256: optionalSha256,
  XERO_EXPECTED_FIRM_GOVERNANCE_AGGREGATE_SHA256: optionalGovernanceAggregateIdentity,
  XERO_ALLOWED_TENANT_ID: optionalUuid,
  XERO_ACCOUNTING_CASE_TEST_TENANT_IDS: optionalUuidCsv,
  XERO_TENANT_COA_PROFILES_JSON: xeroTenantCoaProfilesJson,
  XERO_ACCOUNTING_CASE_BUSINESS_AUTHORITIES_JSON: xeroAccountingCaseBusinessAuthoritiesJson,
  XERO_GOVERNANCE_TRUST_BUNDLE_SHA256: optionalSha256,
  XERO_GOVERNANCE_RECEIPTS_SHA256: optionalSha256,
  XERO_GOVERNANCE_STATUS_SHA256: optionalSha256,
  TOKEN_ENCRYPTION_KEY_B64: base64Key,
  XERO_MUTATION_CONFIRMATION_KEY_B64: base64Key,
  XERO_TARGET_SESSION_REQUIRED: booleanFlag,
  XERO_TARGET_SESSION_TTL_SECONDS: z.coerce.number().int().min(60).max(14_400).default(1_800),
  MCP_OAUTH_BROKER_ENABLED: booleanFlag,
  HOST_OAUTH_CLIENTS_JSON: z.string().optional(),
  OAUTH_MISSING_RESOURCE_COMPAT_CLIENT_IDS: z.string().optional(),
  OAUTH_MANUAL_RETURN_CLIENT_IDS: z.string().optional(),
  OAUTH_ACCESS_TOKEN_TTL_SECONDS: z.string().optional(),
  OAUTH_REFRESH_TOKEN_TTL_SECONDS: z.string().optional(),
  OAUTH_AUTH_CODE_TTL_SECONDS: z.string().optional(),
  OAUTH_BROWSER_FLOW_TTL_SECONDS: z.string().optional(),
  OAUTH_TOKEN_HASH_KEY_B64: z.string().optional(),
  OAUTH_COOKIE_STATE_KEY_B64: z.string().optional(),
  PERSONAL_POC_ONLY: booleanFlag,
  SHARED_TEST_USERS: booleanFlag,
  DEMO_ACTOR_ID: z.string().min(1).max(128).default("demo-operator"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  XERO_BUILD_IDENTITY_JSON: z.string().optional(),
});

export interface AppConfig {
  nodeEnv: "development" | "test" | "production";
  host: string;
  port: number;
  publicBaseUrl: string;
  databaseUrl: string;
  mcpBearerToken: string;
  allowedOrigins: string[];
  allowedHosts: string[];
  requestBodyLimitBytes: number;
  xero: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    scopes: string[];
  };
  xeroWriteEnabled: boolean;
  /** Required by loadConfig in production; optional only for hand-built test/dev configs. */
  xeroBuildIdentity?: XeroBuildIdentity;
  xeroAuthorityRevision: number;
  /** Optional on hand-built test configs; loadConfig always supplies the list. */
  xeroStandingDelegations?: readonly LedgerStandingDelegation[];
  /** SHA-256 of the exact deployment-owned standing-delegation JSON bytes. */
  xeroStandingDelegationsConfigSha256?: string;
  /** Root-admission-approved durable authority snapshot identity. */
  xeroExpectedAuthoritySnapshotSha256?: string;
  /** Root-admission-approved normalized governance aggregate, or NOT_REQUIRED. */
  xeroExpectedFirmGovernanceAggregateSha256?: string;
  xeroAllowedTenantId?: string;
  /** Exact server-owned allowlist where model-extracted test documents may be written. */
  /** Optional on hand-built test configs; loadConfig always supplies the server-owned allowlist. */
  xeroAccountingCaseTestTenantIds?: readonly string[];
  /** Deployment-owned semantic category -> exact tenant AccountID/code bindings. */
  xeroTenantCoaProfiles?: readonly XeroTenantCoaProfile[];
  /** Host-admission-pinned hashes for externally signed firm-governance evidence. */
  xeroGovernanceExpectedHashes?: XeroExternalGovernanceExpectedHashes;
  /** Explicitly test-only legacy fixtures; production loadConfig rejects this source. */
  xeroAccountingCaseBusinessAuthorities?: readonly XeroAccountingCaseBusinessAuthorityProfile[];
  tokenEncryptionKey: Buffer;
  xeroMutationConfirmationKey: Buffer;
  /** Optional on hand-built test configs; loadConfig always populates both fields. */
  xeroTargetSessionRequired?: boolean;
  xeroTargetSessionTtlSeconds?: number;
  /** Optional on hand-built test configs for backward compatibility; loadConfig always populates it. */
  mcpOAuthBroker?: McpOAuthBrokerConfig;
  demoActorId: string;
  logLevel: "debug" | "info" | "warn" | "error";
}

function invalidBrokerConfiguration(message: string): Error {
  return new Error(`Invalid application configuration: ${message}`);
}

function parseBrokerHostClients(rawValue: string | undefined): McpOAuthHostClient[] {
  if (!rawValue) {
    throw invalidBrokerConfiguration(
      "HOST_OAUTH_CLIENTS_JSON is required when MCP_OAUTH_BROKER_ENABLED=true",
    );
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(rawValue) as unknown;
  } catch {
    throw invalidBrokerConfiguration("HOST_OAUTH_CLIENTS_JSON must be a valid JSON array");
  }

  const parsed = brokerHostClientsSchema.safeParse(decoded);
  if (!parsed.success) {
    const message = parsed.error.issues
      .map((issue) => `HOST_OAUTH_CLIENTS_JSON.${issue.path.join(".") || "clients"}: ${issue.message}`)
      .join("; ");
    throw invalidBrokerConfiguration(message);
  }

  return parsed.data.map((client) => ({
    name: client.name,
    clientId: client.client_id,
    clientSecret: client.client_secret,
    redirectUris: [...client.redirect_uris],
  }));
}

function parseBrokerClientIdAllowlist(
  variableName: "OAUTH_MISSING_RESOURCE_COMPAT_CLIENT_IDS" | "OAUTH_MANUAL_RETURN_CLIENT_IDS",
  rawValue: string | undefined,
  hostClients: readonly McpOAuthHostClient[],
): string[] {
  if (!rawValue?.trim()) return [];
  const clientIds = rawValue.split(",").map((value) => value.trim());
  if (
    clientIds.some((clientId) =>
      clientId.length === 0 ||
      clientId.length > 256 ||
      /[\u0000-\u001f\u007f]/u.test(clientId)
    ) ||
    new Set(clientIds).size !== clientIds.length
  ) {
    throw invalidBrokerConfiguration(
      `${variableName} must contain unique exact client IDs`,
    );
  }
  const registeredClientIds = new Set(hostClients.map((client) => client.clientId));
  if (clientIds.some((clientId) => !registeredClientIds.has(clientId))) {
    throw invalidBrokerConfiguration(
      `${variableName} may contain only pre-registered confidential Host client IDs`,
    );
  }
  const compatibleClients = hostClients.filter((client) => clientIds.includes(client.clientId));
  if (compatibleClients.some((client) => client.redirectUris.some((redirectUri) => new URL(redirectUri).search))) {
    throw invalidBrokerConfiguration(
      `${variableName} clients must use exact callback URLs without query parameters`,
    );
  }
  return clientIds;
}

function parseBrokerKey(variableName: string, rawValue: string | undefined): Buffer {
  if (!rawValue) {
    throw invalidBrokerConfiguration(
      `${variableName} is required when MCP_OAUTH_BROKER_ENABLED=true`,
    );
  }

  const parsed = base64Key.safeParse(rawValue);
  if (!parsed.success) {
    throw invalidBrokerConfiguration(`${variableName} must be a canonical base64-encoded 32-byte key`);
  }
  return Buffer.from(parsed.data, "base64");
}

function buildMcpOAuthBrokerConfig(
  value: z.infer<typeof envSchema>,
  tokenEncryptionKey: Buffer,
): McpOAuthBrokerConfig {
  const resourceUri = `${value.PUBLIC_BASE_URL}/mcp`;
  const base = {
    issuer: value.PUBLIC_BASE_URL,
    resourceUri,
    protectedResourceUris: [resourceUri],
    authorizationPath: "/authorize",
    tokenPath: "/token",
    revocationPath: "/revoke",
    authorizationEndpoint: `${value.PUBLIC_BASE_URL}/authorize`,
    tokenEndpoint: `${value.PUBLIC_BASE_URL}/token`,
    revocationEndpoint: `${value.PUBLIC_BASE_URL}/revoke`,
    scopes: MCP_OAUTH_SCOPES,
    personalPocOnly: value.PERSONAL_POC_ONLY,
    sharedTestUsers: value.SHARED_TEST_USERS,
  } satisfies McpOAuthBrokerBaseConfig;

  if (!value.MCP_OAUTH_BROKER_ENABLED) {
    return { ...base, enabled: false };
  }

  const publicUrl = new URL(value.PUBLIC_BASE_URL);
  if (
    publicUrl.protocol !== "https:" ||
    publicUrl.pathname !== "/" ||
    publicUrl.search ||
    publicUrl.hash ||
    publicUrl.username ||
    publicUrl.password
  ) {
    throw invalidBrokerConfiguration(
      "PUBLIC_BASE_URL must be an HTTPS origin when MCP_OAUTH_BROKER_ENABLED=true",
    );
  }

  const ttlResult = brokerTtlSchema.safeParse(value);
  if (!ttlResult.success) {
    const message = ttlResult.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw invalidBrokerConfiguration(message);
  }

  const hostClients = parseBrokerHostClients(value.HOST_OAUTH_CLIENTS_JSON);
  const missingResourceCompatClientIds = parseBrokerClientIdAllowlist(
    "OAUTH_MISSING_RESOURCE_COMPAT_CLIENT_IDS",
    value.OAUTH_MISSING_RESOURCE_COMPAT_CLIENT_IDS,
    hostClients,
  );
  const manualReturnClientIds = parseBrokerClientIdAllowlist(
    "OAUTH_MANUAL_RETURN_CLIENT_IDS",
    value.OAUTH_MANUAL_RETURN_CLIENT_IDS,
    hostClients,
  );
  if (missingResourceCompatClientIds.length > 0 && !value.PERSONAL_POC_ONLY) {
    throw invalidBrokerConfiguration(
      "OAUTH_MISSING_RESOURCE_COMPAT_CLIENT_IDS is allowed only when PERSONAL_POC_ONLY=true",
    );
  }
  if (manualReturnClientIds.length > 0 && !value.PERSONAL_POC_ONLY) {
    throw invalidBrokerConfiguration(
      "OAUTH_MANUAL_RETURN_CLIENT_IDS is allowed only when PERSONAL_POC_ONLY=true",
    );
  }
  if (value.SHARED_TEST_USERS && !value.PERSONAL_POC_ONLY) {
    throw invalidBrokerConfiguration(
      "SHARED_TEST_USERS=true requires PERSONAL_POC_ONLY=true because no signed Host user identity is available",
    );
  }
  const tokenHashKey = parseBrokerKey("OAUTH_TOKEN_HASH_KEY_B64", value.OAUTH_TOKEN_HASH_KEY_B64);
  const cookieStateKey = parseBrokerKey("OAUTH_COOKIE_STATE_KEY_B64", value.OAUTH_COOKIE_STATE_KEY_B64);
  if (
    tokenHashKey.equals(cookieStateKey) ||
    tokenHashKey.equals(tokenEncryptionKey) ||
    cookieStateKey.equals(tokenEncryptionKey)
  ) {
    throw invalidBrokerConfiguration(
      "OAuth broker hash, cookie/state, and Xero token encryption keys must be independent",
    );
  }

  return {
    ...base,
    enabled: true,
    hostClients,
    missingResourceCompatClientIds,
    manualReturnClientIds,
    accessTokenTtlSeconds: ttlResult.data.OAUTH_ACCESS_TOKEN_TTL_SECONDS,
    refreshTokenTtlSeconds: ttlResult.data.OAUTH_REFRESH_TOKEN_TTL_SECONDS,
    authorizationCodeTtlSeconds: ttlResult.data.OAUTH_AUTH_CODE_TTL_SECONDS,
    browserFlowTtlSeconds: ttlResult.data.OAUTH_BROWSER_FLOW_TTL_SECONDS,
    tokenHashKey,
    cookieStateKey,
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const rawStandingDelegationsJson = env.XERO_STANDING_DELEGATIONS_JSON ?? "[]";
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const message = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "environment"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid application configuration: ${message}`);
  }

  const value = parsed.data;
  if (value.NODE_ENV !== "test" && value.XERO_ACCOUNTING_CASE_BUSINESS_AUTHORITIES_JSON.length > 0) {
    throw new Error(
      "Invalid application configuration: candidate-supplied XERO_ACCOUNTING_CASE_BUSINESS_AUTHORITIES_JSON authority is forbidden; use host-admitted signed governance evidence",
    );
  }
  let xeroBuildIdentity: XeroBuildIdentity | undefined;
  if (value.XERO_BUILD_IDENTITY_JSON?.trim()) {
    try {
      xeroBuildIdentity = parseXeroBuildIdentity(value.XERO_BUILD_IDENTITY_JSON);
    } catch (error) {
      throw new Error(
        `Invalid application configuration: XERO_BUILD_IDENTITY_JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (value.NODE_ENV === "production" && !xeroBuildIdentity) {
    throw new Error("Invalid application configuration: XERO_BUILD_IDENTITY_JSON is required in production");
  }
  const missingXeroCapabilities = missingXeroScopeCapabilities(
    value.XERO_SCOPES,
    value.MCP_OAUTH_BROKER_ENABLED || value.XERO_WRITE_ENABLED,
  );
  if (missingXeroCapabilities.length > 0) {
    throw new Error(
      `Invalid application configuration: XERO_SCOPES is missing required Xero capabilities: ${missingXeroCapabilities.map((item) => item.capability).join(", ")}`,
    );
  }
  if (value.NODE_ENV === "production" && !value.PUBLIC_BASE_URL.startsWith("https://")) {
    throw new Error("Invalid application configuration: PUBLIC_BASE_URL must use HTTPS in production");
  }
  if (value.NODE_ENV === "production") {
    const publicUrl = new URL(value.PUBLIC_BASE_URL);
    if (
      publicUrl.pathname !== "/" ||
      publicUrl.search ||
      publicUrl.hash ||
      publicUrl.username ||
      publicUrl.password
    ) {
      throw new Error(
        "Invalid application configuration: PUBLIC_BASE_URL must be an origin without path, query, fragment, or userinfo",
      );
    }
    if (value.MCP_ALLOWED_ORIGINS.some((origin) => new URL(origin).protocol !== "https:")) {
      throw new Error(
        "Invalid application configuration: MCP_ALLOWED_ORIGINS must contain only exact HTTPS origins in production",
      );
    }
  }
  if (value.XERO_WRITE_ENABLED && !value.MCP_OAUTH_BROKER_ENABLED) {
    throw new Error(
      "Invalid application configuration: MCP_OAUTH_BROKER_ENABLED=true is required when XERO_WRITE_ENABLED=true",
    );
  }
  if (value.XERO_WRITE_ENABLED && !value.XERO_TARGET_SESSION_REQUIRED) {
    throw new Error(
      "Invalid application configuration: XERO_TARGET_SESSION_REQUIRED=true is required when XERO_WRITE_ENABLED=true",
    );
  }
  const standingDelegationsConfigSha256 = sha256(rawStandingDelegationsJson);
  if (
    value.XERO_STANDING_DELEGATIONS_CONFIG_SHA256 !== undefined &&
    value.XERO_STANDING_DELEGATIONS_CONFIG_SHA256 !== standingDelegationsConfigSha256
  ) {
    throw new Error(
      "Invalid application configuration: XERO_STANDING_DELEGATIONS_CONFIG_SHA256 does not match the exact XERO_STANDING_DELEGATIONS_JSON bytes",
    );
  }
  if (
    value.XERO_WRITE_ENABLED &&
    (!env.XERO_AUTHORITY_REVISION?.trim() || value.XERO_STANDING_DELEGATIONS_CONFIG_SHA256 === undefined ||
      value.XERO_EXPECTED_AUTHORITY_SNAPSHOT_SHA256 === undefined ||
      value.XERO_EXPECTED_FIRM_GOVERNANCE_AGGREGATE_SHA256 === undefined)
  ) {
    throw new Error(
      "Invalid application configuration: explicit XERO_AUTHORITY_REVISION, XERO_STANDING_DELEGATIONS_CONFIG_SHA256, XERO_EXPECTED_AUTHORITY_SNAPSHOT_SHA256 and XERO_EXPECTED_FIRM_GOVERNANCE_AGGREGATE_SHA256 are required when XERO_WRITE_ENABLED=true",
    );
  }
  if (
    value.XERO_WRITE_ENABLED &&
    !value.XERO_STANDING_DELEGATIONS_JSON.some((delegation) => delegation.status === "ACTIVE")
  ) {
    throw new Error(
      "Invalid application configuration: at least one active Xero standing delegation is required when XERO_WRITE_ENABLED=true",
    );
  }
  const firmGovernanceRequired = value.XERO_STANDING_DELEGATIONS_JSON.some((delegation) =>
    delegation.status === "ACTIVE" && delegation.firmGovernanceRequired === true);
  if (value.XERO_EXPECTED_FIRM_GOVERNANCE_AGGREGATE_SHA256 !== undefined &&
      ((firmGovernanceRequired && value.XERO_EXPECTED_FIRM_GOVERNANCE_AGGREGATE_SHA256 === "NOT_REQUIRED") ||
        (!firmGovernanceRequired && value.XERO_EXPECTED_FIRM_GOVERNANCE_AGGREGATE_SHA256 !== "NOT_REQUIRED"))) {
    throw new Error(
      "Invalid application configuration: XERO_EXPECTED_FIRM_GOVERNANCE_AGGREGATE_SHA256 does not match the standing-delegation governance requirement",
    );
  }
  if (value.XERO_WRITE_ENABLED) {
    // ADR-002: per-tenant chart-of-accounts profiles are no longer a write-gate
    // precondition. Account and tax coordinates are declared by the caller and
    // verified against the target tenant's live chart of accounts and tax rates
    // at prepare and again at the provider permit edge. The environment
    // variable itself is retained so existing deployments keep booting.
    const nonUniqueCoordinateActions = new Set([
      "customer_invoice.create_draft",
      "supplier_bill.create_draft",
      "credit_note.create_draft",
    ]);
    const authorityRequiredTenants = new Set([
      ...value.XERO_STANDING_DELEGATIONS_JSON
        .filter((delegation) => delegation.status === "ACTIVE" &&
          delegation.actionIds.some((actionId) => nonUniqueCoordinateActions.has(actionId)))
        .flatMap((delegation) => delegation.tenantIds),
      ...value.XERO_ACCOUNTING_CASE_TEST_TENANT_IDS,
    ]);
    const governanceHashes = [
      value.XERO_GOVERNANCE_TRUST_BUNDLE_SHA256,
      value.XERO_GOVERNANCE_RECEIPTS_SHA256,
      value.XERO_GOVERNANCE_STATUS_SHA256,
    ];
    if (authorityRequiredTenants.size > 0) {
      if (value.NODE_ENV === "test") {
        const verifiedTenants = new Set(value.XERO_ACCOUNTING_CASE_BUSINESS_AUTHORITIES_JSON
          .filter((profile) => profile.writer_authority.mode === "VERIFIED_FIRM_GOVERNANCE")
          .map((profile) => profile.tenant_id.toLowerCase()));
        const missing = [...authorityRequiredTenants]
          .filter((tenantId) => !verifiedTenants.has(tenantId.toLowerCase()));
        if (missing.length > 0) {
          throw new Error(
            `Invalid application configuration: missing externally verified exclusive-writer authority for active non-unique write tenants: ${missing.join(", ")}`,
          );
        }
      } else if (governanceHashes.some((hash) => hash === undefined)) {
        throw new Error(
          `Invalid application configuration: host-admitted signed Xero governance hashes are required for active actions that can reach non-unique Xero coordinates: ${[...authorityRequiredTenants].join(", ")}`,
        );
      }
    }
  }
  const tokenEncryptionKey = Buffer.from(value.TOKEN_ENCRYPTION_KEY_B64, "base64");
  const xeroMutationConfirmationKey = Buffer.from(value.XERO_MUTATION_CONFIRMATION_KEY_B64, "base64");
  if (tokenEncryptionKey.equals(xeroMutationConfirmationKey)) {
    throw new Error(
      "Invalid application configuration: XERO_MUTATION_CONFIRMATION_KEY_B64 must be independent from TOKEN_ENCRYPTION_KEY_B64",
    );
  }
  const mcpOAuthBroker = buildMcpOAuthBrokerConfig(value, tokenEncryptionKey);
  if (
    mcpOAuthBroker.enabled &&
    (
      xeroMutationConfirmationKey.equals(mcpOAuthBroker.tokenHashKey) ||
      xeroMutationConfirmationKey.equals(mcpOAuthBroker.cookieStateKey)
    )
  ) {
    throw new Error(
      "Invalid application configuration: Xero mutation confirmation, OAuth broker hash, and cookie/state keys must be independent",
    );
  }
  return {
    nodeEnv: value.NODE_ENV,
    host: value.HOST,
    port: value.PORT,
    publicBaseUrl: value.PUBLIC_BASE_URL,
    databaseUrl: value.DATABASE_URL,
    mcpBearerToken: value.MCP_BEARER_TOKEN,
    allowedOrigins: value.MCP_ALLOWED_ORIGINS,
    allowedHosts: value.MCP_ALLOWED_HOSTS.map((host) => new URL(`http://${host}`).hostname),
    requestBodyLimitBytes: value.REQUEST_BODY_LIMIT_BYTES,
    xero: {
      clientId: value.XERO_CLIENT_ID,
      clientSecret: value.XERO_CLIENT_SECRET,
      redirectUri: `${value.PUBLIC_BASE_URL}/oauth/xero/callback`,
      scopes: value.XERO_SCOPES,
    },
    xeroWriteEnabled: value.XERO_WRITE_ENABLED,
    ...(xeroBuildIdentity ? { xeroBuildIdentity } : {}),
    xeroAuthorityRevision: value.XERO_AUTHORITY_REVISION,
    xeroStandingDelegations: Object.freeze([...value.XERO_STANDING_DELEGATIONS_JSON]),
    xeroStandingDelegationsConfigSha256: standingDelegationsConfigSha256,
    ...(value.XERO_EXPECTED_AUTHORITY_SNAPSHOT_SHA256
      ? { xeroExpectedAuthoritySnapshotSha256: value.XERO_EXPECTED_AUTHORITY_SNAPSHOT_SHA256 }
      : {}),
    ...(value.XERO_EXPECTED_FIRM_GOVERNANCE_AGGREGATE_SHA256
      ? { xeroExpectedFirmGovernanceAggregateSha256:
          value.XERO_EXPECTED_FIRM_GOVERNANCE_AGGREGATE_SHA256 }
      : {}),
    ...(value.XERO_ALLOWED_TENANT_ID ? { xeroAllowedTenantId: value.XERO_ALLOWED_TENANT_ID } : {}),
    xeroAccountingCaseTestTenantIds: Object.freeze([...value.XERO_ACCOUNTING_CASE_TEST_TENANT_IDS]),
    xeroTenantCoaProfiles: Object.freeze([...value.XERO_TENANT_COA_PROFILES_JSON]),
    ...(value.XERO_GOVERNANCE_TRUST_BUNDLE_SHA256 && value.XERO_GOVERNANCE_RECEIPTS_SHA256 &&
      value.XERO_GOVERNANCE_STATUS_SHA256 ? {
        xeroGovernanceExpectedHashes: Object.freeze({
          trustBundleSha256: value.XERO_GOVERNANCE_TRUST_BUNDLE_SHA256,
          receiptsSha256: value.XERO_GOVERNANCE_RECEIPTS_SHA256,
          statusSha256: value.XERO_GOVERNANCE_STATUS_SHA256,
        }),
      } : {}),
    ...(value.NODE_ENV === "test" ? {
      xeroAccountingCaseBusinessAuthorities: Object.freeze([
        ...value.XERO_ACCOUNTING_CASE_BUSINESS_AUTHORITIES_JSON,
      ]),
    } : {}),
    tokenEncryptionKey,
    xeroMutationConfirmationKey,
    xeroTargetSessionRequired: value.XERO_TARGET_SESSION_REQUIRED,
    xeroTargetSessionTtlSeconds: value.XERO_TARGET_SESSION_TTL_SECONDS,
    mcpOAuthBroker,
    demoActorId: value.DEMO_ACTOR_ID,
    logLevel: value.LOG_LEVEL,
  };
}
