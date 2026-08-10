import type { NextFunction, Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { MCP_OAUTH_SCOPES } from "../src/config.js";
import { requireConstantTimeOAuthClient } from "../src/oauth/clientAuthentication.js";
import { StaticOAuthClientsStore } from "../src/oauth/staticOAuthClientsStore.js";

const store = new StaticOAuthClientsStore([
  {
    name: "Agent2",
    clientId: "agent2-accounting-mcp",
    clientSecret: "a".repeat(43),
    redirectUris: ["https://agent2.zcloak.ai/api/mcp/accounting-mcp/oauth/callback"],
  },
], MCP_OAUTH_SCOPES);

function formEncode(value: string): string {
  return new URLSearchParams({ value }).toString().slice("value=".length);
}

function basicHeader(clientId: string, clientSecret: string, encode = false): string {
  const id = encode ? formEncode(clientId) : clientId;
  const secret = encode ? formEncode(clientSecret) : clientSecret;
  return `Basic ${Buffer.from(`${id}:${secret}`, "utf8").toString("base64")}`;
}

async function authenticate(options: {
  body?: Record<string, unknown>;
  authorization?: string;
  rawHeaders?: string[];
}, clientsStore = store) {
  const next = vi.fn() as NextFunction;
  const response = {
    setHeader: vi.fn(),
    status: vi.fn(),
    json: vi.fn(),
  } as unknown as Response;
  vi.mocked(response.status).mockReturnValue(response);
  const request = {
    body: options.body ?? {},
    headers: options.authorization ? { authorization: options.authorization } : {},
    rawHeaders: options.rawHeaders ?? [],
  } as unknown as Request;
  await requireConstantTimeOAuthClient(clientsStore)(
    request,
    response,
    next,
  );
  return { next, request, response };
}

describe("static OAuth clients", () => {
  it("publishes the exact pre-registered Agent2 contract without dynamic registration", () => {
    const client = store.getClient("agent2-accounting-mcp");
    expect(client).toMatchObject({
      client_id: "agent2-accounting-mcp",
      client_name: "Agent2",
      redirect_uris: ["https://agent2.zcloak.ai/api/mcp/accounting-mcp/oauth/callback"],
      token_endpoint_auth_method: "client_secret_basic",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: "xero.read xero.draft.write",
    });
    expect(store.registerClient).toBeUndefined();
  });

  it("rejects duplicate client identifiers", () => {
    const duplicate = {
      name: "Duplicate",
      clientId: "same-client",
      clientSecret: "b".repeat(43),
      redirectUris: ["https://example.com/one"],
    };
    expect(() => new StaticOAuthClientsStore([duplicate, { ...duplicate, name: "Other" }], MCP_OAUTH_SCOPES))
      .toThrow(/unique/i);
  });

  it("accepts the existing client_secret_post contract", async () => {
    const accepted = await authenticate({
      body: {
        client_id: "agent2-accounting-mcp",
        client_secret: "a".repeat(43),
      },
    });
    expect(accepted.next).toHaveBeenCalledOnce();
    expect(accepted.response.status).not.toHaveBeenCalled();
  });

  it("accepts RFC Basic, percent-decodes form-encoded credentials, and normalizes for the SDK", async () => {
    const clientId = "agent2:accounting client";
    const clientSecret = "safe +:/% secret ".repeat(3);
    const encodedStore = new StaticOAuthClientsStore([{
      name: "Encoded Agent2",
      clientId,
      clientSecret,
      redirectUris: ["https://agent2.zcloak.ai/api/mcp/encoded/oauth/callback"],
    }], MCP_OAUTH_SCOPES);
    const accepted = await authenticate({
      body: { grant_type: "authorization_code", code: "opaque-code" },
      authorization: basicHeader(clientId, clientSecret, true).replace("Basic", "bAsIc"),
    }, encodedStore);

    expect(accepted.next).toHaveBeenCalledOnce();
    expect(accepted.response.status).not.toHaveBeenCalled();
    expect(accepted.request.body).toEqual({
      grant_type: "authorization_code",
      code: "opaque-code",
      client_id: clientId,
      client_secret: clientSecret,
    });
    expect(accepted.request.headers.authorization).toBeUndefined();

    const rawClientSecret = `${"b".repeat(32)}+raw-client-secret`;
    const rawStore = new StaticOAuthClientsStore([{
      name: "Raw Basic Agent2",
      clientId: "raw-basic-agent2",
      clientSecret: rawClientSecret,
      redirectUris: ["https://agent2.zcloak.ai/api/mcp/raw/oauth/callback"],
    }], MCP_OAUTH_SCOPES);
    const rawAccepted = await authenticate({
      body: { grant_type: "authorization_code" },
      authorization: basicHeader("raw-basic-agent2", rawClientSecret),
    }, rawStore);
    expect(rawAccepted.next).toHaveBeenCalledOnce();
    expect(rawAccepted.request.body).toMatchObject({
      client_id: "raw-basic-agent2",
      client_secret: rawClientSecret,
    });
  });

  it("accepts a malformed percent sequence only as a raw secret for an unchanged client identifier", async () => {
    const rawClientSecret = "literal-%ZZ-client-secret";
    const rawStore = new StaticOAuthClientsStore([{
      name: "Malformed Percent Agent2",
      clientId: "percent-raw-agent2",
      clientSecret: rawClientSecret,
      redirectUris: ["https://agent2.zcloak.ai/api/mcp/percent-raw/oauth/callback"],
    }], MCP_OAUTH_SCOPES);
    const accepted = await authenticate({
      authorization: basicHeader("percent-raw-agent2", rawClientSecret),
    }, rawStore);
    expect(accepted.next).toHaveBeenCalledOnce();
    expect(accepted.request.body).toMatchObject({
      client_id: "percent-raw-agent2",
      client_secret: rawClientSecret,
    });

    const changedIdStore = new StaticOAuthClientsStore([{
      name: "Changed Identifier Agent2",
      clientId: "percent raw agent2",
      clientSecret: rawClientSecret,
      redirectUris: ["https://agent2.zcloak.ai/api/mcp/changed-id/oauth/callback"],
    }], MCP_OAUTH_SCOPES);
    const rejected = await authenticate({
      authorization: basicHeader("percent+raw+agent2", rawClientSecret),
    }, changedIdStore);
    expect(rejected.next).not.toHaveBeenCalled();
    expect(rejected.response.status).toHaveBeenCalledWith(401);
  });

  it("rejects wrong or missing credentials uniformly", async () => {
    for (const options of [
      { body: { client_id: "agent2-accounting-mcp", client_secret: "wrong" } },
      { body: { client_id: "missing", client_secret: "a".repeat(43) } },
      { body: { client_id: "agent2-accounting-mcp" } },
      { body: {} },
      { authorization: basicHeader("agent2-accounting-mcp", "wrong") },
      { authorization: basicHeader("missing", "a".repeat(43)) },
    ]) {
      const rejected = await authenticate(options);
      expect(rejected.next).not.toHaveBeenCalled();
      expect(rejected.response.status).toHaveBeenCalledWith(401);
      expect(rejected.response.setHeader).toHaveBeenCalledWith(
        "WWW-Authenticate",
        'Basic realm="oauth-token", charset="UTF-8"',
      );
      expect(rejected.response.json).toHaveBeenCalledWith({
        error: "invalid_client",
        error_description: "OAuth client authentication failed.",
      });
    }
  });

  it("rejects malformed Basic credentials without exposing parser details", async () => {
    const invalidUtf8 = Buffer.from([0xff, 0x3a, 0x61]).toString("base64");
    const validToken = basicHeader("agent2-accounting-mcp", "a".repeat(43)).slice("Basic ".length);
    for (const authorization of [
      "Bearer not-basic",
      "Basic ",
      "Basic %%%",
      `Baſic ${validToken}`,
      `Basic ${validToken.replace(/=+$/u, "")}`,
      `Basic ${validToken}=`,
      `Basic ${Buffer.from("missing-separator", "utf8").toString("base64")}`,
      `Basic ${Buffer.from("agent2-accounting-mcp:%ZZ", "utf8").toString("base64")}`,
      `Basic ${invalidUtf8}`,
    ]) {
      const rejected = await authenticate({ authorization });
      expect(rejected.next, authorization).not.toHaveBeenCalled();
      expect(rejected.response.status, authorization).toHaveBeenCalledWith(401);
      expect(rejected.response.json, authorization).toHaveBeenCalledWith({
        error: "invalid_client",
        error_description: "OAuth client authentication failed.",
      });
    }
  });

  it("rejects mixed and duplicate client authentication", async () => {
    const validBasic = basicHeader("agent2-accounting-mcp", "a".repeat(43));
    const rejectedRequests = [
      {
        body: { client_id: "agent2-accounting-mcp", client_secret: "a".repeat(43) },
        authorization: validBasic,
      },
      {
        body: { client_id: ["agent2-accounting-mcp", "agent2-accounting-mcp"], client_secret: "a".repeat(43) },
      },
      {
        body: { client_id: "agent2-accounting-mcp", client_secret: ["a".repeat(43), "a".repeat(43)] },
      },
      {
        rawHeaders: ["Authorization", validBasic, "authorization", validBasic],
      },
    ];

    for (const options of rejectedRequests) {
      const rejected = await authenticate(options);
      expect(rejected.next).not.toHaveBeenCalled();
      expect(rejected.response.status).toHaveBeenCalledWith(401);
      expect(rejected.response.json).toHaveBeenCalledWith({
        error: "invalid_client",
        error_description: "OAuth client authentication failed.",
      });
    }
  });
});
