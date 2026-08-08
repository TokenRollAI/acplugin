# 项目概览

> [English version](project.md)

## 项目定位

acplugin 是一套规范化 AI Plugin 框架和 CLI。作者只需维护一份由框架定义的源码结构，即可为 Claude Code、Codex、Cursor、Antigravity、OpenCode 和 Pi 编译由各 Platform 拥有的交付产物。

公开发布的固定包组包括：

- `@tokenroll/acplugin`
- `@tokenroll/acplugin-extension-hooks`
- `@tokenroll/acplugin-extension-mcp`

Core、内置 Platform 实现和集成测试工作区都是私有包。主公开包会内联 Core 和 Platform，因此消费者不会依赖任何 `@acplugin/*` 包。

## 创作边界

Core Component 包括 Commands、Skills 和 Agents。`acplugin.config.ts` 在顶层定义 `name`、`version`、`description`、Platforms、Public 复制行为、Extensions 和严格度。

Instructions 被有意排除在可安装 Plugin 边界之外。Hooks 和 MCP 是可选 Extension：启用后通过其自有 Platform Adapter 加入同一套 Core 生命周期，不会替换 Platform。

默认 Platform 是 Claude Code 和 Codex。Cursor 与 Antigravity 是可选静态 Plugin，OpenCode 是可选 Workspace Overlay，Pi 是可选 npm Package。每个平台都会明确报告原生转换和语义损失，不会伪装成最低公共格式。

## 运行时与工具链

- Node.js >=20；工作区包使用仅 ESM 的 TypeScript 7 进行构建和类型检查
- pnpm workspace，不使用 Turborepo
- Commander.js 和 `@inquirer/prompts` 提供 CLI/TUI
- tsdown 负责包 Bundle、声明文件和包结构校验
- Rolldown 负责本地 Hook/MCP 可执行文件 Bundle
- Vitest 负责仓库内部测试

各 Workspace 通过 catalog 中的 `@typescript/native` 别名安装 TypeScript 7 编译器，因此所有 Package 的 `tsc` Script 都实际使用 7.x。由于 TypeScript 7 不再暴露旧 JavaScript Compiler API，根目录只为 typescript-eslint 和注释 AST 检查器把官方 `@typescript/typescript6` 兼容 API 安装为 `typescript`。Vitest、tsdown、Rolldown 和 Node 类型同样通过 catalog 共享；平台专属运行时与 Lint 依赖仍由实际使用它们的 Package 独立声明。

CLI 入口是 `packages/acplugin/src/cli.ts`；公开门面和配置加载器位于 `packages/acplugin/src/index.ts`。

## Migration 边界

`acplugin migrate` 支持旧 Claude 工程、单 Plugin、Marketplace 和受支持的 GitHub 来源格式。Migration 通过动态导入加载，并隔离在 `packages/acplugin/src/migration/` 下。其容错 Legacy Scanner/Converter 实现只保留在 `migration/legacy/` 子目录中。

`migration/legacy/` 下只保留容错 GitHub 下载和 Claude/Plugin 扫描辅助代码；旧版多平台 Converter、Writer、CLI、TUI 和测试副本均已删除。不可信或不可移植内容会保存在 `.acplugin-migration/unmapped/`，绝不会被伪造成规范 Hooks、MCP 实现或 Instructions Component。
