# Xero MCP 当前能力与边界（通俗版）

核对日期：2026-08-10
当前结论：`线上 43 工具只读核心流程已验收；本地 44 工具候选新增受控公司切换与治理审计，尚未部署`

## 一句话结论

产品方向已经对：会计在 Agent2 里连接自己的 Xero、查历史、加入材料、让 Agent 分析并准备会计操作；经用户确认后，MCP 才把受控结果写入 Xero，Xero 始终是正式账本。

当前线上版本已经支持 43 个固定会计工具，并完成真实 Demo Company 的关键只读验收。本地候选在此基础上新增 `xero_start_organisation_switch`，让会计通过对话获得短效链接并明确选择另一家已授权公司，同时加入版本化治理审计事件。新增能力尚未部署，不能用本地结果表述成线上已经支持。

## 现在处于哪一层

| 层级 | 已确认 | 仍待完成 |
|---|---|---|
| 当前线上版 | 0.3.0 受控 Demo，43 个固定工具；真实 Xero 关键只读调用、Token 自动续期和零写入边界已验收 | 仍是 Personal POC；新增公司切换和治理审计尚未上线 |
| 44 工具本地候选 | 固定工具合同一致；完整默认回归 798 PASS、50 条条件跳过；HTTP/OAuth 强制测试 3/3；全新 PostgreSQL 17 从 001–024 迁移并完成强制测试 47/47；类型检查、构建通过 | 仍需部署迁移、线上 OAuth/切换验收；写入仍需逐对象真实 Xero 回执与同 ID 回读 |
| 真实 Xero | 旧版本曾完成单张 Bill DRAFT 同 ID 回读 | 新增对象尚未逐类真实创建和同 ID 回读 |
| Agent2 | 线上 43 工具版已完成关键只读会计对话验收 | 44 工具版的对话切换流程尚未部署和线上验收 |

## 会计现在可以期待哪些能力

### 1. 读取与分析（Agent 可自主调用）

- 确认当前连接的 Xero Organisation 和本位币；
- 读取科目、税码、联系人及精确联系人；
- 读取 Invoice、Supplier Bill、Credit Note、Payment；
- 读取 Quote、Purchase Order、Manual Journal、Item、Bank Transaction；
- 读取有界 Trial Balance，并明确分页、截断和完整性边界；
- 将 Xero 存量与用户加入的 PDF、表格、截图、邮件说明放在一起做匹配、重复检查、余额分析和编码建议。

只读不等于“全量审计证明”。结果达到分页或大小边界时，Agent 必须明确说没有证明完整。

### 2. 用户确认后可以写入的对象

| 对象 | 当前候选允许的动作 | 写入结果 |
|---|---|---|
| Sales Invoice | 创建 | `DRAFT` |
| Supplier Bill | 创建 | `DRAFT` |
| Quote | 创建 | `DRAFT` |
| Purchase Order | 创建 | `DRAFT` |
| Credit Note | 创建 | `DRAFT`；不分配、不退款 |
| Manual Journal | 创建平衡、NoTax 分录 | `DRAFT`；不 POST |
| Contact | 创建或修改基础名称、地址、邮箱、电话 | `ACTIVE`；不碰银行、税务、归档、合并、删除 |
| Item | 创建或修改基础非库存 Item | `UNTRACKED`；不改价格、科目、税码、库存或 Tracking |

每一次写入都必须经过：

```text
服务端精确账套绑定
  -> 只准备、不写入
  -> 展示不可变提案和来源指纹
  -> 用户输入当前提案的一次性确认句
  -> 再检查权限、OAuth scope、写闸和会计引用
  -> 带幂等保护写入 Xero
  -> 先保存 Xero ID/回执
  -> 按同一个 ID 精确回读
  -> 只有字段和状态一致才报告成功
```

OAuth Broker 模式以服务端 Installation/Binding 的精确 Tenant 为准；旧共享凭证模式仍必须配置显式 Tenant 白名单。Agent 不能从工具参数切换账套。

同一会计需要处理多家公司时，可在对话中要求切换。Agent 只会调用 `xero_start_organisation_switch` 返回一次性链接；用户必须在 MCP 页面从当前 OAuth 已授权列表中明确选择一家。确认后后续调用只解析到新公司，旧账套提案不能跨公司执行。若目标公司不在授权列表中，才重新走 Xero OAuth。

权限遵循最小化原则：读取/准备使用 `xero.read`，执行使用 `xero.draft.write`；HTTP 入口不再强迫写入 Token 同时拥有读取权限。Xero consent 也按实际 Host 能力推导，只写草稿时不会顺带申请 Trial Balance、Payment 或 Bank Transaction 的读取权限。

## 现在明确不能做什么

- 不 AUTHORISE、SUBMIT、POST 或发送单据；
- 不创建、修改或分配 Payment，不收款、不付款、不退款；
- 不分配 Credit Note；
- 不创建或修改 Bank Transaction，不执行最终银行对账；
- 不 Void、Delete、Archive、Merge；
- 不修改科目表、银行科目、系统科目、税率；
- 不上传 Xero Attachment；当前还没有可信的 Agent2 文件暂存与 Host 签名原文件收据；
- 不报税、不关账、不出审计意见；
- 不支持无人监督批量记账，也不能把 Personal POC 表述成多客户生产系统。

Agent 可以读取现有账务、比较材料和账目、提出对账候选及解释差异；最终 reconciliation 仍由会计在 Xero 完成。

## 上线前必须完成的产品事项

1. **真实业务验收。** 本地测试不能替代 Xero 事实。计划在线展示的对象必须获得 Xero ID、保存写入回执并按同一 ID 回读；随后在 Agent2 以普通会计话术跑连续流程。
2. **保留确认层级说明。** 10 组写入已统一为服务端一次性 Preparation + 逐字确认句，满足受监督 Demo；如要进入多人生产审批，还需由 Host 签发可验签、绑定具体用户和提案指纹的确认收据。

## 是否已经达到想要的效果

从能力范围看，已经接近想要的基础形态：不只读，也不只会建 Bill；Agent 可以围绕多种常见会计对象自主调查、分析和准备受控操作。

从上线证据看，目前是 `43 工具线上只读 Demo 可用、44 工具本地发布门槛已通过`，还不是 `44 工具线上 Demo Ready`。转为 Demo Ready 的顺序是：

1. 以写闸关闭状态部署 0.3.0；
2. 让测试 Xero 重新授权新增最小 scope；
3. 先做关键只读抽样；
4. 临时开启单账套写闸，对计划演示对象做真实写入、保存回执并按同一 Xero ID 回读；
5. 在 Agent2 跑自然会计对话的 signature flows；
6. 立即关闭写闸并清理临时运维通道。

工具清单以 [`src/mcp/toolNames.ts`](../src/mcp/toolNames.ts) 为准；风险边界以 [`src/policy/xeroCapabilityPolicy.ts`](../src/policy/xeroCapabilityPolicy.ts) 为准。
