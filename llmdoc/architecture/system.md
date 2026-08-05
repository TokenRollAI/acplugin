# System Architecture

> [中文对照](system.zh-CN.md)

## Pipeline

```text
acplugin.config.ts
  → resolve/validate config
  → order and initialize Modules
  → discover canonical Components/Public
  → validate Component dependency graph
  → Module target contributions
  → built-in Compiler per target
  → immutable Artifact graph
  → compatibility strictness/final validation
  → validate-only materialization or managed output transaction
  → stable report
```

`validate`, `inspect`, and `build` run this same pipeline. Only report detail and commit behavior differ. `dev` creates a fresh pipeline per coalesced rebuild and keeps the last successful complete output after failures.

## Core package

`packages/core/src/` owns:

- `types.ts`: public config, Component, Module, Compiler, Artifact, compatibility, and report contracts;
- `config.ts`: strict config normalization and safe project-relative directories;
- `scanner.ts`: canonical Markdown/Public discovery, Frontmatter validation, dependency graph checks, and Module-directory gating;
- `diagnostics.ts`: stable sorted diagnostics and compatibility strictness;
- `artifacts.ts`: ownership, hashing, file-source roots, modes, and collision checks;
- `builder.ts`: lifecycle orchestration, Compiler dispatch, final graph/report creation;
- `transaction.ts`: validation materialization and whole-`dist` lock/backup/swap/recovery;
- `serialization.ts`: deterministic JSON/YAML/Markdown serialization.

Artifacts reject absolute/traversal paths, symlinks, unsupported modes, source escapes, and exact/case-insensitive/Unicode-normalized collisions.

## Module lifecycle

```text
configResolved → discover → validate → build → generate(target) → buildEnd
```

Modules are topologically ordered by `dependsOn`, preserving config order among peers. A Module may access only declared dependency State/Built State and write only its Core-provided work directory. It returns target Artifacts, uniquely owned top-level Manifest fields, and compatibility entries. Compilers retain complete Manifest and target-schema ownership.

`buildEnd` runs in reverse initialized order after success or failure. On a candidate commit, the transaction keeps the prior output as a rollback backup while reverse cleanup runs. A cleanup failure is reported, passed to remaining cleanup hooks, and rolls the swap back to the previous complete output. Failures before the swap reach cleanup through the normal error path.

## Built-in Compilers

`packages/compiler-claude-code/` emits native Commands, Skills, Agents, and `.claude-plugin/plugin.json`.

`packages/compiler-codex/` emits native Skills, Command fallback Skills, Agent fallback Skills, invocation policy metadata, and `.codex-plugin/plugin.json`. Generated identities are reserved case-insensitively; collisions fail visibly.

Both packages are private and bundled into `@tokenroll/acplugin` by tsdown.

## Official Modules

`packages/module-hooks/` discovers `src/hooks/<id>/hook.ts`, validates event/matcher/timeout/semantic results, and bundles a self-contained bounded JSON runner per supported target. Literal dynamic imports ensure the handler and dependencies enter the bundle. Runtime failures emit fixed codes without input payloads. Third-party dependency licenses are emitted adjacent to handlers.

`packages/module-mcp/` discovers `src/mcp/<id>/mcp.ts`. Streamable HTTP declarations map URL/auth/header environment references without reading secrets. Local stdio entries are bundled as Node 20 ESM and carry adjacent third-party license notices.

## Managed output transaction

`dist` is a complete managed target set:

1. acquire an exclusive sibling lock;
2. recover a retained backup/transaction record;
3. materialize all selected targets into a same-filesystem stage;
4. recompute and verify every Artifact size, SHA-256, mode, and regular-file status;
5. write the transaction record and rename old output to backup;
6. rename stage to output while retaining the rollback boundary;
7. finish Module cleanup successfully or roll back;
8. remove transaction and best-effort cleanup backup.

Pre-commit failure leaves old output untouched. Failure after backup/swap rolls back. If cleanup alone is interrupted, the next run deterministically reconciles output and backup. Core tests inject failures at each observable phase.

## CLI and package boundary

`packages/acplugin/src/index.ts` loads fresh trusted TypeScript config/descriptor modules with Jiti and wires the two bundled Compilers. Nested config objects are runtime-schema checked before pipeline use. `cli.ts` owns commands, JSON/text output discipline, exit codes, watch coalescing, and lazy Migration import. Stable diagnostics redact external exceptions, absolute paths, and recognizable credential forms.

The normal facade and CLI startup do not import `migration/`. The packed main tarball contains no private package imports or runtime dependencies; `scripts/verify-release.mjs` proves this in an external consumer.
