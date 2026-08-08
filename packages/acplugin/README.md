# @tokenroll/acplugin

Canonical AI plugin framework and CLI for building Claude Code, Codex, Cursor, Antigravity, OpenCode, and Pi deliveries from one source project.

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

```text
src/
├── commands/*.md
├── skills/*/SKILL.md
└── agents/*.md
public/
acplugin.config.ts
```

The default Platforms are `claude-code` and `codex`. Commands and Agents are adapted explicitly when a Platform has no equivalent native component. Select all six during scaffolding with:

```bash
pnpm exec acplugin init my-plugin --yes \
  --platform claude-code codex cursor antigravity opencode pi
```

Or configure exported factories directly:

```ts
import { antigravity, claudeCode, codex, cursor, defineConfig, openCode, pi } from '@tokenroll/acplugin';

export default defineConfig({
  name: 'my-plugin',
  version: '1.0.0',
  description: 'Reusable AI workflows.',
  platforms: [claudeCode(), codex(), cursor(), antigravity(), openCode(), pi()],
  build: { strict: false },
});
```

Claude Code, Codex, Cursor, and Antigravity produce Plugin delivery units. OpenCode produces a workspace overlay; Pi produces an npm package. The compatibility report records native, transformed, degraded, and unsupported behavior before any managed output is committed.

Claude Code can be configured as an explicit Platform. Omitting `marketplace` builds only the installable Plugin; `marketplace: {}` additionally creates a self-contained single-Plugin Marketplace from the top-level metadata.

Claude Code 可以作为显式 Platform 配置。省略 `marketplace` 时只构建可安装 Plugin；配置 `marketplace: {}` 时，会从顶层元数据推导并额外生成一个自包含的单 Plugin Marketplace。

```ts
import { claudeCode, defineConfig } from '@tokenroll/acplugin';

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
