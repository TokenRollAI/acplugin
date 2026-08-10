import { defineHook } from '@tokenroll/acplugin-extension-hooks';

/** 覆盖 matcher、timeout、statusMessage 和 Codex 上下文上限等 Hook 配置字段。 */
export default defineHook({
  event: 'PreToolUse',
  matcher: '^(Read|Glob|Grep|read|glob|grep)$',
  timeout: 15,
  statusMessage: 'Checking a read-only playground tool call.',
  platforms: {
    codex: { additionalContextLimit: 512 },
    cursor: { timeout: 10 },
    antigravity: { timeout: 10 },
    opencode: { timeout: 10 },
    pi: { timeout: 10 },
  },
  /** 只展示允许决策，不改写原始工具输入。 */
  run() {
    return {
      decision: 'allow',
      reason: 'The configured matcher only selects read-oriented tools.',
      additionalContext: 'Treat generated Platform output as build artifacts, not canonical author input.',
    };
  },
});
