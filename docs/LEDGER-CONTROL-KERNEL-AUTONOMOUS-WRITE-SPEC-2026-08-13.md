# Ledger Control Kernel：默认受约束自动写规格

状态：`FROZEN FOR IMPLEMENTATION`

日期：2026-08-13

适用范围：Xero MCP 首个落地版本；后续 QuickBooks MCP、Excel MCP 和其他账务软件 MCP 必须复用同一控制合同。

## 1. 已确认的产品决策

1. `Ledger MCP` 是产品类别，不是一个统一运行的 MCP。Xero、QuickBooks、Excel 以及未来的每个账务软件分别部署、分别授权、分别持有各自 provider 凭据。
2. 公共控制能力只实现一次，形成 provider-neutral 的 `ledger-control-kernel`；每个独立 MCP 嵌入同一内核，provider adapter 只负责连接、能力探测、执行和精确回读。
3. Work 平台不为会计垂类开发专用流程、审批页面或附件证明能力。控制在 Ledger MCP 侧完成。
4. 模型已经读取并提炼出的资料可以作为事实候选输入。系统必须记录它是 `MODEL_EXTRACTED` 或 `AGENT_ASSERTED`，但不要求证明原始文件真实性，也不以此阻断自动写。
5. 默认采用 `Standing Autonomous Delegation`：已授权 Agent 在准确账套、有效权限和确定性校验全部通过时自动执行，不逐笔要求用户复制确认短语。
6. 系统可以按版本化默认会计政策自动作出会计、税码、期间和汇率路由判断。不能把这类判断留给模型临场自由发挥；无法满足明确前提时进入 `REVIEW_REQUIRED` 或 `BLOCKED`。
7. Xero 写凭据只由 Xero MCP 持有。任何 Xero 写入都必须经过统一内核，不存在 raw provider 写工具或旁路凭据。
8. 聊天里的“已写入”不构成成功证据。只有同一 case 的 validation receipt、provider object ID、mutation receipt 和 exact-tenant read-back 全部存在，状态才可为 `COMPLETE`。

## 2. 业务目标

本次不是修补某一句提示词，也不是只修 OfficeHub 的 `87.20`。目标是用底层控制原语覆盖整类失败：

- 模型漏读、漏记或把非交易资料当交易；
- 分录借贷不平、明细和总计矛盾、税额或汇率计算错误；
- 权限、OAuth scope、账套绑定、连接状态被混成一个 `FORBIDDEN`；
- 模型拿到准备结果后改 payload、复制确认短语或绕过校验；
- provider 返回成功文字但没有对象 ID，或写后无法精确回读；
- 重试导致重复创建；
- 模型未调用 MCP，却在聊天里编造手工分录或宣称已经写入；
- 本地测试通过，但 Agent 2 或 Work 线上实际工具集、版本、配置并非被测版本。

## 3. 架构边界

```text
Work / Agent
    |
    | high-level intent + extracted facts
    v
Xero MCP
    +-- Agent-facing high-level tools
    +-- ledger-control-kernel  <--- shared contract / shared conformance suite
    |      +-- source/event coverage
    |      +-- deterministic compiler
    |      +-- policy + capability preflight
    |      +-- validation receipt
    |      +-- idempotency + lifecycle state machine
    |      +-- mutation/read-back assurance
    +-- Xero adapter
           +-- capabilities/preflight
           +-- execute_validated_payload
           +-- lookup/read-back
```

共享的是控制合同、代码包、政策格式、receipt 格式和一致性测试；不共享 Xero/QuickBooks/Excel 凭据，也不要求所有 provider 同进程或同一个 MCP。

## 4. Agent-facing 工具合同

公开工具应保持高层、不可自由拼装 provider payload：

- `prepare_*`：把事实候选标准化、解析 provider 引用、生成不可变 proposal；不写 provider。
- `execute_*`：只接收 `preparation_id` 和 `request_id`。内核从持久化 proposal 取 payload，重新校验并在 Standing Delegation 下自动执行；不再接收确认短语，也不允许重新提交会计 payload。
- `status` / `receipt_verify`：查询真实状态和证据。

兼容期间可以保留原工具名，但 schema、描述和执行语义必须符合上述合同。公开 schema 中不得存在可绕过内核的 `xero_create_*(raw_json)`。

## 5. 内核强制不变量

| ID | 不变量 | 失败行为 |
|---|---|---|
| K-001 | 每次 mutation 绑定 actor、workspace、installation、binding、connection、binding revision、target session 和 exact tenant | `BLOCKED_TENANT_BINDING` |
| K-002 | 实际连接、OAuth scope、MCP scope、权限、Standing Delegation、全局 kill switch 和 tenant policy 每次执行前动态重查 | 返回精确阻断原因，不调用 provider |
| K-003 | execute 只能加载服务端保存的 immutable proposal；prepare 后一分钱、一个字段或 tenant 变化都使 receipt 失效 | `VALIDATION_STALE` |
| K-004 | 金额使用 decimal/minor units；总计由代码从行项目重算，禁止模型自带总计作为真值 | `VALIDATION_AMOUNT_MISMATCH` |
| K-005 | 需要复式分录的对象必须借贷相等；税额、含税/未税、币种、汇率和期间满足 typed invariant | `VALIDATION_ACCOUNTING_INVARIANT` |
| K-006 | account、tax code、contact、item、tracking、currency 和 provider route 必须在目标账套精确解析；不以名称猜 ID | `REVIEW_REQUIRED_REFERENCE` |
| K-007 | 每个已识别 source event 必须为 `POSTED`、`PREPARED`、`NON_POSTING`、`BLOCKED` 或 `REVIEW_REQUIRED`；不能从总结里消失 | case 不得宣称完整 |
| K-008 | 同一 source unit、operation、tenant 和 request id 幂等；未知结果进入 recover-only，禁止再次 create | `POSTED_UNVERIFIED` 或返回原结果 |
| K-009 | provider 成功必须先持久化 object ID / request evidence，再 exact-tenant read-back | 无回读不得 `COMPLETE` |
| K-010 | 只有 validation + mutation + read-back receipts 全部匹配同一 payload hash、tenant、case version 才能成功 | `INCOMPLETE_EVIDENCE` |
| K-011 | 错误必须按连接、身份、OAuth scope、MCP scope、provider role、write policy、tenant binding、限流、超时、provider validation 分型 | 不得统一伪装为 `FORBIDDEN` |
| K-012 | provider adapter 的网络出口和凭据只允许 kernel commit path 使用 | 启动/CI conformance 失败 |
| K-013 | runtime 暴露版本、toolset hash、kernel/policy/compiler/validator version、migration status 和 write-mode attestation | attestation 不匹配不得晋级 |
| K-014 | 聊天文字不能改变持久化状态；没有可验证 receipt 的成功声明必须被 Agent 配置视为未写入 | E2E 验收失败 |

## 6. 默认受约束自动写

“默认可以写”定义为：

> 已授权 Agent 的 proposal 在同一账套通过全部确定性校验后，不再逐笔向用户索取确认，系统自动调用 provider。

它不等于“模型要求什么就写什么”。以下情况自动停下：

- 连接或授权无效；
- 目标账套不一致；
- 会计不变量失败；
- provider reference 无法唯一解析；
- 业务资料相互冲突；
- 必需汇率、税务事实或政策条件缺失；
- provider 返回未知结果或无法回读；
- kill switch 被关闭；
- 部署版本或 policy attestation 不满足最低要求。

Standing Delegation 是可撤销、可版本化的授权策略，不是每笔 approval receipt。全局 write flag 只保留为紧急 kill switch，不承担日常逐笔审批。

## 7. 会计事实与政策

模型负责提取候选事实，代码负责决定候选事实是否足以进入确定性编译。至少区分：

- `document_date`、`service_date`、`approval_date`、`payment_date`、`credit_date`；
- invoice、credit note、payment、bank fee、advance receipt、opening balance、employee claim、non-posting PO；
- standard、zero-rated、exempt、out-of-scope/no-tax；
- invoice recognition FX rate、settlement FX rate、realised FX difference；
- supplied evidence 和系统推断。

默认政策必须有 `policy_version`、适用前提、确定性优先级和 fallback。模型可提出分类候选，但不能覆盖 validator。

## 8. 本轮 Xero 首个落地切片

本轮必须至少完成：

1. 抽出 provider-neutral kernel 合同和纯函数 validator；
2. Xero 所有公开 mutation 统一经过同一 foundation/kernel；
3. 去除 execute schema 的确认短语，改为 Standing Delegation 自动授权；
4. 接入动态 capability / tenant / write policy preflight；
5. 继续保留并加强 immutable payload、idempotency、provider receipt、recover-only 和 exact read-back；
6. 输出精确错误分型；
7. 增加 runtime attestation 和 conformance tests；
8. 增加本次 14 份材料与变异用例，覆盖假平衡、漏项、重复费用、贷项/收付款顺序、FX、权限/连接和假成功；
9. 更新本地、Agent 2 和 Work 三层验收清单与版本断言。

QuickBooks/Excel 不在本轮直接上线修改范围内，但新内核不得导入任何 `xero-*` SDK 类型，且必须用一个非 Xero 的 fake adapter 通过 conformance test，证明不是把 Xero 逻辑换个名字。

## 9. 明确残余边界

在 Work 平台不改的前提下，Xero MCP 可以保证任何真实 Xero mutation 不绕过控制；它不能阻止模型完全不调用 MCP、只在聊天里编造一张表或一句“已完成”。本轮必须通过以下方式显著降低该风险：

- Xero Agent 配置只把 receipt-verified 状态称为写入成功；
- 工具返回结构化 `completion_claim` 与 `next_action`；
- E2E 测试故意诱导模型跳过工具或伪造 receipt；
- 审计与验收只认可 MCP receipt，不认可聊天文字。

这项残余不能被写成“已经彻底解决”。

## 10. 完成定义

不能凭“代码写完”或“单测绿了”完成。必须同时满足：

- 需求追踪矩阵所有 P0 项有实现和测试证据；
- 架构、会计业务、可靠性/安全三个独立 reviewer 关闭各自问题；
- 本地全量测试、故障注入、数据库迁移和 crash/recovery 通过；
- 隔离 Agent 2 运行被测版本并通过行为验收；
- Work 在线测试租户运行同一 attested 版本，通过真实 tool trace、provider ID 和 read-back 验收；
- 未解决问题明确列为残余风险，P0/P1 为零后才可建议上线。

