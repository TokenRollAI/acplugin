# 领域术语表

> [English](domain-glossary.md)

| 术语 | 含义 |
| --- | --- |
| 作者 Facade | 工程配置、Project 执行、报告、init 和 Migration 使用的根 `@tokenroll/acplugin` API。 |
| 集成 SDK | 只用于实现 Platform/Extension 的可信 `@tokenroll/acplugin/sdk` 子路径。 |
| Canonical Project | Core 发现并冻结的 Commands、Skills、Agents、Public、可选 Runtime、metadata 和已验证依赖图。 |
| Session | Platform/Extension factory 为一次 build 创建的可变实现状态，由 Core 恰好关闭一次。 |
| SourceRef | 指向精确已验证作者文件/目录的 owner-scoped 引用；它不是物理路径能力。 |
| AssetRef | Core 为当前 Session 签发的 Source、Generated 或 Bytes 输出引用。 |
| Asset | Package 路径到 AssetRef 的映射；报告补充 owner、mode、size、SHA-256 和结构化 origin。 |
| Document | Platform 拥有的结构化 JSON/YAML/TOML/frontmatter 值，由 Core codec 序列化。 |
| Extension point | Platform 显式允许一个 Contribution 填写的精确空 Document 字段路径。 |
| Base Package | `Platform.createPackage()` 返回的不可变 Document、Asset、compatibility 和 metadata disposition。 |
| Platform Contributor | Extension 回调；读取同一份 base Package，并返回独立的 add-only Package Contribution。 |
| Package Contribution | 可选 Document 字段、Asset、subject-bound 不透明 Platform Component 和必需 compatibility；不能替换或删除 base 内容。 |
| Platform Component Contribution | Extension Contributor 提交的、由 Platform 拥有的 JSON payload。它不是 Canonical Component；Core 只传输它，目标 Platform 负责校验、渲染并拥有原生输出。 |
| Merged Package | Core 验证并把 Framework/Extension Contribution 与 base Package 合并后的确定性结果。 |
| Primary Package | 最终可安装 Plugin、workspace 或 npm package，自动继承全部 merged Asset。 |
| Distribution | 只有 primary Package candidate 通过 Platform 校验后才能派生的可选 Package。 |
| Package candidate | Core 在临时根物化并传给 `validatePackage()` 的精确 Package 文件树。 |
| Compatibility | Platform/resource/capability tuple，等级为 `native`、`transform`、`degraded` 或 `unsupported`。 |
| BuildReport | 稳定 schema-v3 结果，包含 Project、Package、Asset provenance、兼容性、metadata、Platform 状态和诊断。 |
| 托管输出 | 针对选中 Platform 集合进行事务整体替换的配置输出根。 |
