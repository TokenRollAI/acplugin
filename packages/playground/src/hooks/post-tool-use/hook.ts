import { defineHook } from '@tokenroll/acplugin-extension-hooks';

/** 展示工具执行后的 pass 决策和非阻断上下文。 */
export default defineHook({
  event: 'PostToolUse',
  /** 返回工具执行后的非阻断观察结果。 */
  run() {
    return {
      decision: 'pass',
      reason: 'The playground only observes successful tool completion.',
      additionalContext: 'Verify claims against canonical source and the generated delivery together.',
    };
  },
});
