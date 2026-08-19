import type { Hook } from '@tokenroll/acplugin-extension-hooks';

/** 展示压缩后的继续决策，不声称已恢复真实 runtime 状态。 */
export default {
  event: 'PostCompact',
  /** 返回压缩完成后的继续决策。 */
  run() {
    return {
      decision: 'continue',
      reason: 'The static template has no continuation state to restore.',
    };
  },
} satisfies Hook<'PostCompact'>;
