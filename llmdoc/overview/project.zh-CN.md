# 项目概览

> [English version](project.md)

## 项目定位

ACPlugin 是一套基于 Rolldown 的 AI Plugin 框架和 CLI。作者维护一份规范工程，持续为 Claude Code、Codex、Cursor、Antigravity、OpenCode 和 Pi 编译经过完整校验的 Package。

独立版本化的公开 package 包括：

- `@tokenroll/acplugin`
- 六个 `@tokenroll/acplugin-platform-*`
- `@tokenroll/acplugin-extension-hooks`
- `@tokenroll/acplugin-extension-mcp`

Core、集成测试、Docs 与 Playground 都是私有 workspace。`@tokenroll/acplugin` 内联 Core，并提供两个有意分离的入口：根入口面向普通作者和程序化调用方，`@tokenroll/acplugin/sdk` 面向 Platform/Extension 实现。官方集成通过主包 peer 使用 SDK；任何公开 tarball 都不依赖 `@acplugin/*`。

## 创作边界

Canonical Component 包括 Command、Skill 和 Agent。`acplugin.config.ts` 定义工程元数据、显式 Platform 实例、Public 映射、可选 Extension、内建 Node Runtime 与构建严格度。Instructions 被有意排除在可安装 Plugin 边界之外。

Hooks 与 MCP 是可选 Extension。每个 Extension 通过 Core 独占的 Module、Compiler、Asset、Execution 和 Watch 服务发现并构建一次作者资源，再为支持的平台 add-only 贡献 Package 字段与 Asset。

Node Runtime 是 Framework Resource，不是 Extension package。默认把 `src/runtime/` 一级文件作为入口；显式 `runtime.entries` 会完整替换自动发现。Core 使用 `portable-node` profile 对每个入口只编译一次，具备能力的 Platform 继承相同的 Asset 引用与字节；不支持的平台必须报告该能力且不能生成伪 Runtime。

`platforms` 必填。构建只使用显式导入的实例，主包不会按 ID 发现实现。未指定平台时，`init` 默认显式安装并导入 Claude Code 与 Codex。每个 Platform 拥有 canonical 转换、base Package 的 Document/Asset、最终 Package 身份、可选 Distribution、候选校验和兼容性报告。

## 运行时与工具链

- Node.js >=20，Package 源码使用 ESM-only TypeScript 7
- pnpm workspace，不使用 Turborepo
- Commander.js 与 `@inquirer/prompts` 提供 CLI/TUI
- tsdown 负责 Package bundle 与声明文件
- Core 唯一的 Rolldown Module/Compiler Service 负责配置、descriptor、portable Node bundle 和受管第三方构建
- Core 通过 `Project.dev()` 独占唯一 Chokidar watcher
- Vitest 负责私有仓库测试
- VitePress 1.6 与 TypeDoc 0.28 负责私有文档

Workspace catalog 把各 Package 的 `tsc` 映射到 `@typescript/native`。仍依赖旧 Compiler API 的工具使用隔离的 `@typescript/typescript6` 别名；生产 Package 的类型检查保持 TypeScript 7。

CLI 与作者 façade 位于 `packages/acplugin/src/cli.ts`、`src/index.ts`；`src/sdk.ts` 是 Integration 实现唯一入口。Core 固定生命周期由 `packages/core/src/kernel/build-session.ts` 实现，`Project.dev()` 的每个重建轮次也委托给同一 BuildSession。

## Migration 边界

`acplugin migrate` 使用动态 import，并隔离在 `packages/acplugin/src/migration/`。容错型 legacy GitHub 与 Claude/plugin 读取仅在 `migration/legacy/` 中服务迁移输入；正常 CLI 启动、Core、Platform 与 Extension 都不导入 Migration。

Migration 不原地写入。无法安全映射的内容会保存在 `.acplugin-migration/unmapped/` 并生成稳定报告；不会伪造成 Canonical Hook、MCP 实现、Instructions 或外部命令包装。
