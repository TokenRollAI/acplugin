# @tokenroll/acplugin-module-hooks

Official optional Hooks Module for `@tokenroll/acplugin`. It bundles local TypeScript handlers into installable Node.js runners for Claude Code and Codex.

```ts
// acplugin.config.ts
import { defineConfig } from '@tokenroll/acplugin';
import hooks from '@tokenroll/acplugin-module-hooks';

export default defineConfig({
  name: 'policy-plugin',
  version: '1.0.0',
  description: 'Portable local policy hooks.',
  modules: [hooks()],
});
```

```ts
// src/hooks/policy/hook.ts
import { defineHook } from '@tokenroll/acplugin-module-hooks';

export default defineHook({
  event: 'PreToolUse',
  matcher: 'Bash',
  async run(input) {
    return input.cwd ? { decision: 'allow' } : { decision: 'deny', reason: 'Missing working directory.' };
  },
});
```

Handlers receive normalized input and return semantic decisions. acplugin owns target protocol mapping, bounded JSON I/O, error redaction, executable bundling, and third-party license notices.

See the [Hooks documentation](https://github.com/TokenRollAI/acplugin#hooks-module) for the portable and target-specific event matrix.

## License

MIT
