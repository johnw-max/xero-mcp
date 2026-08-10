#!/usr/bin/env node

const baseUrl = requiredEnv("MCP_BASE_URL").replace(/\/$/, "");
const bearer = requiredEnv("MCP_BEARER_TOKEN");
const allowedOrigin = requiredEnv("MCP_ALLOWED_ORIGIN");

const toolResponse = await fetch(`${baseUrl}/mcp`, {
  method: "POST",
  headers: {
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${bearer}`,
    "Content-Type": "application/json",
    "MCP-Protocol-Version": "2025-06-18",
    Origin: allowedOrigin,
  },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "xero_connection_status", arguments: {} },
  }),
  redirect: "manual",
});

assert(toolResponse.status === 200, `tools/call returned HTTP ${toolResponse.status}`);
const rpc = await parseMcpResponse(toolResponse);
assert(!rpc.error, `tools/call returned JSON-RPC error ${rpc.error?.code ?? "unknown"}`);
const text = rpc.result?.content?.find((item) => item?.type === "text")?.text;
assert(typeof text === "string", "xero_connection_status returned no text content");
const toolPayload = JSON.parse(text);
const status = toolPayload.result ?? toolPayload;
assert(status.connected === false, "verification requires the pre-OAuth disconnected state");
assert(typeof status.connectUrl === "string", "connection status returned no connect URL");

const first = await fetch(status.connectUrl, { redirect: "manual" });
const location = first.headers.get("location");
assert(first.status === 302, `connect URL returned HTTP ${first.status}, not 302`);
assert(location, "connect URL returned no redirect Location");
const redirect = new URL(location);
assert(redirect.protocol === "https:", "Xero consent redirect is not HTTPS");
assert(redirect.hostname === "login.xero.com", `unexpected consent host ${redirect.hostname}`);

const replay = await fetch(status.connectUrl, { redirect: "manual" });
assert([403, 409].includes(replay.status), `consumed ticket replay returned HTTP ${replay.status}`);

process.stdout.write(`${JSON.stringify({
  status: "PASS",
  verifier: "live-connect-boundary",
  mcpConnected: status.connected,
  firstConnectStatus: first.status,
  redirectOrigin: redirect.origin,
  redirectPath: redirect.pathname,
  consumedTicketReplayStatus: replay.status,
})}\n`);

async function parseMcpResponse(response) {
  const body = await response.text();
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) return JSON.parse(body);
  const messages = body
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert(messages.length > 0, "SSE response contained no JSON event");
  return messages.at(-1);
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
