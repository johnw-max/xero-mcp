# 本地反偷懒验收机制

状态：`ACTIVE / FAIL CLOSED`

日期：2026-08-13

## 目标和边界

这套机制把“再仔细看一下”变成固定、可重复、可否决的本地工作流。目标是在交给 Agent2、Work、GitHub reviewer 或线上环境以前，主动发现产品覆盖、错误层级、架构写死、账务错误、可靠性旁路和证据假绿。

它只证明本地候选满足已取得的证据。它不能自行关闭 reviewer finding，也不能把 deterministic tests 解释为 Agent2、Work 或生产通过。

## 六轴强制评审

每轮必须分别给出 `PASS`、`FAIL` 或 `NOT_CAPTURED`，禁止用一个总分抵消另一轴的失败。

| 轴 | 必答问题 | 最低证据 | 否决条件 |
|---|---|---|---|
| 1. 产品覆盖与体验 | 是否覆盖真实用户任务、异常和恢复？用户是否需要理解内部 ID/Token？结果与下一步是否可解释？ | 任务地图、golden fixtures、普通会计话术、错误/恢复状态 | 核心任务漏项、错误完成声明、必须靠技术字段才能完成 |
| 2. 会计与业务语义 | 来源、借贷、税、日期、期间、FX、期初、残余项和 exact readback 是否完整？ | 业务 reviewer、正向 golden、金额/税/覆盖 mutation tests | 可能错账、漏账或把未验证行为说成完成 |
| 3. MCP 层级与职责 | 控制是否位于 MCP/provider 边界应负责的层？是否越界自建 ledger、close、tax filing 或把平台变成 Xero adapter？ | 层级图、public tool contract、provider contract、Skill/runtime 对照 | Prompt-only 控制、平台垂类适配、MCP 取代 system of record |
| 4. Bottom-up 架构与通用性 | 修的是 failure domain 还是单句补丁？换 tenant、金额、日期、币种或 fake provider 后还成立吗？是否写死 provider 字段？ | ADR、传递依赖扫描、provider-neutral conformance、版本/迁移策略 | fake provider 需删字段才能通过、复制 kernel、绕过统一 invariant |
| 5. 可靠性与安全 | credential、tenant、authority、permit、并发、超时、crash/restart、重试和 readback 是否 fail closed？ | 负向/故障注入、真实 process kill/restart、PostgreSQL、HTTP、at-most-once write count | 凭据旁路、跨 tenant、重复写、unknown 后自动补写、不可恢复状态 |
| 6. 发布与证据真实性 | 测试的是不是同一 source/artifact？所有必跑项是否原子执行？Agent final answer 是否绑定 provider ID/receipt/readback？ | 闭合 traceability、source fingerprint、逐步日志哈希、release bundle、真实 local Agent chain | OPEN/P1/P0、条件 skip、缺 evidence、source 漂移、用旧 Agent/构建冒充当前候选 |

任何轴出现 P0/P1，Gate L 保持 `NO-GO`。P2 必须有 owner、期限和 residual risk；不能在总结中藏成“后续优化”。

## 固定 Chain

```text
冻结需求与 source fingerprint
  -> 六轴 reviewer 先列反例
  -> 实现最小通用 failure-domain control
  -> 正向 + negative/mutation tests
  -> 原 reviewer 复验
  -> requirements traceability 由独立 raw-replayed reviewer 标为 CLOSED
  -> 真实 current local Agent final-answer/receipt chain
  -> lifecycle process kill/restart evidence
  -> 单一 fail-closed release gate
  -> 六轴最终反向复盘
  -> 仅本地候选完成；等待用户决定是否进入外部动作
```

Implementer 只能标记 `FIXED_PENDING_REVIEW`，不能关闭自己的 finding。`CLOSED` 不再信任手写的 `reviewer_identity`、`evidence_checked` 文本或 verdict JSON：它必须引用一个真实、独立、只读 Codex 子进程的 summary + raw artifacts。机器从 raw JSONL、final verdict 和 invocation 重算 Codex thread/PID identity、固定 prompt、只读 command、CLI executable/version/hash、source fingerprint、review-subject digest、不可由实现者自选的 review universe，以及每项 requirement 的最终决定。

Review universe 至少是 accepted release selection、全部 runtime source、build/release/review tooling、deploy、schemas、migrations 的并集；若仓库根存在可信固定 `HEAD` commit，还自动并入相对该 baseline 的 tracked 与 untracked acceptance-critical 工作树差异。没有可信 baseline 时，直接回退到全部 acceptance-source roots。映射先从全部 requirement 的引用与本地 import dependency closure 自底向上推导；deploy/migration/release 固定归入发布身份审计，review/schema 固定归入验收机制审计。仍未映射的孤立/新增文件按文件大小降序、当前 shard 总字节数最小和 requirement ID 稳定排序，进入不可由实现者选择的全局 cross-cutting shard。这样每个 requirement 的独立 Codex execution 只读一个有界语义/dependency shard，全部 requirement closure 的并集又精确覆盖 universe；显式引用只能增加 binding，不能缩小 universe。新增未引用的 release-critical 文件或修改未引用字节，都会改变 universe/input identity；即使重算 summary、closure、verdict digest，没有对应 shard 新的完整 raw inspection 仍不能通过。

固定 inspection plan 不只返回 path/size/hash：它把当前 requirement shard 的全部实际字节先拆成 content-addressed UTF-8/base64 source chunks，再按最终 JSON 编码后的实际字节数装入不超过 64 KiB 的有界 command batch，并要求 reviewer 把每个 batch 作为独立、严格排序的 command 执行。NUL 等高转义成本文本会自动改用 base64，禁止用“原始字节很小”掩盖输出膨胀。已知 shard 内超出单 batch只会生成更多批次，禁止省略 path/byte、退化成 metadata-only，或让实现者挑文件；单 reviewer execution 又被 1 MiB、128 files、32 batches 的语义容量闸限制，超过即 fail closed，不能继续塞给同一模型假装读完。validator 逐 chunk 重建 shard，并复验全 universe identity；依赖映射同时传递覆盖被审控制的本地依赖和所有层级消费者，任一缺块、乱序、偏移、内容、编码、mapping、baseline identity 或 hash 不一致都拒绝。raw events 还必须包含唯一 invocation nonce、完整 chunks，以及每项 requirement 恰好一个由 reviewer 在读取内容后新提出的 executable mutation probe：固定 helper 先让所选 cited Vitest test 在当前字节上通过，再只在 Vite 内存 transform 中替换一个 implementation literal，并要求同一组测试产生真实 assertion failure；不写工作树，也不接受 literal count、语法/collection 错、skip 或 prose-only counterexample。command、结构化 baseline/mutation receipt、reviewer nonce、当前 source/test bytes 与 invocation nonce全部重放。0 command、额外或偏移 command、无关 `rg`、1-token 空审、无 probe 或伪造 receipt都会被拒绝。final verdict 的 `evidence_checked` 只能是由 receipt 派生、映射到该 requirement 的完整排序 `{path, sha256}` 集合，`adversarial_checks` 只能是对应负向测试的完整 `{test_path, sha256}` 集合，并必须逐项带回实际执行的 `falsification_probe`；自由文本“已检查/已通过”不能关闭 requirement。controller PID/执行 ID 与 Codex reviewer PID/thread 必须不同；任一 raw 文件缺失、摘要被重写、source/universe/证据变化、prompt 放宽或 raw 决定不是 `CLOSED`，closure都失效。

风险台账仍可以记录 `WAIVED`，但本地发布 gate **只接受 raw-replayed 独立 `CLOSED`**，任何 waiver 都不能让 gate 变绿。新 finding 必须回到同一 chain，不能靠补一段文档绕过。

### 独立 reviewer invocation

在 source 冻结且 requirement 已是 `FIXED_PENDING_REVIEW` 后，按分配的 reviewer role 运行独立验收。例如：

```sh
node scripts/review/run-independent-review.mjs \
  --file artifacts/ledger-kernel-review/round-2026-08-13-local/requirements-traceability.json \
  --evidence artifacts/ledger-kernel-review/round-2026-08-13-local/independent-review-k-015.json \
  --requirement K-015
```

`--evidence` 必须显式指定为 traceability 同一 evidence boundary 内、事先不存在的确定路径；generator 拒绝覆盖既有 summary/raw 文件。review 完成后 summary/raw 本身不属于 acceptance source fingerprint，所以不会用“写入证据”制造 source drift，但它们由 closure SHA-256、review-subject/input digests 和 gate raw replay 单独绑定。

generator 固定使用 `codex exec --ephemeral --ignore-user-config --ignore-rules -s read-only --json`，禁用 plugins、apps、memories、browser/computer/image/multi-agent 等旁路，只允许 reviewer 在只读 sandbox 内检查本地仓库。它会保存：

- `CODEX_EVENTS_JSONL`：真实 thread/turn、逐 chunk 暴露不可自选 review universe 全部 bytes 的 inspection receipt、每 requirement 的 fresh falsification probe command/stdout receipt 和最后的 structured Agent message；
- `CODEX_STDERR`；
- `FINAL_VERDICT`：逐 requirement 的 evidence、adversarial checks、fresh falsification probe、rationale、residual risk 和 `CLOSED/REOPEN`；
- `INVOCATION`：前后 source/input fingerprints、固定 prompt/hash、output schema/hash、controller/reviewer PID、Codex path/version/binary hash 和完整 argv。

独立 reviewer 的文字 verdict 不能证明测试真实执行。validator 会从每个 closure 的 `positive_tests` 和 `negative_or_mutation_tests` 生成受限 test plan：只允许 `tests/**/*.test.ts` 或 `src/**/*.test.ts` 交给固定的本地 Vitest runner，或 `harness/**/verify-*.mjs` 交给 `node --test`。在 release gate 的 traceability 步骤中，validator 会用当前字节真实重跑这些测试；非零退出、signal、超时、输出溢出、任何 skip，或把普通 JSON/生产 runner 冒充测试，都会 fail closed。这个 rerun 不能代替 reviewer-originated probe：每个 requirement 还必须另跑一个只读 implementation-source probe，且 probe nonce 与内容不得预先存在于固定 prompt 或 reviewed universe bytes。每次 test 与 probe 运行的 command、path/role/hash、runner/target hash、exit code 和 stdout/stderr/structured receipt 会写入 raw evidence 或 traceability step 的机器 receipt 并由 gate 日志继续哈希。

脚本**不会**修改 traceability status 或 closure。只有 verifier 对上述 raw chain 重放通过后，才可把脚本输出的 execution IDs、digests、reviewed_at 和 review artifact 引用附到对应 closure。一个 reviewer artifact 可以覆盖多个明确列出的 requirement，但 final verdict 必须逐项覆盖并匹配各自被分配的 reviewer role。

本地 raw evidence 能防止误填字符串、过期证据和普通自证旁路，但不是远程签名或人类身份认证；它不代表 Agent2、Work、线上或外部 reviewer 已通过。这个边界不能被 summary 中的 `PASS/CLOSED` 扩大。

## 机器追踪合同

追踪文件必须符合 [`schemas/requirements-traceability.schema.json`](../schemas/requirements-traceability.schema.json)，每项要求都必须包含：

- `requirement_id`
- `business_risk`
- `design_control`
- `implementation_files`
- `positive_tests`
- `negative_or_mutation_tests`
- `implementation_owner`
- `reviewer`
- `status`
- `evidence`
- `residual_risk`

`CLOSED` 还必须包含 `implementation_execution_id`、从 raw thread/PID 派生的 `reviewer_execution_id`、`reviewer_role`、`reviewed_at`、`source_fingerprint`、`review_subject_sha256`、`review_inputs_sha256`、`review_artifact` 和实际文件的 `review_artifact_sha256`。这些字段只是索引；最终权威是 validator 对 raw invocation 的重放结果。

校验命令：

```sh
npm run validate:traceability
```

正式本地 release gate 只接受能从独立 Codex raw invocation 重放成功的 `CLOSED`；`WAIVED` 只可留在风险台账，不能通过 gate。正向和负向测试列表完全相同也会拒绝，以防形式化填表。

## 单一 fail-closed 命令

```sh
TEST_DATABASE_URL='postgresql://.../xero_mcp_test_<isolated>' \
  npm run release:local:gate
```

命令顺序不可选择性跳过：

1. raw-replayed independent-review closed traceability；
2. current local Agent final answer、provider ID、mutation receipt、exact readback receipt 机器关联证据；
3. 四个 lifecycle 窗口的真实 process kill/restart 证据；
4. typecheck；
5. build；
6. full regression；
7. 隔离 PostgreSQL required suite；
8. HTTP loopback required suite；
9. static verification；
10. `git diff --check`；
11. deterministic release bundle build 与 verify。

前 3 项会全部检查并列出 blocker；任一不通过，后续命令不运行。第 4 项以后任一失败立即停止。数据库名不是 `xero_mcp_test` 或 `xero_mcp_test_*` 会在开始前拒绝。第 1 项不会只读取 closure summary：它会重放每个 closure 的独立 Codex raw chain，并真实重跑 closure 声明的正向/负向测试；当前 source、review subject、被引用 evidence 或 test runner 任一变化都会判定 stale。

默认还要求以下文件存在并通过机器校验：

- `artifacts/ledger-kernel-review/round-2026-08-13-local/local-agent-run.json`
- `artifacts/ledger-kernel-review/round-2026-08-13-local/process-crash-restart.json`

当前没有这两个文件就必须记录为 `NOT_CAPTURED`，不能用 synthetic runner、fake Agent answer、service fault injection 或 PostgreSQL cross-instance test 冒充。Gate 不信任 generator 写下的 `PASS` 摘要：它会从原始 Codex JSONL、server audit、provider receipt/readback、PostgreSQL durable snapshot、父进程 kill 记录和子进程退出 signal 独立重放并重新计算 tool 顺序、authority 输入、evidence chain、runtime attestation、PID、SIGKILL、GET-only recovery 与 provider create 次数。

Gate 不再直接在可变工作树里跑命令。开始时它在文件系统变更监测已启动的前提下，逐字节捕获全部 acceptance source，验证捕获前后内容 fingerprint 与不可伪造回写的 inode/ctime/mtime mutation guard 一致，再把 source、`node_modules` 和 Git metadata 复制（禁止链接回原树）到以 source SHA-256 命名的临时目录；source、dependency 和 Git metadata 随后改成只读。`typecheck/build/full regression/PostgreSQL/HTTP/static/git diff/release bundle` 的 `cwd` 都是这个 digest-named snapshot。每一步后同时重算 snapshot 和原工作树的内容 fingerprint 与 mutation guard；因此原树或 snapshot 即便从 A 改成 B 又恢复成 A，也会因 ctime/inode journal 漂移 fail closed。文件系统 watcher 是额外的即时信号；watcher 资源不可用时，mutation guard 仍为必选控制而不是降级成仅比较首尾内容 hash。

唯一保留原仓库绝对路径的是第一项 independent-review traceability replay：既有 raw Codex invocation 已把当时真实的 `-C <repo>` 身份纳入 hash chain，换成临时 snapshot 路径会破坏而不是加强原始证据。该 precondition 仍只允许读取与受限 test replay，并且执行前已捕获同字节 snapshot，执行后立即受原树内容 fingerprint、inode/ctime/mtime guard 和 watcher 否决；一旦原树在 replay 中发生修改，即使恢复原内容，后续任何测试都不会运行。local Agent/process-crash summary 则从外部 evidence boundary 读取 hash-bound raw files，但 generator 与所引用实现按 snapshot 字节复验。

输出写入 `artifacts/local-acceptance/<timestamp>/`：`source-snapshot.manifest.json` 保存每个被捕获文件的 path/mode/size/SHA-256，且自身 SHA-256 写入 `gate-result.json`；每个步骤保存经过数据库 URL 精确脱敏的 stdout/stderr、SHA-256、退出码、时间和命令。release builder 在 snapshot 内自行重算 acceptance source identity 并写入 bundle manifest，verifier 再从同一个 snapshot 重算，并逐文件对比 release selection、mode、size、SHA-256 和 archive；禁止把 gate 开始时的 hash 事后贴到由混合工作树生成的 archive。任一内容、metadata journal、snapshot 或 release source identity 漂移时，最终状态强制为 `FAIL/source-stability` 或 `FAIL/release-artifact-identity`。

即便命令最终 `PASS`，`gate-result.json` 仍写明 `gate_l_claim=NOT_IMPLIED`。只有六轴 reviewer 全部结论、原 reviewer closure 和缺失的业务证据都齐全，才能单独判定 Gate L。

## 外部动作边界

默认只允许本地读取、修改、构建和隔离测试。以下动作必须等用户明确指令，不能由本地 gate 自动触发：

- Git commit、push、PR 或合并；
- 飞书文档创建或更新；
- test/staging/production 部署、切流或打开真实写闸；
- Agent2、Work 或真实 Xero 写入验收。

用户批准其中一项不自动授权其他项。特别是“本地通过”不等于可以 push，也不等于可以部署。

## 每轮最终反向复盘

在向用户汇报前，至少再回答：

1. 哪项结论只是 source-code evidence，哪项是实际运行，哪项仍 `NOT_CAPTURED/NOT_RUN`？
2. 有没有只测 adapter mutation、却漏测 client 初始化、凭据解密、OAuth refresh 或其他更早副作用？
3. 有没有通过缩小扫描目录、删字段或 mock callback 得到的假绿？
4. capability 文档、部署授权、public tool、compiler/native route 是否指向同一事实？
5. 修复是否改变 failure domain 的 invariant，而不是只拦一个输入句式？
6. 是否把 MCP 应负责的控制放到了 Skill，或把 system of record/会计师职责搬进 MCP？
7. source、test logs、release bundle 和待验收 runtime 能否由同一 fingerprint/digest 串起来？
8. 把所有刚修的代码再当成不可信输入时，还能构造什么反例？

只要答案中出现无法证明的关键项，就保持 `NO-GO` 并把它登记为 requirement/finding，而不是等外部 reviewer 再发现。
