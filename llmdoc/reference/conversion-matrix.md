# Platform support matrix

> [中文对照](conversion-matrix.zh-CN.md)

This matrix describes canonical ACPlugin 1.0 builds. Tolerant conversion code below `packages/acplugin/src/migration/legacy/` belongs only to Migration and is not another build path.

## Delivery and Components

| Capability | Claude Code | Codex | Cursor | Antigravity | OpenCode | Pi |
| --- | --- | --- | --- | --- | --- | --- |
| Delivery unit | Installable Plugin | Installable Plugin | Installable Plugin | Installable Plugin | Workspace overlay | npm package |
| Skill | Native | Native | Native | Native | Native | Native |
| Command | Native Command | Transform to explicit `command-<id>` Skill | Native Command | Transform to explicit `command-<id>` Skill | Native workspace Command | Transform to Prompt Template |
| Agent | Native Agent | Degraded `agent-<id>` guidance Skill | Native Subagent; some model/capability fields degrade | Degraded `agent-<id>` guidance Skill | Native Subagent; capabilities transform to tools/permissions | Degraded `agent-<id>` guidance Skill |
| Public files | Plugin-root copy | Plugin-root copy | Plugin-root copy | Plugin-root copy | Workspace-root copy | Package-root copy |
| Separate Marketplace distribution | Optional | Optional | Not generated | Not generated | Not applicable | Not applicable |

`native` means the Platform has an equivalent installable resource. `transform` means ACPlugin emits a different native resource while preserving the workflow intent. `degraded` means an important runtime guarantee cannot be preserved. Strict mode rejects any degraded or unsupported result; use `--no-strict` only after reviewing the structured compatibility report.

OpenCode is intentionally a workspace overlay and does not receive a fabricated generic `package.json`. Pi is a real npm package and its manifest must not leak workspace/private fields. Antigravity emits only Manifest fields confirmed by its public contract.

When a Codex Command body uses `{{arguments}}`, the fallback Skill replaces it with explicit invocation guidance and reports an independent `arguments/transform` capability. A declared `argumentHint` remains a separate degraded capability because Codex Skill metadata has no equivalent hint UI.

## Hooks Extension

| Portable event | Claude Code | Codex | Cursor | Antigravity | OpenCode | Pi |
| --- | --- | --- | --- | --- | --- | --- |
| `SessionStart` | Native | Native | Transform | Native | Native | Native |
| `SessionEnd` | Native | Native | Transform | Native | Degraded | Native |
| `UserPromptSubmit` | Native | Native | Transform | Unsupported | Native | Native |
| `PreToolUse` | Native | Native | Transform | Native | Native | Native |
| `PermissionRequest` | Native | Native | Unsupported | Unsupported | Unsupported | Unsupported |
| `PostToolUse` | Native | Native | Transform | Native | Native | Native |
| `PreCompact` | Native | Native | Transform | Native | Unsupported | Native |
| `PostCompact` | Native | Native | Unsupported | Unsupported | Native | Native |
| `SubagentStart` | Native | Native | Transform | Unsupported | Unsupported | Unsupported |
| `SubagentStop` | Native | Native | Transform | Unsupported | Unsupported | Unsupported |
| `Stop` | Native | Native | Transform | Unsupported | Degraded | Degraded |

Platform-only events remain explicitly scoped and do not expand the portable union. A supported event can still report a field-level degradation when the host ignores a meaningful matcher or has no stable status-message field. Empty Hooks produce no runtime or Manifest artifact.

## MCP Extension

| Transport | Claude Code | Codex | Cursor | Antigravity | OpenCode | Pi |
| --- | --- | --- | --- | --- | --- | --- |
| Remote Streamable HTTP | Native | Native | Native | Native | Native | Unsupported |
| Bundled local stdio | Native | Native | Unsupported | Unsupported | Native local process | Unsupported |

Remote MCP authoring is declarative: the author supplies an endpoint and secret references. Local stdio MCP is executable content: the author supplies a complete `server.ts`, which the Extension bundles once as Node 20 ESM and reuses only on Platforms with a verified install-root contract. The bounded initialize/tools-list smoke runs in both development and production; no Adapter reads secret environment values during build.

## Source and output ownership

| Concern | Source of truth |
| --- | --- |
| Config, Components, lifecycle contracts, Artifacts | `packages/core/src/types.ts`, `contracts.ts` |
| Discovery and dependency graph | `packages/core/src/scanner.ts` |
| Lifecycle and Platform dispatch | `packages/core/src/lifecycle.ts` |
| Transactional output | `packages/core/src/transaction.ts` |
| Platform output contracts | `packages/platforms/<id>/src/` |
| Hooks discovery, bundling, and Platform Adapters | `packages/extensions/hooks/src/` |
| MCP discovery, bundling, and Platform Adapters | `packages/extensions/mcp/src/` |
| Public facade and config loading | `packages/acplugin/src/index.ts` |
| CLI and isolated Migration boundary | `packages/acplugin/src/cli.ts`, `migration/` |

Platforms own output paths, Documents, manifests, schemas, validation, and delivery-unit type. Extension Adapters may add owned Artifacts, patch declared add-only Document extension points, and report compatibility; they cannot replace a Platform or write `dist` directly.

Official contracts were last rechecked on 2026-08-06 against [Claude Code Hooks](https://code.claude.com/docs/en/hooks), [Codex Hooks](https://learn.chatgpt.com/docs/hooks), the [Cursor Plugin Schema](https://github.com/cursor/plugins/blob/main/schemas/plugin.schema.json), [Antigravity Plugins](https://antigravity.google/docs/plugins?app=cli), [OpenCode Plugins](https://opencode.ai/docs/plugins/), [OpenCode MCP](https://opencode.ai/docs/mcp-servers/), and [Pi Packages](https://pi.dev/docs/latest/packages).
