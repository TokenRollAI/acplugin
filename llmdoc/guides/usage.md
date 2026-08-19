# Using ACPlugin

> [中文对照](usage.zh-CN.md)

ACPlugin projects author one canonical plugin and compile Platform-owned deliveries for Claude Code, Codex, Cursor, Antigravity, OpenCode, and Pi. Node.js `^20.19.0 || ^22.13.0 || >=23.5.0` and pnpm are required.

## Create a project

```bash
pnpm dlx @tokenroll/acplugin init my-plugin --yes
cd my-plugin
pnpm install
pnpm build
```

`init` can add the official Hooks and MCP Extensions with `--hooks` and `--mcp`; `--node-runtime` generates a built-in conventional `src/runtime/main.ts` entry without adding another package or factory. Without `--platform`, its scaffolding selection is Claude Code and Codex; it still writes both Platform dependencies, imports, and config entries explicitly. Select any supported set instead:

```bash
pnpm dlx @tokenroll/acplugin init my-plugin --yes \
  --platform claude-code codex cursor antigravity opencode pi \
  --hooks --mcp --node-runtime
```

Every selected Platform is an independent package. An enabled Extension similarly adds its dependency, import, config entry, and empty source directory; `init` never invents a Hook handler or MCP server. The built-in Runtime template is actual neutral executable source and relies on Core's default `src/runtime` discovery. The build runtime has no default package discovery or installation behavior.

Known `init` input errors use the stable `INIT_INVALID` diagnostic and preserve a safe actionable reason. The specialized error class remains internal and is not exported from the public facade.

## Author Components

Put Commands in `src/commands/<id>.md`, Skills in `src/skills/<id>/SKILL.md`, and Agents in `src/agents/<id>.md`. Component IDs use lowercase kebab-case. Markdown files require YAML Frontmatter and a non-empty body.

The required top-level identity belongs directly in `acplugin.config.ts`:

```ts
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

There is no Instructions Component. Hooks and MCP directories are accepted only when their official Extension is enabled. `src/runtime` belongs to Core: direct TS/JS files are entries by convention, while `runtime.entries` can replace discovery and `runtime: false` can disable it.

The TypeScript config and enabled Hook/MCP descriptors are trusted executable project code. Review them like build scripts. Legacy Migration sources are scanned as untrusted data and are not executed as descriptors.

## Validate and build

```bash
pnpm exec acplugin validate
pnpm exec acplugin inspect
pnpm exec acplugin build
pnpm exec acplugin dev
```

- `validate` generates and materializes every selected Platform in temporary storage without changing `dist`.
- `inspect` adds Package and Asset details without changing `dist`.
- `build` atomically replaces the complete managed Package set only after every selected Platform succeeds.
- `dev` watches config, canonical resources, Public, descriptors, and the actual Core Module/Build Service graph, including plugin, license, and tsconfig dependencies. Resolved dependencies contribute package roots. Managed bundles reject runtime-computed imports that Rolldown cannot represent in the static module graph. Dev coalesces changes, closes watcher-readiness gaps with a catch-up build, and retains the last successful output after a failed rebuild.

Common options are `--config`, `--platform <id...>`, `--mode`, and `--json`. Strict mode is on by default and is configured through `build.strict` or a Platform factory override. For example, a Codex build containing an Agent fails because Codex can only receive an explicit degraded Skill fallback; use `codex({ strict: false })` when that result is intentional.

To configure Platforms in an existing project, install and import each package explicitly:

```ts
import { defineConfig } from '@tokenroll/acplugin';
import antigravity from '@tokenroll/acplugin-platform-antigravity';
import claudeCode from '@tokenroll/acplugin-platform-claude-code';
import codex from '@tokenroll/acplugin-platform-codex';
import cursor from '@tokenroll/acplugin-platform-cursor';
import openCode from '@tokenroll/acplugin-platform-opencode';
import pi from '@tokenroll/acplugin-platform-pi';

export default defineConfig({
  name: 'my-plugin',
  version: '1.0.0',
  description: 'Reusable AI workflows.',
  platforms: [claudeCode(), codex(), cursor(), antigravity(), openCode(), pi()],
  build: { strict: false },
});
```

`platforms` is required and `--platform <id...>` only filters IDs already instantiated in that list. The main package does not re-export official factories or provide Platform subpaths. OpenCode output is a workspace overlay and Pi output is an npm package. They are not mislabeled as static Plugins. See the [Platform support matrix](../reference/conversion-matrix.md) before enabling strict multi-Platform builds.

Codex transforms Commands into explicit `<plugin-name>-<id>` Skills. For Plugin `my-plugin`, Command `bootstrap` becomes `my-plugin-bootstrap`; this does not change the canonical Command ID or other Platforms.

## Public files

Regular files in `public/` are copied to every target root by default. Use explicit rules when only part of the directory should be copied:

```ts
public: {
  dir: 'public',
  copy: [
    { from: 'assets', to: 'assets' },
    { from: 'NOTICE.md', to: 'NOTICE.md' },
  ],
},
```

Symlinks, traversal, collisions, and sources outside approved roots are rejected.

## Migrate legacy input

```bash
pnpm exec acplugin migrate ./legacy-project ./new-plugin \
  --name new-plugin \
  --description "Migrated plugin"
```

Migration also accepts supported GitHub forms, single Claude plugins, and marketplaces. `--plugin <name>` emits one project at the destination root; `--all` emits a pnpm workspace. Use `--dry-run` to avoid destination writes and `--strict` to fail on any degraded or unmapped resource. Generated projects run through public config loading and real Extension/Platform validation. Non-portable resources are preserved under `.acplugin-migration/unmapped/` with a report; Migration never writes in place.
