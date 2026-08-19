# 真实 Xero 响应捕获

这些不是手写的样例,是从真实 Xero Accounting API 抓下来的响应原文。

## 为什么需要它

本仓库的测试替身长期是**回声式**的:你发什么,它回什么。这模拟的是一个永远同意
我们的提供方,而那恰恰是唯一不需要防备的提供方。五个生产缺陷都出自这道缝:

- Xero 对**每一个**联系人都返回 4 个空电话块和 2 个空地址块,不管你有没有传;
- 某些查询会整体丢掉分页信封;
- 一部分字段回的是 `Date` 对象,而同一份载荷里其他日期是日历字符串。

最后一条 JSON 装不下——`JSON.stringify` 会把 `Date` 变成字符串,于是纯 JSON 夹具
**恰好丢掉**导致该缺陷的那个区别。所以这里有两样东西:响应原文,以及
`runtime-types.json`,记录捕获时每个叶子节点的真实运行时类型。

## 怎么用

```ts
import { loadXeroResponse } from "./fixtures/xero-provider-responses/index.js";

const body = loadXeroResponse("contact_single"); // Date 字段已还原为 Date 对象
```

不要直接 `JSON.parse` 这些文件——那样会退回成字符串,夹具就白抓了。

`capturedDateFields(name)` 与 `capturedEmptyArrayFields(name)` 返回真实 API
在该响应里给出 `Date` 和空数组的字段路径,可用于断言映射层覆盖了全部这些字段。

## 来源与脱敏

- 租户:`Demo Company (Global)`(Xero 面向所有开发者发放的公共演示账套),USD
- 捕获时间:2026-08-19
- 捕获方式:线上候选 `072-readback-773eac7d` 容器内,经 `XeroClientManager`
  以只读 scope 调用 `accountingApi`,与生产读路径完全相同
- **脱敏**:`bankAccountNumber` 的值已替换为等长的 `9`。演示账套的账号并非真实
  账户,但本仓库远端公开,而这些数值对"形状保真"这个用途没有任何贡献。
  其余字段一律原样保留,包括空字符串、空数组和默认块——**它们正是重点**。

## 重新捕获

演示账套的内容会随写入变化。需要刷新时,在能连到线上候选的机器上,用与本目录
生成时相同的方式导出:调用一次 `getContacts` / `getInvoices` / `getOrganisations` /
`getAccounts` / `getTaxRates` / `getItems` / `getCreditNotes`,以及一次**必然为空**的
联系人过滤查询(空结果的信封形状与非空不同,这条不能省)。同时导出运行时类型清单:
遍历响应,对每个叶子记录 `Array.isArray` / `instanceof Date` / `typeof`,空数组记为
`array(empty)`。然后按上面的脱敏规则处理再提交。

捕获后请核对 `capturedDateFields` 的输出是否变化——多出来的 `Date` 字段意味着有新的
一类映射需要检查。
