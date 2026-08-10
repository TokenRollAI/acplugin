import { defineHook } from '@tokenroll/acplugin-extension-hooks';

/** 展示压缩前扩展点；playground 不保存续接状态或阻止压缩。 */
export default defineHook({
  event: 'PreCompact',
  /** 明确允许压缩，也不产生虚假的续接状态。 */
  run() {
    return {
      decision: 'continue',
      reason: 'The template has no runtime state that must be persisted before compaction.',
    };
  },
});
