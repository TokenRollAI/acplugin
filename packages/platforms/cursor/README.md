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

The package also exports the named `cursor` factory, its option types, `CursorPackageComponent`, `CursorNativeAgentComponent`, `PLATFORM_ID`, and `PLATFORM_API_VERSION`.

`CursorPackageComponent` is for trusted Extension contributors that need Cursor-native private delivery. Cursor validates and renders it during Package finalization; it does not permit raw Plugin Manifest patches.

## License

MIT
