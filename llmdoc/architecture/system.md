# System Architecture

> [中文对照](system.zh-CN.md)

## Product boundary

ACPlugin is a Rolldown-powered AI Plugin framework and CLI. It combines project scaffolding with a build system that remains in the project for validation, development, packaging, compatibility reporting, and managed output updates.

The public package boundary is deliberately split:

- `@tokenroll/acplugin` is the author facade, CLI, Project API, report API, init, and isolated Migration entry.
- Six `@tokenroll/acplugin-platform-*` packages own target-specific Package formats.
- `@tokenroll/acplugin-extension-hooks` and `@tokenroll/acplugin-extension-mcp` own optional horizontal authoring formats.
- `@acplugin/core` is private and is bundled into the main package.

Configuration authors import from `@tokenroll/acplugin`. Trusted Platform and Extension implementations import contracts from `@tokenroll/acplugin/sdk`. The main package never bundles, discovers, or re-exports official integrations.

Configuration, descriptor, Platform, and Extension modules execute as trusted build-time code in the host Node.js process; they are not process sandboxes. Core service capabilities govern which sources and outputs can enter managed Packages and reports, not what a malicious integration could read through Node.js itself. Factory results carry a `Symbol.for(...)` shared registry brand so root, SDK, and CLI bundle chunks recognize the lifecycle definition. This brand is interoperable identity metadata, not a private Symbol, capability token, or security boundary.

## Fixed lifecycle

```text
config load/resolve
→ Platform and Extension Session setup
→ canonical/Public/Runtime/Extension resource discovery
→ immutable CanonicalProject assembly
→ Platform Component and Extension validation
→ Extension and Core Runtime compilation
→ Platform.createPackage
→ Framework and Extension Contributor collection
→ Core add-only merge
→ Platform.finalizePackage
→ primary candidate materialization and validation
→ optional Distribution creation and validation
→ compatibility and metadata finalization
→ aggregate materialization validation
→ managed output transaction
→ reverse Session close
```

Core is the only scheduler. Platform Package pipelines are isolated from one another, while stable registries make diagnostics and reports independent of concurrent completion order. Every initialized Session is closed exactly once in reverse order after success or failure; close receives only a sanitized outcome summary.

## Core service ownership

Core owns the physical filesystem and process capabilities:

- `SourceRegistry` issues owner-scoped `SourceFileRef` and `SourceDirectoryRef` values after path, type, symlink, case, and Unicode checks.
- `ModuleHost` evaluates trusted TypeScript/JavaScript config and descriptors and registers their module graphs for dev.
- `CompilerHost` is the only Rolldown owner. `portable-node` provides the framework contract for Hooks, local MCP, and built-in Runtime; `managed-rolldown` exposes a bounded Rolldown surface to integrations.
- `ExecutionHost` runs only current-session generated Node Assets with bounded input, output, timeout, cwd, and environment.
- `AssetRegistry` signs Source, Generated, and Bytes Assets, enforces grants, and records mode, hash, size, owner, and structured origin.
- `WatchRegistry`, the Package candidate materializer, compatibility registry, and output transaction remain Core-only.

Platforms and Extensions never receive a physical work directory or direct `dist` access through the framework contract. They express managed output through Core-issued references and owner-scoped services; this output boundary does not turn trusted Integration code into a process sandbox.

## Resources and Project

The framework-owned resource model contains:

- Commands from `src/commands/<id>.md`;
- Skills from `src/skills/<id>/SKILL.md` plus exact auxiliary files;
- Agents from `src/agents/<id>.md`;
- Public files from `public` or explicit copy rules;
- built-in Node Runtime entries from direct `src/runtime` TS/JS files or explicit `runtime.entries`.

Hooks and MCP are Extension-owned roots. A root containing author files without its owning Extension is a configuration error. Instructions are intentionally not a canonical Component.

The graph assembler freezes one `CanonicalProject`. Component dependency validation rejects missing, self, and cyclic dependencies before Package creation. Runtime is compiled once by Core only when a selected Platform declares the exact Plugin-local Node 20 ESM capability.

## Platform Packages and Contributions

A Platform Session owns:

1. optional Component field validation;
2. `createPackage()` for base Documents, Assets, compatibility, and metadata dispositions;
3. `finalizePackage()` for primary Package identity and optional additional Platform Assets;
4. `validatePackage()` against the fully materialized candidate;
5. optional `createDistributions()` from an already validated primary Package.

An Extension validates and builds one platform-neutral state. Its `PlatformContributor` instances all read the same immutable Platform base Package and return independent `PackageContribution` values. A Contribution may add fields only at declared empty Document extension points, add Assets owned by that Extension, and report compatibility. It cannot read another Extension state, observe another Contribution, replace a Document, delete output, or claim a Component.

Core validates all Contributions, then performs one deterministic add-only merge. Conflicting Document fields or Package paths fail regardless of Extension configuration order.

## Output, reports, and dev

Package candidates are materialized only under Core-owned temporary roots. Platform validation therefore sees the exact file tree that would be installed. Distribution Assets inherit the validated primary Asset identity unless the Platform explicitly adds a newly signed Asset.

`BuildReport` schema version 2 contains Components, Runtimes, Extensions, Platform status, Packages, Asset provenance, compatibility, metadata dispositions, and stage-bound diagnostics. It contains no bytes, timestamps, environment values, project absolute paths, or temporary roots.

The managed output transaction treats the selected Platform set as one replacement:

```text
lock → recover → stage → validate → backup → swap → cleanup
```

Any failure keeps the last complete output. `DevSession` remains Core-owned: it maintains one active build round, coalesces pending changes, reconciles the latest module/source graph, keeps the last successful output after failure, and drains safely on close or process signals.

The fixed transaction lock record is published complete with a no-replace hard link. Short-lived lock-metadata operations are serialized by unique PID/token guard intents, so stale recovery cannot rename a live replacement observed after an earlier read; dead guard paths are exact, never-reused identities. Stale recovery also compares inode/content metadata and bytes. This schema-3 protocol does not claim concurrent lock interoperability with pre-schema-3 beta processes.

## Migration isolation

Migration is dynamically imported from `packages/acplugin/src/migration/`. Its tolerant legacy readers operate only on untrusted migration input and do not form a second normal build path. Content that cannot be mapped safely is written to `.acplugin-migration/unmapped/` with a stable report; it is never fabricated into canonical Hooks, local MCP implementations, or Instructions.
