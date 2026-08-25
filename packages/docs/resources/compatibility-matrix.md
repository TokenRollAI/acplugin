# 兼容性矩阵

## Canonical Components

| Platform | Command | Skill | Agent |
| --- | --- | --- | --- |
| Claude Code | Native | Native | Native |
| Codex | Transform → 固定 `<plugin-name>-<id>` explicit Skill | Native | Degraded → `agent-*` guidance Skill |
| Cursor | Native | Native | Native |
| Antigravity | Transform → explicit Skill | Native | Degraded → guidance Skill |
| OpenCode | Native workspace Command | Native workspace Skill | Native workspace Agent；capability 为 transform |
| Pi | Transform → Prompt Template | Native | Degraded → guidance Skill |

表格只描述 Component 主能力。`argumentHint`、invocation、model、capabilities 等字段仍可能产生独立 degraded/transform 记录。

## Platform Component Contribution

| Platform | 私有原生 Component contribution |
| --- | --- |
| Claude Code | Native Agent；Platform 渲染 `agents/<id>.md` 并写受控 Manifest 字段 |
| Cursor | Native Subagent；Platform 渲染 `agents/<id>.md` 并写受控 Manifest glob |
| OpenCode | Native workspace Subagent；Platform 渲染 `.opencode/agents/<id>.md`，不 patch config |
| Codex | Unsupported；非空 contribution 在 finalization 失败，不生成 Skill fallback |
| Antigravity | Unsupported；非空 contribution 在 finalization 失败，不生成 Skill fallback |
| Pi | Unsupported；非空 contribution 在 finalization 失败，不生成 Skill fallback |

此能力仅供 Extension 的 `PlatformContributor<TPayload>` 使用；不是 Canonical Component，也不引入 Extension 顺序、slot 或覆盖模型。payload schema、路径与冲突策略由各 Platform package 拥有。

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
