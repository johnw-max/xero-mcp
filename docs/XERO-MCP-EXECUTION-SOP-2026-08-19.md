# 执行 SOP 与子 agent 调度

配套 `XERO-MCP-REMEDIATION-PLAN-2026-08-19.md`。这些规则每一条都对应一个真实出厂的
缺陷,写死是为了换人、换 agent 也不重犯。

---

## SOP-1 提供方响应:禁止手搓

代表 Xero 响应的测试数据必须来自 `tests/fixtures/xero-provider-responses/`,
经 `loadXeroResponse()` 载入。禁止在测试里手写 Xero 响应对象。

**为什么**:20 个测试替身,零个来自真实录制。五个生产缺陷全部出自"替身回声式地
同意我们"。真实 Xero 会补空电话块、丢分页信封、把日期发成 `Date`。

**例外**:需要构造真实 API **不会**产生的形状(反面断言)时可手写,但必须注释
"真实 API 不会产生此形状,此处刻意构造"。

**判定**:测试里出现 Xero 字段名而未引用夹具的,不合格。

---

## SOP-2 修复前必须先证伪

改任何一行修复代码之前,先给出**单变量翻转**证据:构造一个当前**通过**的用例,
只改被怀疑的那一个变量,展示结果翻转。证据写进提交信息。

**为什么**:今天四次"找到根因"里有两次是错的。第一次以为是 `target` 比对失配,
实际是整个数组映射把回读判死;第二次以为夹具缺 lock 文件,补上后发现缺口在别处。

---

## SOP-3 新写入能力的完成定义

缺任何一条都算半接通。仓库里已有 6 个半接通的能力,就是这么来的。

1. 公开输入 schema(业务语义,不含内部 ID)
2. prepare 原语:canonical payload + hash + 业务坐标/身份
3. 坐标预留(数据库唯一约束防重复;新建类可能需要新迁移)
4. provider 写入方法:幂等键 + 一次性写入许可 + 写入回执
5. **精确回读校验器,用捕获的真实响应测过,且失配要报到字段级**
6. 执行器派发——**必须是穷尽 switch,不是三元表达式**
7. 全部约 14 处动作枚举点(文档式:documents 与 entity 两种形状不同)
8. **在真实 Xero 上成功写入并回读验证过一次**

第 8 条不可省略。当前 4 个可触达动作里有 2 个从未在真实 Xero 上跑过。

---

## SOP-4 测试必须能跑,或者显式失败

禁止静默跳过。闸门里已有"出现 skip 即判 FAIL"的控制
(`local-acceptance-gate-lib.mjs:1509`),本地默认要拉到同一标准。

数据库存在时必须关闭跨文件并行——已由 `vitest.config.ts` 落实。修复前
`npm test` 的失败里 67% 是并发争抢造成的假失败。

---

## SOP-5 每个测试要说清"删掉它会漏掉什么"

新增测试带一行 `// proves:` 注释,写明删掉后生产上会漏掉什么。写不出来的不要写。

**为什么**:22 处 `.resolves.toBeDefined()` 取回业务记录却从不检查是哪一条;
1594 个测试里 `expect.assertions()` 用了 0 次。

---

## SOP-6 判定以账本为准

"已写入/已验证"的结论必须以 `xero_mutation_requests` 表和 Xero 端直查为准。
agent 自述、报告散文一律不作判定依据。

**为什么**:验收对话里 agent 曾对自身工具历史失实陈述(称未调用 Drive,
而界面记录显示调用并认证失败)。

---

## SOP-7 子 agent 派发规范

每份任务书必须包含:

- **已确立的事实**:哪些结论已验证、不要重新推导。省 token,也避免各自得出矛盾结论。
- **真相来源**:SDK 类型 / 捕获夹具 / 数据库 / 真实 Xero。**禁止依赖记忆中的文档**。
- **文件边界**:可改哪些、不可改哪些。
- **提交权**:默认**不允许提交**,由调度方统一提交。
- **验收标准**:跑哪些命令、期望什么输出。
- **必须报告"没做什么"**:发现但未修的、无法判断的,必须列出。

**模型**:枚举、对照、机械修复用 sonnet;跨领域取舍由调度方做。

**并发冲突**:同一时刻不允许两个 agent 编辑同一文件。派发前列文件占用表。

### 今日教训:调度方自己也要守边界

一个执行 agent 正在工作时,调度方的 `git add -A` 把它进行中的编辑扫进了一个
主题无关的提交。没有丢失工作,但提交历史因此不准确。

**规则**:有执行 agent 在跑时,调度方**不做 `git add -A`**,只提交明确列出的路径;
或等 agent 交付后再统一提交。

---

## 文件占用表(执行阶段)

| 工作流 | 独占文件 | 冲突方 |
|---|---|---|
| W1 夹具接入 | `tests/xero-*-primitives.test.ts`、`tests/provider-*.test.ts` | W6 |
| W1 共享替身 | `harness/lib/syntheticXeroAccountingProvider.ts` | 无 |
| W1 静态约束 | `deploy/scripts/verify-static.sh` | 无 |
| W2 字段级失配 | `src/providers/xeroContactItemMapper.ts`、`xeroQuotePurchaseOrderDraft.ts`、`xeroCreditNoteManualJournalDraft.ts` | W4 批次 2/3 |
| W2 验收边界 | `scripts/release/local-acceptance-gate-lib.mjs`、`run-local-acceptance-gate.mjs` | 无 |
| W3 目录纠偏 | `src/policy/xeroCapabilityPolicy.ts` | W4(全部批次) |
| W3 派发表 | `src/services/xeroAccountingCaseService.ts` | W4(全部批次) |
| W4 各批次 | 约 14 处枚举点 | 彼此互斥,**必须串行** |
| W5 读取 | `src/providers/xeroClientManager.ts`(白名单)、`xeroProvider.ts`、`src/mcp/` | 批次间互斥 |
| W6 测试质量 | `tests/oauth-*`、`tests/mcp-oauth-token-service.test.ts` | W1 |

**因此:W2 与 W4 不可并行;W3 必须在 W4 之前;W1 与 W5 可并行;W6 可随时并行。**
