# @tokenroll/acplugin-platform-opencode

OpenCode Platform package for `@tokenroll/acplugin`.

```bash
pnpm add -D @tokenroll/acplugin @tokenroll/acplugin-platform-opencode
```

```ts
import { defineConfig } from '@tokenroll/acplugin';
import openCode from '@tokenroll/acplugin-platform-opencode';

export default defineConfig({
  name: 'my-plugin',
  version: '1.0.0',
  description: 'Reusable AI workflows.',
  platforms: [openCode()],
});
```

The package also exports the named `openCode` factory, its option types, `OpenCodePackageComponent`, `OpenCodeNativeAgentComponent`, `PLATFORM_ID`, and `PLATFORM_API_VERSION`.

`OpenCodePackageComponent` is for trusted Extension contributors that need native workspace delivery. OpenCode owns its validation and rendering and does not create a synthetic Plugin Manifest for it.

## License

MIT
