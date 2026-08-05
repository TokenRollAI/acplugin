# @tokenroll/acplugin

Canonical AI plugin framework and CLI for building installable Claude Code and Codex plugins from one source project.

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

The default build targets are `claude-code` and `codex`. Commands and Agents are adapted explicitly when the target has no equivalent native plugin component.

```bash
pnpm exec acplugin validate
pnpm exec acplugin inspect
pnpm exec acplugin build
```

Hooks and MCP are optional official Modules:

```bash
pnpm add -D @tokenroll/acplugin-module-hooks @tokenroll/acplugin-module-mcp
```

See the [repository documentation](https://github.com/TokenRollAI/acplugin#readme) for the complete authoring schema, compatibility rules, Migration workflow, and security model.

## License

MIT
