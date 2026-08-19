# Lifecycle 契约

Core 是唯一阶段调度者，CLI、`runProject()`、`Project.run()` 与 `Project.dev()` 都只调用这条 Kernel v2 路径：

```text
config load/resolve
→ Platform/Extension Session setup
→ canonical/Public/Runtime/Extension discovery
→ CanonicalProject assembly
→ Component/Extension validation
→ Extension/Core Runtime compilation
→ Platform.createPackage
→ Framework/Extension Contributor collection
→ Core add-only merge
→ Platform.finalizePackage
→ primary candidate materialize/validate
→ Distribution create/validate
→ compatibility/metadata finalization
→ aggregate materialization validation
→ managed transaction
→ reverse Session close
```

## 隔离与顺序

- Platform/Extension 按配置顺序 setup；已经初始化的 Session 始终按逆序恰好关闭一次。
- 各 Extension 的 discover/validate/build state 被复制、冻结并按 owner 隔离，不能跨 Extension 读取。
- 所有 Contributor 读取同一份 Platform base Package，可以并发执行；Contribution 集中合并且不以配置顺序决定结果。
- 一个 Platform 的 Package pipeline 失败不抑制其他独立 Platform；工程级错误才阻止全部 Package 消费。
- `close()` 只收到成功/失败/中止、`committed` 和首个脱敏失败摘要。

## Context 与 capability

Context 只公开当前阶段需要的只读数据和 owner-scoped capability。SourceRef、AssetRef、workDir、Package candidate 都依赖当前 Session 对象身份，不能伪造、跨 owner 使用或保存到后续 Session。

生命周期 API version 保持 `1`。版本不匹配在 setup/Contributor 规划阶段失败，不提供 shape fallback 或旧 API 兼容层。
