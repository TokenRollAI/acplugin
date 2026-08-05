# Using acplugin

> [中文对照](usage.zh-CN.md)

acplugin projects author one canonical plugin and compile installable Claude Code and Codex packages. Node.js 20 or newer and pnpm are required.

## Create a project

```bash
pnpm dlx @tokenroll/acplugin init my-plugin --yes
cd my-plugin
pnpm install
pnpm build
```

`init` can add the official Hooks and MCP Modules with `--hooks` and `--mcp`. The default configuration builds both targets and uses `src/`, `public/`, and `dist/`.

## Author Components

Put Commands in `src/commands/<id>.md`, Skills in `src/skills/<id>/SKILL.md`, and Agents in `src/agents/<id>.md`. Component IDs use lowercase kebab-case. Markdown files require YAML Frontmatter and a non-empty body.

The required top-level identity belongs directly in `acplugin.config.ts`:

```ts
import { defineConfig } from '@tokenroll/acplugin';

export default defineConfig({
  name: 'my-plugin',
  version: '1.0.0',
  description: 'Reusable AI workflows.',
});
```

There is no Instructions Component. Hooks and MCP directories are accepted only when their official Module is enabled.

The TypeScript config and enabled Hook/MCP descriptors are trusted executable project code. Review them like build scripts. Legacy Migration sources are scanned as untrusted data and are not executed as descriptors.

## Validate and build

```bash
pnpm exec acplugin validate
pnpm exec acplugin inspect
pnpm exec acplugin build
pnpm exec acplugin dev
```

- `validate` generates and materializes every selected target in temporary storage without changing `dist`.
- `inspect` adds Artifact details without changing `dist`.
- `build` atomically replaces the complete managed output only after every target succeeds.
- `dev` watches inputs, coalesces changes, and retains the last successful output after a failed rebuild.

Common options are `--config`, repeatable `--target`, `--mode`, `--no-strict`, and `--json`. Strict mode is on by default. For example, a Codex build containing an Agent fails because Codex can only receive an explicit degraded Skill fallback; use `--no-strict` when that result is intentional.

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

Migration also accepts supported GitHub forms, single Claude plugins, and marketplaces. Use `--dry-run` to avoid destination writes and `--strict` to fail on any degraded or unmapped resource. Non-portable resources are preserved under `.acplugin-migration/unmapped/` with a report; Migration never writes in place.
