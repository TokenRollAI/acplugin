# Project Overview

> [中文对照](project.zh-CN.md)

## Identity

ACPlugin is a Rolldown-based AI Plugin framework and CLI. Authors maintain one canonical project and continuously compile validated Packages for Claude Code, Codex, Cursor, Antigravity, OpenCode, and Pi.

The independently versioned public packages are:

- `@tokenroll/acplugin`
- six `@tokenroll/acplugin-platform-*` packages
- `@tokenroll/acplugin-extension-hooks`
- `@tokenroll/acplugin-extension-mcp`

Core, integration tests, Docs, and Playground are private workspaces. `@tokenroll/acplugin` bundles Core and exposes two intentional boundaries: the root author/programmatic API and `@tokenroll/acplugin/sdk` for Platform and Extension implementations. Official integrations use the SDK through a peer dependency; public tarballs never depend on `@acplugin/*`.

## Authoring boundary

Canonical Components are Commands, Skills, and Agents. `acplugin.config.ts` defines project metadata, explicit Platform instances, Public mappings, optional Extensions, the built-in Node Runtime, and build strictness. Instructions are intentionally outside the installable Plugin boundary.

Hooks and MCP are optional Extensions. Each discovers and builds its author resources once through Core-owned Module, Compiler, Asset, Execution, and Watch services, then contributes add-only Package fields and Assets for supported Platforms.

Node Runtime is a Framework Resource, not an Extension package. Direct files under `src/runtime/` are entries by convention; explicit `runtime.entries` replaces automatic discovery. Core compiles each entry once with the `portable-node` profile and capable Platforms inherit the same Asset references and bytes. Unsupported Platforms report the capability and emit no pseudo runtime.

`platforms` is required. Builds use explicitly imported instances; the main package never discovers implementations by ID. `init` defaults to explicit Claude Code and Codex dependencies/imports when no platform option is supplied. Each Platform owns canonical conversion, base Package Documents and Assets, final Package identity, optional distributions, candidate validation, and compatibility reporting.

## Runtime and tooling

- Node.js >=20 and ESM-only TypeScript 7 package sources
- pnpm workspace without Turborepo
- Commander.js and `@inquirer/prompts` for CLI/TUI
- tsdown for package bundles and declarations
- one Core-owned Rolldown Module/Compiler service for config, descriptors, portable Node bundles, and managed third-party builds
- one Core-owned Chokidar watcher behind `Project.dev()`
- Vitest for private repository tests
- VitePress 1.6 and TypeDoc 0.28 for private documentation

The workspace catalog maps package `tsc` commands to `@typescript/native`. Tools that still require the legacy Compiler API use the isolated `@typescript/typescript6` alias. Production package typechecking remains on TypeScript 7.

The CLI and author facade live in `packages/acplugin/src/cli.ts`, `src/cli/`, `src/index.ts`, and `src/author/`; `src/sdk.ts` is the only Integration implementation entry. Core's fixed lifecycle is implemented by `packages/core/src/lifecycle/build-session.ts`, while `Project.dev()` delegates every rebuild round to that same BuildSession.

## Migration boundary

`acplugin migrate` is dynamically imported and isolated under `packages/acplugin/src/migration/`. Tolerant legacy GitHub and Claude/plugin reading remains under `migration/legacy/` only for migration input. Normal CLI startup, Core, Platforms, and Extensions do not import Migration.

Migration never writes in place. Content that cannot be mapped safely is preserved under `.acplugin-migration/unmapped/` with a stable report; it is not fabricated into canonical Hooks, MCP implementations, Instructions, or external-command wrappers.
