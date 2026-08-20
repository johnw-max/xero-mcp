# 会计核心能力补全计划(2026-08-20 重定范围)

用户当日指示:**把会计核心业务相关的写入、读取补完整**;验收要快、不要用力过度;
只修**确实存在、影响上线后体验**的 MCP blocker。

先前 `docs/REMEDIATION-SCOPE-BOUNDARY.md` 把"只读报表广度"排除在本轮之外。
**那条作废。** 读取与写入同为核心。

---

## 一、写入侧

| 动作 | 状态 |
|---|---|
| `contact.create_basic` | 已接通(案件面 `CONTACT_CREATE`) |
| `customer_invoice.create_draft` / `supplier_bill.create_draft` | 已接通 |
| `credit_note.create_draft` | 已接通;含税原单据的校验器已修,**端到端仍差三处**(见下) |
| `quote.create_draft` / `purchase_order.create_draft` | 已接通(`c63494b`,独立 `CommercialDocumentRoute` 族) |
| `manual_journal.create_draft` | **进行中** |
| `contact.update_basic`、`item.create_basic_untracked`、`item.update_basic_untracked` | **待做**,走案件面第四路由族(见 `REFERENCE-DATA-SURFACE-DESIGN-2026-08-20.md`) |
| **附件上传** | **完全没建**。`XERO_MUTATION_OBJECT_TYPES` 里有 `ATTACHMENT`/`UPLOAD`,但没有写入动作、没有 provider 方法、没有服务 |

### 含税贷项还差的三处

1. `src/domain/accountingCase.ts` —— `OriginalTransactionEvidenceFact.lineAmountType` 仍是 `EXCLUSIVE \| NO_TAX`
2. `src/domain/accountingCaseSchemas.ts` —— 同名 zod enum
3. `src/control-kernel/accountingCaseCompiler.ts` —— 拿**原单据**的含税方式与**贷项自己的**直接比对,
   而 `src/mcp/xeroAccountingCaseBusinessIntake.ts` 把后者写死成 `EXCLUSIVE`

### 附件为什么算核心

事务所从一张 PDF 入账,**PDF 必须挂回 Xero 的那张单据上**,审计才能从分录追到凭证。
现在凭证只存在于 MCP 自己的审计轨迹里,Xero 端是一张没有来源的单据。
它是草稿态、不移动资金,落在用户划定的核心边界内。

---

## 二、读取侧

现有 30 个工具覆盖单据与联系人,**不覆盖总账,也不覆盖任何一张财务报表**。

进行中:总账 Journals、损益表、资产负债表、应收/应付账龄、`xero_get_payment`、
追踪类别(tracking categories)。

`xero_list_journals` 是其中最重要的一个:**它是总账本身**——一张单据实际产生的借贷分录。
没有它,agent 只能确认"单据存在",无法确认"账做对了"。

---

## 三、确实存在的上线体验 blocker(已在修)

今天用真实 connector 连线复现了两条,**不是假设**:

1. **选择组织页没有防重复提交。** 纯 HTML 表单,点两下:第一下成功并 302,
   第二下报 `FLOW_SELECTION_MISSING`,浏览器落在**一页裸 JSON**上。
   日志实证:`02:03:38 POST 302` / `02:03:52 POST 403`——连接其实在 38 秒时就成了,用户只看到 403。
2. **此后约 6 分钟内所有重试都被拒,而提示不说等。** 第一次留下一个授权码尚未兑换的
   ACTIVE installation,personal-poc 单实例规则拒绝替换,直到码过期(实测 01:54:09 签发,01:59:49 过期)。

两条都发生在**每一个客户接入的第一分钟**。

## 四、暂不追的

claude.ai connector 始终没有来兑换授权码(`POST /token` 对该客户端 0 次,
历史 117 次全部来自 Work/Agent2 的服务端)。服务端每一步都正确:302 已发出、
flow `COMPLETED`、授权码已签发。**问题在浏览器把授权码送回 claude.ai 这一段**,
不在本服务器的正确性上。已为该客户端开启 manual-return 以增加一条可见的返回路径。
真实 Xero 写入验收(SOP-3 第 8 条)因此顺延,不阻塞其余全部工作。
