# Ledger Kernel 持续交叉评审与验收闭环

状态：`ACTIVE CONTROL PROCEDURE`

日期：2026-08-13

## 1. 核心规则

1. 开发者不能关闭自己发现或自己修复的问题。
2. reviewer 不能只写“看起来可以”；每个结论必须包含反例、证据和可重复命令/轨迹。
3. 修复后必须由原问题提出者复验。状态只能从 `OPEN` → `FIXED_PENDING_REVIEW` → `CLOSED`。
4. 一轮中出现 P0，立即退回实现；出现未豁免 P1，不得进入下一层验收。
5. 新增补丁若只覆盖一个例句，必须解释它由哪条通用 invariant 解决；没有通用控制归属的修复不接受。
6. 本地、Agent 2、Work 是递进门禁，不可用后一级的“看起来正常”代替前一级确定性证据。
7. 任何“已成功写入”都必须与同一 case/call 的 receipts 和 exact read-back 建立机器可验证关联。

## 2. 五个独立角色

| 角色 | 主要职责 | 有权否决 |
|---|---|---|
| Implementer | 实现、测试、修复、提交证据包 | 无权关闭 reviewer finding |
| Chief Architect | 检查 bottom-up 程度、provider-neutral 边界、技术选型、绕过路径、未来 QuickBooks/Excel 复用 | 架构漂移、伪共享内核、旁路 mutation |
| Accounting Business Reviewer | 检查会计语义、资料覆盖、业务完成声明和真实用户目标 | 业务错误、漏项、错误税务/期间/FX 处理 |
| Reliability & Security Red Team | 故障注入、权限/连接分型、并发/幂等、crash/recovery、凭据与租户隔离、假成功 | 数据损坏、重复写、跨租户、不可恢复中间态 |
| Acceptance Operator | 按固定脚本执行 local Agent、Agent 2、Work，核验 attestation、tool trace、provider receipt/read-back | 环境不一致、证据缺失、线上行为与本地不同 |

角色可以由多个 Agent 承担，但同一个 finding 的 implementer 与 closer 不能是同一角色。

## 3. 每轮固定 Loop

```text
冻结本轮需求/反例
    -> 架构 reviewer 先审设计
    -> Implementer 做最小通用切片
    -> 静态检查 + 单元/契约测试
    -> 业务 reviewer 跑资料与 mutation 用例
    -> 红队跑绕过/故障/恢复用例
    -> Implementer 逐项修复
    -> 原 reviewer 复验并关单
    -> 全量回归
    -> 决定继续下一切片或进入验收
```

任何 reviewer 新发现都回到同一循环，不允许在最终总结里用“后续优化”隐去。

## 4. 需求追踪与变更纪律

每项需求必须有稳定 ID，并在 review ledger 中关联：

- `requirement_id`
- `business_risk`
- `design_control`
- `implementation_files`
- `positive_tests`
- `negative_or_mutation_tests`
- `reviewer`
- `status`
- `evidence`
- `residual_risk`

每次技术选型写简短 ADR，至少比较：

1. 中央控制服务；
2. 各 MCP 复制实现；
3. 共享 kernel SDK/package；
4. 为什么当前选择最符合独立 MCP、平台零垂类适配和底层复用。

若选择发生变化，必须更新 ADR，不能只改代码。

## 5. Finding 严重度

- `P0`：可能真实错账、重复写、跨租户、伪成功、凭据旁路、不可恢复写入；立即停止晋级。
- `P1`：会造成主要业务漏项、权限/连接误诊、错误完成声明、无法证明被测版本、核心场景不可用；修复后才能晋级。
- `P2`：不影响账本正确性但影响操作性、可诊断性或维护性；需记录 owner 和期限。
- `P3`：文案、低风险体验或非阻断优化。

`WAIVED` 必须写明接受人、理由、范围和到期日。开发者不能自行豁免。

## 6. 反偷懒检查

每轮 reviewer 必答：

1. 这个改动解决的是一个例句，还是一个可定义的 failure domain？
2. 能否构造只改金额、日期、币种、provider 或 tenant 的同类反例绕过？
3. 换成 QuickBooks fake adapter 后，控制还成立吗？
4. 有无只在 Skill/prompt 中存在、运行时并未强制的规则？
5. 有无工具仍能直接调用 provider client？
6. 测试是否只比 substring，还是核对结构化状态、hash、receipt 和 read-back？
7. 测试运行的版本、toolset、policy、migration 和配置是否就是将要发布的版本？
8. Agent 的成功陈述是否能在没有 receipt 时通过？
9. 失败或超时后重试会不会创建第二个对象？
10. 报告是否把未验证行为写成已完成？

## 7. 三层验收门禁

### Gate L：本地

必须有：

- typecheck、build、全量 unit/contract/integration tests；
- PostgreSQL migration integrity；
- provider-neutral fake adapter conformance；
- 14 份资料 golden fixture 和 mutation tests；
- 401/403/409/429、timeout、read-back mismatch、unknown result；
- 并发重复请求、进程在各 lifecycle 状态 crash/restart；
- 无 raw write tool、无 adapter bypass；
- 本地 Agent final answer 与 receipt 语义关联测试；
- runtime attestation 与构建产物一致。

### Gate A2：隔离 Agent 2

前提：只连接测试公司，固定 Agent revision、Skill revision、MCP image digest、kernel/policy/compiler/validator version 和 toolset hash。

必须通过：

- 正常自动写：无需逐笔确认，得到 provider ID 和 exact read-back；
- OfficeHub 假平衡、漏 SGD25、漏期初、No Tax/Exempt 互换、汇率缺失全部被拦截；
- 连接断开、OAuth scope 不足、provider role 不足、write kill switch、错 tenant 返回不同错误；
- prompt injection 要求跳过工具或伪造 receipt 时不宣称完成；
- timeout 后 resume 不重复创建。

### Gate W：Work 在线

必须证明 Work 实际调用的就是 Gate A2 通过的版本，且工具轨迹可取得。测试公司真实写入至少一条低风险、可清理的 DRAFT，并按 provider ID 回读。

必须保存：

- Agent ID/revision、Skill revision；
- MCP endpoint/image digest/release version；
- kernel/policy/compiler/validator version、toolset hash、migration status；
- tool call ID、参数摘要、结构化返回；
- Xero tenant ID、provider object ID、mutation receipt、read-back receipt；
- final answer；
- 清理或保留 DRAFT 的处理记录。

没有这些证据只能记为 `UNVERIFIED`，不能说通过。

## 8. 晋级规则

| 从 | 到 | 必须满足 |
|---|---|---|
| 设计 | 实现 | 架构 reviewer 无 P0/P1，需求与 ADR 已冻结 |
| 实现 | 本地验收 | 三类 reviewer 均完成首轮，所有 P0/P1 已由原 reviewer 关闭 |
| 本地 | Agent 2 | Gate L 全绿，构建和 attestation 固定 |
| Agent 2 | Work | Gate A2 全绿，无替换构建或配置漂移 |
| Work | 上线建议 | Gate W 全绿，P0/P1 为零，残余风险显式签收 |

## 9. 证据包结构

每轮保留：

```text
artifacts/ledger-kernel-review/<round>/
  requirements-traceability.json
  findings.json
  diff-summary.txt
  test-results.json
  fault-injection-results.json
  attestation.json
  agent2-run.json          # 仅 A2 阶段
  work-run.json            # 仅 Work 阶段
  reviewer-verdicts.md
  independent-review-<requirement-or-axis>.json
  independent-review-<requirement-or-axis>.raw/
```

`CLOSED` 必须绑定独立只读 Codex invocation 的 raw JSONL/final/invocation，而不是只信 reviewer 名称或手写 verdict；validator 会重算 source、review subject、被引用 evidence bytes、Codex executable/argv/thread/PID 和逐项决定。固定 inspection plan 必须把全部 cited bytes 以有序、独立 command 的 content-addressed chunks 实际送入 reviewer context，并防止单次大输出截断；每项 requirement 还必须保存一个 reviewer 新提出、只读、非既有 test 的 falsification probe command/stdout receipt，并按当前 bytes 与 invocation nonce 重放。metadata-only、1-token、缺块/乱序、缺 probe、复述既有 test 或 command 偏移都不能关闭 requirement。

## 10. 本轮起点

- 原仓库用户工作固定点：临时 snapshot commit `8d2b5d2`。
- 本轮只审 `8d2b5d2` 之后的增量，不把用户已有改动冒充本轮成果。
- 现有工作树不清理、不 reset、不覆盖。
- 当前报告与线上测试材料是业务问题来源，不是实现成功证明。
