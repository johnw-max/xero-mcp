# ADR-003：早期阶段的治理范围——只保证挂对账，其余不设卡

状态：`ACCEPTED`

日期：2026-08-18

关联：延续 ADR-002 的网关定位；收缩 ADR-001 中 firm governance 的适用范围。

## 决策

**治理在当前阶段只需保证一件事:所有数据交互都正确挂在账号、公司、case 上,
不发生串帐。** 其余控制若要保留,必须自己证明收益大于成本。

据此撤除 **firm governance 排他写入权威**,不再作为任何写入动作的前置要求——
既不是部署前置(配置层),也不是写入拦截(运行时)。

## 撤除的东西保护的是什么

Xero 对 ACCREC 发票号强制唯一,对 **ACCPAY 账单号不强制**。所以供应商账单这类
坐标,系统无法自证"全世界只有这一张"。原设计要求写入方先证明自己是该账套的
**排他写入者**,证明方式是一组 Ed25519 签名的治理文件。

它防的是:**别人**(会计手工、另一个系统、另一个 agent)在 Xero 里建了同号单据。

## 为什么撤

**代价与收益不成比例:**

- 供应商账单与供应商贷项整条路由被封死;
- 每开一个新的用户测试环境,都要先建一套签名基础设施才能写任何东西;
- 而它防的那个重复,**Xero 自己就允许**,会计本来在日常处理。

**残余风险已由零成本的控制承接:**

1. 每次创建前都会**去 Xero 查该坐标的历史**——已存在同坐标但经济字段不符,
   仍然拒绝(`PROVIDER_BUSINESS_COORDINATE_ECONOMIC_MISMATCH`);
2. 我方持久业务坐标预留,由数据库唯一索引强制;
3. 幂等身份 = 持久 mutation request ID;
4. 回执 + 零容差精确回读;
5. **只写 DRAFT**,入账永远由会计在 Xero 内完成。

也就是说,系统对外部写入**并不盲目**——它写之前会看。

## 明确保留:循环引用的 occurrence 绑定

一个可复用的引用(例如「月度顾问费」这种每月重复的标签)命名的是一个**系列**,
不是一张单据。没有 occurrence 绑定,系统无法判断要创建的是哪一期,
仍然以 `PROVIDER_RECURRING_SERIES_AUTHORITY_UNPROVEN` 拒绝。

**这不是治理,是正确性。** 撤掉它会真的记错期间。两者的区别值得写清楚:

| | 已撤除的排他写入权威 | 保留的 occurrence 绑定 |
|---|---|---|
| 防的是 | 别人建了同号单据 | **我们自己**分不清是哪一期 |
| 失败后果 | 多一张草稿,人复核可见 | 真的记错账 |
| 成本 | 签名体系 + 封死整条路由 | 零成本,agent 问一句即可 |

拒绝的形态也符合既定边界:MCP 只返回机器可读的理由码并拒绝写入,
**不替 agent 组织话术**;把它翻译成一个人能回答的问题是 skill 的职责。

## 验证

在 harness 上实测:

- 正式单据号的客户发票:`TERMINAL` / `READBACK_VERIFIED`,对象 ID、回执、
  精确回读齐全;
- 可复用引用:仍被拒(保留项生效);
- 账套中不存在的税码:仍被拒 `DECLARED_TAX_TYPE_NOT_FOUND`。

原先断言"无权威则拒绝供应商账单/贷项"的测试**被反转为正面全证据链**,
而不是删除:现在断言写入成功、且 provider 写入恰好一次。

## 诚实的残余

若他人在 Xero 中建立了同号供应商账单,且经济字段恰好一致,本系统不会察觉,
可能建出第二张**草稿**。会计复核时可见。当前阶段接受此风险。

## 何时重新评估

- 出现无人复核的自动过账(超出 DRAFT 边界)时;
- 单一账套存在多个并发自动写入方时;
- 客户要求可证明的排他写入保证时。

届时应恢复排他写入权威,但**按路由与场景**启用,不再作为所有部署的全局前置。

## Production verification, 2026-08-19

The removal was proven end to end on the live host against
`Demo Company (Global)`, driven by the real product agent on agent2, not by a
test double:

| Evidence | Value |
|---|---|
| Xero object | `2190a20f-e634-48fa-9559-b1c53317cc54` |
| Mutation state | `READBACK_VERIFIED` |
| Provider status | `DRAFT` |
| Reference | `INV-2026-0819C` (supplier bill, ACCPAY) |
| Provider writes for one document | 1 |

Re-asking for the same bill in the next turn produced **no second write** — the
mutation table still held exactly one row for that coordinate.

Four separate blockers had to be cleared before this write could happen, each
of which would have made supplier bills permanently unwritable:

1. Organisation lock dates were passed to the case target as Xero `Date`
   objects, failing the target schema for every document in the tenant.
2. `listInvoices` requested `summaryOnly=true`, which makes Xero omit
   `pagination` entirely, so the coordinate history walk could never prove
   exhaustion.
3. Xero answers a first-ever-supplier walk with `pageCount 0 / itemCount 0`;
   that exact empty answer was being rejected as invalid.
4. `resolveXeroFirmGovernanceExpectation` still demanded a signed
   exclusive-writer authority for non-unique coordinates — on both the sealed
   and unsealed paths — long after any delegation carried
   `firmGovernanceRequired`.

Items 1–3 were defects. Item 4 was the governance remnant this ADR removes.
