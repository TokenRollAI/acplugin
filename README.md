# acplugin

[中文文档](./README.zh-CN.md)

acplugin is a canonical AI plugin framework and CLI. You author Commands, Skills, Agents, optional Hooks, and optional MCP servers once; acplugin builds Platform-owned deliveries for Claude Code, Codex, Cursor, Antigravity, OpenCode, and Pi.

This is not a Claude-project converter. The canonical project is the source of truth, and each Platform owns its final manifest, paths, compatibility decisions, and deterministic serialization. Legacy Claude projects and plugins are handled separately by `acplugin migrate`.

## Requirements

- Node.js 20 or newer
- pnpm for generated projects and this repository

## Quick start

```bash
pnpm dlx @tokenroll/acplugin init my-plugin --yes
cd my-plugin
pnpm install
pnpm build
```

Or add the CLI to an existing empty project:

```bash
pnpm add -D @tokenroll/acplugin
```

```ts
// acplugin.config.ts
import { defineConfig } from '@tokenroll/acplugin';

export default defineConfig({
  name: 'my-plugin',
  version: '1.0.0',
  description: 'Reusable AI workflows.',
});
```

The default build produces both `dist/claude-code` and `dist/codex`. Cursor, Antigravity, OpenCode, and Pi are opt-in because their compatibility and delivery types differ.

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
    └── mcp/                        # only with the MCP Extension
        └── docs/mcp.ts
```

IDs and directory names use lowercase kebab-case. Markdown Components require YAML Frontmatter and a non-empty body. Symlinks and paths escaping the project are rejected.

acplugin deliberately has no Instructions Component. Repository-wide instructions are host/project configuration, not an installable plugin capability.

## Configuration

`acplugin.config.ts` exports an object or a sync/async function receiving `{ command, mode }`.

```ts
import { claudeCode, codex, defineConfig } from '@tokenroll/acplugin';

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
| `platforms` | Platform factory list; defaults to Claude Code and Codex. |
| `extensions` | Optional horizontal capabilities such as Hooks and MCP. |
| `build.outDir` | Managed output directory; defaults to `dist`. |
| `build.strict` | Fail on degraded/unsupported compatibility; defaults to `true`. |

All built-in Platform factories are exported from the main package:

```ts
import { antigravity, claudeCode, codex, cursor, openCode, pi } from '@tokenroll/acplugin';

const platforms = [claudeCode(), codex(), cursor(), antigravity(), openCode(), pi()];
```

Claude Code, Codex, Cursor, and Antigravity emit static Plugin delivery units. OpenCode emits a workspace overlay; Pi emits an npm package. `acplugin init --platform <id...>` writes the selected factories explicitly.

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

Codex installable plugins cannot register custom project/user Agents. Therefore an Agent makes a strict Codex build fail; `--no-strict` emits the fallback and a structured warning instead of silently claiming native support.

See the [complete compatibility matrix](./llmdoc/reference/conversion-matrix.md) for delivery units, every portable Hook event, and MCP transport support.

## Hooks Extension

```bash
pnpm add -D @tokenroll/acplugin-extension-hooks
```

```ts
import { defineConfig } from '@tokenroll/acplugin';
import hooks from '@tokenroll/acplugin-extension-hooks';

export default defineConfig({
  name: 'policy-plugin',
  version: '1.0.0',
  description: 'Portable policy hooks.',
  extensions: [hooks()],
});
```

```ts
// src/hooks/policy/hook.ts
import { defineHook } from '@tokenroll/acplugin-extension-hooks';

export default defineHook({
  event: 'PreToolUse',
  matcher: 'Bash',
  timeout: 5,
  async run(input) {
    return input.cwd
      ? { decision: 'allow' }
      : { decision: 'deny', reason: 'Missing working directory.' };
  },
});
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

acplugin bundles each handler once as platform-neutral Node 20 ESM. Every Platform Adapter contributes a verified static or runtime integration and an adjacent `wire.mjs` for native input validation, recursive camelCase conversion, and output mapping; the shared Handler owns bounded JSON I/O, semantic result validation, safe failures, and deterministic third-party license notices. Meaningful matchers ignored by the selected host are reported per Hook as `degraded`; unsupported events generate no fake runtime.

## MCP Extension

```bash
pnpm add -D @tokenroll/acplugin-extension-mcp
```

```ts
import { defineConfig } from '@tokenroll/acplugin';
import mcp from '@tokenroll/acplugin-extension-mcp';

export default defineConfig({
  name: 'tools-plugin',
  version: '1.0.0',
  description: 'Portable MCP tools.',
  extensions: [mcp()],
});
```

Remote Streamable HTTP server:

```ts
// src/mcp/docs/mcp.ts
import { defineMcpServer } from '@tokenroll/acplugin-extension-mcp';

export default defineMcpServer({
  transport: 'http',
  url: 'https://example.com/mcp',
  auth: { type: 'bearer', env: 'DOCS_TOKEN' },
  headers: { 'X-Tenant': { env: 'TENANT_ID' } },
});
```

Local stdio server:

```ts
// src/mcp/local-tools/mcp.ts
import { defineMcpServer } from '@tokenroll/acplugin-extension-mcp';

export default defineMcpServer({
  transport: 'stdio',
  entry: 'server.ts',
  env: { API_TOKEN: { env: 'LOCAL_API_TOKEN' } },
});
```

For local MCP, you provide a complete stdio MCP implementation in `server.ts`; acplugin bundles it for Node 20 ESM. The build rejects unresolved runtime dynamic imports, starts the bundle with only declared literal environment values, and requires a bounded `initialize → initialized → tools/list` smoke test to pass. Referenced secret values are never read. For HTTP MCP, you declare the remote endpoint and auth/header references—there is no local server implementation to provide. Production HTTP endpoints require HTTPS; development permits loopback HTTP.

Claude Code, Codex, and OpenCode support both remote HTTP and bundled local stdio. Cursor and Antigravity support remote HTTP only; Pi reports MCP unsupported. See the [complete compatibility matrix](./llmdoc/reference/conversion-matrix.md).

## Extension lifecycle

All Extensions participate in the same Core-owned pipeline:

```text
configResolved → buildStart → discover → validate → build → Platform prepare → Adapter → Platform generate/validate → buildEnd
```

Extensions use only their provided work directory. A build can register every source/dependency it actually reads with `context.addWatchFile()` so `dev` follows the complete graph. Platform Adapters can emit Artifacts, add fields at declared Document extension points, and report compatibility; they cannot replace the Platform pipeline or write `dist` directly. `buildEnd` always runs in reverse initialized order.

## CLI

```text
acplugin init [directory]
acplugin dev
acplugin validate
acplugin inspect
acplugin build
acplugin migrate <source> [destination]
```

Common project options include `--config`, `--platform`, `--mode`, `--no-strict`, and `--json`.

- `validate` runs complete Platform generation and materialization validation without writing `dist`.
- `inspect` adds detailed Artifact metadata without writing `dist`.
- `build` atomically replaces the complete managed `dist` only after every selected Platform succeeds.
- `dev` watches config, Components, Public files, descriptors, and Extension-registered bundle dependencies. It performs a catch-up build after each new watcher becomes ready, retains the last successful output after failures, and rebuilds after recovery.
- Bare `acplugin` prints Help and never prompts.

Exit codes are `0` success, `1` project/build/migration failure, `2` CLI usage or internal framework failure, and `130` cancellation. JSON mode writes one schema-versioned document to stdout for non-watch commands; diagnostics/logs use stderr.

## Deterministic output and security

- Artifacts are immutable regular files with an owner, mode, size, and SHA-256.
- Absolute/traversal paths, symlinks, path collisions, and sources outside approved roots are rejected.
- Builds use a same-filesystem stage, lock, transaction record, backup, and whole-output swap.
- Any Platform failure preserves the previous complete `dist`.
- Generated files and reports contain no timestamps, temporary paths, environment values, or credentials.
- Extension source under `src/hooks` or `src/mcp` without its Extension enabled is an error.

## Legacy Migration

Migration is CLI-only, lazy-loaded, and isolated from Core/Platforms/normal startup.

```bash
acplugin migrate ./legacy-project ./new-plugin \
  --name new-plugin \
  --description "Migrated plugin"

acplugin migrate owner/repository ./new-workspace --all
```

Supported sources include local Claude projects, single plugins, marketplaces, and supported GitHub forms. `--plugin <name>` writes one canonical project directly at the destination; only `--all` creates a pnpm workspace of independent projects. Skills, Commands, Agents, and portable remote HTTP MCP declarations are mapped where possible. Instructions, raw Hooks, Hook implementation files, local external-command MCP, and unsupported resources are preserved under `.acplugin-migration/unmapped/` with a stable report and manual actions. Every generated project is loaded through the public API and runs real Extension/Platform validation before atomic commit. Migration never writes in place.

Use `--dry-run` for scan/map/validation without destination writes and `--strict` to fail on any degraded or unmapped item.

## Packages and repository development

Public packages:

- `@tokenroll/acplugin`
- `@tokenroll/acplugin-extension-hooks`
- `@tokenroll/acplugin-extension-mcp`

Core, built-in Platform implementations, and the Vitest integration workspace are private packages bundled or excluded from public runtime manifests.

```bash
pnpm install
pnpm run check
pnpm run release:verify
```

`release:verify` creates pnpm tarballs, inspects their files/manifests and type resolution, installs all three into a clean external consumer, builds the default project, and creates/builds a six-Platform/two-Extension scaffold. It performs no npm publication.

Pull requests automatically run lint and typecheck. The manually dispatched `Patch` workflow accepts a target branch containing at least one effective Changeset that bumps a public package, consumes its Changesets to bump versions and generate changelogs, and opens a version PR back to that branch.

Every npm release is manual. A maintainer publishes the verified tarballs in Hooks → MCP → main order, verifies each exact Registry version, and only then manually creates the matching `tokenroll-vX.Y.Z` tag and GitHub Release. The repository contains no automated publication workflow.

## License

MIT
