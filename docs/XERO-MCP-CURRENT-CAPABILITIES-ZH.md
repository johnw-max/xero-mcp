# Xero MCP 当前能力与边界（通俗版）

核对日期：2026-08-13

当前候选：`0.4.0-rc.1` / 28 个公共工具 / Accounting Case / Standing Delegation
晋级状态：本地候选，尚未部署，Agent2 与 Work 的 0.4 写入验收尚未执行

## 一句话结论

当前候选把“模型直接挑对象并提交写入”改成了更严格的 Accounting Case：Agent 先提交来源清单和结构化事实，MCP 在服务端解析账套、联系人、科目、税码和业务路由，编译不可变计划；只有有效的长期授权、动态写闸、精确目标和整案预检同时成立时，才会创建受支持的 Xero 草稿。

它不再要求用户逐张复制一句确认文字。成功也不靠聊天声称，而必须同时看到 Xero object ID、持久化 Provider receipt 和同 ID 精确回读。

但这仍不是线上完成事实。当前线上服务仍是历史 `0.3.1 / 44 工具` 只读与组织切换 Demo；本地 0.4 候选必须先完成 Gate L，再依次通过 Agent2 和 Work，才能替换线上版本或打开测试写闸。

## 两层状态不要混在一起

| 层级 | 已证明 | 未证明 |
|---|---|---|
| 线上历史 0.3.1 | 44 工具的只读核心流程、受控组织切换和零写入边界曾完成 Agent2 / Work 验收 | 不代表当前 0.4 Case 写契约已部署或已验收 |
| 本地候选 0.4.0-rc.1 | 28-tool 合同、Case compiler、动态授权、幂等、Provider permit、经济数回读与 PostgreSQL 状态机正在本地发布门复验 | 尚无真实 Agent2 / Work 0.4 对话、当前部署 attestation 或真实 Xero Golden14 写入证据 |

因此当前可说“0.4 候选已实现并在本地验收”，不能说“0.4 已上线”或“Agent2 / Work 已自动记账成功”。

## 会计用户看到的 28 个公共工具

- 23 个读取工具：Organisation、Account、Tax Rate、Contact、Invoice/Bill、Credit Note、Payment、Quote、Purchase Order、Manual Journal、Item、Bank Transaction 和有界 Trial Balance。
- 2 个目标控制工具：pin 当前 Organisation，以及发起受控 Organisation 切换。
- 3 个 Accounting Case 工具：prepare、execute、status。

旧的 object-level prepare/create/update 工具不再对 Agent 公布。尤其不能用任意 Manual Journal 作为业务漏项、Payment 或原生 Credit Note 的降级入口。

## Accounting Case 如何工作

```text
普通业务单据字段 + 仅针对本次 submitted set 的完整性声明
  -> MCP 层确定性派生内部 fact / lineage / event / source-unit / line identity
  -> 服务端解析 exact Tenant / Contact / Account / Tax / native route
  -> 编译不可变 Case version，计算 coverage、eligible operations 和 residual events
  -> 整案只读 preflight；任一可预见错误发生时 0 次 Provider mutation
  -> 动态重查 Standing Delegation、紧急写闸、MCP scope、Xero OAuth scope 和 Provider 能力
  -> 原子 claim + 一次性 Provider write permit
  -> 写入 Xero DRAFT / ACTIVE 对象
  -> 先保存 object ID 与 Provider receipt
  -> 按同一个 ID 精确 GET，并核对状态、身份、行项目、税额和总额
  -> 只有 exact readback 才能报告 READBACK_VERIFIED
```

`xero_execute_accounting_case` 只接收 `case_id + case_version + request_id`。Agent 不能在 execute 时重新提交 Tenant、action、lines、amount、account、tax 或 Provider ID。

一张单据可以包含不同会计语义的行，但必须显式选择模式。`DOCUMENT_DEFAULT_FOR_ALL_LINES` 表示同一组 category/tax/rate 确实适用于全部行；`PER_LINE` 则不接受无意义的 document 默认值，并要求每一行都有完整 category、tax class、effective rate 和必要 exemption evidence。MCP 会逐行编译科目和税码、逐行做整数金额桥、逐行封存通用 binding hash，并在同 ID 回读时逐行核对。任何一行未知或不一致都会让整张单据 0 次 Provider 写入；全部通过后仍只创建一个原生 Xero 单据对象。

## 当前允许自动执行什么

在已发布 action、专用测试 Tenant、有效 Standing Delegation 和所有服务端门禁成立时，Case 可以执行：

- Sales Invoice DRAFT；
- Supplier Bill DRAFT；
- Credit Note DRAFT，且必须保持 unallocated；
- 基础 Contact create。Contact 已存在时由服务端解析并封存 exact identity，不重复创建。

Quote、Purchase Order、Manual Journal、Contact update 和 Item create/update 虽有独立的内部适配器能力，但当前公开 Case compiler 不会生成这些 route；因此它们不属于当前可达的自动执行能力，也不应出现在 Standing Delegation 示例中。

当前 Golden14 的公共验收只期待 5 张原生文档：1 张 Sales Invoice、2 张 Supplier Bill、2 张 Credit Note。Payment、Prepayment、Bank Transaction、Expense Claim、分配、退款和银行对账仍是明确 residual，不能用手工分录替代，也不能说“整包全部入账”。

## 授权不是逐笔聊天确认

业务授权来自服务端、可版本化的 Standing Delegation，精确绑定 workspace、Agent、installation、Tenant 和 action。共享 PostgreSQL 保存当前 authority snapshot；旧进程也会在整案 preflight 和最终 claim 重新读取它。

- Delegation 被撤销、过期、换 revision、目标或 action 不匹配：Provider mutation 为 0。
- 紧急写闸关闭：fresh write 为 0；未知结果仍只允许 exact GET recovery。
- authority snapshot 在 resolve 与 claim 之间变化：数据库事务拒绝 claim。
- 同一 request/payload 重放：不重复创建；不确定结果不能盲目重试 create。

`XERO_WRITE_ENABLED` 是紧急 fail-closed 闸门，不是日常逐单审批。配置仍默认 `false`；本地通过不会自动把任何线上或测试 Tenant 改成可写。

## 来源与材料边界

产品已接受模型提取事实作为输入，所以“拿到原文件 hash / Host 文件收据”不是当前 Case 的授权前置条件。MCP 会保留事实来源、revision、source hash 和 coverage 轨迹，但这些是 provenance，不是权限。

因此 Case 返回值把两类结论永久分开：`source_claim.source_truth_claim=NOT_VERIFIED`、`original_file_verified=false` 表示当前 MCP 没有验证原始文件真实性；`completion_claim.ledger_write_claim` 只描述 Xero 写入、receipt 和 exact readback。即使后者是 `ALL_ELIGIBLE_WRITES_READBACK_VERIFIED`，也不能把前者改写成“来源已验证”。

这也留下明确残余：如果模型从一开始就漏报或伪造一份未被 MCP 看到的材料，Xero MCP 无法凭空还原原件。它只能证明“本次提交集合”已被逐项消费或给出终态，不能证明用户现实中所有 14 张材料都已提交。

测试文档另有独立门禁：生产 Tenant 的原生文档必须明确是 `VALID_FOR_LIVE_BOOKS`；未知或缺失状态会阻断整案。Golden14 测试材料只允许进入显式测试 Tenant。

## 成功和失败应怎样表述

- PREPARED：只表示计划已持久化，`NOT_WRITTEN`。
- READBACK_VERIFIED：该对象已有 Provider ID、receipt 和精确回读。
- WRITE_UNCERTAIN：可能已写，禁止再次 create，只能恢复性 GET。
- READBACK_MISMATCH：不能称成功，Case 进入恢复状态。
- BLOCKED_UNSUPPORTED / REVIEW_REQUIRED：是明确 residual，不是“已完成”。
- `supplied_set_coverage=COMPLETE`：只表示已提交集合有终态，不等于所有 eligible writes 都成功，也不等于跨 Drive/Xero 全流程完成。

聊天文字不是账本证据。即使模型说“已写入”，没有上述 durable evidence 也不能验收为成功。

## 当前明确不开放

- AUTHORISE、SUBMIT、POST、发送；
- Payment、receipt、refund、prepayment create/update；
- Credit Note allocation；
- Bank Transaction 写入、Bank Transfer、最终 reconciliation；
- Void、Delete、Archive、Merge；
- Account/Tax 写入、银行或系统科目修改；
- Contact 银行资料与高风险付款信息修改；
- Item 价格、科目、税码、Tracking、库存价值修改；
- Attachment 上传、Tax filing、payroll、close、audit opinion；
- 任意 Tenant、任意 endpoint、任意 JSON 或绕过 Case 的批量写入。

## 还差哪些上线证据

1. Gate L：最新整树 typecheck/build/full regression、HTTP、真实 PostgreSQL 025–032、静态发布包与 reviewer verdict 全绿。
2. Gate A2：专用测试 Organisation、精确三联系人、当前 28-tool Agent、真实 prepare/execute/status tool trace；5 张文档各自有 ID、receipt、经济数 exact readback；负向权限、连接、错误金额、漏项和 unknown-result 话术也通过。
3. Gate W：在 Work 的真实绑定中复跑最小高信号链，并确认最终聊天没有把 partial/unsupported/unknown 说成完成。
4. 只有以上证据完成后，才讨论部署切换和是否在受控测试窗口开启写闸；默认仍保持关闭。

唯一公共工具清单以 [`src/mcp/toolNames.ts`](../src/mcp/toolNames.ts) 为准；当前发布契约以 [`harness/manifests/contract-v1.json`](../harness/manifests/contract-v1.json) 为准；历史 0.3.1 线上记录继续保留，但不得代替 0.4 验收。
