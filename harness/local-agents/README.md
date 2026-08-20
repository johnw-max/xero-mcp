# Local deployment-equivalent business-agent MCP harness

## Current 0.4.0-rc.1 synthetic release evidence

`npm run evidence:local-agent` starts a real ephemeral Codex process against
`serve-accounting-case-mcp.ts` over STDIO MCP. Before each run it creates an
ephemeral workspace containing one `AGENTS.md`, composed byte-for-byte from the
current final Agent instructions, capability contract, and Xero connector
profile. The exact `prepare-balanced-accounting-entry` and
`execute-approved-accounting-entry` packages plus their required references are
mounted separately under `.agents/skills`, matching Codex project-Skill
discovery without exceeding the project-document byte limit. Only delimiter
headings are added. Codex uses that workspace as `-C`; the MCP process still
uses the repository as its `cwd`. The Agent runs in a read-only sandbox. The
raw-event verifier permits only successful reads of those exact mounted Skill
files before the first business MCP call and rejects every other command, path,
write, wrapper, root change, or late command.

The Agent receives a natural Chinese accounting request: process one synthetic
customer invoice, check the accounting file and submitted material, and create
a DRAFT when the installed authorization allows it. It does not receive the
oracle's required tool sequence or internal Case/target/receipt vocabulary. The
oracle independently checks the minimal Case sequence, target binding, and
the existing provider receipt plus exact same-ID read-back assertions.

The default local Agent runtime is model `gpt-5.6-luna` with reasoning effort
`xhigh`. The MCP backend retains the reviewed 28-tool contract, while this
typed Accounting Case execution profile uses Codex's native `enabled_tools`
filter to expose only target pin, target read, Case prepare, Case execute and
Case status/recovery to the model. Agent2 must mount the same profile for a
comparable run. `LOCAL_AGENT_MODEL` and `LOCAL_AGENT_EFFORT` may override these values;
both are recorded in the invocation and evidence. Each run records every
mounted source path, byte count and SHA-256, the composed `AGENTS.md` digest,
and the 28-tool allowlist/schema source contract. The release verifier
re-reads and recomputes all of these values and fails on any drift. The
temporary workspace is removed in a `finally` block, including failed runs.

The server uses the production
`XeroAccountingCaseService -> AccountingService -> XeroMutationService` chain.
Only the SDK/provider boundary is synthetic. That boundary still consumes the
one-shot permit, stores one provider-side DRAFT, and serves the exact same-ID
GET readback used by the production recovery path.

The run writes the summary and raw evidence below
`artifacts/ledger-kernel-review/round-2026-08-13-local/`. Raw evidence includes
the Codex JSONL, stderr, final answer, invocation/runtime attestation and server
audit. The server audit separately labels exact JSON-RPC public arguments and
raw results as `mcp_protocol_calls`, and post-normalizer Case service inputs as
`tool_calls[].normalized_input`. The release gate recomputes the production
normalizer and binds all three layers; it does not trust the generator's PASS
summary.

The proven target scope is the verified OAuth installation principal plus the
immutable ledger binding and high-entropy target capability. Production does
not currently expose a trusted server-issued conversation identity, so this
harness neither consumes a client conversation header nor claims
cross-conversation binding. The raw capability appears only in the Codex event
stream needed to reconstruct the public sequence; the server audit retains a
SHA-256 binding and redacted values only.

This is LOCAL synthetic-provider evidence only. It is not Agent2, Work, OAuth,
live tenant or external Xero acceptance, and the command performs no push,
deployment or Feishu update. If the local Codex executable is unavailable or
the account needs an interactive/token-backed login, do not reinterpret that
as a synthetic-provider pass; report the run as blocked/not captured.

## Historical 0.3.0 harness

> Status: **HISTORICAL 0.3.0 INTERNAL HARNESS / NOT A 0.4 RELEASE GATE.** Its
> old object-level tool schemas and process-local preparation flow are retained
> for reproducibility. Current release evidence must use the 28-tool Accounting
> Case harnesses.

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
