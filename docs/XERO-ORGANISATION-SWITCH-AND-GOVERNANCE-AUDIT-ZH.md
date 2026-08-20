# Xero Organisation 切换与治理审计设计

更新日期：2026 年 8 月 10 日

## 目标

让代理多家公司的会计人员直接在对话中提出“切换公司”，但不允许 Agent 仅凭聊天文本静默改变账套；同时把授权、切换、读取、准备和受控写入统一记录为可迁移、可验证的治理事件。

Xero 仍是正式账本。PostgreSQL 只保存连接控制、短期确认状态、幂等状态和审计证据。

## 用户流程

```text
会计：帮我切到 Company B
  -> Agent 调用 xero_start_organisation_switch
  -> MCP 返回 10 分钟有效的一次性链接
  -> 用户打开 MCP 页面，从已授权 Organisation 中明确选择一家
  -> 同源 POST + CSRF 校验
  -> 服务端原子更新该 MCP installation 的当前 binding
  -> 用户回到对话，Agent 重新读取 connection status 后继续工作
```

若目标公司已经包含在本次 Xero OAuth 授权中，无需重新登录 Xero。只有目标公司不在已授权列表时，才重新走 Xero OAuth。手动断开并重连仍保留为备用路径。

## 当前实现与线上验收

- 已部署版本：0.3.1 build `20260810.1`，公网工具数 44。
- Agent2 已完成 `Demo Company (Global) / USD → zcloak / HKD → Demo Company (Global) / USD` 的往返切换；两次页面确认后都由 Agent 重新调用 `xero_get_organisation` 回读。
- Work 已在独立 OAuth client 下回读 Demo Company，并从自然语言请求调用 `xero_start_organisation_switch` 返回一次性链接；为保持最终 Demo 状态，没有在 Work 确认切走。
- 当前同一开发者测试身份可同时拥有 Agent2 与 Work 的独立 active installation；同一 client 重新授权仍会原子替换旧 grant，避免一个 Host 的授权覆盖另一个 Host。
- 线上账套切换页已经收敛为单卡片授权结构：zCloak AI 品牌位于卡片外，Xero 请求与 Organisation 选择位于卡片内；390×844 视口下无横向或纵向溢出，主按钮无需滚动即可到达。
- 写闸全程关闭，本轮 0 preparation、0 execute、0 Xero 会计写入。

## 关键安全边界

- 一个 MCP installation 在任意时刻只有一个 current Organisation。
- Agent 不能在普通会计工具参数里提交 Tenant ID 或 Organisation ID 来切账套。
- 切换链接使用 32 字节随机值；数据库只保存带用途隔离的 HMAC，不保存原始链接秘密。
- 链接一次性使用，默认 10 分钟有效，最大不超过 15 分钟；切换前后均校验 installation、binding、connection、workspace、subject 和 agent 的完整关系。
- 选择页无外部脚本，使用 `no-store`、`no-referrer`、CSP `default-src 'none'`、`form-action 'self'` 和 `frame-ancestors 'none'`。
- 确认请求必须来自 MCP 自身 origin，并通过独立 CSRF 校验。
- 切换完成后，旧 binding 仍可作为历史 token family 的关系证据保留，但不再能解析为运行时账套；尚未完成的旧账套请求会在后续服务端 binding 校验处失败。
- 已准备但尚未执行的会计提案继续绑定原 installation、binding、connection 和 tenant，切换后不能写入新公司。

## 数据结构

迁移 `022_xero_organisation_switch.sql` 新增：

- `oauth_installation_active_bindings`：每个 installation 的唯一当前 binding 指针及 revision；
- `organisation_switch_sessions`：短期、一次性的切换确认会话，只保存 ticket hash 和精确来源关系。

迁移 `024_allow_binding_history_per_installation.sql` 将早期“一个 installation 永远只能有一条 binding”的唯一约束改为“可以保留多条历史 binding、但只有 active pointer 指向一条当前 binding”。binding/installation/connection 三元组的唯一性仍然保留。

过期切换会话由现有定时清理任务分批删除，不长期保留原始确认能力。

## 治理审计事件

迁移 `023_governance_audit_events.sql` 新增 `governance_audit_events`。事件采用 `zcloak.governance-event.v1`，按 stream 串行追加，并包含前一事件 hash 与当前事件 hash。数据库禁止普通 UPDATE 和 DELETE，用于发现链路缺口或事后改写。

主要字段分为六组：

| 维度 | 记录内容 |
|---|---|
| 身份与范围 | actor、workspace、agent、installation、binding、connection、tenant |
| 行为 | event type、action、source、发生时间 |
| 决策 | disposition、policy、mandate 预留字段 |
| 关联 | correlation、causation、stream |
| 结果 | proposed、succeeded、rejected 或 failed |
| 证据 | 输入/输出 hash、最小化结构化 evidence、前后事件 hash |

当前会记录：

- Xero OAuth 连接及用户选择 Organisation；
- Organisation 切换发起和用户确认完成；
- 每次 MCP 工具的 proposed 与 completed；
- 被策略或校验拒绝的调用；
- 读取、准备和受控写入对应的治理 disposition。

审计事件不保存 OAuth access/refresh token、原始用户材料、完整工具输入输出、Prompt、Chain of Thought 或模型内部推理。业务证据使用 hash、对象标识、策略结果、Provider receipt/read-back 引用等可验证信息表达。

## 与 SAFR 的关系

该设计参考新加坡金融管理局 2026 年发布的 **Safeguards for Agentic Finance at Runtime (SAFR)**：用明确的 Agent 身份、运行时控制、处置结果和可审计日志约束金融 Agent。当前字段可表达 `OBSERVE`、`AUTO_EXECUTE`、`ESCALATE` 和 `DENY` 四类处置，并为 policy、mandate、correlation 和 evidence 保留统一边界。

这属于 **SAFR-oriented readiness**，不能称为完整 SAFR 合规。当前版本仍没有独立 Controls Repository、独立 Disposition Engine、独立 verifier、签名式外部时间戳或审计事件事务 outbox；失败结果的补偿和跨系统一致性需要正式平台继续建设。

参考资料：

- [MAS SAFR 论文](https://www.mas.gov.sg/-/media/mas-media-library/development/fintech/ai-safr/safr.pdf)
- [MAS SAFR 发布页](https://www.mas.gov.sg/publications/monographs-or-information-paper/2026/safeguards-for-agentic-finance-at-runtime)

## ATP 兼容策略

当前工作区和可检索历史中没有找到可作为开发依据的 ATP 正式协议规范，因此本版本不猜测 ATP 字段，也不声称已经实现 ATP。

为降低后续接入成本，事件采用版本化、供应商中立的 envelope，并保留 `schema_version`、`event_type`、`actor`、`mandate_id`、`policy_id`、`correlation_id`、`causation_id`、`disposition`、`outcome` 和 `evidence`。ATP 新版本确定后，应新增独立 mapper/exporter，把治理事件映射到 ATP，而不是修改既有审计记录或把 ATP 私有结构写死在 Xero 业务表中。

## 正式上线前仍需完成

1. 在公司环境继续验证并发切换、append-only、备份恢复和滚动发布；当前隔离 PostgreSQL 17 强制测试已经通过，但不替代生产演练。
2. 将审计完成事件与业务状态通过同一事务 outbox 或等价机制收口，消除“业务已完成但完成事件暂未落库”的窗口。
3. 明确审计留存期限、访问权限、数据主体请求、跨境存储和密钥轮换策略。
4. ATP 正式规范可用后实现版本化 adapter，并用固定 fixtures 做兼容测试。
5. 若要宣称 SAFR aligned/compliant，需由治理、法律、安全和独立验证方依据最终系统及适用监管要求评估。
