# Project Overview

## Identity

acplugin is a canonical AI Plugin framework and CLI. Authors maintain one framework-owned source layout and compile complete installable plugins for Claude Code and Codex.

The public release cohort is:

- `@tokenroll/acplugin`
- `@tokenroll/acplugin-module-hooks`
- `@tokenroll/acplugin-module-mcp`

Core, both built-in Compilers, and the integration-test workspace are private packages. The main public package bundles Core and the Compilers so consumers never depend on `@acplugin/*`.

## Authoring boundary

Core Components are Commands, Skills, and Agents. `acplugin.config.ts` defines top-level `name`, `version`, `description`, targets, Public copy behavior, Modules, and strictness.

Instructions are intentionally outside the installable Plugin boundary. Hooks and MCP are optional Modules: enabling one extends the same Core-owned lifecycle rather than replacing the Compiler.

Default targets are Claude Code and Codex. Claude supports all Core Components natively. Codex transforms Commands to explicit Skills and degrades Agents to model-only fallback Skills because installable Codex plugins cannot register custom project/user Agents.

## Runtime and tooling

- Node.js >=20, ESM-only TypeScript
- pnpm workspace, no Turborepo
- Commander.js and `@inquirer/prompts` for CLI/TUI
- tsdown for package bundles/declarations/package validation
- Rolldown for local Hook/MCP executable bundles
- Vitest for private repository tests

The CLI entry is `packages/acplugin/src/cli.ts`; the facade/config loader is `packages/acplugin/src/index.ts`.

## Migration boundary

`acplugin migrate` accepts legacy Claude projects, single plugins, marketplaces, and supported GitHub forms. Migration is dynamically imported and isolated under `packages/acplugin/src/migration/`. Its tolerant legacy scanner/converter implementation is retained only below `migration/legacy/`.

Only the tolerant GitHub download and Claude/plugin scanning helpers remain below `migration/legacy/`; the retired multi-platform converter, writer, CLI, TUI, and test copies were removed. Untrusted or non-portable content is preserved under `.acplugin-migration/unmapped/`; it is never fabricated into canonical Hooks, MCP implementations, or Instructions Components.
