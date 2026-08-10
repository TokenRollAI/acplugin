import { defineHook } from '@tokenroll/acplugin-extension-hooks';

/** 展示停止扩展点；Playground 不执行业务写入或延长会话。 */
export default defineHook({
  event: 'Stop',
  /** 明确完成，不延长会话，也不执行业务写入。 */
  run() {
    return {
      decision: 'finish',
      reason: 'The capability template has no product-specific work to commit.',
    };
  },
});
