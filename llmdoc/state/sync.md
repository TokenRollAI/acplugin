# llmdoc sync state

- Baseline commit: `d254e8ad7fe444f5230bc3d1ab4140cf72a83890`
- Mode: `full`
- Workflow: `grill-with-docs → to-spec → to-tickets → implement → code-review` completed through ACPL-001～ACPL-023; no commit, Tag, Release, registry mutation, or publication was performed.
- Architecture: pnpm-only monorepo; public `@tokenroll/acplugin` plus fixed-version Hooks/MCP Extensions; private Core, six private Platform implementations, and private Vitest workspace; ESM-only on Node.js 20 or newer.
- TypeScript: all 11 source Packages execute TypeScript `7.0.2` through cataloged `@typescript/native`; the root installs official `@typescript/typescript6` as `typescript` only for tools that still require the legacy JavaScript Compiler API.
- Migration: isolated legacy code validates generated projects through public `runProject()`, reports every discovered field as mapped/degraded/unmapped, accepts complete SemVer including build metadata, validates URL/email/SPDX/keywords, retains MCP-only Marketplace entries, and uses the official MCP public contract for safe remote declarations.
- MCP packaging: the official Extension publishes a lightweight `index.mjs` and a lazy local-stdio `bundler.mjs`; the main package has no optional Extension/Rolldown runtime dependency. Release verification includes a main-package-only remote MCP Migration consumer.
- Dev: Extension module graphs participate in watch mode; initial/dynamic ready windows receive catch-up builds; split editor writes are stabilized before queue-level debounce; signal cleanup exits with code 130.
- Review: Standards Hard 0, with one non-blocking Hooks platform-profile consolidation suggestion. Spec final rereview passed after the Migration field-fidelity remediation; no blocking findings remain.
- Validation: `pnpm install --frozen-lockfile`; 11 × TypeScript `7.0.2`; lint and Chinese comment guard across 131 files; 14 integration files / 60 integration tests and 174 tests overall; build/ATTW/publint; three 1.0.0 tarballs in clean consumers; main-only packed Migration; Changesets status; staged/unstaged diff checks.

```text
pnpm run check
pnpm run release:verify
pnpm changeset status
git diff --check
git diff --cached --check
```
