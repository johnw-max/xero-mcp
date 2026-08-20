# 网关契约改造实现规格

依据 ADR-002。目标：把会计判断移出 MCP，保留全部不变量执行。

## 现有管线（改造前）

```
public input: accounting_category + tax_class + effective_tax_rate_percent
  -> xeroSingaporeAccountingPolicy: taxClass + counterpartyRole -> taxSemantics
                                    校验税率 == SG 法定税率
  -> xeroAccountingCaseProviderContract: category -> account（查 CoA profile）
                                         taxSemantics -> taxType（写死映射表）
  -> xeroTaxRateResolver: taxType 在账套税率表中核验
```

## 目标管线（改造后）

```
public input: account_code + tax_type（Xero 原生值，逐行显式）
  -> xeroDeclaredLedgerPolicy: 透传声明值；effectiveTaxRateBps 取自账套实际税率
  -> providerContract: account_code -> account（查账套实时 CoA）
                       taxType 恒等透传
  -> xeroTaxRateResolver: 仅保留核验（存在/ACTIVE/税率相符/适用性）
```

内核 `AccountingPolicyEnforcementContract` 接口形状**不变**，只换实现。

## 逐文件改动

### 1. `src/domain/accountingCaseSchemas.ts` + `src/mcp/xeroAccountingCaseBusinessIntake.ts`

行级新增（必填）：
- `account_code`: `/^[A-Za-z0-9][A-Za-z0-9._-]{0,9}$/`
- `tax_type`: `/^[A-Za-z0-9_]{1,50}$/`（Xero 原生税码字符串）

删除：`accounting_category`、`tax_class`、`effective_tax_rate_percent`、
`line_accounting_mode` 的 `DOCUMENT_DEFAULT_FOR_ALL_LINES` 变体（改为逐行必填后
文档级默认失去意义；保留 `PER_LINE` 语义即可，或直接移除该字段）。

保留：`declared_net`/`declared_tax`/`declared_gross`、日期、币种、contact、
`document_validity`、`transition_review_required`（改为可选的纯记录字段，不参与判定）。

工具描述中删除全部辖区与类目词汇。

### 2. 新增 `src/policy/xeroDeclaredLedgerPolicy.ts`（替代 SG 政策在写路径的位置）

实现 `AccountingPolicyEnforcementContract`：

- `policyId`: `"xero-declared-ledger"`，`policyVersion`: `"v1"`
- `jurisdiction`: 取账套 `countryCode`（信息性，不再用于选择）
- `monetaryRule(currency)`: 从 `LEDGER_CURRENCY_MINOR_UNITS` 取小数位，
  `roundingMode: "HALF_UP"`，`taxAggregation: "PER_LINE"`。
  **这是币种/provider 机制，不是辖区政策，必须保留。**
- `evaluateNativeDocument`: 对每行
  - 声明的 `account_code` 必须在注入的实时 CoA 中存在且 `ACTIVE` 且可入账
    → 否则 `DECLARED_ACCOUNT_NOT_FOUND` / `DECLARED_ACCOUNT_NOT_POSTABLE`
  - 声明的 `tax_type` 必须在注入的实时税率表中存在且 `ACTIVE`
    → 否则 `DECLARED_TAX_TYPE_NOT_FOUND`
  - `effectiveTaxRateBps` = **账套该税码的实际税率**（不是调用方声明的）
  - `taxSemantics` = 声明的 `tax_type`（恒等）
  - `accountingCategory` 字段填 `account_code`，`taxClass` 字段填 `tax_type`
    （内核视其为不透明字符串；新实现的文档注释必须说明这一点）
- `validatePrepayment` / `validateEmployeeExpense`: 保持现有结构性校验，
  去掉辖区相关判断

`src/policy/xeroSingaporeAccountingPolicy.ts` 从写路径移除。其**币种小数位表**
迁入新的 `src/policy/ledgerCurrencyUnits.ts`。文件本身可保留供参考，但不得被
`src/services/` 或 `src/mcp/` 引用。

### 3. `src/policy/xeroAccountingCaseProviderContract.ts`

- 删除 `XERO_TAX_TYPE_BY_SEMANTICS` 映射表与 `xeroTaxSemanticsForTaxType` 的
  反向查表逻辑；taxType 直接取 `taxSemantics`
- 科目解析：从 CoA profile 绑定改为查注入的实时 CoA（按 `account_code` 命中，
  取其 `accountId`/`code`/`type`/`class`）

### 4. `src/policy/xeroTaxRateResolver.ts`

删除 `STABLE_TAX_POLICIES` 白名单与「税种必须在政策表中」的判定。保留：

- 该 taxType 在账套税率表中恰好命中一个 `ACTIVE` 记录
- 声明税额 == `round(净额 × 该税率, 币种最小单位)` —— 由编译器算术承担
- **方向与科目适用性改用 Xero 税率自带属性**（`CanApplyToRevenue` /
  `CanApplyToExpenses` / `CanApplyToAssets` / `CanApplyToLiabilities` /
  `CanApplyToEquity`），而不是我方政策表
- 保留「显示名不参与语义选择」的原则

### 5. `src/services/xeroAccountingCaseService.ts`

- **删除 prepare 开头的 `country !== "SG"` 硬闸**
- `taxJurisdiction` 改为取账套 `countryCode`（信息性）
- 注入实时 CoA 与税率表到政策与 provider contract（这两个读取已存在，
  现用于其它校验，复用即可）
- `createXeroSingaporeAccountingPolicy` 换成 `createXeroDeclaredLedgerPolicy`
- CoA profile 不再是必需输入

### 6. `src/config.ts`

- `XERO_TENANT_COA_PROFILES_JSON` 不再是开写闸的硬前提（删除 §716-726 的
  `missing active write tenant profiles` 校验）
- 保留变量本身以免破坏现有部署

### 7. `src/control-kernel/accountingCaseCompiler.ts`

- 保留 `target.taxJurisdiction !== policy.jurisdiction` 检查（现在两边都取自
  账套，恒等成立，作为一致性断言保留）
- 其余不动

## 必须逐字节保持不变的部分

两阶段流程、case 版本与 plan hash 不可变、幂等键身份、业务坐标预留、
一次性 permit、回执 + 零容差精确回读、崩溃恢复、错误信封分型、审计、
source-case 绑定、全部读工具。**这些是产品核心资产，一行不动。**

## 测试处置

引用了被删词汇的测试（约 15 个文件）改为显式值输入。**不得**为了让测试通过而
放宽任何核验。新增测试：

- 声明科目不存在 → 拒绝，零写入
- 声明税码不存在 → 拒绝，零写入
- 声明税额 ≠ 净额 × 账套实际税率 → 拒绝，零写入
- 税码对该科目类别不适用（按 Xero 属性）→ 拒绝，零写入
- 非 SG 账套 + 合法声明值 → **成功**（证明辖区解耦）
- 现有 SG 场景以显式值提交 → 与改造前逐字段等价

harness 的 `run-p0-accounting-case.ts` 与六场景金额矩阵同步改为显式值。
