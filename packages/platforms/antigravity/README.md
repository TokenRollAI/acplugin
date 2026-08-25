# @tokenroll/acplugin-platform-antigravity

Antigravity Platform package for `@tokenroll/acplugin`.

```bash
pnpm add -D @tokenroll/acplugin @tokenroll/acplugin-platform-antigravity
```

```ts
import { defineConfig } from '@tokenroll/acplugin';
import antigravity from '@tokenroll/acplugin-platform-antigravity';

export default defineConfig({
  name: 'my-plugin',
  version: '1.0.0',
  description: 'Reusable AI workflows.',
  platforms: [antigravity()],
});
```

The package also exports the named `antigravity` factory, its option types, `PLATFORM_ID`, and `PLATFORM_API_VERSION`.

Antigravity does not currently expose a Platform Component Contribution payload. A non-empty private component contribution fails during Package finalization rather than being silently converted to a Skill.

## License

MIT
