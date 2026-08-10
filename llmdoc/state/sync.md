# llmdoc sync state

- Baseline commit: `3380ada8b907cc6e1b63154e3582187d9b0dc83b`
- Mode: `full`
- Workflow: adversarial review and implementation completed through the first-class Platform package correction; local commits were created, but no push, Tag, Release, registry mutation, or publication was performed.
- Architecture: pnpm-only monorepo; independently versioned public main package, six Platform packages, and two Extension packages; private Core and Vitest workspace; ESM-only on Node.js 20 or newer.
- TypeScript: all 11 source Packages execute TypeScript `7.0.2` through cataloged `@typescript/native`; the root installs official `@typescript/typescript6` as `typescript` only for tools that still require the legacy JavaScript Compiler API.
- Migration: isolated legacy code validates generated projects through public `runProject()`, reports every discovered field as mapped/degraded/unmapped, accepts complete SemVer including build metadata, validates URL/email/SPDX/keywords, retains MCP-only Marketplace entries, and uses the official MCP public contract for safe remote declarations.
- Ecosystem packages: every official Platform/Extension imports only the public SDK from `@tokenroll/acplugin` through `workspace:^`; packed peer ranges are normal semver, and the main-package factory's private Symbol brands interoperate with clean-consumer third-party Platforms through one peer instance. The main package has no official integration manifest dependency or re-export.
- MCP packaging: the official Extension publishes a lightweight `index.mjs` and a lazy local-stdio `bundler.mjs`; the main package has no optional Extension/Rolldown runtime dependency. The isolated Migration lazy chunk bundles only the official integrations needed to validate generated projects.
- Dev: Extension module graphs participate in watch mode; initial/dynamic ready windows receive catch-up builds; split editor writes are stabilized before queue-level debounce; signal cleanup exits with code 130.
- Review: Standards Hard 0, with one non-blocking Hooks platform-profile consolidation suggestion. Spec final rereview passed after the Migration field-fidelity remediation; no blocking findings remain.
- Validation: lint, TypeScript 7 typecheck, package and cross-package Vitest suites, build, ATTW/publint, `release:verify`, and `docs:check` pass for the `0.0.1-beta` workspace. Nine beta tarballs pass clean-consumer checks covering all official integrations, a third-party Platform brand, six-platform scaffolding, and main-only packed Migration.

```text
pnpm run check
pnpm run release:verify
pnpm changeset status
git diff --check
git diff --cached --check
```
