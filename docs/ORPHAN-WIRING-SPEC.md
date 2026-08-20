# 孤儿动作接线规格

六个动作已建好、已测、策略已批、provider 已实现,但**没有任何工具能调用它们**。
本文写死"缺哪几处",让接线的人不必各自重新摸一遍。

已验证的事实(用 `grep -rln <actionId> src/` 数出来,排除测试):

| 动作 | 已接 | 参照物 `credit_note.create_draft` |
|---|---|---|
| `quote.create_draft` | 6 处 | 13 处 |
| `purchase_order.create_draft` | 6 处 | 13 处 |
| `manual_journal.create_draft` | 6 处 | 13 处 |
| `contact.update_basic` | 5 处 | — |
| `item.create_basic_untracked` | 5 处 | — |
| `item.update_basic_untracked` | 5 处 | — |

---

## 一、已经接通的 6 处(所有孤儿都有,不用动)

`src/db/repository.ts`、`src/domain/xeroWriteActions.ts`、
`src/policy/xeroAutonomousActions.ts`、`src/policy/xeroCapabilityPolicy.ts`、
对应的 `src/providers/xero*Provider.ts`、对应的 `src/services/xero*Service.ts`。

**prepare → 授权 → provider 写入 → 精确回读**这条链路是完整且已测的。
缺的只是"从案件执行器走到它"。

---

## 二、账本事件类缺的 7 处(报价单、采购单、手工日记账)

1. **`src/domain/accountingCase.ts`** —— `actionId` 联合类型;
   若需要新路由,还要扩 `NativeDocumentRoute`
2. **`src/domain/accountingCasePersistence.ts`** —— actionId → `{objectType, operation}` 映射
   (这是穷尽 switch,漏了编译不过)
3. **`src/control-kernel/accountingCaseCompiler.ts`** —— 把提交的事实编译成操作
4. **`src/services/xeroAccountingCaseService.ts`** —— 执行器派发。
   **注意 `#executeNativeDocument` 已改为穷尽 switch,新路由会强制编译报错,这是设计如此**
5. **`src/mcp/xeroToolCapabilityContract.ts`** —— 工具 → 能力绑定
6. **`src/policy/xeroAccountingCaseExistingDocumentEvidence.ts`** —— 既有单据证据
7. **`src/policy/xeroExternalGovernanceAuthority.ts`** —— 治理授权

**外加一处 string grep 抓不到的:** `src/policy/xeroNativeRouteContract.ts`。
它按 `NativeDocumentRoute`/`documentKind` 索引,决定"编译器选的路由是不是已发布适配器
能表达的"。报价单/采购单需要在这里写自己的字段兼容规则。

### 手工日记账另有一道阻塞

`NativeDocumentFact` 硬性要求 `documentKind: INVOICE | CREDIT_NOTE`、`counterpartyRole`、
`contactName`、`declaredNet/Tax/Gross`。手工日记账**没有交易对手**,有 N 条必须配平的
借贷,**没有含税合计**。`#executeNativeDocument` 无条件要求 `contactName` 并调用
`#assertSealedContactBinding`,会直接拒掉。

按系统设计文档,事实模型要泛化为 `LedgerEventFact`,新增 `kind: BALANCED_JOURNAL`:
交易对手与含税合计变为**该 kind 特有**;`BALANCED_JOURNAL` 携带 N 条
`{accountCode, taxType, debit|credit, description}`,**借贷合计必须相等**,
不等给 `JOURNAL_NOT_BALANCED`。

**现有 `NATIVE_DOCUMENT` 行为必须逐字节不变**,由回归测试锁定。

---

## 三、主数据类缺的 8 处(联系人更新、商品新建/更新)

这三个**不该走案件面**。改一个供应商的地址不动任何余额;
要求它提供来源凭证、覆盖回执、全案预审,是把它建模成了它不是的东西。

新增第二个面:`xero_prepare_reference_change` / `xero_execute_reference_change`。

**保留的控制**(不因为"轻"就取消):两阶段 prepare→execute、不可变提案 +
`compiled_plan_hash`、幂等键、一次性写入许可、写入回执、**精确回读且失配报到字段级**、
新建类的坐标预留(与联系人预留触发器同构)、常设委派授权、审计轨迹。

**去掉的仪式**(因为对象本身没有这些语义):来源凭证/源单据桥接(没有单据)、
覆盖回执/全案预审(没有多步计划)、经济学回读(不动余额)。

**分界规则**:作为账本事件**依赖**而产生的主数据走案件面(所以
`contact.create_basic` 留在案件里);独立维护的走维护面。

新面还要动:`src/mcp/toolNames.ts`、`src/mcp/createServer.ts`、
`src/mcp/xeroToolCapabilityContract.ts`,以及所有钉住工具数的地方
(见 `docs/CANDIDATE-DEPLOY-RUNBOOK.md`;上次加一个工具牵出 9 处)。

---

## 四、完成定义(每个动作都要满足)

摘自 `docs/XERO-MCP-EXECUTION-SOP-2026-08-19.md` SOP-3:

1. 公开输入 schema(业务语义,不含内部 ID)
2. prepare 原语:canonical payload + hash + 业务坐标/身份
3. 坐标预留(新建类可能需要新迁移)
4. provider 写入:幂等键 + 一次性许可 + 写入回执
5. **精确回读校验器,用捕获的真实响应测过,失配报到字段级**
6. 执行器派发——**必须是穷尽 switch**
7. 全部枚举点(本文第二、三节)
8. **在真实 Xero 上成功写入并回读验证过一次**

第 8 条不可省略。今天已经证明过它的价值:贷项通知单的日期解析缺陷,
在真实写入之前所有本地测试都是绿的。

## 五、验证方式(写死,不是"跑一下测试")

- `tsc` 通过(穷尽 switch 会强制暴露漏接)
- 该动作的单元与集成测试通过
- **真实 Xero 写入一次**,`xero_mutation_requests` 出现
  `READBACK_VERIFIED`,且**不得出现 `WRITE_UNCERTAIN`**
- 向 Xero 端直查,核对对象内容与 agent 所述逐条一致
