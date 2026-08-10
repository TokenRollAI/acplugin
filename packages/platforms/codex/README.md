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

Commands become explicit Codex Skills named `command-<id>` by default. If a
consumer needs the Plugin name to remain visible in each generated Command
Skill ID, opt in without changing the canonical Command:

```ts
codex({
  generatedSkillIds: {
    command: 'plugin-prefixed',
  },
})
```

For Plugin `my-plugin`, Command `bootstrap` then becomes
`skills/my-plugin-bootstrap/SKILL.md`. The default remains
`skills/command-bootstrap/SKILL.md`; templates and per-Command overrides are
not supported.

The package also exports the named `codex` factory, its option types, `PLATFORM_ID`, and `PLATFORM_API_VERSION`.

## License

MIT
