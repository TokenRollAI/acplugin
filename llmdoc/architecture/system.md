# System Architecture

> [中文对照](system.zh-CN.md)

## Pipeline

```text
acplugin.config.ts
  → resolve/validate config
  → initialize Platforms and Extensions
  → Extension discover, then canonical Component/Public scan
  → Extension validate/build
  → Platform prepare
  → Extension Platform Adapters
  → Platform generate/validate/distribute
  → immutable DeliveryUnit/Artifact graph
  → compatibility strictness
  → validate-only materialization or managed output transaction
  → stable report
```

`validate`, `inspect`, and `build` run this same pipeline. Only report detail and commit behavior differ. `dev` creates a fresh pipeline per coalesced rebuild, includes Extension-reported bundle module graphs, performs a catch-up build after watcher readiness, and keeps the last successful complete output after failures.

## Core package

`packages/core/src/` owns:

- `types.ts`: public config, Component, Artifact, compatibility, and report contracts;
- `contracts.ts`: branded Platform, Extension, Adapter, and lifecycle APIs;
- `config.ts`: strict config normalization and safe project-relative directories;
- `scanner.ts`: canonical Markdown/Public discovery, Frontmatter validation, dependency graph checks, and Extension-directory gating;
- `diagnostics.ts`: stable sorted diagnostics and compatibility strictness;
- `artifacts.ts`: ownership, hashing, file-source roots, modes, and collision checks;
- `documents.ts`: add-only logical Document extension points and final serialization;
- `delivery-units.ts`: primary/distribution ownership and immutable Artifact registration;
- `lifecycle.ts`: fixed Platform/Extension orchestration and final report creation;
- `transaction.ts`: validation materialization and whole-`dist` lock/backup/swap/recovery;
- `serialization.ts`: deterministic JSON/YAML/Markdown serialization.

Artifacts reject absolute/traversal paths, symlinks, unsupported modes, source escapes, and exact/case-insensitive/Unicode-normalized collisions.

## Platform and Extension lifecycle

```text
configResolved → buildStart → Extension discover → Core scan → Extension validate/build
→ Platform prepare → Adapter apply → Platform generate/validate/distribute → buildEnd
```

Platforms run in config order; Extensions run in config order and do not form a hidden dependency graph. Each Extension writes only its Core-provided work directory and returns platform-neutral Built State. Its Adapter can only read declared Documents, add fields at Platform-owned extension points, emit owned Artifacts, and report compatibility. Platforms retain complete lifecycle, Manifest, schema, validation, and distribution ownership.

`buildEnd` runs in reverse initialized order after success or failure. On a candidate commit, the transaction keeps the prior output as a rollback backup while reverse cleanup runs. A cleanup failure is reported, passed to remaining cleanup hooks, and rolls the swap back to the previous complete output. Failures before the swap reach cleanup through the normal error path.

## Official Platform packages

`packages/platforms/claude-code/` emits native Commands, Skills, Agents, `.claude-plugin/plugin.json`, and optional Marketplace distributions.

`packages/platforms/codex/` emits native Skills, Command fallback Skills, Agent fallback Skills, invocation policy metadata, `.codex-plugin/plugin.json`, and optional Marketplace distributions. Generated identities are reserved case-insensitively; collisions fail visibly.

`packages/platforms/cursor/` emits a static Cursor Plugin with native Commands, Skills, and Subagents. Its Manifest is validated against a pinned complete official Schema fixture; model and non-readonly capability losses are reported rather than guessed.

`packages/platforms/antigravity/` emits a static Plugin with native Skills, Command fallback Skills, Agent guidance Skills, and the smallest publicly verified `plugin.json`. Metadata without a confirmed Manifest field is reported as omitted.

`packages/platforms/opencode/` emits a workspace overlay with native Commands, Skills, and Subagents. It creates `opencode.json` only when configured fields or an Extension Adapter requires it, and never fabricates a generic package Manifest.

`packages/platforms/pi/` emits an npm package with native Skills, Command Prompt Templates, and Agent guidance Skills. Its package Manifest declares only Pi discovery fields and cannot leak `private`, `workspaces`, or private workspace dependencies.

Each directory is published as `@tokenroll/acplugin-platform-<id>`. Production code imports only the public SDK from `@tokenroll/acplugin`, declares it as a peer dependency, and exports its factory as both the default and a named export. The main package neither bundles nor re-exports these implementations; private serializers and validators stay inside the owning Platform tarball.

## Official Extensions

`packages/extensions/hooks/` discovers `src/hooks/<id>/hook.ts`, validates event/matcher/timeout/result semantics, and bundles each implementation once as a platform-neutral Node 20 ESM Handler. Its six built-in Platform Adapters emit the verified static config or runtime integration for each host and report unsupported/degraded events individually. Runtime failures use fixed codes without payloads; third-party license notices remain adjacent to the Handler.

`packages/extensions/mcp/` discovers `src/mcp/<id>/mcp.ts`. Remote HTTP entries remain declarations containing only public values and environment-variable references. Local stdio entries provide complete server code, are bundled once as Node 20 ESM, reject unresolved dynamic imports, and must pass a bounded real initialize/tools-list smoke without referenced Secret values in both development and production. There is no mode or cache bypass for this protocol check. Its six Platform Adapters emit only transports each host can install: Claude Code/Codex support both, Cursor/Antigravity support remote HTTP, OpenCode supports remote/local, and Pi reports both unsupported.

Extension build contexts expose `addWatchFile()` as the single dependency-registration boundary. Official bundlers report their actual Rolldown module graphs through it; Core validates absolute file identities, and the CLI—not the Extension—owns watcher policy and readiness compensation.

## Managed output transaction

`dist` is a complete managed target set:

1. acquire an exclusive sibling lock;
2. recover a retained backup/transaction record;
3. materialize all selected Platform delivery units into a same-filesystem stage;
4. recompute and verify every Artifact size, SHA-256, mode, and regular-file status;
5. write the transaction record and rename old output to backup;
6. rename stage to output while retaining the rollback boundary;
7. finish reverse Platform/Extension cleanup successfully or roll back;
8. remove transaction and best-effort cleanup backup.

Pre-commit failure leaves old output untouched. Failure after backup/swap rolls back. If cleanup alone is interrupted, the next run deterministically reconciles output and backup. Core tests inject failures at each observable phase.

## CLI and package boundary

`packages/acplugin/src/index.ts` exposes the public facade while `project-config.ts` loads fresh trusted TypeScript config/descriptor modules with Jiti and `run-project.ts` connects resolved projects to Core. Nested config objects are runtime-schema checked before lifecycle use. `cli.ts` owns commands, JSON/text output discipline, exit codes, watch coalescing, and lazy Migration import. Stable diagnostics redact external exceptions, absolute paths, and recognizable credential forms.

The normal facade and CLI startup do not import `migration/`. The packed main tarball contains no private package imports, official integration manifest dependencies, or normal eager edges to those integrations. Migration's lazy chunk is the isolated exception that bundles the Claude Code Platform and MCP implementation needed to validate generated projects. `scripts/verify-release.mjs` proves the eager boundary, all nine public package manifests, peer rewrites, and private Symbol-brand interoperability through one main-package peer instance in external consumers.

## Repository-only documentation consumers

`packages/docs/` is a private VitePress workspace. TypeDoc scans only the root public entry point of each of the nine public packages, generates Markdown and the API sidebar into an ignored directory, and then VitePress builds the task-oriented manual without remote content, timestamps, or deployment side effects.

`packages/playground/` is a private real consumer that explicitly imports the main package, Claude Code/Codex Platforms, and Hooks Extension. It exercises Components, Skill auxiliary files, Hooks, Public files, compatibility propagation, and managed output. Its llmdoc v3 content is intentionally a template smoke: runtime state, incremental update/cache, Schema, Migration, and MCP behavior remain non-goals. Neither private workspace is a dependency of a public package or part of release tarballs.
