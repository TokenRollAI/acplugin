# @tokenroll/acplugin-platform-cursor

Cursor Platform package for `@tokenroll/acplugin`.

```bash
pnpm add -D @tokenroll/acplugin @tokenroll/acplugin-platform-cursor
```

```ts
import { defineConfig } from '@tokenroll/acplugin';
import cursor from '@tokenroll/acplugin-platform-cursor';

export default defineConfig({
  name: 'my-plugin',
  version: '1.0.0',
  description: 'Reusable AI workflows.',
  platforms: [cursor()],
});
```

The package also exports the named `cursor` factory, its option types, `PLATFORM_ID`, and `PLATFORM_API_VERSION`.

## License

MIT
