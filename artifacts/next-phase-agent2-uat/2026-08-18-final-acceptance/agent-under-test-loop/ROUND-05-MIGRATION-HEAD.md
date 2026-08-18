# 第 5 轮：必需迁移清单缺口（P0）

## 发现

重新构建候选时，build identity 报出 `requiredMigration = 040_…`，但本轮已经
新增了 `041_accounting_case_source_case_binding.sql`。查证确认：**041 从来没有
被加进 `src/db/required-migrations.json`**。

这是那个被中断的跨 MCP 绑定工作留下的缺口。我当时补完了仓储实现和 service
接线、也补了迁移文件本身，但没注意到清单没跟上。

## 为什么这是 P0

必需迁移清单是**部署就绪检查的依据**。041 不在清单里，意味着：

- 部署到一个没跑 041 的数据库时，就绪检查**不会报错**；
- 但运行时只要有任何 Case 引用了上游 source case，就会往
  `accounting_case_source_case_bindings` 表写入；
- 那张表不存在 → 运行时失败。

也就是说：**一个通过了所有就绪检查的部署，会在真实业务触发时才炸**。而且触发
条件正是我们本轮新加的、用来防串帐的那条路径。

这类缺口的危险之处在于它不产生任何本地症状——本地数据库是用 `migrate` 全量跑
出来的，表一直都在，所有测试都绿。只有在"部分迁移的环境"才会暴露。

## 修法与连带

把 041 加入清单后，四处硬编码的 head 断言随之失配，逐一对齐：

| 位置 | 处置 |
|---|---|
| `tests/required-migrations-release-gate.test.ts` | 清单加 041，标题 025-040 → 025-041 |
| `tests/xero-release-attestation.test.ts` 的 `requiredMigration` | 040 → 041 |
| 同文件的**迁移内容断言** | 原本断言 head 迁移里含 `native_recovery_claim jsonb`（那是 040 的结构）。改为断言 041 自己的定义结构：`accounting_case_source_case_bindings` 表、其主键、以及 `source_case_claim` 列 |
| `harness/manifests/contract-v1.json` + `tests/current-release-contract.test.ts` | 040 → 041 |

第三项值得单独说：那条断言的**意图**是"attested head 必须真的定义了它声称的
东西，而不只是文件存在"。head 换了之后，正确做法是把断言指向新 head 的定义性
结构，而不是删掉它或降级成"文件存在即可"。041 的主键正是"一个上游 case 不能
跨两个 Xero 租户"这条保证的实际载体，断言它是有意义的。

## 验证

`typecheck` 通过；迁移/attestation/就绪三个文件 43 个测试通过；全量 1411 通过，
失败仍只剩既有的实验性治理框架债。
