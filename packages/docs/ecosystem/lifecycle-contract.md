# Lifecycle 契约

Core 是唯一阶段调度者：

```text
configResolved → buildStart → Extension.discover → Scanner
→ Extension.validate → Extension.build → Platform.prepare
→ Adapter.apply → Platform.generateBundle → Platform.validateBundle
→ generateDistributions → compatibility → transaction → buildEnd
```

## 顺序规则

- Platform 与 Extension 按配置中的稳定顺序初始化。
- Adapter 只在 Extension 和目标 Platform API version 同时匹配时应用。
- `buildEnd` 对已经初始化的参与者按逆序调用，成功和失败都会执行。
- 一个 Extension 不能访问另一个 Extension 的 discovered、validated 或 built state。

因此第三方实现不能依赖“某个扩展先覆盖另一个扩展”。同一 add-only 字段或 Artifact path 的竞争是错误；不同扩展点的结果在内容上可独立，但诊断和 lifecycle 调用仍遵守配置顺序。

## Context 边界

Context 只公开当前阶段需要的只读 project、稳定 config snapshot、独占 workDir、诊断/兼容性出口和受控注册方法。不要保存 Context 跨 build 使用，也不要根据临时绝对路径生成内容。

API version 当前是 `1`。版本不匹配在配置或 Adapter 选择阶段失败，不提供 shape fallback。
