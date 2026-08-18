# Ledger Kernel Review Ledger

状态说明：`OPEN` → `FIXED_PENDING_REVIEW` → `CLOSED`。只有 finding 的原 reviewer 可以执行最后一步。本轮 implementer 没有自行关闭任何 finding。

| ID | Severity | Owner role | Requirement | Finding | Status | Fix evidence | Re-review evidence |
|---|---|---|---|---|---|---|---|
| ARCH-001 | P0 | Chief Architect | K-002/K-012 | 所有公开 mutation 与 raw Xero SDK writer 必须经过 Case/kernel/one-shot permit | FIXED_PENDING_REVIEW | `tests/xero-provider-write-permit-boundary.test.ts`; final Accounting Case runner | Final reviewer: no raw-writer bypass reproduced |
| ARCH-002 | P1 | Chief Architect | K-002 | 共享层不依赖 Xero 语义，并由非 Xero fake adapter 复用 | FIXED_PENDING_REVIEW | `tests/provider-neutral-ledger-conformance.test.ts` | Final reviewer independently passed 2/2; separate package extraction remains P2 |
| BUS-001 | P0 | Accounting Reviewer | K-004/K-005 | OfficeHub 80/800 假平衡与错误回读必须被确定性阻断 | FIXED_PENDING_REVIEW | source-bridge/readback tests; wrong-economics runner | Pending original accounting reviewer closure |
| BUS-002 | P1 | Accounting Reviewer | K-007 | Golden14 与银行事件需有有界 coverage，残余不得被成功话术掩盖 | FIXED_PENDING_REVIEW | Golden14/public/adversarial tests | Submitted-set boundary remains explicit |
| BUS-003 | P1 | Accounting Reviewer | K-005/K-006 | Credits、unsupported payments、No Tax/Exempt、tax period 与 FX 走 typed policy | FIXED_PENDING_REVIEW | tax/rate/native-route/readback suites | Real Xero behavior pending Gate A2/W |
| REL-001 | P0 | Reliability Reviewer | K-008/K-009/K-010 | Provider unknown/mismatch 必须 recover-only 且不重复 create | FIXED_PENDING_REVIEW | recovery, PostgreSQL, economic mismatch tests | Required PG gate 73/73 PASS |
| REL-002 | P1 | Reliability Reviewer | K-011 | connection/scope/provider/tenant/policy 错误必须精确分型 | FIXED_PENDING_REVIEW | error taxonomy, HTTP and offline negative contract | Live Agent2 matrix NOT_RUN |
| SEC-001 | P0 | Security Reviewer | K-001/K-002/K-012 | wrong tenant/binding/target、stale authority、raw adapter 必须失败 | FIXED_PENDING_REVIEW | target/authority/permit/PostgreSQL suites | Dynamic revocation and bootstrap race passed locally/PG |
| PROD-001 | P0 | Product Reviewer | K-003 | Standing Delegation 取代逐笔确认；execute 仅 identifiers；payload immutable | FIXED_PENDING_REVIEW | tool contract and final Case runner | Public surface exact 28 |
| PROD-002 | P1 | Product Reviewer | K-014 | 无 Provider ID/receipt/exact readback 的聊天自述不算写成功 | FIXED_PENDING_REVIEW | Agent2 verifier 18/18; offline negative 12/12 | Actual Agent2/Work NOT_RUN |
| UAT-001 | P1 | Acceptance Operator | K-013 | Local、Agent2、Work 必须证明相同 build/toolset/policy/migration/kernel | OPEN | Local evidence round ready; source bundle digest recorded | Agent2 and Work live receipts absent |
| OBS-001 | P2 | Reliability Reviewer | K-011 | Public Case status需投影 allowlisted economic mismatch reasons/recovery action | OPEN | Durable mutation receipt already retains reasons | Safety fail-closed; diagnostic projection deferred |

当前本地 evidence 包：`artifacts/ledger-kernel-review/round-2026-08-13-local/`。

禁止为了让台账“看起来完成”而批量关单。每一行必须由原 reviewer 关联可重复测试或线上证据后才能进入 `CLOSED`。
