# @tokenroll/acplugin-platform-codex

Codex Platform package for `@tokenroll/acplugin`.

```bash
pnpm add -D @tokenroll/acplugin @tokenroll/acplugin-platform-codex
```

```ts
import { defineConfig } from '@tokenroll/acplugin';
import codex from '@tokenroll/acplugin-platform-codex';

export default defineConfig({
  name: 'my-plugin',
  version: '1.0.0',
  description: 'Reusable AI workflows.',
  platforms: [codex()],
});
```

Commands become explicit Codex Skills named `<plugin-name>-<command-id>`.
For Plugin `my-plugin`, Command `bootstrap` is delivered at
`skills/my-plugin-bootstrap/SKILL.md`. Arbitrary templates and per-Command
overrides are intentionally not supported.

The package also exports the named `codex` factory, its option types, `PLATFORM_ID`, and `PLATFORM_API_VERSION`.

## License

MIT
