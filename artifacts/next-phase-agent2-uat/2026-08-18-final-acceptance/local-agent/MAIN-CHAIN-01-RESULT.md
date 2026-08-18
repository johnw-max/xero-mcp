# Local natural-language main chain 01

- Boundary: local Codex Agent + current mounted Agent instructions/Skill + 28-tool MCP; synthetic Provider adapter only.
- Model: `gpt-5.6-luna`, effort `high`.
- Business outcome: one customer-invoice DRAFT was created in the synthetic test company; one Provider object, Provider receipt, and exact same-ID readback are present in the raw server audit.
- Release-gate outcome: **FAIL**. The existing oracle required exactly five calls and rejected legitimate bounded reads. The Agent also relied on the terminal execute result and did not make the oracle's separate status call.
- Tool behavior: target pin and organisation verification succeeded; the Agent additionally checked connection state, exact contact, bounded duplicate invoices, and tax rates. It made three prepare attempts: two schema-shape errors followed by one valid prepare, then one valid execute.
- Token observation: 350,817 input tokens, including 301,824 cached input tokens; 4,534 output tokens; 2,010 reasoning output tokens.
- Evidence boundary: this run does **not** prove Agent2, OAuth, a live Xero tenant, Postgres durability, or external deployment.

Required response:

1. Keep the hard one-write/receipt/exact-readback oracle, but allow bounded read-only exploration and schema-validation failures before the single successful prepare.
2. Decide whether an explicit status query is required after an execute result that is already terminal and exact-readback verified; do not add a redundant call only to satisfy an old sequence.
3. Treat the three prepare attempts and 350k input context as a token/tool-UX finding, not as a pass.
