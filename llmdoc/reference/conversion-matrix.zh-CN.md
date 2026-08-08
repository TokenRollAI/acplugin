# Platform 支持矩阵

> [English version](conversion-matrix.md)

本矩阵描述规范 ACPlugin 1.0 构建。`packages/acplugin/src/migration/legacy/` 下的容错转换代码只属于 Migration，不是另一条构建路径。

## 交付形态与 Component

| 能力 | Claude Code | Codex | Cursor | Antigravity | OpenCode | Pi |
| --- | --- | --- | --- | --- | --- | --- |
| 交付单元 | 可安装 Plugin | 可安装 Plugin | 可安装 Plugin | 可安装 Plugin | Workspace Overlay | npm Package |
| Skill | 原生 | 原生 | 原生 | 原生 | 原生 | 原生 |
| Command | 原生 Command | 转换为显式 `command-<id>` Skill | 原生 Command | 转换为显式 `command-<id>` Skill | 原生 Workspace Command | 转换为 Prompt Template |
| Agent | 原生 Agent | 降级为 `agent-<id>` 指导 Skill | 原生 Subagent；部分模型/能力字段降级 | 降级为 `agent-<id>` 指导 Skill | 原生 Subagent；能力转换为 tools/permissions | 降级为 `agent-<id>` 指导 Skill |
| Public 文件 | 复制到 Plugin 根 | 复制到 Plugin 根 | 复制到 Plugin 根 | 复制到 Plugin 根 | 复制到 Workspace 根 | 复制到 Package 根 |
| 独立 Marketplace 分发 | 可选 | 可选 | 不生成 | 不生成 | 不适用 | 不适用 |

`原生` 表示 Platform 有等价的可安装资源；`转换` 表示生成另一种原生资源并保留工作流意图；`降级` 表示关键运行时保证无法完整保留。严格模式会拒绝 degraded/unsupported；只有在审阅结构化兼容性报告后，才应使用 `--no-strict`。

OpenCode 明确是 Workspace Overlay，不会收到伪造的通用 `package.json`。Pi 是真实 npm Package，其 Manifest 不得泄漏 workspace/private 字段。Antigravity 只输出公开契约已经确认的 Manifest 字段。

当 Codex Command 正文使用 `{{arguments}}` 时，回退 Skill 会把它替换为显式调用指引，并独立报告 `arguments/transform` 能力。作者声明的 `argumentHint` 仍是另一项 degraded 能力，因为 Codex Skill 元数据没有等价的参数提示 UI。

## Hooks Extension

| 可移植事件 | Claude Code | Codex | Cursor | Antigravity | OpenCode | Pi |
| --- | --- | --- | --- | --- | --- | --- |
| `SessionStart` | 原生 | 原生 | 转换 | 原生 | 原生 | 原生 |
| `SessionEnd` | 原生 | 原生 | 转换 | 原生 | 降级 | 原生 |
| `UserPromptSubmit` | 原生 | 原生 | 转换 | 不支持 | 原生 | 原生 |
| `PreToolUse` | 原生 | 原生 | 转换 | 原生 | 原生 | 原生 |
| `PermissionRequest` | 原生 | 原生 | 不支持 | 不支持 | 不支持 | 不支持 |
| `PostToolUse` | 原生 | 原生 | 转换 | 原生 | 原生 | 原生 |
| `PreCompact` | 原生 | 原生 | 转换 | 原生 | 不支持 | 原生 |
| `PostCompact` | 原生 | 原生 | 不支持 | 不支持 | 原生 | 原生 |
| `SubagentStart` | 原生 | 原生 | 转换 | 不支持 | 不支持 | 不支持 |
| `SubagentStop` | 原生 | 原生 | 转换 | 不支持 | 不支持 | 不支持 |
| `Stop` | 原生 | 原生 | 转换 | 不支持 | 降级 | 降级 |

Platform-only 事件保持显式平台限定，不会扩充可移植事件联合。即使事件受支持，当宿主忽略 meaningful matcher 或没有稳定状态消息字段时，仍会产生字段级降级。空 Hooks 不会生成运行时或 Manifest 产物。

## MCP Extension

| 传输 | Claude Code | Codex | Cursor | Antigravity | OpenCode | Pi |
| --- | --- | --- | --- | --- | --- | --- |
| 远程 Streamable HTTP | 原生 | 原生 | 原生 | 原生 | 原生 | 不支持 |
| Bundle 后的本地 stdio | 原生 | 原生 | 不支持 | 不支持 | 原生本地进程 | 不支持 |

远程 MCP 是声明式内容：作者提供 Endpoint 和秘密引用。本地 stdio MCP 是可执行内容：作者提供完整 `server.ts`，Extension 只 Bundle 一次 Node 20 ESM，并只复用到具有已验证安装根契约的 Platform。有边界的 initialize/tools-list smoke 会在 development 与 production 中都执行；任何 Adapter 都不会在构建时读取环境变量秘密值。

## 源码与输出所有权

| 关注点 | 事实来源 |
| --- | --- |
| Config、Components、生命周期契约、Artifacts | `packages/core/src/types.ts`、`contracts.ts` |
| 发现与依赖图 | `packages/core/src/scanner.ts` |
| 生命周期与 Platform 分发 | `packages/core/src/lifecycle.ts` |
| 事务化输出 | `packages/core/src/transaction.ts` |
| Platform 输出契约 | `packages/platforms/<id>/src/` |
| Hooks 发现、Bundle 与 Platform Adapter | `packages/extensions/hooks/src/` |
| MCP 发现、Bundle 与 Platform Adapter | `packages/extensions/mcp/src/` |
| 公开门面与配置加载 | `packages/acplugin/src/index.ts` |
| CLI 与隔离 Migration 边界 | `packages/acplugin/src/cli.ts`、`migration/` |

Platform 拥有输出路径、Document、Manifest、Schema、Validator 和交付单元类型。Extension Adapter 可以增加自有 Artifact、修改声明为 add-only 的 Document 扩展点并报告兼容性，但不能替换 Platform，也不能直接写入 `dist`。

官方契约最后核验于 2026-08-06，来源包括 [Claude Code Hooks](https://code.claude.com/docs/en/hooks)、[Codex Hooks](https://learn.chatgpt.com/docs/hooks)、[Cursor Plugin Schema](https://github.com/cursor/plugins/blob/main/schemas/plugin.schema.json)、[Antigravity Plugins](https://antigravity.google/docs/plugins?app=cli)、[OpenCode Plugins](https://opencode.ai/docs/plugins/)、[OpenCode MCP](https://opencode.ai/docs/mcp-servers/) 和 [Pi Packages](https://pi.dev/docs/latest/packages)。
