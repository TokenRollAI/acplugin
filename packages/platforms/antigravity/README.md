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

## License

MIT
