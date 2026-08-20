# Xero MCP main 合并与开发交接说明

日期：2026-08-20
用途：说明本次候选合并包含的产品收口、验证结果和上线前剩余事项。

## 本次合并做了什么

- 固定 R1 产品边界：Xero MCP 是 Ledger Gateway；用户确认只通过组织选择 URL 完成，不引入逐笔签名、二次审批、确认 token 或额外治理状态机。
- 将公开工具、能力清单、Case action、policy、provider、read-back 和测试收敛到同一套能力契约；当前 MCP 工具数为 38，Case 可达写动作覆盖草稿、账本状态、纠正和 tracking 四类主干。
- 接通并保留严格边界的会计写入：Contact/Item 基础写入；Invoice/Bill/Credit Note/Quote/Purchase Order/Manual Journal 的 DRAFT 创建与更新；Invoice/Bill 授权、Manual Journal 过账；Payment/Bank Transaction 的受控写入与逆向；Credit Note/Invoice/Bill/Manual Journal 的账本纠正；Tracking Category/Option 的基础写入。
- 所有 Case 写路径继续使用 OAuth 组织绑定、当前 target session、typed action、幂等键、provider receipt、同 ID exact read-back 和 GET-only recovery；未知结果不自动重放写入。
- 清理 stale 30/28-tool 固定断言、旧 delegation/standing approval 运行时依赖及不再属于 R1 的生成验收物；静态能力校验改为基于 manifest 和实际工具集合。

## 明确没有放进本次产品边界的内容

- 不把 `payment.allocate` / `payment.refund` 伪装成已经支持的普通 payment 写入；它们仍是后续/非核心能力。
- 不开放外部资金发起、bank feed 导入、批量付款、最终对账、附件上传、敏感银行/税务字段或其他高风险结构写入。
- 不把本地 synthetic、构建成功或单次 read-back 当成真实租户上线证据。
- `artifacts/`、原始 JSONL、生成 ZIP 和本轮内部反馈文件不进入 main；验收产物已保存在本机临时归档目录，便于追溯但不污染产品树。

## 已完成的本地验证

- `npm run typecheck`：通过。
- `npm run build`：通过。
- `bash deploy/scripts/verify-static.sh`：通过。
- `node scripts/validate-capability-manifest.mjs`：结构校验通过；38 tools、100 capability rows，当前 `release_gate=NO_GO`。
- `npm test`：通过（1594 passed、113 skipped）；跳过项主要是没有本地 PostgreSQL/线上环境的集成测试。
- `git diff --check`：通过。

## 合并后仍必须完成的上线前事项

1. 提供隔离的 live PostgreSQL，并运行 release admission / migration / readiness gate。
2. 在 `agent2.zcloak.ai` 用当前真实 Xero 测试组织完成最小真实对话验收：读取、DRAFT 创建、DRAFT 更新、状态/纠正主干，以及 receipt 后 exact read-back。
3. 对 Demo Company 上 payment/bank transaction 的 upstream `PROVIDER_ERROR` 补采原始 HTTP status/body 和账号权限证据；在证据明确前，不把该 tenant 结果归因于 Free Tier，也不宣称 payment/bank 全链路已获线上通过。
4. 通过 live evidence 后再生成 accepted OCI、执行唯一 admission→compose→switch 发布路径，并保留可回滚的上一镜像。

因此，本次合并是“代码与架构收口候选”，不是已经通过生产上线门槛的 GO。开发接手时应先处理上述 live evidence 和 PostgreSQL gate，不应删除 `NO_GO` 标记或绕过 admission。
