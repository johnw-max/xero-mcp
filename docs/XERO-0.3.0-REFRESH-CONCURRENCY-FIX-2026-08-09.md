# Xero MCP 0.3.0 Agent2 并发续期修复

日期：2026-08-09  
状态：`LOCAL_RELEASE_CANDIDATE_PASS / NOT_YET_DEPLOYED`

## 业务影响

Agent2 的 MCP access token 最长 15 分钟。旧线上实现遇到同一次 401 触发的多个 refresh 请求时，第一个请求虽然成功生成新 token，第二个请求却把旧 token 判为恶意重放并撤销整个连接，导致会计用户在连续工作中突然掉线。

## 固定规则

1. 首次 refresh 在原子事务中轮换 access/refresh token。
2. 同时把完全相同的 token response 加密保存，最长可用 10 秒。
3. 窗口内重复请求只有在 successor 仍是未消费、无 replacement 的当前 tip，且 client/resource/audience/scope 完全一致时才返回第一次结果。
4. 窗口内无法安全合并时只返回通用 `invalid_grant`，不误伤有效新连接。
5. 超过窗口的旧 token 重放继续撤销整个 grant。
6. 加密回执到期后由有界 cleanup 擦除，不长期保留原始 token。
7. 发布时必须停旧启新，禁止旧、新实例同时接收 refresh 流量。

## 代码范围

- OAuth token service：加密 exact-response coalescing 与 fail-closed 校验。
- In-memory / PostgreSQL repository：tip、scope、tuple、grace window、replay 与 scrub 原子语义。
- Migration 021：短期 retry 字段、完整性约束与过期索引。
- Cleanup service：过期密文的有界擦除及计数。
- Service、repository、真实 PostgreSQL 3 路并发、HTTP OAuth edge 测试。

## 验收结果

- TypeScript typecheck、build、deployment static validation：PASS。
- 常规 suite：792 PASS。
- required PostgreSQL suite：42 PASS；真实 3 路并发只创建一个 successor token set。
- required HTTP OAuth edge：2 PASS。
- 合计 836/836 PASS。
- Release bundle：148 个白名单文件；Secret 与旧域名扫描均为 0。
- Source archive SHA-256：`e7d4c218895c9d1684998f0fca8ba592a647292ace9f074b2b06a21a7b8e946a`。

## 未完成

公网 `mcp.jiayuanwang.xyz` 尚未部署本修复。标准 SSH 仍在握手阶段被 VPS 关闭，本机 Hetzner CLI 没有 active context。恢复标准运维通道后，按单实例停旧启新发布，再用 Agent2 完成跨 15 分钟的线上 refresh 和 O1/O2/O3 复跑，才能改为 `DEMO_READY`。
