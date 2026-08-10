# 兼容性矩阵

## Canonical Components

| Platform | Command | Skill | Agent |
| --- | --- | --- | --- |
| Claude Code | Native | Native | Native |
| Codex | Transform → 默认 `command-*`、可选 Plugin 前缀 Skill | Native | Degraded → `agent-*` guidance Skill |
| Cursor | Native | Native | Native |
| Antigravity | Transform → explicit Skill | Native | Degraded → guidance Skill |
| OpenCode | Native workspace Command | Native workspace Skill | Native workspace Agent；capability 为 transform |
| Pi | Transform → Prompt Template | Native | Degraded → guidance Skill |

表格只描述 Component 主能力。`argumentHint`、invocation、model、capabilities 等字段仍可能产生独立 degraded/transform 记录。

## MCP transports

| Transport | Claude Code | Codex | Cursor | Antigravity | OpenCode | Pi |
| --- | --- | --- | --- | --- | --- | --- |
| Remote HTTP | Native | Native | Native | Native | Native | Unsupported |
| Local stdio | Native | Native | Unsupported | Unsupported | Native | Unsupported |

## Portable Hook events

| Platform | Native | Transform/Degraded | Unsupported |
| --- | --- | --- | --- |
| Claude Code | 11 个 portable events | 部分事件 matcher degraded | — |
| Codex | 11 个 portable events | 部分事件 matcher degraded | — |
| Cursor | — | 9 events transformed；部分 matcher/status degraded | `PermissionRequest`、`PostCompact` |
| Antigravity | `SessionStart`、`SessionEnd`、`PreToolUse`、`PostToolUse`、`PreCompact` | 部分字段 degraded | 其余 6 events |
| OpenCode | `SessionStart`、`UserPromptSubmit`、`PreToolUse`、`PostToolUse`、`PostCompact` | `SessionEnd`、`Stop` degraded | 其余 4 events |
| Pi | `SessionStart`、`SessionEnd`、`UserPromptSubmit`、`PreToolUse`、`PostToolUse`、`PreCompact`、`PostCompact` | `Stop` degraded | `PermissionRequest`、两个 Subagent events |

最终以 build report 为准。Platform/Extension 升级后，文档矩阵和实现测试必须一起更新。
