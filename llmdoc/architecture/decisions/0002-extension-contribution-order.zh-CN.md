# ADR-0002：Extension Contribution 无序并由 Core 集中合并

- 状态：已接受
- 日期：2026-08-08
- 更新：2026-08-14
- 适用范围：Kernel v2、lifecycle API v1

## 背景

Extension 只构建一次与 Platform 无关的不可变状态，并可为每个支持的平台提供一个 `PlatformContributor`。如果 Contributor 修改共享 Package 或观察前序 Contribution，配置顺序就会成为隐式依赖，冲突也会退化为 first-writer-wins。

Kernel v2 需要的是相互独立的集成、可并行收集和确定性冲突。

## 决策

1. Platform 创建一份冻结的 base Package；所有匹配的 Framework/Extension Contributor 都读取同一个 base snapshot。
2. Contributor 不能观察其他 Contribution、其他 Extension state 或可变 Package。
3. Core 并发收集 Extension Contribution，为每条贡献绑定 owner，按稳定 owner 身份排序，再执行一次集中式 add-only merge。
4. Contribution 只能填写已声明且为空的 Document extension point、追加 owner 已授权的 Asset，并报告兼容性；不能替换或删除 base 内容、写入未声明字段、接管 Component 或覆盖其他 owner。
5. 重复 Document 字段、Asset 路径、兼容性 tuple，以及大小写/Unicode 归一化等价路径都会确定性失败。配置顺序不是冲突解决机制。
6. lifecycle API v1 不增加 `order`、`enforce`、Extension 依赖图、跨 Extension state 访问或 claim/suppress 协议。

## 影响

- 调整相互独立的 Extension 顺序不会改变成功 Package 的字节。
- Contributor 可以并发收集而不改变语义。
- 冲突是显式架构错误，不会产生依赖顺序的输出。
- 真正需要协作的能力必须进入共享 Framework contract 或 Platform extension point，不能隐藏在 Extension 顺序中。

## 未采用方案

- 按配置顺序串行修改：会产生未声明依赖图和可观察的部分状态。
- `enforce: 'pre' | 'post'`：增加排序词汇，却没有定义安全的数据依赖。
- last-writer-wins：破坏 owner 隔离，并掩盖互不兼容的集成。
- 直接替换 Platform 或 suppress Component：把权限模型扩张到 additive integration 之外。

## 证据

- `packages/core/src/resources/extension-provider.ts`
- `packages/core/src/package/package-registry.ts`
- `packages/core/src/kernel/build-session.ts`
- `packages/core/src/kernel-types.ts`（`PlatformContributor`、`ContributionContext`、`PackageContribution`）
