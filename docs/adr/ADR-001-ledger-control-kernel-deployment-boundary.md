# ADR-001：Ledger Control Kernel 的复用与部署边界

状态：`ACCEPTED TARGET / EXTRACTION NOT YET COMPLETE`

日期：2026-08-13

## 决策问题

多个独立 Accounting MCP 需要复用同一组底层安全不变量，同时不能把平台改造成了解 Xero、QuickBooks 等垂类细节的中央会计服务。需要在以下三种方案中确定长期边界：

1. 中央控制服务；
2. 每个 MCP 复制一套实现；
3. 共享、provider-neutral 的 kernel SDK/package。

## 决策

长期选择第 3 种：**版本化的共享 kernel package + 每个 MCP 内部的 provider adapter**。

当前仓库中的 `src/control-kernel/` 只是 package 抽取前的孵化位置，不代表已经完成 provider-neutral 验收。只要共享 domain、compiler、validator 或测试仍要求删除 Xero 字段后才能接入 fake provider，就不能宣称抽取条件已满足。

执行边界如下：

```text
Agent / Work
    -> 独立 MCP：协议、连接、capability、tenant binding、审计、错误与用户可解释状态
        -> shared kernel：authority、来源覆盖、deterministic validation、idempotency、permit、receipt/readback invariant
            -> provider adapter：Xero/未来 provider 的 API、ID、scope、状态和错误映射
                -> provider system of record
```

MCP 负责在 provider 边界执行控制，但不承担以下职责：

- 自建总账、替代 Xero/QuickBooks 作为正式 system of record；
- 在平台层写 Xero 专用 tax code、contact ID 或 route；
- 替代会计师完成 close、tax filing、audit opinion 或机构审批；
- 通过 Prompt/Skill 代替运行时强制控制；
- 用中央服务静默取得所有客户凭据或跨 MCP 直接执行 mutation。

## 三种方案比较

| 方案 | 优点 | 主要问题 | 结论 |
|---|---|---|---|
| 中央控制服务 | 策略发布集中、可统一观测 | 新增强依赖与单点；会迫使平台了解 provider/垂类；独立 MCP 的 tenant、credential 和故障边界被扩大 | 不选作账本控制执行面。未来可有只读 policy distribution，但不能持有 provider credential 或直接写账 |
| 各 MCP 复制实现 | 初期最快、无 package 发布流程 | 安全修复漂移；相同 invariant 逐渐不同；难证明 QuickBooks/Excel 复用；review 和 migration 成本成倍增加 | 拒绝 |
| 共享 kernel SDK/package | 独立部署同时复用不变量；provider adapter 保持隔离；版本、conformance 和回滚可证明 | 需要稳定 API、版本纪律和跨 provider contract tests | 选择 |

## Package 抽取前置条件

以下条件必须同时满足，不能因“第二个 provider 快上线”而提前复制：

1. exported kernel type、error、receipt、permit 和 test fixture 中没有 `xero`、Xero ID、Xero policy literal 或 Xero route；
2. fake provider 不需要先删字段、改 schema 或跳过校验即可通过相同 conformance suite；
3. Xero adapter 只能通过明确定义的 provider contract 接入，不能被 shared kernel import；
4. kernel 外部不存在 credential-backed raw writer 或绕过 permit 的 adapter path；
5. 至少两个 MCP/provider consumer 使用相同 API，或第二个 consumer 已有可执行 conformance harness；
6. local Gate 的架构、业务、可靠性和验收 reviewer 均关闭相关 P0/P1。

任何一项不满足，维持 in-repo 孵化并把差距记为 OPEN，不得复制一份到第二个 MCP。

## 版本与迁移策略

- package 使用独立 SemVer；kernel contract、receipt schema、policy/compiler/validator 各有可查询版本；
- additive field 和兼容 reader 属于 minor；删除字段、改变 hash canonicalization、状态语义或 permit contract 属于 major；
- MCP runtime attestation 必须记录 package version、contract/hash schema version 和 toolset hash；
- 数据库 migration 仍由各 MCP 所有，但 migration 必须引用所需 kernel schema version；启动 readiness 对不兼容组合 fail closed；
- 升级采用 expand → 双读/兼容读 → backfill/验证 → contract 的顺序；不能先发布只会读新格式的代码；
- 同一验收批次不得混用不同 kernel/package 版本；回滚必须保留 reader compatibility，不能把已写入的新 receipt 变成不可恢复状态。

## 何时重新评估中央组件

只有当多个 MCP 需要共享不含凭据、provider payload 和客户账本数据的签名 policy/版本目录时，才评估中央只读控制平面。即便如此，中央不可用时 mutation 必须 fail closed，且 provider credential、tenant binding、write claim 和 exact readback 仍留在独立 MCP 内。

## 验收后果

- 当前 `src/control-kernel/` 不能仅凭目录名被称为成熟 shared package；
- provider-neutral conformance 必须扫描传递依赖和真实 exported types，而不是只扫描一个目录；
- 任何按 provider 写死的规则必须下沉至 adapter/policy，并通过 typed contract 进入 kernel；
- 本 ADR 的改变必须新建 superseding ADR，并重新跑六轴本地验收。
