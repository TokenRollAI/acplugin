# 项目概览

> [English version](project.md)

## 项目定位

acplugin 是一套规范化 AI Plugin 框架和 CLI。作者只需维护一份由框架定义的源码结构，即可为 Claude Code 和 Codex 编译出完整、可安装的 Plugin。

公开发布的固定包组包括：

- `@tokenroll/acplugin`
- `@tokenroll/acplugin-module-hooks`
- `@tokenroll/acplugin-module-mcp`

Core、两个内置 Compiler 和集成测试工作区都是私有包。主公开包会内联 Core 和 Compiler，因此消费者不会依赖任何 `@acplugin/*` 包。

## 创作边界

Core Component 包括 Commands、Skills 和 Agents。`acplugin.config.ts` 在顶层定义 `name`、`version`、`description`、目标平台、Public 复制行为、Modules 和严格度。

Instructions 被有意排除在可安装 Plugin 边界之外。Hooks 和 MCP 是可选 Module：启用 Module 只会扩展同一套 Core 生命周期，不会替换 Compiler。

默认目标是 Claude Code 和 Codex。Claude Code 原生支持全部 Core Component。Codex 会把 Command 转换成需要显式调用的 Skill，并把 Agent 降级成仅保留模型指导的回退 Skill，因为可安装 Codex Plugin 无法注册项目级或用户级自定义 Agent。

## 运行时与工具链

- Node.js >=20；工作区包使用仅 ESM 的 TypeScript 7 进行构建和类型检查
- pnpm workspace，不使用 Turborepo
- Commander.js 和 `@inquirer/prompts` 提供 CLI/TUI
- tsdown 负责包 Bundle、声明文件和包结构校验
- Rolldown 负责本地 Hook/MCP 可执行文件 Bundle
- Vitest 负责仓库内部测试

根目录 ESLint 工具链暂时保留 `typescript-eslint` 所需的 TypeScript 6 API；所有实际工作区包都从 pnpm catalog 解析共享的 TypeScript 7 编译器。

CLI 入口是 `packages/acplugin/src/cli.ts`；公开门面和配置加载器位于 `packages/acplugin/src/index.ts`。

## Migration 边界

`acplugin migrate` 支持旧 Claude 工程、单 Plugin、Marketplace 和受支持的 GitHub 来源格式。Migration 通过动态导入加载，并隔离在 `packages/acplugin/src/migration/` 下。其容错 Legacy Scanner/Converter 实现只保留在 `migration/legacy/` 子目录中。

`migration/legacy/` 下只保留容错 GitHub 下载和 Claude/Plugin 扫描辅助代码；旧版多平台 Converter、Writer、CLI、TUI 和测试副本均已删除。不可信或不可移植内容会保存在 `.acplugin-migration/unmapped/`，绝不会被伪造成规范 Hooks、MCP 实现或 Instructions Component。
