# Xero MCP 0.4.0-rc.1 本地候选：多公司会话隔离

> **候选快照已被后续 28-tool Accounting Case cutover 取代。** 本文中的 45-tool
> 数字是 2026-08-12 target-session 阶段的真实本地证据，故保留不改；它不代表当前
> 0.4.0-rc.1 发布面，也不能替代新的 Case contract/static/PG 复验。

日期：2026-08-12  
状态：**LOCAL RC / NOT COMMITTED / NOT PUSHED / NOT DEPLOYED**

## 结论

本地候选版已把 Xero MCP 从“每个 installation 只有一个会随切换改变的当前公司”，升级为“Agent 可为每个会计对话持有一个短效、不可变的公司目标”。MCP 当前并未获得可信 `conversation_id`，因此这是短效 capability 隔离，不是服务端会话身份绑定。

这样，同一位会计可以同时打开两个对话：会话 A 固定处理 Company A，会话 B 固定处理 Company B。B 切换公司不会改变 A 后续的读取、prepare、确认、受控写入或精确回读目标。

本轮没有修改 Work、分享页面、资料同步 MCP 或 QuickBooks MCP，也没有向 GitHub 或服务器推送任何内容。

## 使用流程

1. 新对话先调用 `xero_pin_current_organisation`。
2. MCP 返回一个 30 分钟有效的 `target_session_ref`，同时返回公司名称、安全引用、binding revision 和到期时间。
3. Agent 把该引用传给本次对话后续的每一个 Xero ledger 工具。
4. MCP 服务端把它解析成固定的 installation、binding、connection、Organisation 和 revision；Prompt 中填写的 Tenant ID 不参与路由。
5. 用户需要换公司时，Agent 把当前 `target_session_ref` 传给 `xero_start_organisation_switch`，由 MCP 返回短效网页链接。
6. 用户在页面明确选择后，MCP 只撤销发起切换的 target；其他并发对话的 target 不变。Agent 必须重新 pin，再继续工作。

正式部署配置建议：

```env
XERO_TARGET_SESSION_REQUIRED=true
XERO_TARGET_SESSION_TTL_SECONDS=1800
```

兼容模式仍可临时设为 `false`，但不能作为多人、多客户生产隔离的验收状态。

## 本轮完成的控制

- 新增第 45 个 MCP 工具 `xero_pin_current_organisation`；
- 原始 target capability 只返回给 MCP 客户端，数据库仅保存 HMAC；
- 目标能力只能由原 OAuth installation、workspace、subject 和 Agent 使用；
- 目标过期、被切换流程撤销、跨 installation、格式错误或 strict 模式缺失时 fail closed；
- 读取、prepare、确认、受控写入和 Provider 精确回读统一使用同一目标；
- prepare 保存 binding revision 和内部 target id；旧 preparation 只能由原未撤销 target 执行，切换撤销该 target 后立即失效；
- Agent-visible evidence 与持久审计不回显原始 `target_session_ref`；
- pin、读取与写入审计共用同一 target 安全引用算法，并记录 binding revision、到期时间和 hash 链；
- 过期 target 进入现有 bounded ephemeral cleanup；
- PostgreSQL migration `025_xero_ledger_target_sessions.sql` 使用独立表、FK、TTL 约束和清理索引；
- 工具 allowlist、policy mapping、release version、health/tool count、合同 harness 和部署配置同步到 `0.4.0-rc.1 / 45 tools`。

## 本地验收结果

| 检查 | 结果 |
|---|---|
| TypeScript typecheck | PASS |
| Production build | PASS |
| 完整 Vitest 回归 | 73 files PASS；785 tests PASS；54 条环境条件测试 SKIPPED |
| MCP 兼容面合同 harness | 40/40 PASS；Provider write attempts = 0；该 harness 不代表 strict target 流程 |
| Strict target MCP 回归 | PASS；pin → 读取安全引用一致，原始 ref 不进入业务审计/evidence；切换必须携带 ref |
| A/B 本地隔离 | PASS；发起切换的 A target 被撤销，另一个 A target 与 B target 均保持准确；尚非真实 Provider 20 次读取 |
| 跨 installation / 缺失 / 错误 / 过期 target | 全部拒绝 |
| 受控写入目标 | PASS；使用 pinned target，不追随可变兼容指针 |
| 原始 target capability 泄漏检查 | PASS；业务审计和 read-evidence 中均不存在 |
| 本地 source release bundle | build + verify PASS；131 files；0 secret / legacy-domain / forbidden-path findings |
| PostgreSQL 真实集成 | 测试已编写，当前机器没有 `TEST_DATABASE_URL`，因此尚未执行 |

通过合同证据：`artifacts/harness-runs/2026-08-12T12-17-43.653Z/`。

## 当前仍未关闭的边界

1. **本轮不是上线批准。** 新 migration 必须先在隔离 PostgreSQL 17 环境执行新增集成测试，再进入部署评审。
2. **Host 仍未提供可信 `conversation_id / actor_type / authz_revision`。** 当前通过“每个对话持有独立短效 capability”实现无需上游改造的隔离，但还不能证明正式案件级授权或外部访客角色策略。
3. **MCP 不能区分同一 user + Agent 下的不同会话。** opaque ref 若被复制到另一对话，服务端会把它视为同一授权主体；正式案件级授权仍需上游提供可信 conversation / case / authz revision。
4. **切换页仍会更新 installation 的兼容指针。** 发起切换的 target 会被撤销，其他已 pin 对话不受影响；但并发切换造成兼容指针已变化时，票据会 fail closed，而不是自动猜测目标。
5. **Provider-neutral Ledger Contract 尚未在运行时完成。** 当前实现仍是 Xero 工具名与 Xero evidence；与 QuickBooks 的公共 capability/envelope 仍需独立合同与一致性测试。
6. **真实 Work / Agent2 未更新。** 上线前需同步 Agent 指令：新会话先 pin、切换后重新 pin、每次 ledger 调用携带同一 ref。
7. 外部客户资料收集会话不应配置 Ledger MCP；正式共享场景还需 Host 侧工具可见性和 Ledger 侧 actor-type fail-closed 双重控制。

## 晋级门槛

只有以下项目全部通过，才可以从 local RC 进入部署候选：

- PostgreSQL 025 migration 和新增并发集成测试通过；
- Agent 在真实 Host 中能自动执行 pin → Organisation 校验 → 连续业务调用；
- 20 次 A/B 交叉读取及至少一条 prepare-only 流程零串账；
- target 过期后的重新 pin 体验可理解；
- 确认线上仍保持写闸关闭，除非另行批准受控写入 UAT；
- 完成代码标准审查与产品需求审查，且没有 P0/P1 未解决项。
