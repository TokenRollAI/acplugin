# @tokenroll/acplugin-platform-pi

Pi Platform package for `@tokenroll/acplugin`.

```bash
pnpm add -D @tokenroll/acplugin @tokenroll/acplugin-platform-pi
```

```ts
import { defineConfig } from '@tokenroll/acplugin';
import pi from '@tokenroll/acplugin-platform-pi';

export default defineConfig({
  name: 'my-plugin',
  version: '1.0.0',
  description: 'Reusable AI workflows.',
  platforms: [pi()],
});
```

The package also exports the named `pi` factory, its option types, `PLATFORM_ID`, and `PLATFORM_API_VERSION`.

## License

MIT
