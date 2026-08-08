# @tokenroll/acplugin-extension-hooks

Portable Hook authoring plus six official Platform adapters for `@tokenroll/acplugin`.

`统一书写 Hook，并由官方 Adapter 构建为六个平台各自支持的静态或运行时产物。`

```bash
pnpm add -D @tokenroll/acplugin @tokenroll/acplugin-extension-hooks
```

```ts
// acplugin.config.ts
import { defineConfig } from '@tokenroll/acplugin';
import hooks from '@tokenroll/acplugin-extension-hooks';

export default defineConfig({
  name: 'my-plugin',
  version: '1.0.0',
  description: 'Reusable AI workflows.',
  extensions: [hooks()],
});
```

Each Hook is a branded TypeScript descriptor at `src/hooks/<id>/hook.ts`:

`每个 Hook 使用独立一级目录，并通过 defineHook 获得事件级输入和结果类型。`

```ts
import { defineHook } from '@tokenroll/acplugin-extension-hooks';

export default defineHook({
  event: 'PreToolUse',
  matcher: 'Bash|Write|Edit',
  timeout: 10,
  platforms: {
    codex: { additionalContextLimit: 2_500 },
  },
  async run(input, context) {
    return input.toolName === 'Bash'
      ? { decision: 'allow' }
      : { decision: 'deny', reason: `Denied on ${context.platform}.` };
  },
});
```

The canonical events are `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`, `SubagentStart`, `SubagentStop`, and `Stop`.

Platform-only events stay explicitly scoped and never expand that union:

`平台专属事件必须显式限定；其他 Platform 不会获得产物或兼容性结论。`

```ts
export default defineHook({
  event: { platform: 'claude-code', name: 'Setup' },
  matcher: 'init',
  run() {},
});
```

acplugin bundles each implementation once as a platform-neutral Node 20 ESM `hooks/<id>/handler.mjs`. Each Adapter emits an adjacent `wire.mjs` that owns its native stdin schema, camelCase conversion, runtime root/data environment mapping, and stdout mapping. The shared Handler validates event-specific results, keeps stdin/stdout within 1 MiB, and emits only stable error codes. Third-party code included in a Handler receives a deterministic `THIRD_PARTY_LICENSES.txt`.

`作者不能声明原始 shell、绝对 executable、HTTP、prompt、agent 或 MCP-tool Handler；平台 wire 协议完全由 Adapter 管理。`

Claude Code uses shell-free exec form (`command: "node"` plus `args`). Codex currently receives a fixed framework-generated command string because its public Hook schema does not expose `args`. A meaningful matcher is reported as `degraded` whenever the selected host silently ignores it, including Claude Code `UserPromptSubmit`/`Stop` and Codex `UserPromptSubmit`/`Stop`; empty Hooks produce no artifacts.

Portable event support:

| Platform | Native | Transformed | Degraded | Unsupported |
| --- | --- | --- | --- | --- |
| Claude Code | all 11 portable events | — | matcher on selected events | — |
| Codex | all 11 portable events | — | matcher on selected events | — |
| Cursor | — | 9 events | field-level matcher/status loss | `PermissionRequest`, `PostCompact` |
| Antigravity | `SessionStart`, `SessionEnd`, `PreToolUse`, `PostToolUse`, `PreCompact` | — | field-level matcher/status loss | remaining 6 events |
| OpenCode | `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostCompact` | — | `SessionEnd`, `Stop` | remaining 4 events |
| Pi | `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PreCompact`, `PostCompact` | — | `Stop` | `PermissionRequest`, `SubagentStart`, `SubagentStop` |

Strict mode rejects degraded or unsupported outcomes; relaxed mode emits only verified runtimes and preserves the full structured report. Empty Hooks produce no Artifact.

Contracts were last rechecked on 2026-08-06 against [Claude Code Hooks](https://code.claude.com/docs/en/hooks), [Codex Hooks](https://learn.chatgpt.com/docs/hooks), [Cursor Hooks](https://cursor.com/docs/agent/hooks), [Antigravity Plugins](https://antigravity.google/docs/plugins?app=cli), [OpenCode Plugins](https://opencode.ai/docs/plugins/), and [Pi Extensions](https://pi.dev/docs/latest/extensions).

## License

MIT
