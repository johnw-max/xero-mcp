# Xero MCP 系统设计(2026-08-19 定稿)

本文定义整改后的目标设计。执行以此为准;与既有代码冲突处,以本文为准并在提交信息里
说明改了什么、为什么。

---

## 一、两个写入面,一条分界规则

现有设计把一切写入都压进"会计案件",而案件的事实模型
(`NativeDocumentFact`)硬性假设**一份带交易对手的单据**:`documentKind`、
`counterpartyRole`、`contactName`、`lines`、`declaredNet/Tax/Gross`。

这对账单/发票/贷项通知单是对的,并且带来真实价值:全案预审能在**任何写入发生之前**
判定"这个计划依赖一个尚不存在的联系人",强制拆步,从而杜绝"建了供应商、账单失败、
留下孤儿供应商"。这个约束保留。

但它对另外两类写入是错的:

- **手工日记账**是账本事件,却没有交易对手,有 N 条必须配平的借贷,没有含税合计。
- **联系人更新 / 商品维护**根本不是账本事件——改一个供应商的地址不动任何余额。

### 分界规则(唯一判据)

> **作为账本事件依赖而产生的主数据 → 走案件面**
> **独立维护的主数据 → 走维护面**

因此 `contact.create_basic` **留在案件里**(建供应商是"入这张账单"的一部分),
而 `contact.update_basic` 走维护面。

### 面 A:账本事件(Accounting Case)

工具:`xero_prepare_accounting_case` / `xero_execute_accounting_case`(不变)。

**改造**:`NativeDocumentFact` 泛化为 `LedgerEventFact`,`kind` 增加
`BALANCED_JOURNAL`。新形状:

- 交易对手与含税合计变为**该 kind 特有**,不再是全体必填
- `BALANCED_JOURNAL` 携带 N 条 `{accountCode, taxType, debit|credit, description}`,
  **借贷合计必须相等**,由编译器校验并在不等时给出 `JOURNAL_NOT_BALANCED`
- 现有 `NATIVE_DOCUMENT` 行为**逐字节不变**(回归测试锁定)

承载动作:`supplier_bill.create_draft`、`customer_invoice.create_draft`、
`credit_note.create_draft`、`quote.create_draft`、`purchase_order.create_draft`、
`manual_journal.create_draft`、`contact.create_basic`(作为依赖)。

### 面 B:主数据维护(Reference Data Maintenance)

新工具:`xero_prepare_reference_change` / `xero_execute_reference_change`。

承载动作:`contact.update_basic`、`item.create_basic_untracked`、
`item.update_basic_untracked`。

**保留的控制**(不因为"轻"就取消):

- 两阶段 prepare→execute,不可变提案 + `compiled_plan_hash`
- 幂等键 + 一次性写入许可 + 写入回执
- **精确回读校验,失配报到字段级**
- 重复防护:新建类走数据库唯一约束坐标预留(与联系人预留触发器同构)
- 常设委派授权、审计轨迹

**去掉的仪式**(因为对象本身没有这些语义):

- 来源凭证 / 源单据桥接——**没有单据**
- 覆盖回执 / 全案预审——**没有多步计划**
- 经济学回读(净额/税额/合计比对)——**不动余额**

---

## 二、动作集合单一来源化(扩写入的前置)

**现状**:一个动作的身份被复制在约 14 个文件里。6 个孤儿各自只接通了 6~7 处,
漏掉的部分不会报错,只是静默不可达。

**目标**:`src/domain/xeroWriteActions.ts` 成为唯一真相源,导出:

```ts
export const XERO_WRITE_ACTIONS = {
  "supplier_bill.create_draft": {
    surface: "LEDGER_EVENT",
    objectType: "SUPPLIER_BILL",
    operation: "CREATE_DRAFT",
    providerAdapter: "XeroAccountingProvider.createDraftSupplierBill",
    expectedReadbackStatus: "DRAFT",
    // …
  },
  // …
} as const satisfies Record<string, XeroWriteActionDefinition>;
```

所有下游(能力目录、写入许可、执行器派发、持久化映射、工具契约)从这里派生,
**不再各自枚举**。派生不到的地方,用 `satisfies` + 穷尽性检查让遗漏变成编译错误。

**验收**:新增一个动作定义而不接线,`tsc` 必须失败。

---

## 三、派发必须穷尽

**现状**:`#executeOperation` 是 `if (actionId === "contact.create_basic") … else 文档路径`;
`#executeNativeDocument` 用**三元表达式**在供应商账单与销售发票之间二选一。
加了报价单路由而没改那行,报价单会被**静默当作销售发票执行**。

**目标**:两处都改为对联合类型的穷尽 `switch`,`default` 分支做
`assertNever`。新增动作若未派发,编译失败。

---

## 四、回读失配必须报到字段级

**现状**:

| 校验器 | 失配信息 |
|---|---|
| `verifyContactReadback` | `target.name` / `target.phones` —— 字段级 ✅ |
| `verifyItemReadback` | 只有 `"target"` |
| 四个草稿校验器 | 只有 `"CANONICAL_PAYLOAD_MISMATCH"`,连桶名都没有 |

**目标**:全部对齐到 `verifyContactReadback` 的粒度。

**为什么不是可选项**:上一层修过同样的问题(`de6610a`),原因是不透明的失配让
agent **把账单挂到了错误的供应商名下**。同一个坑在 provider 层还开着,而且开在
6 种可写对象里的 4 种上。

---

## 五、测试的真相来源

**规则**:代表 Xero 响应的测试数据来自 `tests/fixtures/xero-provider-responses/`,
经 `loadXeroResponse()` 载入(它会按 `runtime-types.json` 还原 `Date` 对象——
JSON 装不下这个区别,而这正是一个生产缺陷的成因)。

**结构性强制**:`deploy/scripts/verify-static.sh` 增加一条断言——
`tests/xero-*-primitives.test.ts` 与 `tests/provider-*.test.ts` 必须至少引用一次
`xero-provider-responses`,否则静态校验失败。

**共享替身**:`syntheticXeroAccountingProvider.ts:122` 的
`providerPageCount = Math.max(1, …)` 改为真实 API 行为(空结果 `pageCount: 0 /
itemCount: 0`)。这一行被本仓库文档点名"第三次藏住缺陷",至今未改。

---

## 六、读取扩展路径

读取的硬天花板是 `xeroClientManager.ts` 的 `XERO_READ_ACCOUNTING_API_METHODS`
(20 个 SDK 方法白名单)。任何新读取都要三步:白名单 → provider 映射 → 工具注册。

优先级:

1. **Journals** —— 今天所有读取只能看到单据怎么说,看不到总账实际过了什么
2. **P&L + 资产负债表** —— PRD 第 192 行写进 V1,未做
3. **应收/应付账龄** —— 同上
4. **Bank Transfers** —— 转账两条腿可见但无对象说明它们是一笔
5. **`xero_get_credit_note`** —— 已实现、已白名单、生产在用、只差注册;
   且是目前唯一能看到贷项通知单行项目的路径

报表类共享 `ReportWithRows` 网格结构而非强类型模型,Trial Balance 因此走了自建
raw-HTTP 传输;P&L 与资产负债表按同类工作量估,不是薄封装。

---

## 七、评审子系统降级

`scripts/review/` 不测代码行为,它测"关于代码的文档"。18 条需求从未有一条被 CLOSED;
抽查发现探针经常在测另一条声明的内容;它关于自己的 15 条声明里 14 条共用一个探针。

**决定**:降级为**可选诊断**,不再作为闸门前置。保留指纹检测器本身(它确实在真报警)。

**连带消失**:1.36MB PNG 的分片容量问题、40 条 cross-claim 重映射——
两者都只因这个子系统而存在。

---

## 八、明确不做

**资金移动类**(付款、银行交易、银行转账、批量付款、各类分配、费用报销单)。

SDK 事实:`Payment.StatusEnum` = `{AUTHORISED, DELETED}`、
`BankTransaction.StatusEnum` = `{AUTHORISED, DELETED, VOIDED}`、
`ExpenseClaim.StatusEnum` 无 DRAFT ——**这些对象没有草稿态**。

本服务器全部安全架构建立在"草稿是真实发生之前最后一道检查点"之上。这类写入没有
检查点,回读只能在钱已经动了之后确认。**结论:不建写入路径,保持只读,由人在 Xero 里执行。**
