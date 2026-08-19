# Xero MCP 整改方案(2026-08-19)

六路并行审计的综合结论与执行计划。审计范围:读取覆盖、写入覆盖、验收机制、
测试替身保真度、休眠测试、测试套结构。

---

## 一、根因:验证从不接触 Xero

这不是推断,是这个仓库自己写下的事实:

- `harness/README.md` 第一句:**"It never contacts Xero."**
- 验收闸门 14 个步骤,**没有一步调用 Xero**。
- `local-agent-evidence` 这一步——本该证明"agent 真的完成了一次带凭据和回读的
  记账"——其 schema **硬性要求** `evidence_boundary === "LOCAL_SYNTHETIC_PROVIDER_SDK_BOUNDARY"`。
  一次真实的 Xero 运行**在结构上没有资格**满足它。
- 全仓 `tests/` 里没有任何一个自动化测试接触真实 Xero。

后果是可量化的:一个让"从新供应商入第一张账单"完全不可用的缺陷,
**在 13 个已发布版本里存活**,而闸门里必过的 `full-regression` 全程绿灯。

### 复发机制:替身回声式地同意我们

五个生产缺陷同属一类:替身把请求原样回给你,于是"提供方会不同意我们"这件事
永远测不到。真实 Xero 会补空电话块、丢分页信封、把日期发成 `Date` 对象。

项目自己的文档已经点名过这个模式——`XERO-MCP-RELEASE-VERDICT-2026-08-19.md`:
> 病根仍是测试替身:`providerPageCount: Math.max(1, …)` 强行把页数抬到至少 1……
> **这是同一模式第三次藏住缺陷**

**那一行今天仍然在 `harness/lib/syntheticXeroAccountingProvider.ts:122`。**
第四次复发正在等着。修复只打在一个调用点和一份内联 mock 上,共享库没动。

---

## 二、必须保留的部分(不要重建)

审计明确认定这些是高质量工程,重建会丢掉真正的资产:

| 资产 | 为什么保留 |
|---|---|
| 112 个数据库门控集成测试 | 用真实 `pg_advisory_xact_lock` 制造竞态、故意构造加锁顺序相反的组合证明不死锁、直接篡改数据库行证明能检出。**逐个判定:全部保留,一个都不删。** |
| 崩溃重启证据、确定性 OCI 重建、不可变快照 | 认真的工程,只是回答的是另一个问题(字节是否可重建、进程能否扛住 kill) |
| cross-claim 指纹检查 | 真实有效的对抗性检测器,当前真的在报警 |
| 账套切换 / target-session 防串账 | 唯一证明"切换账套不会把旧会话的写入重定向到新租户"的地方 |
| 失败信封测试 | 断言 `JSON.stringify(envelope)).not.toContain("SECRET-LEAK")`——真回归测试 |

---

## 三、覆盖现状(数字)

| | SDK 提供 | 已实现 | 已注册 | **agent 可触达** |
|---|---|---|---|---|
| 读取 | 126 个操作 | 20 个 SDK 方法(硬白名单) | — | 22 个工具 |
| 写入 | 109 个操作 | **9 个 SDK 方法** | 10 个动作 | **4 个动作** |

写入真实可触达的只有:新建联系人、销售发票草稿、供应商账单草稿、贷项通知单草稿。
其中**只有 2 个在真实 Xero 上跑通过**。

读取的硬天花板不是工具列表,是 `xeroClientManager.ts:56-77` 的
`XERO_READ_ACCOUNTING_API_METHODS`——20 个方法的白名单,之外的资源需要改客户端管理器
才可能被工具触达。

---

## 四、工作流(按依赖排序)

### W0 — 让测量可信(今日已完成)

- `vitest.config.ts`:数据库存在时关闭跨文件并行。**修复前 `npm test` 的失败里
  67% 是假的**(并发争抢同一个数据库),读数在 2/5/6 之间跳。修复后稳定在 1596 项、
  2 个失败。
- 从真实租户捕获响应夹具 + 运行时类型清单(JSON 装不下 `Date`,类型清单补上)。
- 六个日期解析器合并到一个内核。**四类草稿的必然失败缺陷已修**。
- 四个门控测试夹具修正(其中一个是我自己引入的错误)。

### W1 — 关闭现实缺口(最高优先,针对根因)

1. **把已捕获的夹具接进测试。** 夹具是真的、类型保真的、**没有任何测试在用**。
   接入 contact / credit note / manual journal / quote / purchase order / invoice
   的 mapper 与 verifier 测试。
2. **修共享替身,不是第三份内联副本。** `syntheticXeroAccountingProvider.ts:122`
   的 `Math.max(1, …)` 改成真实 API 的 `pageCount: 0 / itemCount: 0`。
3. **把"必须用真实形状夹具"变成结构性约束。** `verify-static.sh` 已经在用 grep
   强制几十条字面量不变式,加一条:`tests/xero-*-primitives.test.ts` 与
   `tests/provider-*.test.ts` 必须至少引用一次 `xero-provider-responses`,否则静态校验失败。
4. **建立一条可按需运行、产出机器可核对凭据的真实 Xero 冒烟。** 不必进 CI,
   但必须存在、可复现、有回执。

### W2 — 让验收机制回答正确的问题

1. `local-agent-evidence` 的 `evidence_boundary` 必须允许真实提供方运行,
   否则这一步在结构上排斥真相。
2. **字段级失配上报**推广到 `verifyItemReadback` 与四个草稿校验器——
   它们目前只给 `"target"` 或 `"CANONICAL_PAYLOAD_MISMATCH"`,连桶名都没有。
   项目已经在上一层修过同样的问题(`de6610a`),原因是不透明的失配让 agent
   "把账单挂到了错误的供应商名下"。
3. **人工放行必须是结构化记录,不是散文。** 至今每一轮验收都是在机器产物写着
   `FAIL` 的旁边,用自由格式 markdown 判定放行。改成 `gate-result.json` 的
   结构化兄弟文件。

### W3 — 消除能力目录与现实的背离

1. `xeroCapabilityPolicy.ts` 把 6 个**不可触达**的动作标为 `AVAILABLE_NOW`,
   其 `toAgentFacingDecision()` 因此返回 `policyAllowsExecution: true`。
   任何据此判断"agent 能做什么"的人或程序,对 10 个已发布动作中的 6 个是错的。
2. `#executeNativeDocument` 用**三元表达式**选 provider 调用,不是穷尽 switch。
   加了新路由而没改这行,报价单会被静默当作销售发票执行。改成穷尽派发表。

### W4 — 补全写入覆盖(依赖 W1、W3)

**六个"孤儿"不是半成品**——它们有完整且已测的 prepare→授权→provider→精确回读
链路,只是被 `createServer.ts:289-293` 的硬开关挡在案件执行器之外。缺的是集成,不是能力。

| 批次 | 内容 | 规模 |
|---|---|---|
| 1 | `contact.update_basic`、`item.create_basic_untracked`、`item.update_basic_untracked` | 小-中。`item.create` 可能需要一个新迁移(镜像现有的联系人预留触发器) |
| 2 | `quote.create_draft`、`purchase_order.create_draft` | 中。形状与发票/账单同构,但要真正重构派发,不是加第三个分支 |
| 3 | `manual_journal.create_draft` | **大,单独排期**。手工日记账没有交易对手、有 N 条借贷必须配平,**完全不适配现有的 `NativeDocumentFact` 抽象**。需要新的事实类型与配平校验 |

**Class C(资金移动)建议明确关闭,而不是留作待办。** SDK 事实无可辩驳:
`Payment.StatusEnum` = `{AUTHORISED, DELETED}`、`BankTransaction.StatusEnum` =
`{AUTHORISED, DELETED, VOIDED}`、`ExpenseClaim.StatusEnum` 无 DRAFT——
**这些对象根本没有草稿态**。本服务器全部安全架构都建立在"草稿是真实发生之前的最后一道
检查点"之上。Class C 没有这个检查点,回读只能在钱已经动了之后确认。

### W5 — 补全读取覆盖

| 序 | 内容 | 为什么 |
|---|---|---|
| 1 | **Journals(系统总账)** | 今天所有读取只能看到**单据怎么说**,看不到**总账实际过了什么**。这是月结对账的盲区。SDK 白名单里根本没有 `getJournals` |
| 2 | **P&L + 资产负债表** | **PRD 第 192 行自己写进 V1 范围,没做**。只做了 Trial Balance |
| 3 | **应收/应付账龄** | 同上,同一行 PRD |
| 4 | **Bank Transfers** | 转账两条腿今天各自可见,但没有对象说明它们是一笔转账 |
| 5 | `xero_get_credit_note` | **近乎零成本**:已实现、在白名单里、生产在用、只是没注册成工具。且**它是目前唯一能看到贷项通知单行项目的路径** |

### W6 — 测试套质量(可并行,低风险)

- 22 处 `.resolves.toBeDefined()`——取回一条业务记录却从不检查它是哪一条,
  返回错误记录也会通过
- 内存版与 Postgres 版契约测试是手工复制的(全仓 `describe.each` 用了 0 次),
  于是弱断言被复制成了两份
- 1594 个测试里 `expect.assertions()` 用了 **0 次**——回调里的断言从没执行过也看不出来

---

## 五、需要产品决策的四件事

1. **Class C(资金移动)**:按上面的理由明确关闭,还是要另建一套不依赖草稿态的安全模型?
2. **1.36MB 架构图**:给评审模型增加"非文本资源摘要表示",还是把二进制移出被证明的源集合?
3. **40 条 cross-claim**:谁来重新映射?这是评审人的判断,没有脚本能推导。
4. **对象级工具是否开放**:现在只有案件这一个写入面,这是刻意设计
   (`createServer.ts:285-287`);补全写入覆盖时是否维持这个约束?
