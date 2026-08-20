# Xero MCP 当前能力与边界（通俗版）

核对日期：2026-08-20

候选版本：`0.4.0-rc.1`，尚未上线

架构真相源：[`XERO-MCP-TARGET-ARCHITECTURE-2026-08-20.md`](./XERO-MCP-TARGET-ARCHITECTURE-2026-08-20.md)

能力真相源：[`config/xero-capability-manifest.json`](../config/xero-capability-manifest.json)

## 一句话结论

当前候选是一个 Xero Ledger Gateway：Google Drive 保存和同步用户材料，Accounting Skills/Agent 理解业务并组织操作，Xero MCP 读取或写入 Xero；Xero 始终是唯一正式账本。

本地代码链已有明显进展，但 capability manifest 的 `SHIP` 项还没有当前冻结 candidate 的真实 Xero UAT，因此现在仍是 `NO-GO`，不能说已经上线。

## 当前公共面

公共工具由 manifest 与 allowlist 动态核对，当前工作树为 38 个，不再把 28/29/30 写成发布常量：

- 3 个连接/组织控制工具；
- 31 个有界账本/参考数据读取工具；
- 4 个 typed Accounting Case 工具：prepare、execute、status、list。

读取已包括 Organisation、Accounts、Tax Rates、Tracking Categories/Options、Contacts、Items、Contact Groups、主要单据、Payments、Bank Transactions、Journals、Trial Balance、P&L、Balance Sheet、Aged AR/AP。

Journals 不等于 Manual Journals。Journals 的真实上线还取决于 Xero 所需 tier、scope 和 use-case approval；缺 entitlement 时必须明确报错，不能把它伪装成空结果。

## 当前代码可达的写入

所有公开写入都从 typed Accounting Case 进入，不重新开放旧 object-level mutation tools。当前代码可表达并派发：

- Contact：create basic、update basic；
- Item：create/update basic untracked；
- DRAFT create：Customer Invoice、Supplier Bill、Credit Note、Quote、Purchase Order、Manual Journal。

这些仍需在专用 Xero test company 完成真实 provider receipt、对象 ID 和 exact read-back，才能从 `NOT_READY` 晋级。

## 本期仍需补齐

- Invoice/Bill、Credit Note、Quote、Manual Journal 的 existing DRAFT update；
- Tracking Category/Option 的安全 create/update；
- Invoice/Bill authorise、Manual Journal post；
- Payment record/allocation/refund/reversal；
- Bank Transaction create/update；
- Credit Note allocation/refund；
- 官方 API 支持的 void/reverse。

这些是正常会计账本动作，不因包含 Payment/Bank 就永久排除。但每项必须是独立 typed action，并有合法状态校验、幂等、provider receipt、exact read-back 和 unknown-write recovery；不能用 generic update 偷渡。

## 唯一需要用户确认的流程

只有切换 Xero Organisation 需要用户操作网页：Agent 调用 `xero_start_organisation_switch` 返回短效 URL，用户在页面中选择一个已经授权的组织，然后 Agent 重新 pin 并读取 Organisation。

聊天文字不能直接切换组织。其他会计动作不新增签名、审批、确认 token、确认短语或确认状态机。

## 明确不做

- 通过银行或支付机构真实发起、批准或释放资金；
- Bank Feed 注入/篡改、Batch Payment 银行执行；
- hard delete 或历史重写；
- Payroll 发薪、tax filing、period close/lock；
- 官方 API 不支持时伪造 final reconciliation confirmation；
- 任意 endpoint、URL、JSON、generic CRUD；
- 在 MCP 内复制余额或重建第二套 Ledger。

## 怎样才算上线通过

真实用户验收必须按下面的线上组合运行，而不是只调用 provider 或跑本地单测：

```text
Google Drive 中的真实形态材料
  → 线上 Accounting Skills/Agent
  → Xero Organisation 读取或 URL 切换
  → Xero 账本读取
  → typed Accounting Case 写入
  → provider receipt + exact read-back + 适用时 Journals 验证
```

Drive 文件和 Agent 回答不是记账证据。只有 Xero 对象 ID、持久化 receipt 和同对象精确回读一致，才能称该项写入成功。
