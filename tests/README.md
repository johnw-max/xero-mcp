# Independent QA scripts

These scripts are black-box release checks and intentionally do not depend on the application package.

## MCP smoke

Required environment variables:

- `MCP_BASE_URL`: service origin without `/mcp`.
- `MCP_BEARER_TOKEN`: Demo MCP bearer; never commit or paste into test artifacts.
- `MCP_ALLOWED_ORIGIN`: exact configured zCloak/LibreChat browser origin.

Optional:

- `MCP_PROTOCOL_VERSION`, default `2025-06-18`.
- `MCP_OVERSIZE_BYTES`, default 2 MiB.
- `MCP_SMOKE_OUTPUT`, writes a mode-0600 JSON result.

The script invokes only initialize, initialized notification, ping and tools/list. It also checks 401, 403 and 413. It never calls an accounting write tool.

The authorise fixture is for lower-level policy/integration tests only. In the real user flow, the Review Page creates and consumes the internal approval reference and directly invokes the controlled authorisation path; neither the user nor the Agent copies an approval token.

## Log redaction

Pass one or more service log files/directories to `assert-log-redaction.mjs`. Set `LOG_SECRET_SENTINELS` to comma-separated synthetic markers injected during tests; do not put real production secrets in the environment. `LOG_REDACTION_OUTPUT` optionally writes a mode-0600 JSON report.

The scanner reports only file, line and pattern name. It never copies a matched value into its report.
