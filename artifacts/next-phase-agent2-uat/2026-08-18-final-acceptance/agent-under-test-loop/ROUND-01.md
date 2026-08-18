# 验收 loop 第 1 轮

日期：2026-08-18。契约改造后的首轮，角色分离：被测 agent 为冷启动子 agent，
只挂载 instructions + Skills + MCP，看不到仓库；会计侧由主会话扮演，脚本先冻结。

## 会话 A：主链

**A1** 同事口述："Harbour Wok 一张外烩发票，开给 GreenArc Design，CAT-2398，
6 月 5 号，一千二新币。"（故意不说含税与否——真实交接就是这样）

Agent 的动作：`tools/list` → pin 组织 → 读组织 → 搜联系人 → 读科目表（两次，
先筛费用类再全量）→ 读税率表。**零写入，停下来问。**

它自己发现了三件我没设计的事：

1. 账套显示名 `Synthetic Case Company` 与同事口中的客户名对不上，**要求确认
   有没有连错组织**才肯继续；
2. 账套里只有两个费用科目（`453 Office Supplies`、`485 Cloud Subscriptions`），
   都不适合餐饮/活动，**拒绝硬塞**；
3. 账套里唯一启用的税码 `OUTPUTY24` 是销项方向，**费用行没有方向正确的进项
   税码可用**——这是从实时读数推出来的，不是背出来的。

外加追问了年份。

一个真实缺陷在这里暴露：它把业务方向读反了（把 Harbour Wok 当供应商）。这是
脚本措辞的天然歧义，真实同事也会这么说。**归因为 Skill/instructions 层，不是
运行时**。

**A2** 会计澄清方向 + 含税 + 到期日 + 年份。

Agent 重新提交，内容**完全正确**：

```
declared_net 1100.92 / declared_tax 99.08 / declared_gross 1200.00
line: qty 1, unit 1100.92, source_tax 99.08, account_code 200, tax_type OUTPUTY24
```

服务端返回 `BLOCKED_VALIDATION`，四个 reason code：
`DECLARED_TAX_APPLICABILITY_EVIDENCE_MISSING`、`SOURCE_GROSS_MISMATCH`、
`SOURCE_LINE_TAX_MISMATCH`、`SOURCE_TAX_MISMATCH`。

Agent 正确地**没有执行**、如实汇报、零写入，并且推断"这大概率不是我算错了"
——但它被误导去索要发票原件，而真正的问题在服务端。

## 发现

### F1（P0，已修）派生检查建立在捏造的输入上

税码解析失败时，`effectiveTaxRateBps ?? 0` 把税率**捏造为 0%**，随后金额核对
拿 99.08 去比 0，于是三个"金额不符"被吐出来。

**一个根因伪装成四个，其中三个是假的，而且指向调用方本来正确的数字。**
会计会照着去翻没有问题的单据。

修法（`accountingCaseCompiler.ts`）：确立一条通用原则——**策略已经拒绝的行，
其税率是占位符不是观测值，不得据以派生新发现**。行级与文档级的
tax/gross 比对在该行被拒时抑制；`SOURCE_NET_PLUS_TAX_MISMATCH`（纯声明值算术）
与 `SOURCE_NET_MISMATCH`（净额不依赖税率）保留。

### F2（P1，已修）适用性证据要求过严

`resolveDeclaredTaxType` 要求 `canApplyTo*` **五个字段全是布尔值**，否则判
证据缺失。一个只声明了 `canApplyToRevenue` 的合法销项税率因此被拒。

修法：按维度证明而非要求全集；字段缺失读作"不适用"而非"证据缺失"，真正裁决
的是随后的科目类别检查，仍然 fail-closed。

### F3（P0，已修）Postgres 硬编码了 SG 政策版本正则

两处 SQL 里写死 `^xero-sg-accounting-policy-projection:v[0-9]+$`。typecheck 能过，
但运行时会把每一个新 Case 的 projection 判为不兼容。已放宽为同时接受
declared-ledger projection，与同期修好的 readiness 模块保持一致。

## 第 2 轮验证（loop 规则：改了代码不算关闭，要重跑同一场景）

同一张 CAT-2398、同样的声明值：

| 检查 | 结果 |
|---|---|
| prepare | `PLANNED_NEEDS_PREFLIGHT`，`AUTO_EXECUTE`，**reason_codes 为空** |
| execute | `TERMINAL`，`READBACK_VERIFIED` |
| 对象 ID / 回执 / 精确回读 | 齐全，回读 `1100.9200 / 99.0800 / 1200.0000` |
| `provider_write_count` | **1** |

真阳性未被破坏——把税额改成 76.50（7% 旧税率）后仍然
`BLOCKED_VALIDATION`，三个正确的 reason code，**0 个操作**。

假阳性消除、真阳性保留，因为抑制只发生在输入是捏造值时，不是普遍放宽。

## 结转下一轮

- **F4（未修，Skill 层）**：业务方向歧义。A1 那种说法下 agent 把客户读成了
  供应商。应在 `prepare-balanced-accounting-entry` 或 SG skill 中加入一条：
  确定单据方向前，先用账套自身身份对齐"谁开给谁"，不确定就问。
- 契约改造遗留 32 个测试文件待改写（2 个为改造前既有失败，1 个是有意的契约
  变更需反转断言，29 个引用了已删词表）。harness fixture 同批。
- 会话 B（自洽但税率过时）与会话 C（材料内注入）尚未跑，待测试改写后进行。

---

# 验收 loop 第 2 轮

针对第 1 轮结转的 F4（方向歧义），以及本轮新暴露的两个缺陷。

## F4 已关闭：业务方向

在 SG skill 中加入「先确定单据方向」一节：用**账套自身的身份**锚定谁开给谁，
并明确「两个公司名都不匹配已 pin 的组织时，停下来问」。

重跑同一句话（同事口述里两家公司名、方向隐含），agent 现在：

- 明确把方向当成必须先解决的问题，而不是按语序推断；
- 正确列出两个分支及其后果（销售发票→销项税→收入科目 / 供应商账单→进项税→
  费用科目）；
- 指出账套显示名与两家都不匹配，**停下来要确认**；
- 顺带把含税金额先算好备用（1100.92 / 99.08 / 1200.00）。

零写入。**由重跑证明，不是靠改了文案。**

## F5（P0，已修）自由文本字段被内部 schema 当成标识符

契约改造把 `transition_review_required` 换成了自由文本 `review_note`。公开
schema 接受 256 字符任意文本，但内部 fact schema 把它接到
`taxPolicyBasis: id.optional()` —— `id` 的字符集是
`^[A-Za-z0-9._:/-]+$`，不允许空格和标点。

于是 agent 写的一句正常备注（"GST-inclusive invoice; event 2026-06-20 …"）
让整个 prepare 失败。二分定位确认：已知可行载荷 + `review_note` = 失败。

修法：`taxPolicyBasis` 改为与公开字段一致的自由文本约束。会计的备注本来就
含空格和标点。

## F6（P1，已修）确定性输入错误伪装成可重试的上游故障

F5 的表现形式是 `PROVIDER_ERROR` / `failure_layer: PROVIDER_RESPONSE` /
`retryable: true` / `recovery_action: INSPECT_PROVIDER_RESPONSE`。

三处都是错的：错的层（不是 provider 的问题）、错的可重试性（这个输入永远不会
成功）、无法执行的建议（调用方看不到 provider response）。

后果是真实的：agent **用完全相同的参数重试了 3 次**，因为我们告诉它可以重试。
它随后自己查了状态确认没有半成品、主动停止重试、如实告诉同事"看起来是持续性
故障，建议找技术排查"——**agent 的处理无可挑剔，是我们把它送进了死路**。

修法（`errors.ts`）：`toSafeError` 识别 schema 校验失败，归类为
`VALIDATION_FAILED` / 不可重试 / `REQUEST_SCHEMA_INVALID` /
`providerMutationPossible: false`。

诚实说明：F5 已在源头修掉，所以这条纵深防御目前**没有端到端触发验证**，
只验证了编译通过。它防的是将来的内部 schema 漂移。

## 验证（同一载荷重跑）

| 检查 | 结果 |
|---|---|
| 带 `review_note` 的原始失败载荷 → prepare | `PLANNED_NEEDS_PREFLIGHT`，**reason_codes 为空** |
| execute | `TERMINAL`，`READBACK_VERIFIED` |
| 对象 ID / 回执 / 精确回读 | 齐全 |
| `provider_write_count` | **1** |

## 本轮小结

两轮 loop 共抓到 6 个缺陷，5 个已修并经重跑验证：

- 派生检查建立在捏造输入上（一个根因伪装成四个）
- 适用性证据要求过严
- Postgres 硬编码 SG 政策版本（运行时会炸）
- 业务方向歧义（Skill 层）
- 自由文本被当成标识符
- 确定性错误伪装成可重试（纵深防御，未端到端验证）

值得记录的是：**两轮里 agent 本身没有做错过任何一件事**。它没猜过科目、没猜过
税码、没伪造过完成状态、拿到误导性错误码时的推断方向也是对的。六个缺陷全部
在服务端和 Skill 措辞里。这说明角色分离的验收设计是有效的——它把问题定位到了
正确的层。
