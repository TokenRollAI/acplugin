# @tokenroll/acplugin-platform-claude-code

Claude Code Platform package for `@tokenroll/acplugin`.

```bash
pnpm add -D @tokenroll/acplugin @tokenroll/acplugin-platform-claude-code
```

```ts
import { defineConfig } from '@tokenroll/acplugin';
import claudeCode from '@tokenroll/acplugin-platform-claude-code';

export default defineConfig({
  name: 'my-plugin',
  version: '1.0.0',
  description: 'Reusable AI workflows.',
  platforms: [claudeCode()],
});
```

The package also exports the named `claudeCode` factory, its option types, `ClaudePackageComponent`, `ClaudeNativeAgentComponent`, `PLATFORM_ID`, and `PLATFORM_API_VERSION`.

`ClaudePackageComponent` is for trusted Extension contributors that need Claude-native private delivery. It is not a Canonical Agent or a raw Manifest escape hatch: Claude Code validates and renders it during Package finalization.

## License

MIT
