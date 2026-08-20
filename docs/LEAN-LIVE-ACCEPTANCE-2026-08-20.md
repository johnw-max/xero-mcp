# 精简真实验收清单

用户明确要求:**验收要快,不要用力过度**。所以这一轮不做情景剧本,
只做"每个新能力在真实 Xero 上走通一次并可核对"。

驱动方式:部署候选 → 切 nginx → 在 **agent2.zcloak.ai / work.zcloak.ai** 里驱动。
不要再走 Claude connector(见 memory `xero-live-acceptance-path`)。
注意 Work 会缓存工具清单,新工具要到 MCP 面板点刷新才可见。

---

## 一、写入(每个动作一次,共 6 个)

对每一个:在 Demo Company 上真实写一次草稿,然后**两处核对**:

1. `xero_mutation_requests` 出现 `READBACK_VERIFIED`,且**不得出现 `WRITE_UNCERTAIN`**
2. 到 Xero 端直查该对象,内容与 agent 所述逐条一致

| 动作 | 最小用例 |
|---|---|
| `quote.create_draft` | 一张两行的报价单,带到期日 |
| `purchase_order.create_draft` | 一张两行的采购单 |
| `manual_journal.create_draft` | 两行、借贷相等的日记账 |
| `contact.update_basic` | 改一个既有联系人的地址 |
| `item.create_basic_untracked` | 新建一个商品 |
| `item.update_basic_untracked` | 改这个商品的单价 |
| 附件上传(若本轮建成) | 给上面某张单据挂一个 PDF |

**另加两条负面用例**(便宜且防的是真事故):

- 借贷不等的日记账 → 必须 `JOURNAL_NOT_BALANCED` 且**不产出操作**
- `QUOTE` 配供应商 → 必须显式拒绝,不得落到另一个看起来合理的路由

## 二、读取(每个新工具一次)

不需要断言数值正确性,只要求**真实返回且形状可读**:

| 工具 | 核对点 |
|---|---|
| `xero_list_journals` | 拿刚写的那张单据的分录,**借贷合计相等** |
| `xero_get_profit_and_loss` | 返回有科目行,不是空壳 |
| `xero_get_balance_sheet` | 同上,且资产 = 负债 + 权益 |
| `xero_get_aged_receivables` / `payables` | 指定一个真实联系人,返回账龄分桶 |
| `xero_get_payment` | 用 `xero_list_payments` 拿一个 id 再 get |

`xero_list_journals` 那条是本轮读取的**核心验收**:
它是唯一能证明"写入不只是造了一张单据,而是把账做对了"的证据。

## 三、不做的

- 不重跑 7/7 情景验收(自主发现工作、注入拒绝、诚实自述等)——上一轮已过,本轮没有改动这些路径
- 不做压测、不做并发验收
- 不为读取工具的数值做逐项对账
