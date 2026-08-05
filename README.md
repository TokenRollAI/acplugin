# acplugin

[中文文档](./README.zh-CN.md)

acplugin is a canonical AI plugin framework and CLI. You author Commands, Skills, Agents, optional Hooks, and optional MCP servers once; acplugin builds complete installable plugins for Claude Code and Codex.

This is not a Claude-project converter. The canonical project is the source of truth, and each target Compiler owns its final manifest, paths, compatibility decisions, and deterministic serialization. Legacy Claude projects and plugins are handled separately by `acplugin migrate`.

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

The default build produces both `dist/claude-code` and `dist/codex`.

`acplugin.config.ts`, Hook descriptors, and MCP descriptors are trusted executable project code loaded by the local Node.js process. Review them with the same care as build scripts; Migration input remains untrusted data and is never executed as canonical descriptor code.

## Canonical project

```text
my-plugin/
├── acplugin.config.ts
├── package.json
├── public/                         # optional files copied to each target root
└── src/
    ├── commands/
    │   └── review.md
    ├── skills/
    │   └── review/
    │       ├── SKILL.md
    │       └── references/         # copied with the Skill
    ├── agents/
    │   └── reviewer.md
    ├── hooks/                      # only with the Hooks Module
    │   └── policy/hook.ts
    └── mcp/                        # only with the MCP Module
        └── docs/mcp.ts
```

IDs and directory names use lowercase kebab-case. Markdown Components require YAML Frontmatter and a non-empty body. Symlinks and paths escaping the project are rejected.

acplugin deliberately has no Instructions Component. Repository-wide instructions are host/project configuration, not an installable plugin capability.

## Configuration

`acplugin.config.ts` exports an object or a sync/async function receiving `{ command, mode }`.

```ts
import { defineConfig } from '@tokenroll/acplugin';

export default defineConfig(({ mode }) => ({
  name: 'team-review',
  version: '1.0.0',
  description: 'Shared review workflows.',
  displayName: 'Team Review',
  targets: [
    'claude-code',
    { id: 'codex', strict: mode === 'production' },
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
| `targets` | Target set; defaults to Claude Code and Codex. |
| `modules` | Lifecycle Modules such as Hooks and MCP. |
| `build.outDir` | Managed output directory; defaults to `dist`. |
| `build.strict` | Fail on degraded/unsupported compatibility; defaults to `true`. |
| `extensions` | Explicit target-specific escape hatch. |

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

| Component | Claude Code | Codex |
| --- | --- | --- |
| Skill | Native | Native |
| Command | Native Command | Explicit `command-<id>` Skill |
| Agent | Native Agent | Degraded model-only `agent-<id>` fallback Skill |

Codex installable plugins cannot register custom project/user Agents. Therefore an Agent makes a strict Codex build fail; `--no-strict` emits the fallback and a structured warning instead of silently claiming native support.

## Hooks Module

```bash
pnpm add -D @tokenroll/acplugin-module-hooks
```

```ts
import { defineConfig } from '@tokenroll/acplugin';
import hooks from '@tokenroll/acplugin-module-hooks';

export default defineConfig({
  name: 'policy-plugin',
  version: '1.0.0',
  description: 'Portable policy hooks.',
  modules: [hooks()],
});
```

```ts
// src/hooks/policy/hook.ts
import { defineHook } from '@tokenroll/acplugin-module-hooks';

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

Claude-only events are accepted for Claude builds and reported unsupported for Codex:

```text
Setup, UserPromptExpansion, PermissionDenied, PostToolUseFailure, PostToolBatch,
Notification, MessageDisplay, TaskCreated, TaskCompleted, StopFailure,
TeammateIdle, InstructionsLoaded, ConfigChange, CwdChanged, DirectoryAdded,
FileChanged, WorktreeCreate, WorktreeRemove, Elicitation, ElicitationResult
```

acplugin bundles each handler, normalizes target input, validates semantic results, bounds JSON I/O, emits concise redacted runtime failures, and includes deterministic third-party license notices when needed. See the current [Claude Code Hooks](https://code.claude.com/docs/en/hooks) and [Codex Hooks](https://learn.chatgpt.com/docs/hooks) references for target behavior.

## MCP Module

```bash
pnpm add -D @tokenroll/acplugin-module-mcp
```

```ts
import { defineConfig } from '@tokenroll/acplugin';
import mcp from '@tokenroll/acplugin-module-mcp';

export default defineConfig({
  name: 'tools-plugin',
  version: '1.0.0',
  description: 'Portable MCP tools.',
  modules: [mcp()],
});
```

Remote Streamable HTTP server:

```ts
// src/mcp/docs/mcp.ts
import { defineMcpServer } from '@tokenroll/acplugin-module-mcp';

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
import { defineMcpServer } from '@tokenroll/acplugin-module-mcp';

export default defineMcpServer({
  transport: 'stdio',
  entry: 'server.ts',
  env: { API_TOKEN: { env: 'LOCAL_API_TOKEN' } },
});
```

For local MCP, you provide a complete stdio MCP implementation in `server.ts`; acplugin bundles it for Node 20 ESM. For HTTP MCP, you declare the remote endpoint and auth/header references—there is no local server implementation to provide. Secret environment values are never read during build. Production HTTP endpoints require HTTPS; development permits loopback HTTP.

See [Claude Code MCP](https://code.claude.com/docs/en/mcp) and [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp).

## Module lifecycle

All Modules use the same Core-owned pipeline:

```text
configResolved → discover → validate → build → generate(target) → buildEnd
```

Modules may declare `dependsOn`, use only their provided work directory, and contribute Artifacts, owned manifest fields, and compatibility results. They do not replace the Compiler or write `dist` directly. `buildEnd` always runs in reverse initialized order.

## CLI

```text
acplugin init [directory]
acplugin dev
acplugin validate
acplugin inspect
acplugin build
acplugin migrate <source> [destination]
```

Common project options include `--config`, `--target`, `--mode`, `--no-strict`, and `--json`.

- `validate` runs complete target generation and materialization validation without writing `dist`.
- `inspect` adds detailed Artifact metadata without writing `dist`.
- `build` atomically replaces the complete managed `dist` only after every selected target succeeds.
- `dev` watches project inputs, retains the last successful output after failures, and rebuilds after recovery.
- Bare `acplugin` prints Help and never prompts.

Exit codes are `0` success, `1` project/build/migration failure, `2` CLI usage or internal framework failure, and `130` cancellation. JSON mode writes one schema-versioned document to stdout for non-watch commands; diagnostics/logs use stderr.

## Deterministic output and security

- Artifacts are immutable regular files with an owner, mode, size, and SHA-256.
- Absolute/traversal paths, symlinks, path collisions, and sources outside approved roots are rejected.
- Builds use a same-filesystem stage, lock, transaction record, backup, and whole-output swap.
- Any target failure preserves the previous complete `dist`.
- Generated files and reports contain no timestamps, temporary paths, environment values, or credentials.
- Module source under `src/hooks` or `src/mcp` without its Module enabled is an error.

## Legacy Migration

Migration is CLI-only, lazy-loaded, and isolated from Core/Compilers/normal startup.

```bash
acplugin migrate ./legacy-project ./new-plugin \
  --name new-plugin \
  --description "Migrated plugin"

acplugin migrate owner/repository ./new-workspace --all
```

Supported sources include local Claude projects, single plugins, marketplaces, and supported GitHub forms. Skills, Commands, Agents, and portable remote HTTP MCP declarations are mapped where possible. Instructions, raw Hooks, Hook implementation files, local external-command MCP, and unsupported resources are preserved under `.acplugin-migration/unmapped/` with a stable report and manual actions. Migration never writes in place.

Use `--dry-run` for scan/map/validation without destination writes and `--strict` to fail on any degraded or unmapped item.

## Packages and repository development

Public packages:

- `@tokenroll/acplugin`
- `@tokenroll/acplugin-module-hooks`
- `@tokenroll/acplugin-module-mcp`

Core, Claude/Codex Compilers, and the Vitest integration workspace are private implementation packages bundled or excluded from public runtime manifests.

```bash
pnpm install
pnpm run check
pnpm run release:verify
```

`release:verify` creates pnpm tarballs, inspects their files/manifests, installs all three into a clean external consumer, typechecks its config, imports the API, and builds both target plugins. It performs no npm publication.

The first npm release is a manual 2FA bootstrap from verified tarballs. Later `tokenroll-vX.Y.Z` tags use the protected OIDC workflow, publish Modules before the main package, verify exact registry versions, and only then create the GitHub Release.

## License

MIT
