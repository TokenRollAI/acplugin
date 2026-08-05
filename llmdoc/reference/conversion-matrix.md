# Target support matrix

> [中文对照](conversion-matrix.zh-CN.md)

This matrix describes canonical acplugin 1.0 builds. The tolerant converters retained below `packages/acplugin/src/migration/legacy/` are Migration implementation details, not additional build targets.

| Capability | Claude Code | Codex |
| --- | --- | --- |
| Skills | Native | Native |
| Commands | Native | Explicit `command-<id>` fallback Skill |
| Agents | Native | Explicit `agent-<id>` model-only fallback Skill |
| Public files | Target-root copy | Target-root copy |
| Hooks Module | Native supported events | Native portable events |
| Remote HTTP MCP | Native declaration | Native declaration |
| Local stdio MCP | Bundled Node 20 ESM | Bundled Node 20 ESM |

Commands are supported on Codex through a semantic transformation. Agents are degraded because installable Codex plugins cannot register custom project/user Agents. With the default strict setting, an Agent therefore fails the Codex target; `--no-strict` explicitly accepts the generated fallback and structured compatibility warning.

Hooks and MCP are not Core Components. They join the same build lifecycle only when `@tokenroll/acplugin-module-hooks` or `@tokenroll/acplugin-module-mcp` is configured. Source under `src/hooks` or `src/mcp` without the corresponding Module is an error.

## Source and output ownership

| Concern | Source of truth |
| --- | --- |
| Config, Components, Modules, Artifacts | `packages/core/src/types.ts` |
| Discovery and dependency graph | `packages/core/src/scanner.ts` |
| Lifecycle and target dispatch | `packages/core/src/builder.ts` |
| Transactional output | `packages/core/src/transaction.ts` |
| Claude output schema | `packages/compiler-claude-code/src/index.ts` |
| Codex output schema and fallbacks | `packages/compiler-codex/src/index.ts` |
| Hooks discovery/runtime bundling | `packages/module-hooks/src/index.ts` |
| MCP declaration/runtime bundling | `packages/module-mcp/src/index.ts` |
| Public facade, config loading | `packages/acplugin/src/index.ts` |
| CLI and Migration boundary | `packages/acplugin/src/cli.ts` |

Compilers own target paths and manifests. Modules may contribute Artifacts, uniquely owned top-level manifest fields, and compatibility entries, but cannot replace a Compiler or write `dist` directly.
