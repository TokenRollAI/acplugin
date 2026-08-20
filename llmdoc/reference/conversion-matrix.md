# Platform support matrix

> [中文对照](conversion-matrix.zh-CN.md)

This matrix describes canonical ACPlugin 1.0 builds. Tolerant conversion code below `packages/acplugin/src/migration/legacy/` belongs only to Migration and is not another build path.

## Delivery and Components

| Capability | Claude Code | Codex | Cursor | Antigravity | OpenCode | Pi |
| --- | --- | --- | --- | --- | --- | --- |
| Primary Package | Installable Plugin | Installable Plugin | Installable Plugin | Installable Plugin | Workspace overlay | npm package |
| Skill | Native | Native | Native | Native | Native | Native |
| Command | Native Command | Transform to explicit `<plugin-name>-<id>` Skill | Native Command | Transform to explicit `command-<id>` Skill | Native workspace Command | Transform to Prompt Template |
| Agent | Native Agent | Degraded `agent-<id>` guidance Skill | Native Subagent; some model/capability fields degrade | Degraded `agent-<id>` guidance Skill | Native Subagent; capabilities transform to tools/permissions | Degraded `agent-<id>` guidance Skill |
| Public files | Plugin-root copy | Plugin-root copy | Plugin-root copy | Plugin-root copy | Workspace-root copy | Package-root copy |
| Built-in Node Runtime | Native Plugin-local Node 20 ESM | Native Plugin-local Node 20 ESM | Unsupported | Unsupported | Unsupported | Unsupported |
| Separate Marketplace distribution | Optional | Optional | Not generated | Not generated | Not applicable | Not applicable |

`native` means the Platform has an equivalent installable resource. `transform` means ACPlugin emits a different native resource while preserving the workflow intent. `degraded` means an important runtime guarantee cannot be preserved. Strict mode rejects any degraded or unsupported result; set `strict: false` on the affected Platform factory only after reviewing the structured compatibility report.

OpenCode is intentionally a workspace overlay and does not receive a fabricated generic `package.json`. Pi is a real npm package and its manifest must not leak workspace/private fields. Antigravity emits only Manifest fields confirmed by its public contract.

When a Codex Command body uses `{{arguments}}`, the fallback Skill replaces it with explicit invocation guidance and reports an independent `arguments/transform` capability. A declared `argumentHint` remains a separate degraded capability because Codex Skill metadata has no equivalent hint UI.

Codex uses `<plugin-name>-<command-id>` as the generated Skill ID. The final ID is validated with the native and Agent fallback Skill namespace before Package creation.

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

Platform-only events remain explicitly scoped and do not expand the portable union. A supported event can still report a field-level degradation when the host ignores a meaningful matcher or has no stable status-message field. Empty Hooks produce no runtime Asset or Manifest field.

## MCP Extension

| Transport | Claude Code | Codex | Cursor | Antigravity | OpenCode | Pi |
| --- | --- | --- | --- | --- | --- | --- |
| Remote Streamable HTTP | Native | Native | Native | Native | Native | Unsupported |
| Bundled local stdio | Native | Native | Unsupported | Unsupported | Native local process | Unsupported |

Remote MCP authoring is declarative: the author supplies an endpoint and secret references. Local stdio MCP is executable content: the author supplies a complete `server.ts`, which the Extension bundles once as Node 20 ESM through Core's `portable-node` Compiler profile and reuses only on Platforms with a verified install-root contract. The bounded initialize/tools-list smoke runs in both development and production; no Contributor reads secret environment values during build.

## Source and output ownership

| Concern | Source of truth |
| --- | --- |
| Config, author types, and Integration SDK contracts | `packages/core/src/contracts/`, `api/definitions.ts`, `api/author.ts`, `api/integration.ts` |
| Canonical/Public/Runtime/Extension discovery | `packages/core/src/resources/` |
| Fixed lifecycle and Platform isolation | `packages/core/src/lifecycle/build-session.ts` |
| Package, Document, Contribution, and report registries | `packages/core/src/package/` |
| Transactional output | `packages/core/src/output/transaction.ts` |
| Platform output contracts | `packages/platforms/<id>/src/` |
| Hooks discovery, compilation, and Platform Contributors | `packages/extensions/hooks/src/` |
| MCP discovery, compilation, and Platform Contributors | `packages/extensions/mcp/src/` |
| Public facade, SDK, and Project config loading | `packages/acplugin/src/index.ts`, `sdk.ts`, `author/project.ts` |
| CLI and isolated Migration boundary | `packages/acplugin/src/cli.ts`, `cli/`, `migration/` |

Platforms own base Package paths, Documents, manifests, schemas, final Package identity, distributions, and candidate validation. Extension Contributors all read the same immutable base Package and may add owned Assets, fill declared add-only Document extension points, and report compatibility. They cannot observe other Contributions, replace a Platform, or write `dist` directly.

Official contracts were last rechecked on 2026-08-06 against [Claude Code Hooks](https://code.claude.com/docs/en/hooks), [Codex Hooks](https://learn.chatgpt.com/docs/hooks), the [Cursor Plugin Schema](https://github.com/cursor/plugins/blob/main/schemas/plugin.schema.json), [Antigravity Plugins](https://antigravity.google/docs/plugins?app=cli), [OpenCode Plugins](https://opencode.ai/docs/plugins/), [OpenCode MCP](https://opencode.ai/docs/mcp-servers/), and [Pi Packages](https://pi.dev/docs/latest/packages).
