#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";

const baseUrl = requiredEnv("MCP_BASE_URL").replace(/\/$/, "");
const bearer = requiredEnv("MCP_BEARER_TOKEN");
const allowedOrigin = requiredEnv("MCP_ALLOWED_ORIGIN");
const protocolVersion = process.env.MCP_PROTOCOL_VERSION ?? "2025-06-18";
const oversizeBytes = positiveInt(process.env.MCP_OVERSIZE_BYTES ?? "2097152");
const outputPath = process.env.MCP_SMOKE_OUTPUT;
const endpoint = `${baseUrl}/mcp`;
const expectedTools = JSON.parse(
  readFileSync(new URL("./contract/expected-tools.json", import.meta.url), "utf8"),
);

let nextId = 1;
let sessionId;
let negotiatedProtocolVersion = protocolVersion;
const checks = [];

await check("EDGE-001 missing bearer returns 401", async () => {
  const response = await rawPost(initializeMessage(9001), {
    origin: allowedOrigin,
    auth: false,
  });
  assertStatus(response, 401);
});

await check("EDGE-001 invalid bearer returns 401", async () => {
  const response = await rawPost(initializeMessage(9002), {
    origin: allowedOrigin,
    bearerOverride: "qa-invalid-bearer-that-must-never-work",
  });
  assertStatus(response, 401);
});

await check("EDGE-002 wrong Origin returns 403", async () => {
  const response = await rawPost(initializeMessage(9003), {
    origin: "https://evil.invalid",
  });
  assertStatus(response, 403);
});

await check("EDGE-003 oversized body returns 413", async () => {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 9004,
    method: "ping",
    params: { padding: "x".repeat(oversizeBytes) },
  });
  const response = await rawPost(body, { origin: allowedOrigin, bodyIsString: true });
  assertStatus(response, 413);
});

await check("MCP-001 initialize", async () => {
  const response = await rawPost(initializeMessage(nextId++), { origin: allowedOrigin });
  assertStatus(response, 200);
  const payload = await parseMcpResponse(response);
  assertRpcSuccess(payload);
  if (!payload.result?.serverInfo?.name) {
    throw new Error("initialize response is missing result.serverInfo.name");
  }
  if (!payload.result?.capabilities?.tools) {
    throw new Error("initialize response is missing tools capability");
  }
  sessionId = response.headers.get("mcp-session-id") ?? undefined;
  negotiatedProtocolVersion = payload.result.protocolVersion ?? protocolVersion;
});

await check("MCP-001 notifications/initialized", async () => {
  const response = await rawPost(
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { origin: allowedOrigin, session: sessionId },
  );
  assertOneOfStatuses(response, [200, 202, 204]);
});

await check("MCP-002 ping", async () => {
  const response = await rpc("ping", {});
  assertRpcSuccess(response);
});

await check("MCP-003 fixed tools/list", async () => {
  const tools = [];
  let cursor;
  do {
    const params = cursor ? { cursor } : {};
    const response = await rpc("tools/list", params);
    assertRpcSuccess(response);
    if (!Array.isArray(response.result?.tools)) {
      throw new Error("tools/list response is missing result.tools array");
    }
    tools.push(...response.result.tools);
    cursor = response.result.nextCursor;
  } while (cursor);

  const actualNames = [...new Set(tools.map((tool) => tool.name))].sort();
  const expectedNames = [...expectedTools].sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    const missing = expectedNames.filter((name) => !actualNames.includes(name));
    const unexpected = actualNames.filter((name) => !expectedNames.includes(name));
    throw new Error(
      `tool allowlist mismatch; missing=${JSON.stringify(missing)} unexpected=${JSON.stringify(unexpected)}`,
    );
  }

  for (const tool of tools) {
    if (!tool.inputSchema || tool.inputSchema.type !== "object") {
      throw new Error(`${tool.name} must declare an object inputSchema`);
    }
  }
});

const summary = {
  target: endpoint,
  protocolVersion: negotiatedProtocolVersion,
  sessionMode: sessionId ? "stateful" : "stateless",
  expectedToolCount: expectedTools.length,
  passed: checks.filter((item) => item.status === "PASS").length,
  failed: checks.filter((item) => item.status === "FAIL").length,
  checks,
  finishedAt: new Date().toISOString(),
};

const rendered = `${JSON.stringify(summary, null, 2)}\n`;
if (outputPath) {
  writeFileSync(outputPath, rendered, { mode: 0o600 });
}
process.stdout.write(rendered);
process.exitCode = summary.failed === 0 ? 0 : 1;

async function rpc(method, params) {
  const response = await rawPost(
    { jsonrpc: "2.0", id: nextId++, method, params },
    { origin: allowedOrigin, session: sessionId },
  );
  assertStatus(response, 200);
  return parseMcpResponse(response);
}

async function rawPost(body, options = {}) {
  const headers = {
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
    Origin: options.origin ?? allowedOrigin,
    "MCP-Protocol-Version": negotiatedProtocolVersion,
  };
  if (options.auth !== false) {
    headers.Authorization = `Bearer ${options.bearerOverride ?? bearer}`;
  }
  if (options.session) {
    headers["Mcp-Session-Id"] = options.session;
  }
  return fetch(endpoint, {
    method: "POST",
    headers,
    body: options.bodyIsString ? body : JSON.stringify(body),
    redirect: "manual",
  });
}

async function parseMcpResponse(response) {
  const text = await response.text();
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    const messages = text
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    if (messages.length === 0) {
      throw new Error("SSE response did not contain a JSON data event");
    }
    return messages.at(-1);
  }
  if (!text.trim()) {
    throw new Error("MCP response body was empty");
  }
  return JSON.parse(text);
}

async function check(name, fn) {
  const startedAt = Date.now();
  try {
    await fn();
    checks.push({ name, status: "PASS", durationMs: Date.now() - startedAt });
  } catch (error) {
    checks.push({
      name,
      status: "FAIL",
      durationMs: Date.now() - startedAt,
      error: sanitizeError(error),
    });
  }
}

function initializeMessage(id) {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: "zcloak-xero-qa-smoke", version: "0.1.0" },
    },
  };
}

function assertRpcSuccess(payload) {
  if (!payload || payload.jsonrpc !== "2.0") {
    throw new Error("response is not JSON-RPC 2.0");
  }
  if (payload.error) {
    throw new Error(`JSON-RPC error ${payload.error.code}: ${payload.error.message}`);
  }
  if (!("result" in payload)) {
    throw new Error("JSON-RPC response is missing result");
  }
}

function assertStatus(response, expected) {
  if (response.status !== expected) {
    throw new Error(`expected HTTP ${expected}, received ${response.status}`);
  }
}

function assertOneOfStatuses(response, expected) {
  if (!expected.includes(response.status)) {
    throw new Error(`expected one of HTTP ${expected.join(",")}, received ${response.status}`);
  }
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    process.stderr.write(`Missing required environment variable: ${name}\n`);
    process.exit(2);
  }
  return value;
}

function positiveInt(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`expected a positive integer, received ${value}`);
  }
  return parsed;
}

function sanitizeError(error) {
  return String(error?.message ?? error)
    .replaceAll(bearer, "[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [REDACTED]")
    .slice(0, 500);
}
