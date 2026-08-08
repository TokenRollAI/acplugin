# ADR-0002：Extension 贡献顺序等于配置顺序

- 状态：已接受
- 日期：2026-08-08
- 适用范围：lifecycle API v1

## 背景

Platform Adapter 针对同一个可变 Platform Draft 串行运行。`getDocument()` 返回包含前序 Extension patch 的当前文档；`patchDocument()` 与 `emitArtifact()` 则提交带 owner 的新增贡献。

Add-only 与 owner 隔离可以阻止替换和静默 deep merge，但不能使 Adapter 执行天然可交换。Adapter 可以先观察前序贡献，再决定另一个字段的值。同步 owner-conflict 异常也可能被 Adapter 自己捕获，除非 Core 记住该贡献已经被拒绝。

## 决策

1. resolved config 中 `extensions[]` 的顺序就是 Extension 贡献的语义顺序。
2. Adapter 按该顺序串行执行，并可通过 `getDocument()` 观察此前已接受的贡献。
3. lifecycle API v1 不增加 `order`、`enforce`、Extension 依赖图或并行 Adapter；调整配置数组就是显式排序机制。
4. Add-only 与 owner 隔离继续是强制不变量。它们限制每个 Adapter 能改什么，但不承诺产物与执行顺序无关。
5. `patchDocument()` 或 Artifact 贡献一旦被拒绝，即使 Adapter 捕获即时异常，Core 仍必须把当前 Platform 标为无效；最终有效性由 Core 决定。
6. 报告和测试直接描述配置顺序语义。文档不得再以“贡献可交换”为不增加 `order/enforce` 的理由。

## 影响

- 保持当前实现模型与官方 Adapter 兼容。
- 第三方作者只有一套确定、可检查的排序机制。
- 调整 Extension 顺序可能有意改变产物，必须视为配置变化。
- 同一 extension point 冲突会失败，不会退化为 first-writer-wins。
- 未来若要求顺序无关，必须让所有 Adapter 读取同一份 pre-adapter snapshot、缓冲声明式贡献，并由 Core 以顺序无关方式集中合并与报告；这属于新的 lifecycle API 决策。

## 未采用方案

- 宣称 add-only 天然可交换：与 `getDocument()` 及 first-writer owner 事实冲突。
- 增加 `enforce:'pre'|'post'`：引入第二套排序语言，却不能解决数据依赖。
- 按 Extension 名称排序：虽然确定，但会忽略用户配置顺序并改变现有行为。
- 1.0 引入 pre-adapter snapshot：需要缓冲贡献协议，并改变当前 Adapter 可观察内容。

## 证据

- `packages/core/src/contracts.ts:266-283`
- `packages/core/src/documents.ts:198-236,305-325`
- `packages/core/src/lifecycle.ts:543-580`
- 规范 §9.3 与 §9.4
