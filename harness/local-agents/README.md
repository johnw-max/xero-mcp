# Local business-agent MCP harness

This test-only STDIO server gives a real Agent the production 0.3.0 MCP tool
schemas and `AccountingService`, with Xero replaced only at the Provider
boundary by the pinned synthetic ledger. It is intended for business-language
Agent orchestration checks after deterministic protocol tests pass.

Safety defaults:

- `XERO_SYNTHETIC_WRITE_ENABLED` is false unless explicitly set to `true`.
- The tenant is fixed by a synthetic OAuth installation/binding; no tool input
  can select another organisation.
- The Provider has no network client and cannot reach live Xero.
- Preparations can be created in the process-local repository; they disappear
  when that Agent run exits.
- Even in explicit write mode, only the synthetic Provider can receive a DRAFT
  write. This harness is never evidence of a live Xero posting.

Build the sandbox-safe runtime before starting business Agents:

```sh
./node_modules/.bin/esbuild harness/local-agents/serve-synthetic-mcp.ts \
  --bundle \
  --packages=external \
  --platform=node \
  --format=esm \
  --target=node24 \
  --outfile=tmp/xero-local-agent-runtime/xero-synthetic-mcp-0.3.0.mjs
```

Configure each Agent's STDIO MCP with:

- command: `node`
- args: `tmp/xero-local-agent-runtime/xero-synthetic-mcp-0.3.0.mjs`
- cwd: the repository root
- env: `XERO_SYNTHETIC_WRITE_ENABLED=false`

Do not use the `tsx` CLI as the MCP command inside a restricted Agent sandbox.
That CLI creates a temporary IPC listener which some sandboxes deny, causing a
misleading 30-second MCP handshake timeout before the server can initialize.
The precompiled Node entrypoint has no such listener.

Use a fresh process for every Agent role so one conversation cannot inherit a
previous role's preparation or synthetic Provider records. Capture the Agent's
tool-call events and final answer separately. A passing business answer still
does not replace deterministic idempotency, PostgreSQL, OAuth, or live same-ID
read-back evidence.
