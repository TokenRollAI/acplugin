import type { Hook } from '@tokenroll/acplugin-extension-hooks';

/** 展示子代理结束时的 finish 决策。 */
export default {
  event: 'SubagentStop',
  /** 返回子代理结束时的完成决策。 */
  run() {
    return {
      decision: 'finish',
      reason: 'No additional playground-only work is required.',
    };
  },
} satisfies Hook<'SubagentStop'>;
