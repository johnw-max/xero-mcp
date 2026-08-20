# 手工日记账接入设计(推翻 ORPHAN-WIRING-SPEC 的方案)

## 一、`docs/ORPHAN-WIRING-SPEC.md` 提的方案,不采纳

那份文档说:把 `NativeDocumentFact` 泛化成 `LedgerEventFact`,新增
`kind: BALANCED_JOURNAL`,让交易对手与含税合计变成"该 kind 特有"。

**不采纳,理由是爆炸半径。** `NATIVE_DOCUMENT` 这个事实种类被
编译器、策略、持久化、provider 适配器、案件执行器共同读取,把它改成一个带内部
判别式的联合,等于让**每一个现有读取点**都要重新证明自己仍然正确。那份文档
自己也承认这一点,所以它加了一句"现有 `NATIVE_DOCUMENT` 行为必须逐字节不变,
由回归测试锁定"。

**靠回归测试锁定"行为没变",和靠构造保证"行为不可能变",不是一个安全级别。**
本仓库已经出厂五个全绿闸门下的缺陷,其中一个存活 13 个版本。这里不应该再选
一个把正确性押在测试覆盖率上的方案。

## 二、采纳的方案:并列新增,不改动既有

`AccountingFactKind` 已经是一个 13 个成员的联合(`PAYMENT`、`BANK_FEE`、
`PREPAYMENT`、`FX_SETTLEMENT`……)。**加一个种类是这个代码库既有的、被反复
使用过的扩展方式**,而不是一个新发明。

1. `ACCOUNTING_FACT_KINDS` 增加 `"BALANCED_JOURNAL"`。
2. 新增 `BalancedJournalFact extends AccountingFactBase`,与 `NativeDocumentFact`
   **并列**,不继承、不共享字段:
   - 无 `counterpartyRole`、无 `contactName`、无 `declaredNet/Tax/Gross`
   - `lines: Array<{ lineId, description, accountCode, taxType, debit?, credit? }>`
   - 每行**恰好**有 debit 或 credit 之一
   - **借方合计必须等于贷方合计**,不等 → `JOURNAL_NOT_BALANCED`
3. 路由联合从 `NativeDocumentRoute | "CONTACT_CREATE"` 扩为
   `… | "MANUAL_JOURNAL"`。
4. 执行器**新增 `#executeBalancedJournal`**,不复用 `#executeNativeDocument`。
   后者无条件要求 `contactName` 并调 `#assertSealedContactBinding`;日记账没有
   交易对手,走进去只能靠塞假值,那是把"没有"伪造成"有"。

**这样 `NativeDocumentFact` 一个字节都不动,现有路径的正确性不需要被重新证明。**

## 三、平衡校验的位置

借贷相等是**记账恒等式**,不是 Xero 的偏好。它必须在**编译期**判定,
和金额、账户代码一起进入不可变提案与 `compiled_plan_hash`,
**不能**放到 provider 适配器里——那时提案已经封版,再拒就是执行期失败,
拿不到"提案本身不成立"这个结论。

金额比较用本仓库既有的货币规则,不用浮点。

## 四、验收(SOP-3 第 8 条,不可省)

真实 Xero 写入一次草稿态手工日记账,`xero_mutation_requests` 出现
`READBACK_VERIFIED`,**不得出现 `WRITE_UNCERTAIN`**,并到 Xero 端直查核对每一行。

日记账的回读有一个已知坑:`xeroProviderDate` 的整合已经处理了 `/Date(ms+tz)/`
返回 `Date` 对象的情况,但手工日记账**从未真实写入过**,
所以那条路径至今没有被真实响应验证过。这正是第 8 条存在的原因。

---

## 五、路由归属(2026-08-20 补,与报价单/采购单的决定配套)

报价单/采购单接线时暴露出:`NativeDocumentRoute` 这四个值不只是"文档种类",
它背后连着一整套**总账过账**假设——
`xeroDocumentCoordinateAuthority` 的 InvoiceNumber/CreditNoteNumber 唯一性、
`xeroBusinessCoordinateHistory` 的 ACCREC/ACCPAY 去重、
`xeroBusinessCoordinateAuthority.ts` 里那个与 TS 联合无法互相校验的 `z.enum`。

所以路由分成**三族**,按"是否过账"和"有没有交易对手"切:

| 族 | 成员 | 过总账 | 有交易对手 | 复用发票机制 |
|---|---|---|---|---|
| `NativeDocumentRoute` | 销售发票、供应商账单、客户贷项、供应商贷项 | 是 | 是 | 是 |
| `CommercialDocumentRoute` | 报价单、采购单 | **否** | 是 | 否 |
| `MANUAL_JOURNAL` | 手工日记账 | **是** | **否** | 否 |

手工日记账**确实过总账**,这一点和报价单不同,不能拿"它不是账本事件"当理由。
它不能进 `NativeDocumentRoute` 的理由是另一条:**没有交易对手,也没有
ACCREC/ACCPAY 这种单据类型**。`xeroBusinessCoordinateHistory` 的
`snapshot.type !== (originalRoute === "SALES_INVOICE" ? "ACCREC" : "ACCPAY")`
对它无从谈起。

## 六、日记账去重是本设计里最难的一处,不要照抄报价单的结论

报价单/采购单可以接受"跨系统重复检测暂不覆盖",因为重开一张报价单不影响任何余额,
且 Xero 里可删。**手工日记账不是。** 重复入账直接造成错报,而且它**没有
单据号**(Xero `ManualJournal` 没有 InvoiceNumber 那样的天然唯一坐标)。

因此:
- 本服务器自身的重复写入,由坐标预留挡住——**坐标怎么定义要专门设计**,
  候选是 `(narration, date, 逐行 {accountCode, debit/credit} 的规范化哈希)`。
- 跨系统重复(有人在 Xero 网页端手工录过同一笔),**在做出可靠方案之前
  不得声称已覆盖**,并且必须以显式 reason code 告知调用方。

如果这条挡住了草稿态手工日记账的验收,**先把上面那句"未覆盖"做诚实**,
再谈能力,不要为了让它看起来通过而弱化去重。
