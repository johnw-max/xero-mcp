# 加一个 MCP 工具要改哪些地方

用命令数出来的,不是回忆出来的。当前 30 个工具。
主数据维护面要加 2 个(`xero_prepare_reference_change` / `xero_execute_reference_change`),
届时全部变 32,且 `toolsetHash` 会变。

枚举命令:

```
grep -rn "tool_count\|toolCount\|GREEN_TOOL_COUNT\|!== 30\|toBe(30)" src tests scripts deploy docs
grep -rln "toolsetHash\|TOOLSET_HASH" src tests scripts deploy docs
```

## 一、工具清单本身(改这里,数字才会变)

| 位置 | 说明 |
|---|---|
| `src/mcp/toolNames.ts` | `TOOL_ALLOWLIST`,类型 `AccountingToolName` 由它派生 |
| `config/tool-allowlist.json` | `tools` 数组,必须与上面逐字一致 |
| `src/mcp/createServer.ts` | 工具注册 |
| `src/mcp/xeroToolCapabilityContract.ts` | 工具 → 能力绑定 |

## 二、写死了 30 这个数字的地方(不改就红)

| 位置 | 形态 |
|---|---|
| `tests/local-agent-deployment-equivalent.test.ts:141` | `expect(toolContract.tool_count).toBe(30)` |
| `tests/local-agent-deployment-equivalent.test.ts:163` | `expect(contract.tool_count).toBe(30)` |
| `tests/local-agent-deployment-equivalent.test.ts:167` | `backend_tool_count: 30` |
| `scripts/release/smoke-accepted-oci-runtime.mjs:198` | `challengeResult.toolCount !== 30` |
| `scripts/release/smoke-accepted-oci-runtime.mjs:288` | `health.body?.toolCount !== 30` |
| `deploy/scripts/switch-xero-upstream.sh:11` | `readonly GREEN_TOOL_COUNT="30"` |

## 三、自动跟随、不用手改(但会因此变红,要看懂)

- `src/http/app.ts:673` —— `toolCount: TOOL_ALLOWLIST.length`,自动
- `tests/smoke-mcp.mjs` —— 从 `config/tool-allowlist.json` 读,自动
- `tests/current-release-contract.test.ts:65` —— 比对合约与 allowlist,自动
- **`toolsetHash`** —— `hashObject(TOOL_ALLOWLIST)`,加工具必变。
  所有钉住它的产物需要重新生成:`src/xeroRelease.ts`、`tests/xero-build-identity.test.ts`、
  `tests/security-contract.test.ts`、`tests/http-oauth-edge.test.ts`、
  `scripts/verify-accepted-oci-release.mjs`、`scripts/verify-accepted-build-context.mjs`、
  `scripts/release/*`、`deploy/scripts/verify-static.sh`、`docs/CANDIDATE-DEPLOY-RUNBOOK.md`

## 四、查过、确认不用动的

`scripts/agent2_uat_write_gate_vps.sh` 写着 `EXPECTED_TOOL_COUNT="44"`,
`tests/current-release-contract.test.ts:216` 还断言这个 44 必须在。

**这不是缺陷。** `deploy/scripts/verify-static.sh:129` 要求该文件含有
`HISTORICAL 0.3.1 UAT SCRIPT ONLY`——它是被有意冻结的历史产物,那个 44 是
0.3.1 当时的工具数,测试锁的是"它没有被人偷偷改动",不是"生产有 44 个工具"。
加工具时**不要**动它。
