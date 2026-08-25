# 系统架构

> [English](system.md)

## 产品边界

ACPlugin 是基于 Rolldown 的 AI Plugin 框架和 CLI。它既负责初始化工程，也作为持续使用的构建系统留在项目中，统一完成校验、开发监听、打包、兼容性报告和托管输出更新。

公开 package 刻意分层：

- `@tokenroll/acplugin` 是作者 facade、CLI、Project API、报告 API、init 和隔离 Migration 入口；
- 六个 `@tokenroll/acplugin-platform-*` package 拥有目标平台 Package 格式；
- `@tokenroll/acplugin-extension-hooks` 与 `@tokenroll/acplugin-extension-mcp` 拥有可选横向作者格式；
- `@acplugin/core` 保持私有，并由主包 bundle。

配置作者从 `@tokenroll/acplugin` 导入。可信 Platform/Extension 实现从 `@tokenroll/acplugin/sdk` 导入契约。主包不会 bundle、发现或重新导出官方集成。

配置、descriptor、Platform 与 Extension 模块都是在宿主 Node.js 进程中执行的可信构建时代码，不是进程沙箱。Core Service capability 约束哪些来源与输出可以进入受管 Package 和报告，并不阻止恶意 Integration 自行通过 Node.js 读取内容。Factory result 携带 `Symbol.for(...)` 共享 registry brand，使主包 root、SDK 与 CLI bundle chunk 能识别生命周期定义；它只是可互操作的身份元数据，不是 private Symbol、权限令牌或安全边界。

## 固定生命周期

```text
config load/resolve
→ Platform 与 Extension Session setup
→ canonical/Public/Runtime/Extension Resource discover
→ immutable CanonicalProject assembly
→ Platform Component 与 Extension validate
→ Extension 与 Core Runtime compile
→ Platform.createPackage
→ Framework/Extension Contributor collection
→ Core add-only merge
→ Platform.finalizePackage
→ primary candidate materialize/validate
→ optional Distribution create/validate
→ compatibility 与 metadata finalize
→ aggregate materialization validate
→ managed output transaction
→ reverse Session close
```

Core 是唯一调度者。各 Platform 的 Package pipeline 相互隔离；稳定 Registry 使诊断和报告不依赖并发完成顺序。所有已初始化 Session 在成功或失败后都恰好逆序关闭一次，`close` 只收到脱敏结果摘要。

## Core Service 所有权

Core 独占物理文件系统和进程能力：

- `SourceRegistry` 在路径、类型、symlink、大小写和 Unicode 校验后签发 owner-scoped `SourceFileRef`/`SourceDirectoryRef`；
- `ModuleHost` 执行可信 TypeScript/JavaScript 配置与 descriptor，并把模块图登记到 dev；
- `CompilerHost` 是唯一 Rolldown owner。`portable-node` 为 Hooks、本地 MCP 和内建 Runtime 提供框架契约，`managed-rolldown` 向集成暴露受限 Rolldown 能力；
- `ExecutionHost` 只运行当前 Session 生成的 Node Asset，并限制输入、输出、超时、cwd 和环境；
- `AssetRegistry` 签发 Source、Generated、Bytes Asset，执行授权，并记录 mode、hash、size、owner 和结构化 origin；
- `WatchRegistry`、Package candidate materializer、compatibility registry 和输出事务保持 Core-only。

Platform/Extension 不通过框架契约获得物理 workDir 或 `dist` 写权限，只能通过 Core 引用和 owner-scoped Service 表达受管输出；这一输出边界不会把可信 Integration 代码变成进程沙箱。

## Resource 与 Project

Framework-owned Resource 包含：

- `src/commands/<id>.md` 中的 Command；
- `src/skills/<id>/SKILL.md` 及精确辅助文件；
- `src/agents/<id>.md` 中的 Agent；
- `public` 或显式 copy 规则中的 Public 文件；
- `src/runtime` 一级 TS/JS 文件或显式 `runtime.entries` 定义的内建 Node Runtime 入口。

Hooks 与 MCP 是 Extension-owned root。root 中存在作者文件但没有启用 owner Extension 时属于配置错误。Instructions 被明确排除在 canonical Component 之外。

Graph assembler 冻结唯一 `CanonicalProject`。Component 依赖在 Package 创建前拒绝缺失、自依赖和循环。只有选中 Platform 声明精确 Plugin-local Node 20 ESM capability 时，Core 才把 Runtime 编译一次。

## Platform Package 与 Contribution

Platform Session 拥有：

1. 可选 Component 字段校验；
2. 通过 `createPackage()` 创建 base Document、Asset、compatibility 与 metadata disposition；
3. 通过 `finalizePackage()` 确定 primary Package 身份和可选新增 Platform Asset；
4. 通过 `validatePackage()` 校验完整物化候选；
5. 可选地从已验证 primary Package 创建 Distribution。

Extension 校验并构建一次平台中立 State。它的 `PlatformContributor` 都读取同一份不可变 Platform base Package，并独立返回 `PackageContribution`。Contribution 可以向声明且为空的 Document extension point 增加字段、增加本 Extension 自有 Asset、报告兼容性，或提交 subject-bound 的不透明 JSON Platform Component。Core 只确定性传输 payload；只有接收 Platform 的 finalizer 负责校验、渲染、命名并按需注册原生资源。Contributor 不能读取其他 Extension State、观察其他 Contribution、替换 Document、删除输出或接管 Canonical Component。

Core 先验证全部 Contribution，再执行一次确定性 add-only merge。Document 字段或 Package 路径冲突与 Extension 配置顺序无关，始终失败。

## 输出、报告与 dev

Package candidate 只在 Core 临时根中物化，因此 Platform 校验看到的就是最终将安装的文件树。Distribution 继承已验证 primary Asset 的身份；只有 Platform 显式签发新 Asset 时才能增加内容。

Schema version 3 `BuildReport` 包含 Component、Runtime、Extension、Platform 状态、Package、Asset provenance、兼容性、metadata disposition 和精确阶段诊断。由 Component contribution 决定的生成 Asset 和 finalization Document 可以记录稳定的 contributor owner/subject provenance；报告不包含字节、时间戳、环境值、工程绝对路径或临时根。

托管输出事务把选中 Platform 集合作为一次整体替换：

```text
lock → recover → stage → validate → backup → swap → cleanup
```

任一失败都保留上一份完整输出。`DevSession` 由 Core 独占：同时只有一个 active round，快速变化合并为 pending，最新模块/来源图会被重新协调；失败保留最后成功输出，关闭或进程信号会安全 drain。

固定 transaction lock record 通过 no-replace hard link 完整发布。短生命周期的 lock metadata 操作由唯一 PID/token guard intent 串行化，因此 stale recovery 不会 rename 首次读取后出现的活跃 replacement；dead guard 使用永不复用的精确 identity 回收。stale recovery 还会同时比较 inode/content metadata 与字节。本 schema-3 协议不承诺和 pre-schema-3 beta 进程并发构建时的 lock 互操作。

## Migration 隔离

Migration 从 `packages/acplugin/src/migration/` 动态导入。容错 legacy reader 只处理不可信迁移输入，不形成第二条正常构建路径。无法安全映射的内容写入 `.acplugin-migration/unmapped/` 和稳定报告，不会伪装成 canonical Hook、本地 MCP 实现或 Instructions。
