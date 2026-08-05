# 目标支持矩阵

> [English version](conversion-matrix.md)

本矩阵描述规范 acplugin 1.0 构建。保留在 `packages/acplugin/src/migration/legacy/` 下的容错 Converter 只是 Migration 实现细节，不代表额外构建目标。

| 能力 | Claude Code | Codex |
| --- | --- | --- |
| Skills | 原生 | 原生 |
| Commands | 原生 | 显式 `command-<id>` 回退 Skill |
| Agents | 原生 | 显式 `agent-<id>`、仅保留模型指导的回退 Skill |
| Public 文件 | 复制到目标根目录 | 复制到目标根目录 |
| Hooks Module | 原生支持事件 | 原生可移植事件 |
| 远程 HTTP MCP | 原生声明 | 原生声明 |
| 本地 stdio MCP | Node 20 ESM Bundle | Node 20 ESM Bundle |

Codex 通过语义转换支持 Command。Agent 会降级，因为可安装 Codex Plugin 无法注册项目级或用户级自定义 Agent。因此，在默认严格设置下，包含 Agent 的 Codex 目标会失败；`--no-strict` 表示明确接受生成的回退和结构化兼容性警告。

Hooks 和 MCP 不是 Core Component。只有配置 `@tokenroll/acplugin-module-hooks` 或 `@tokenroll/acplugin-module-mcp` 后，它们才会加入同一构建生命周期。如果 `src/hooks` 或 `src/mcp` 中存在源码但未启用对应 Module，则构建会报错。

## 源码与输出所有权

| 关注点 | 事实来源 |
| --- | --- |
| Config、Components、Modules、Artifacts | `packages/core/src/types.ts` |
| 发现与依赖图 | `packages/core/src/scanner.ts` |
| 生命周期与目标分发 | `packages/core/src/builder.ts` |
| 事务化输出 | `packages/core/src/transaction.ts` |
| Claude 输出 Schema | `packages/compiler-claude-code/src/index.ts` |
| Codex 输出 Schema 与回退 | `packages/compiler-codex/src/index.ts` |
| Hooks 发现与运行时 Bundle | `packages/module-hooks/src/index.ts` |
| MCP 声明与运行时 Bundle | `packages/module-mcp/src/index.ts` |
| 公开门面与配置加载 | `packages/acplugin/src/index.ts` |
| CLI 与 Migration 边界 | `packages/acplugin/src/cli.ts` |

Compiler 拥有目标路径和 Manifest。Module 可以贡献 Artifact、由其唯一拥有的顶层 Manifest 字段和兼容性条目，但不能替换 Compiler，也不能直接写入 `dist`。
