# 领域术语

以下术语用于区分 ACPlugin 生命周期中相近但不同的结果与顺序规则。

| 术语 | 定义 |
|---|---|
| 构建结果（Build outcome） | 当前调用是否无 error 诊断、无异常地完成全部必需生命周期阶段；由 `BuildResult.success` 表示。 |
| 提交结果（Commit outcome） | 当前调用是否完成托管输出事务；由 `BuildResult.committed` 表示。validate/inspect、提交失败或回滚、从未尝试提交时均为 false。 |
| 清理结果（Cleanup outcome） | 逆初始化顺序执行 `buildEnd` 的结果。lifecycle API v1 不提供独立 boolean：清理失败产生 error 诊断、使构建失败，并回滚仍在进行的提交。 |
| 确定性输入（Deterministic input） | 工程字节、resolved command/mode/config、Platform/Extension 实现与版本、Node major、lockfile，以及生命周期捕获的环境快照。可信可执行代码对自己主动读取的其他机器状态负责。 |
| 稳定输出（Stable output） | 相同确定性输入产生完全相同的 Artifact/报告字节与顺序。稳定输出不得包含 timestamp、绝对/临时路径、随机 ID、Secret 值或 locale-dependent 排序。 |
| 可缓存计算（Cacheable computation） | 具有版本化完整 fingerprint、可序列化结果、已声明依赖闭包和可重放 owner-scoped effects 的计算。Context 只读并不能自动证明任意生命周期 Hook 可缓存。 |
| Extension 贡献顺序 | resolved `extensions[]` 中的顺序。Adapter 按该语义顺序串行执行，并可读取此前已接受的 Document 贡献。 |
| 当前 Draft（Current Draft） | Platform 初始贡献与配置顺序中所有前序已接受 Adapter 贡献合并后的 Platform Draft；`getDocument()` 观察的就是它。 |
| Add-only 贡献 | 只在声明为空的 extension point/path 新增 Document 字段或 Artifact，不替换、删除、移动、追加数组或隐式 deep merge 既有数据。 |
| Owner 冲突 | 两个 owner 声明同一 Document 字段或 Artifact 输出路径。它是 Core 强制失败，Adapter 不能靠捕获异常把它变成 first-writer-wins。 |

1.0 的正式语义见 `llmdoc/architecture/decisions/` 下 ADR-0001 与 ADR-0002。
