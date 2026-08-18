# 第 4 轮：契约改造后的全量测试收口

## 结果

| | 改造刚落地时 | 现在 |
|---|---:|---:|
| 失败文件 | 32 | **2** |
| 失败测试 | — | **9**（串行去抖后） |
| 通过测试 | — | **1408** |
| typecheck | 通过 | 通过 |

剩下的 2 个文件（`independent-review-evidence`、`traceability-validator`）是
改造前就存在的实验性治理框架债，本轮之前已明确从发布门槛中剔除。
**产品运行时零失败。**

并行跑会显示 23 个失败，串行加长超时后降到 9 个 —— 差额是 worker 争用导致的
超时抖动，不是新问题。这一点与改造前的基线一致。

## 本轮修掉的三处

### 1. Postgres 仍绑着已退役的政策版本常量（P0，真回归）

`postgresRepository.ts` 在两处把 `XERO_SINGAPORE_ACCOUNTING_POLICY_PROJECTION_VERSION`
作为**参数值**绑进恢复兼容性查询，而同一条链路返回的
`requiredPolicyProjectionVersion` 已经是新的 declared-ledger 版本。后果：今天
用现行政策编译出来的 Case，会被 Postgres 侧的就绪检查误报为
`UNSUPPORTED_ACTIVE_RECOVERY_PROJECTION`。

这与我更早修的两处 SQL 正则是**不同的位置**——正则管"能不能识别"，这两处管
"要求哪个版本"。两处都得改，只改一处会留下自相矛盾的状态。

值得记的是它是怎么被发现的：测试改写 agent **故意留着这个失败的测试没有改断言**，
并明确报告"这是疑似真回归，不是 fixture 问题"。如果它当时顺手把断言改成旧版本
常量，这个缺陷会被永久掩埋，而且掩埋得毫无痕迹。

### 2. 两个共享 fixture 掉进工作包的缝里

`harness/fixtures/xero/golden-14-case.v1.json` 和 `tests/mcp-oauth-config.test.ts`
**两个并行工作包都没分到**——是我拆活时漏的。

症状很有欺骗性：前者表现为 group 1 有 76 个测试大面积失败，后者表现为整个文件
"No test suite found"（因为 group 1 删掉的 helper 导出被它 import 着）。两种症状
都很容易被误读成回归。

修法：golden fixture 按 group 1 独立验证过的映射迁移（注意不是改名，旧结构把
科目/税类放在**单据级**，新契约是**逐行必填**，还要按 `counterpartyRole` 分
销项/进项方向）；oauth config 照 group 2 在 `security-contract.test.ts` 里的做法
内联那份仅供兼容解析用的 legacy profile 字面量。

### 3. 教训

并行拆包时，**共享 fixture 和共享 helper 的归属必须显式指定**。它们不属于任何
一个功能分组，却被多个分组消费；一旦掉进缝里，症状会伪装成另一个分组的回归。

## 值得记录的一件事

两个测试改写工作包都做了正确的取舍，而不是让套件变绿：

- 一个把断言 KWD 币种不受支持的测试改指向 ISO 4217 专留测试码 `XTS`——因为
  新的通用币种表**合法地**包含了 KWD，原断言已经过时，但它保住了"未支持币种
  必须 fail closed"这个**意图**；
- 另一个留下一个失败的测试来暴露真回归（见上），并写明理由。

这两个动作都比"把断言改成能过"难，也都是对的。验收的价值恰恰来自这里。
