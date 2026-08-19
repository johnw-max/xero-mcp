# 字段级失配上报:实施方案

## 问题

回读失配时,agent 拿到的信息不足以自我纠正。

| 校验器 | 现在给出的 |
|---|---|
| `verifyContactReadback` | `target.name` / `target.phones` —— 字段级 ✅ |
| `verifyItemReadback` | 只有 `"target"` |
| `verifyCreditNoteDraftReadback` | 只有 `"CANONICAL_PAYLOAD_MISMATCH"` |
| `verifyManualJournalDraftReadback` | 同上 |
| `verifyQuoteDraftReadback` | 同上 |
| `verifyPurchaseOrderDraftReadback` | 同上 |

而服务层抛出的错误里,`details` 只有 `{ outcome, xeroObjectId }`——**连桶名都没有**。

**这个坑上一层已经踩过并修过。** commit `de6610a` 给失败信封加了 `mismatch_fields`,
原因是不透明的 `ACCOUNTING_CASE_PREPARATION_PAYLOAD_MISMATCH` 让 agent
**把账单挂到了错误的供应商名下**。provider 层的同一个坑至今开着,而且开在
6 种可写对象里的 4 种上。

## 关键发现:信息本来就在手里

草稿校验器失配时**已经返回了两份 canonical payload**:

```ts
return {
  ok: false,
  reasons,
  ...(reasons.includes("CANONICAL_PAYLOAD_MISMATCH") ? {
    snapshot: mapped.snapshot,
    readbackCanonicalPayload: mapped.snapshot.canonicalPayload,
  } : {}),
};
```

期望值(`expected`)也在同一个函数的入参里。**没人去算这两者的差异**,仅此而已。
所以这不是"要采集新信息",是"把已有信息算出来并透出"。

## 实施

### 1. 一个共享的差异计算器

新建 `src/providers/canonicalPayloadDiff.ts`:

```ts
export function canonicalPayloadMismatchFields(
  expected: unknown,
  actual: unknown,
): readonly string[]
```

- 返回**点号路径**(`lines[0].accountCode`、`total`),按字典序、去重、上限 32 条
- 数组按下标比对;长度不同时报数组本身的路径,不逐个展开
- **只返回字段名,绝不返回值**

最后一条是硬约束,不是风格问题:失败信封的全部意义就是**永不泄露提供方内容**。
差异计算器如果回传值,等于从这里凿了个洞。

不要写五份。五份重复正是本仓库反复出问题的病根——六个日期解析器、
十四处动作枚举,都是这么来的。

### 2. 接入五个校验器

四个草稿校验器在 `reasons.push("CANONICAL_PAYLOAD_MISMATCH")` 处附带
`mismatchFields`;`verifyItemReadback` 把裸 `"target"` 换成
`target.${field}` 形式,与 `verifyContactReadback` 对齐(那个已经是对的,照抄它)。

### 3. 接入两个服务层

- `xeroCreditNoteManualJournalService.ts` 的两处抛错
- `xeroControlledMutationService.ts` 的对应处

加进 `details.mismatchFields`——**必须是这个键名**。失败信封投影的就是
`safe.details?.mismatchFields`(`xeroFailureEnvelope.ts:212`),
今天早些时候统一过一次键名,联系人那条路径当时用的是 `mismatches`,
于是诊断信息算出来了却从未透出去过。别再造第三个名字。

### 4. 测试

用 `tests/fixtures/xero-provider-responses/` 的真实响应构造失配,
断言**报出的是哪个字段**,而不只是"失配了"。每个测试带 `// proves:` 注释。

## 验收

- `npx tsc --noEmit -p tsconfig.json` 干净
- 五个校验器各有一个测试证明它报出了确切字段
- 一个测试证明**值不会出现在信封里**(照抄
  `xeroFailureEnvelope.test.ts` 里 `not.toContain("SECRET-LEAK")` 的写法)
- 全量套件不新增失败

## 文件占用

`src/providers/{xeroCreditNoteManualJournalDraft,xeroQuotePurchaseOrderDraft,xeroContactItemMapper}.ts`、
`src/services/{xeroCreditNoteManualJournalService,xeroControlledMutationService}.ts`、
以及对应的 `tests/xero-*-primitives.test.ts`。

**最后一项与夹具接入那一路冲突,必须等它交付后再动。**
