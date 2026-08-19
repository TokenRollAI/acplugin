# ACPlugin

[中文文档](./README.zh-CN.md)

ACPlugin is a Rolldown-powered canonical AI plugin framework and CLI. You author Commands, Skills, Agents, and optional Hooks, MCP servers, or Node runtimes once; ACPlugin builds Platform-owned deliveries for Claude Code, Codex, Cursor, Antigravity, OpenCode, and Pi.

This is not a Claude-project converter. The canonical project is the source of truth, and each Platform owns its final manifest, paths, compatibility decisions, and deterministic serialization. Legacy Claude projects and plugins are handled separately by `acplugin migrate`.

## Requirements

- Published CLI/runtime: Node.js `^20.19.0 || ^22.13.0 || >=23.5.0`
- Repository development/build: Node.js `^22.18.0 || >=24.11.0`
- pnpm for generated projects and this repository

## Quick start

```bash
pnpm dlx @tokenroll/acplugin init my-plugin --yes
cd my-plugin
pnpm install
pnpm build
```

Or add the framework and the Platforms you want to an existing empty project:

```bash
pnpm add -D @tokenroll/acplugin \
  @tokenroll/acplugin-platform-claude-code \
  @tokenroll/acplugin-platform-codex
```

```ts
// acplugin.config.ts
import { defineConfig } from '@tokenroll/acplugin';
import claudeCode from '@tokenroll/acplugin-platform-claude-code';
import codex from '@tokenroll/acplugin-platform-codex';

export default defineConfig({
  name: 'my-plugin',
  version: '1.0.0',
  description: 'Reusable AI workflows.',
  platforms: [claudeCode(), codex()],
});
```

`init` selects Claude Code and Codex unless you pass `--platform`, but it writes both packages and imports explicitly. The runtime has no implicit Platforms: every build uses exactly the instances in `platforms`.

`acplugin.config.ts`, Hook descriptors, and MCP descriptors are trusted executable project code loaded by the local Node.js process. Review them with the same care as build scripts; Migration input remains untrusted data and is never executed as canonical descriptor code.

## Canonical project

```text
my-plugin/
├── acplugin.config.ts
├── package.json
├── public/                         # optional files copied to each Platform root
└── src/
    ├── commands/
    │   └── review.md
    ├── skills/
    │   └── review/
    │       ├── SKILL.md
    │       └── references/         # copied with the Skill
    ├── agents/
    │   └── reviewer.md
    ├── hooks/                      # only with the Hooks Extension
    │   └── policy/hook.ts
    ├── mcp/                        # only with the MCP Extension
    │   └── docs/mcp.ts
    └── runtime/                    # optional Core-managed Node Runtime sources
        ├── cli.ts                  # direct files are entries by convention
        └── internal/helpers.ts     # nested files are normal dependencies
```

IDs and directory names use lowercase kebab-case. Markdown Components require YAML Frontmatter and a non-empty body. Symlinks and paths escaping the project are rejected.

ACPlugin deliberately has no Instructions Component. Repository-wide instructions are host/project configuration, not an installable plugin capability.

## Configuration

`acplugin.config.ts` exports an object or a sync/async function receiving `{ command, mode }`.

```ts
import { defineConfig } from '@tokenroll/acplugin';
import claudeCode from '@tokenroll/acplugin-platform-claude-code';
import codex from '@tokenroll/acplugin-platform-codex';

export default defineConfig(({ mode }) => ({
  name: 'team-review',
  version: '1.0.0',
  description: 'Shared review workflows.',
  displayName: 'Team Review',
  platforms: [
    claudeCode(),
    codex({ strict: mode === 'production' }),
  ],
  public: {
    dir: 'public',
    copy: [
      { from: 'assets', to: 'assets' },
      { from: 'NOTICE.md', to: 'NOTICE.md' },
    ],
  },
  build: {
    outDir: 'dist',
    strict: true,
  },
}));
```

Top-level fields:

| Field | Meaning |
| --- | --- |
| `name`, `version`, `description` | Required plugin identity. |
| `displayName` | Optional presentation name. |
| `srcDir` | Canonical source directory; defaults to `src`. |
| `public` | `false`, a directory, or explicit copy rules. |
| `platforms` | Required, non-empty list of explicitly imported Platform instances. |
| `runtime` | Built-in Node Runtime convention, explicit entries, compile options, or `false`. |
| `extensions` | Optional horizontal capabilities such as Hooks and MCP. |
| `build.outDir` | Managed output directory; defaults to `dist`. |
| `build.strict` | Fail on degraded/unsupported compatibility; defaults to `true`. |

Official Platforms are independent packages with a peer dependency on the framework:

```ts
import antigravity from '@tokenroll/acplugin-platform-antigravity';
import claudeCode from '@tokenroll/acplugin-platform-claude-code';
import codex from '@tokenroll/acplugin-platform-codex';
import cursor from '@tokenroll/acplugin-platform-cursor';
import openCode from '@tokenroll/acplugin-platform-opencode';
import pi from '@tokenroll/acplugin-platform-pi';

const platforms = [claudeCode(), codex(), cursor(), antigravity(), openCode(), pi()];
```

Claude Code, Codex, Cursor, and Antigravity emit static Plugin Packages. OpenCode emits a workspace overlay; Pi emits an npm package. `acplugin init --platform <id...>` installs and writes the selected packages explicitly. The main package does not re-export official integrations, discover packages by ID, or install anything during a build.

## Core Components

### Skill

```md
---
description: Review a change for correctness and maintainability.
invocation:
  user: true
  model: true
requires:
  agents: [reviewer]
---
Review the selected change and report concrete findings.
```

Place it at `src/skills/review/SKILL.md`. Every other regular file below that directory is copied as a Skill auxiliary file.

### Command

```md
---
description: Review a named change.
argumentHint: <commit-or-branch>
requires:
  skills: [review]
---
Review {{arguments}} using the review Skill.
```

Place it at `src/commands/review.md`.

### Agent

```md
---
description: Focused read-only code reviewer.
model: capable
capabilities: [filesystem:read, search]
---
Inspect the change, verify evidence, and report only actionable findings.
```

Place it at `src/agents/reviewer.md`. Canonical model classes are `inherit`, `fast`, and `capable`. Capabilities are semantic declarations rather than target tool names.

Components may require Skills and Agents. Missing dependencies, self-dependencies, and cycles are build errors.

## Compatibility

| Component | Claude Code | Codex | Cursor | Antigravity | OpenCode | Pi |
| --- | --- | --- | --- | --- | --- | --- |
| Skill | Native | Native | Native | Native | Native | Native |
| Command | Native | Transform to Skill | Native | Transform to Skill | Native | Transform to Prompt |
| Agent | Native | Degraded Skill | Native with field-level limits | Degraded Skill | Native with capability transform | Degraded Skill |

Codex installable plugins cannot register custom project/user Agents. Therefore an Agent makes a strict Codex build fail; configure `codex({ strict: false })` only when the explicit fallback and its structured warning are acceptable.

See the [complete compatibility matrix](./llmdoc/reference/conversion-matrix.md) for Package shapes, every portable Hook event, and MCP transport support.

## Hooks Extension

```bash
pnpm add -D @tokenroll/acplugin-extension-hooks
```

```ts
import { defineConfig } from '@tokenroll/acplugin';
import claudeCode from '@tokenroll/acplugin-platform-claude-code';
import hooks from '@tokenroll/acplugin-extension-hooks';

export default defineConfig({
  name: 'policy-plugin',
  version: '1.0.0',
  description: 'Portable policy hooks.',
  platforms: [claudeCode()],
  extensions: [hooks()],
});
```

```ts
// src/hooks/policy/hook.ts
import type { Hook } from '@tokenroll/acplugin-extension-hooks';

export default {
  event: 'PreToolUse',
  matcher: 'Bash',
  timeout: 5,
  async run(input) {
    return input.cwd
      ? { decision: 'allow' }
      : { decision: 'deny', reason: 'Missing working directory.' };
  },
} satisfies Hook<'PreToolUse'>;
```

Portable events are:

```text
SessionStart, SessionEnd, UserPromptSubmit, PreToolUse, PermissionRequest,
PostToolUse, PreCompact, PostCompact, SubagentStart, SubagentStop, Stop
```

Claude Code-only events remain explicitly platform-scoped and do not affect Codex compatibility:

```text
Setup, UserPromptExpansion, PermissionDenied, PostToolUseFailure, PostToolBatch,
Notification, MessageDisplay, TaskCreated, TaskCompleted, StopFailure,
TeammateIdle, InstructionsLoaded, ConfigChange, CwdChanged, DirectoryAdded,
FileChanged, WorktreeCreate, WorktreeRemove, Elicitation, ElicitationResult
```

Declare one with `event: { platform: 'claude-code', name: 'Setup' }`; a bare `'Setup'` string is rejected.

ACPlugin bundles each handler once as a self-contained, platform-neutral Node 20 ESM executable. Verified platform wire profiles are compiled into that same Bundle for native input validation, recursive camelCase conversion, root/data mapping, and output mapping; no adjacent runtime JavaScript is required. The shared Handler owns bounded JSON I/O, semantic result validation, safe failures, and deterministic third-party license notices. Meaningful matchers ignored by the selected host are reported per Hook as `degraded`; unsupported events generate no fake runtime.

## MCP Extension

```bash
pnpm add -D @tokenroll/acplugin-extension-mcp
```

```ts
import { defineConfig } from '@tokenroll/acplugin';
import claudeCode from '@tokenroll/acplugin-platform-claude-code';
import mcp from '@tokenroll/acplugin-extension-mcp';

export default defineConfig({
  name: 'tools-plugin',
  version: '1.0.0',
  description: 'Portable MCP tools.',
  platforms: [claudeCode()],
  extensions: [mcp()],
});
```

Remote Streamable HTTP server:

```ts
// src/mcp/docs/mcp.ts
import type { McpServer } from '@tokenroll/acplugin-extension-mcp';

export default {
  transport: 'http',
  url: 'https://example.com/mcp',
  auth: { type: 'bearer', env: 'DOCS_TOKEN' },
  headers: { 'X-Tenant': { env: 'TENANT_ID' } },
} satisfies McpServer;
```

Local stdio server:

```ts
// src/mcp/local-tools/mcp.ts
import type { McpServer } from '@tokenroll/acplugin-extension-mcp';

export default {
  transport: 'stdio',
  entry: 'server.ts',
  env: { API_TOKEN: { env: 'LOCAL_API_TOKEN' } },
} satisfies McpServer;
```

For local MCP, you provide a complete stdio MCP implementation in `server.ts`; ACPlugin bundles it for Node 20 ESM. Both development and production builds reject unresolved runtime dynamic imports, start the bundle with only declared literal environment values, and require a bounded `initialize → initialized → tools/list` smoke test to pass. No mode branch or cache bypasses this protocol check. Referenced secret values are never read. For HTTP MCP, you declare the remote endpoint and auth/header references—there is no local server implementation to provide. Production HTTP endpoints require HTTPS; development permits loopback HTTP.

Claude Code, Codex, and OpenCode support both remote HTTP and bundled local stdio. Cursor and Antigravity support remote HTTP only; Pi reports MCP unsupported. See the [complete compatibility matrix](./llmdoc/reference/conversion-matrix.md).

## Built-in Node Runtime

```ts
// acplugin.config.ts
export default defineConfig({
  // ...metadata and explicit Platforms
  runtime: {
    entries: {
      cli: { entry: 'bin/cli.ts', kind: 'executable' },
      library: { entry: 'library.ts', kind: 'module' },
    },
    compile: { treeshake: true },
  },
});
```

With no `runtime` field, every supported direct file under `src/runtime/` is an executable entry; nested files remain normal dependencies. An explicit `runtime.entries` map completely replaces auto-discovery, and `runtime: false` disables the convention. Each entry becomes one deterministic, self-contained Node 20 ESM bundle at `runtime/<id>/main.mjs`. npm dependencies are bundled, only `node:` built-ins remain external, executable entries use mode `0755`, module entries use `0644`, and third-party notices are emitted next to the bundle when required. Core compiles every entry once, then Claude Code and Codex inherit the same framework-owned bytes. Platforms without a stable local Node/plugin-root contract report `unsupported` and receive no substitute Asset. Type checking remains the project-owned `tsc --noEmit` step.

## Extension lifecycle

All Extensions participate in the same Core-owned pipeline:

```text
config → setup Sessions → discover Resources → Canonical Project
→ validate → compile → Platform base Package → Contributors → Core merge
→ finalize → materialize/validate candidates → Distributions
→ compatibility → transaction → reverse close
```

Descriptor loading goes through `context.modules`, while executable output goes through the Core-owned Rolldown service at `context.compiler`. The services register the actual module, license, plugin, and tsconfig graph for `dev`; integrations receive owner-scoped capabilities, do not create private bundlers, and cannot write `dist`. Platform Contributors can return owned Assets, add fields at declared Document extension points, and report compatibility from the same immutable base Package; they cannot replace Platform output or observe other Extension state. Session `close` always runs in reverse initialization order.

## CLI

```text
acplugin init [directory]
acplugin dev
acplugin validate
acplugin inspect
acplugin build
acplugin migrate <source> [destination]
```

Common project options include `--config`, `--platform`, `--mode`, and `--json`. Compatibility strictness is declared in `acplugin.config.ts` through `build.strict` or a Platform factory override.

- `validate` runs complete Platform generation and materialization validation without writing `dist`.
- `inspect` adds detailed Package/Asset metadata without writing `dist`.
- `build` atomically replaces the complete managed `dist` only after every selected Platform succeeds.
- `dev` watches config, the Core Module/Build Service graph, Components, Public files, descriptors, and bundler/plugin/license/tsconfig dependencies. Package dependencies are watched at their resolved package roots. It performs a catch-up build after each new watcher becomes ready, retains the last successful output after failures, and rebuilds after recovery. Runtime-computed import targets that Rolldown cannot place in a static module graph are rejected for managed executable bundles.
- Bare `acplugin` prints Help and never prompts.

Exit codes are `0` success, `1` project/build/migration failure, `2` CLI usage or internal framework failure, and `130` cancellation. JSON mode writes one schema-versioned document to stdout for non-watch commands; diagnostics/logs use stderr.

## Deterministic output and security

- Assets are immutable owner-scoped references reported with mode, size, SHA-256, and structured origin.
- Absolute/traversal paths, symlinks, path collisions, and sources outside approved roots are rejected.
- Builds use a same-filesystem stage, lock, transaction record, backup, and whole-output swap.
- Any Platform failure preserves the previous complete `dist`.
- Generated files and reports contain no timestamps, temporary paths, environment values, or credentials.
- Extension source under `src/hooks` or `src/mcp` without its Extension enabled is an error; `src/runtime` is owned directly by Core.

## Legacy Migration

Migration is CLI-only, lazy-loaded, and isolated from Core/Platforms/normal startup.

```bash
acplugin migrate ./legacy-project ./new-plugin \
  --name new-plugin \
  --description "Migrated plugin"

acplugin migrate owner/repository ./new-workspace --all
```

Supported sources include local Claude projects, single plugins, marketplaces, and supported GitHub forms. `--plugin <name>` writes one canonical project directly at the destination; only `--all` creates a pnpm workspace of independent projects. Skills, Commands, Agents, and portable remote HTTP MCP declarations are mapped where possible. Instructions, raw Hooks, Hook implementation files, local external-command MCP, and unsupported resources are preserved under `.acplugin-migration/unmapped/` with a stable report and manual actions. Before atomic commit, every generated project is loaded through the public API and checked by the real Core Module Service, Scanner, lifecycle, and isolated Migration validators; installed Platform/Extension packages perform their full semantic validation when the generated project is built. Migration never writes in place.

Use `--dry-run` for scan/map/validation without destination writes and `--strict` to fail on any degraded or unmapped item.

## Documentation and playground

The repository includes two private, repository-only workspaces beside the publishable packages:

- `packages/docs` is a VitePress site with task-oriented Guide, Config, Platform, Extension, Ecosystem, Playground, and Resource sections. TypeDoc regenerates API pages and the sidebar for all nine public package root entries before every docs dev/build.
- `packages/playground` is a domain-neutral six-Platform/Hooks/MCP/Node Runtime capability template. It validates canonical Commands, Skill auxiliary files, Agents, all portable Hook events, HTTP and local MCP, portable Node runtime delivery, Public files, and Claude Code/Codex Marketplaces without implementing product-specific behavior.

```bash
pnpm run docs:dev       # generate API pages, then start VitePress
pnpm run docs:build     # generate API pages and build the static site
pnpm run docs:check     # docs structure/build plus the real playground checks
```

Generated API Markdown/sidebar, VitePress cache/output, and Playground `dist` are reproducible and ignored by Git.

## Packages and repository development

Public packages:

- `@tokenroll/acplugin`
- `@tokenroll/acplugin-platform-claude-code`
- `@tokenroll/acplugin-platform-codex`
- `@tokenroll/acplugin-platform-cursor`
- `@tokenroll/acplugin-platform-antigravity`
- `@tokenroll/acplugin-platform-opencode`
- `@tokenroll/acplugin-platform-pi`
- `@tokenroll/acplugin-extension-hooks`
- `@tokenroll/acplugin-extension-mcp`

The official integrations use the same public lifecycle SDK available to third-party packages and declare the main package as a peer dependency. Core, the Vitest integration workspace, Docs, and Playground remain private; Core is bundled into the main package and no public runtime manifest contains `@acplugin/*`.

```bash
pnpm install
pnpm run check
pnpm run docs:check
pnpm run release:verify
```

`release:verify` creates all nine public tarballs from one revision, inspects their files/manifests and type resolution, verifies peer rewriting and brand interoperability, and installs a six-Platform/two-Extension scaffold into a clean external consumer while exercising the built-in Runtime. It performs no npm publication.

Pull requests automatically run lint/typecheck and an independent Docs/Playground quality gate. The manually dispatched `Patch` workflow accepts a target branch containing at least one effective Changeset that bumps a public package, consumes its Changesets to bump versions and generate changelogs, and opens a version PR back to that branch.

Every package is versioned independently and only changed packages are published. If a new integration release requires a newly published main-package peer range, publish and verify that main-package version first; otherwise unrelated integrations have no prescribed order. Each exact Registry version, package-specific tag, and GitHub Release is handled manually. The repository contains no automated publication workflow.

## License

MIT
