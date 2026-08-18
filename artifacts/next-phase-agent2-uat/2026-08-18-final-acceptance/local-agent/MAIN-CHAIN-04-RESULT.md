# Local natural-language main chain 04

- Model: `gpt-5.6-luna`, effort `xhigh`; backend MCP contract 28 tools; model-visible Accounting Case profile 5 tools.
- Xero behavior: exact one-shot sequence `pin -> organisation read -> prepare -> execute`; no schema repair, one DRAFT, one Provider object, receipt plus exact same-ID readback.
- Release-gate outcome: **FAIL**. Before the Xero sequence, Codex called its own read-only MCP resource/template discovery tools. This exposed that the mounted Skill referred to `references/capability-routing.md` but the temporary deployment bundle mounted only the Skill entry file.
- Token result: 201,501 input (169,216 cached), 2,602 output, 1,244 reasoning output; 42.6% lower input and 42.6% lower output than run 01.
- Remediation: mount and hash the required Skill reference as part of the deployment-equivalent bundle. The two platform discovery calls are not Xero writes and do not invalidate the business write evidence, but this run remains a release-gate failure because the mounted Skill package was incomplete.
- Raw evidence: `main-chain-04-narrow-profile.raw/`.
- Evidence boundary: no Agent2, live OAuth, Postgres or real Xero claim.
