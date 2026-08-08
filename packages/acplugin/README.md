# @tokenroll/acplugin

Canonical AI plugin framework, public lifecycle SDK, and CLI. Platform and Extension implementations are independently installed peer packages.

Requires Node.js `^20.19.0 || ^22.13.0 || >=23.5.0`.

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

```text
src/
├── commands/*.md
├── skills/*/SKILL.md
└── agents/*.md
public/
acplugin.config.ts
```

`platforms` is required and there is no runtime default. `init` selects Claude Code and Codex only as a scaffolding default, writing their dependencies and imports explicitly. Select all six during scaffolding with:

```bash
pnpm exec acplugin init my-plugin --yes \
  --platform claude-code codex cursor antigravity opencode pi
```

Or install and configure the independent packages directly:

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

Claude Code, Codex, Cursor, and Antigravity produce Plugin delivery units. OpenCode produces a workspace overlay; Pi produces an npm package. The compatibility report records native, transformed, degraded, and unsupported behavior before any managed output is committed.

The main package does not re-export official Platforms or Extensions and has no `platforms/*` subpath. Official packages use the same `definePlatform()` and Adapter contracts exposed to third-party authors, so the framework does not need a registry, naming convention, or source change to accept another implementation.

Claude Code can be configured as an explicit Platform. Omitting `marketplace` builds only the installable Plugin; `marketplace: {}` additionally creates a self-contained single-Plugin Marketplace from the top-level metadata.

Claude Code 可以作为显式 Platform 配置。省略 `marketplace` 时只构建可安装 Plugin；配置 `marketplace: {}` 时，会从顶层元数据推导并额外生成一个自包含的单 Plugin Marketplace。

```ts
import { defineConfig } from '@tokenroll/acplugin';
import claudeCode from '@tokenroll/acplugin-platform-claude-code';

export default defineConfig({
  name: 'my-plugin',
  version: '1.0.0',
  description: 'Reusable AI workflows.',
  author: { name: 'TokenRoll', email: 'maintainers@example.com' },
  platforms: [
    claudeCode({
      marketplace: {
        owner: { name: 'TokenRoll' },
        category: 'Developer Tools',
        tags: ['workflow'],
      },
    }),
  ],
});
```

The Claude Code output uses `.claude-plugin/plugin.json`, `commands/`, `skills/`, and `agents/`. Hooks and MCP remain independent Extensions: the Platform only exposes validated `hooks` and `mcpServers` manifest extension points and never imports those Extension packages.

Claude Code 产物使用 `.claude-plugin/plugin.json`、`commands/`、`skills/` 与 `agents/`。Hooks 和 MCP 仍是独立 Extension：Platform 只提供经过校验的 `hooks` 与 `mcpServers` 清单扩展点，不依赖对应 Extension 包。

```bash
pnpm exec acplugin validate
pnpm exec acplugin inspect
pnpm exec acplugin build
```

Hooks and MCP are optional official Extensions（Hooks 与 MCP 通过可选的官方 Extension 启用）. Their Platform Adapters are included in the Extension packages, while each Platform remains independent of them:

```bash
pnpm add -D @tokenroll/acplugin-extension-hooks @tokenroll/acplugin-extension-mcp
```

See the [repository documentation](https://github.com/TokenRollAI/acplugin#readme) for the complete authoring schema, compatibility rules, Migration workflow, and security model.

## License

MIT
