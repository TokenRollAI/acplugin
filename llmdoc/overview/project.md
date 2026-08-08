# Project Overview

> [中文对照](project.zh-CN.md)

## Identity

acplugin is a canonical AI Plugin framework and CLI. Authors maintain one framework-owned source layout and compile Platform-owned deliveries for Claude Code, Codex, Cursor, Antigravity, OpenCode, and Pi.

The independently versioned public packages are:

- `@tokenroll/acplugin`
- `@tokenroll/acplugin-platform-claude-code`
- `@tokenroll/acplugin-platform-codex`
- `@tokenroll/acplugin-platform-cursor`
- `@tokenroll/acplugin-platform-antigravity`
- `@tokenroll/acplugin-platform-opencode`
- `@tokenroll/acplugin-platform-pi`
- `@tokenroll/acplugin-extension-hooks`
- `@tokenroll/acplugin-extension-mcp`

Core and the integration-test workspace are private packages. The main package bundles Core, while every official Platform and Extension imports the public SDK from `@tokenroll/acplugin` through a peer dependency. Consumers never depend on `@acplugin/*`.

## Authoring boundary

Core Components are Commands, Skills, and Agents. `acplugin.config.ts` defines top-level `name`, `version`, `description`, Platforms, Public copy behavior, Extensions, and strictness.

Instructions are intentionally outside the installable Plugin boundary. Hooks and MCP are optional Extensions: enabling one joins the same Core-owned lifecycle through its own Platform Adapters rather than replacing a Platform.

`platforms` is required: builds use explicitly imported instances and the main package never discovers or loads an implementation by ID. `init` keeps Claude Code and Codex as its scaffolding selection when no `--platform` option is supplied, but writes both dependencies and imports. Claude Code, Codex, Cursor, and Antigravity are static Plugins, OpenCode is a workspace overlay, and Pi is an npm package. Every Platform reports native transformations and semantic losses instead of claiming a lowest-common-denominator format.

## Runtime and tooling

- Node.js >=20, ESM-only TypeScript 7 for package builds and typechecking
- pnpm workspace, no Turborepo
- Commander.js and `@inquirer/prompts` for CLI/TUI
- tsdown for package bundles/declarations/package validation
- Rolldown for local Hook/MCP executable bundles
- Vitest for private repository tests

The TypeScript 7 compiler is installed across workspaces through the cataloged `@typescript/native` alias, so every package `tsc` script uses 7.x. The root keeps the official `@typescript/typescript6` compatibility API under the `typescript` name only for tools such as typescript-eslint and the comment AST checker, because TypeScript 7 no longer exposes the legacy JavaScript compiler API. Vitest, tsdown, Rolldown, and Node types are also shared through the catalog; package-specific runtime and lint dependencies stay in the package that owns them.

The CLI entry is `packages/acplugin/src/cli.ts`; the facade is `packages/acplugin/src/index.ts`, and `packages/acplugin/src/project-config.ts` loads trusted project configuration. Official integration factories live only in their own packages.

## Migration boundary

`acplugin migrate` accepts legacy Claude projects, single plugins, marketplaces, and supported GitHub forms. Migration is dynamically imported and isolated under `packages/acplugin/src/migration/`. Its tolerant legacy scanner/converter implementation is retained only below `migration/legacy/`.

Only the tolerant GitHub download and Claude/plugin scanning helpers remain below `migration/legacy/`; the retired multi-platform converter, writer, CLI, TUI, and test copies were removed. Untrusted or non-portable content is preserved under `.acplugin-migration/unmapped/`; it is never fabricated into canonical Hooks, MCP implementations, or Instructions Components.
