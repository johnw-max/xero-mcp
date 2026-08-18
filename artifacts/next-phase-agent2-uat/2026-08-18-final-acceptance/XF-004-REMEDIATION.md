# XF-004 remediation evidence

Status: `FIXED_PENDING_REVIEW`

The final contract now states:

- execution authority is either an exact per-transaction approval required by a connection/action, or a current platform-bound standing delegation covering the same target/action/scope;
- Xero typed Accounting Case under standing delegation must not ask for a confirmation phrase or per-item approval;
- natural-language intent is not permission and never replaces runtime enforcement;
- target, scope, write gate, deterministic validation, idempotency, one-shot permit, Provider receipt and exact readback remain runtime/MCP controls;
- outcome-unknown recovery forbids blind or new-key retry and permits only one runtime-controlled same-request/same-key replay within the Provider-native idempotency window under a durable claim.

The deploy ZIP for `execute-approved-accounting-entry` was rebuilt from the updated Skill.

Independent verification: typecheck PASS; 5 related test files / 81 tests PASS; `validate_double_entry_candidate.py` PASS for 11 Skills and matching deploy packages; diff check PASS.

Remaining closure gate: capture exact source hashes and prove the deployment-equivalent local Agent, then Agent2, loaded this same instruction/Skill bundle and behaved without requesting a redundant per-item confirmation.
