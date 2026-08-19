# 独立评审子系统：两项未关闭事项（2026-08-19）

本轮把该子系统的测试失败从 24 个降到 2 个，并修好了其中三个真实缺陷
（见 commit `1b6551f`）。剩下两项都不是"跑一下脚本就能好"的，各自需要一个
决定，记录在此。它们**不影响已发布的 MCP 运行时**。

---

## 一、二进制资源撑破评审分片：`docs/assets/*.png`

**现象**

```
INDEPENDENT_REVIEW_DOCUMENT_GLOBAL_PATH_SEMANTIC_UNIT_CAPACITY_EXCEEDED:
docs/assets/xero-mcp-mvp-zero-architecture-2026-08-17.png:0-1359041
```

失败测试：`tests/independent-review-evidence.test.ts` →
`plans the real current K-013/K-015 tree ...`

**根因**

分片容量上限 `REVIEW_SHARD_ADMISSION_TOKEN_LIMIT = 360_000`，按保守
2 字节/token 折算约 720KB。该 PNG 为 1,359,041 字节，约合 68 万 token，
**接近上限两倍**。非 TypeScript 文件被当作单个不可再分的语义单元，
`partitionDocumentGlobalCoverage` 没有把一个单元继续切小的通路。

**为什么不该靠放宽上限解决**

放宽只会产出一个任何评审者都无法接收的分片。上限本身是对的——
1.36MB 的二进制图片在任何分片大小下都不是可供文本评审的内容。
**闸门是对的，输入不对。**

**两条正当解法（需要决定）**

1. **给评审模型增加"非文本资源"的表示**：这类文件以摘要出现在分片里
   （路径 + sha256 + "二进制资源，按摘要核验"），而不是以字节出现。
   完整性不减，容量归零。代价：要同时改内容物化（`materializeSemanticUnitSelection`）
   与传输分块，"无损发出每个宇宙字节"这条不变式需要重新表述为
   "无损发出每个**可评审**字节 + 每个资源的摘要"。
2. **把二进制资源移出被评审的源集合**：调整 `APPROVED_ACCEPTANCE_SOURCE_ROOTS`
   使 `docs/assets` 不进入评审宇宙。改动小，但改变了"被证明的源"的范围，
   属于治理决定，不该由实现方单方面决定。

本轮试过一个中间做法（二进制不产出可评审单元、路径仍被哈希），
结果触发 `INDEPENDENT_REVIEW_DOCUMENT_PLAN_PATH_COVERAGE_INCOMPLETE`——
路径覆盖要求每条路径都归属某个分片。已撤回，因为"覆盖不完整"比
现在这个明确的失败更糟。

---

## 二、可追溯性artifact 的 40 条 cross-claim 冲突

**现象**

`tests/traceability-validator.test.ts` →
`keeps the current traceability artifact at schema v4 with the exact 18/90 atomic shape`

`artifacts/ledger-kernel-review/round-2026-08-13-local/requirements-traceability.json`
有 40 条 `INDEPENDENT_REVIEW_CROSS_CLAIM_PROBE_FINGERPRINT_REUSED`
（2026-08-18 时为 57 条，已被逐个改下来）。

**根因**

不是探针写错，是**声明映射到了错误的实现文件**，导致多条声明落到同一处、
指纹重用：

- K-013 的 24 条声明里有 21 条钉在 `src/xeroRelease.ts`——一个 178 行、
  只做哈希、不含任何决策逻辑的模块。而这些声明描述的控制
  （Dockerfile 摘要钉定、buildx 构建上下文封存、OCI 校验、切换、就绪门）
  实际住在 `scripts/` 与 `src/http/app.ts`。
- K-015 的声明全部钉在 `traceability-validator-lib.mjs`，
  而该文件只是转发给真正实现逻辑的三个文件。

**为什么没有脚本能修**

`scripts/review/emit-review-obligation-probe.mjs` 只负责**执行并证明**一个
探针，其 `target_path` / `target_anchor` / `literal` / `replacement`
必须由人先选定并写进 JSON。全仓没有任何脚本能机械推导出
"声明 → 真正实现该控制的文件" 这个映射。

**需要的人工步骤**

1. 评审人重新把 K-013 / K-015（以及 K-001、K-007、K-008、K-012、K-016、
   K-017、K-018 中出现在这 40 条里的部分）逐条映射到真正包含该控制的文件；
2. 为每条义务手写互不相同的 `probe_obligations`；
3. 逐条运行 `emit-review-obligation-probe.mjs`；
4. `npm run validate:traceability` 确认归零。

`artifacts/ledger-kernel-review/REVIEW-LEDGER.md` 中对应的
`UAT-001` / K-013 行仍为 `OPEN`，与此一致。
