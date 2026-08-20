# 主数据维护(联系人更新、商品新建/更新)接入设计

覆盖 `contact.update_basic`、`item.create_basic_untracked`、`item.update_basic_untracked`。

## 一、不新开工具面。推翻 ORPHAN-WIRING-SPEC 第三节

那份文档主张新增 `xero_prepare_reference_change` / `xero_execute_reference_change`
一对工具,理由是"改一个供应商的地址不动任何余额,要求它提供来源凭证、覆盖回执、
全案预审,是把它建模成了它不是的东西"。

**理由成立,方案不成立。** 它自己列出的"保留的控制"——两阶段、不可变提案 +
`compiled_plan_hash`、幂等键、一次性写入许可、写入回执、精确回读且失配报到字段级、
坐标预留、常设委派、审计轨迹——**正好是案件面已经提供的全部东西**。
新开一对工具,等于把这九项控制在另一处再实现一遍。

而它想去掉的那些仪式,案件面**对主数据本来就没有施加**:
`contact.create_basic` 今天就在案件里,走 `nativeRoute: "CONTACT_CREATE"`,
`dependencyEventKeys: []`、`reasonCodes: []`,不经过 `#executeNativeDocument`,
不要求来源单据桥接,不做覆盖回执。**先例已经出厂并在真实 Xero 上验收过。**

结论:主数据维护是第四个路由族,和 `CONTACT_CREATE` 并列,不是第二个工具面。

```
ReferenceChangeRoute = "CONTACT_UPDATE" | "ITEM_CREATE" | "ITEM_UPDATE"
```

操作的路由字段最终为:
`NativeDocumentRoute | CommercialDocumentRoute | ReferenceChangeRoute | "CONTACT_CREATE" | "MANUAL_JOURNAL"`

(`CONTACT_CREATE` 保持独立字面量,不并进 `ReferenceChangeRoute`——
它是**账本事件的依赖**而产生的,分界规则见 ORPHAN 文档第三节末,那条规则是对的。)

## 二、这个选择直接省掉的东西

新工具会让 `TOOL_ALLOWLIST` 从 30 变 32,`toolsetHash = hashObject(TOOL_ALLOWLIST)`
随之改变,`docs/TOOL-COUNT-PIN-POINTS.md` 里**六处硬编码 30** 要改,
十余处钉住 `toolsetHash` 的产物要重新生成,再走一遍构建—部署—切换。
发布前夜为一个不需要的架构付这笔账,是不划算的。

**走案件面则工具数与 `toolsetHash` 一个字节都不动**(已核对:
`TOOL_ALLOWLIST` 是工具**名**数组,扩展现有工具的输入 schema 不影响它的哈希)。

## 三、事实模型

与 `ContactCandidateFact` 并列新增,不继承:

- `ContactUpdateFact` —— 携带 Xero contactId(或可解析到唯一联系人的持久身份)
  与**本次要改的字段**。未出现的字段一律不动。
- `ItemDefinitionFact` —— `code`、`name`、销售/采购描述与单价、账户代码、税种;
  新建与更新由是否已存在该 `code` 区分,**不由调用方声明**。

`AccountingFactBase` 已有的 `origin`(`MODEL_EXTRACTED` / `AGENT_ASSERTED` /
`SERVER_RESOLVED_PROVIDER_EVIDENCE`)与 `sourceUnitIds` 足以诚实表达
"这条改动来自客户的一封邮件"。**不要为此发明新的凭证类型**,也不要允许
无来源单元的事实——"客户来电"也是一个来源单元,写出来即可。

## 四、必须保留、不得因为"轻"而取消的

坐标预留(`ITEM_CREATE` 按 `code` 预留,与联系人预留触发器同构)、
一次性写入许可、写入回执、**精确回读且失配报到字段级**。

商品与联系人的回读校验器**今天已经存在**
(`verifyItemReadback`、`verifyContactReadback`),字段级失配上报正由另一路改造。

## 五、更新类动作特有的一条:不得静默覆盖

`contact.update_basic` 与 `item.update_basic_untracked` 会**覆盖已有值**。
新建类没有这个风险,联系人新建的先例不足以覆盖它。

要求:提案必须同时携带**该字段的当前值**与**将要写入的值**,
两者都进 `compiled_plan_hash`。执行时若 Xero 端当前值已不等于提案里记录的当前值,
说明期间有人改过,**必须拒绝并要求重新预备**,不得覆盖。
这是乐观并发,不是额外仪式——它防的是真实事故。

## 六、验收(SOP-3 第 8 条)

三个动作各在真实 Xero 上写入并回读验证一次,`xero_mutation_requests` 出现
`READBACK_VERIFIED`,不得出现 `WRITE_UNCERTAIN`。
更新类另需构造一次"期间被改动"的冲突,确认被拒而不是被覆盖。
