import { defineHook } from '@tokenroll/acplugin-extension-hooks';

/** 展示停止扩展点；playground 不执行知识提交或延长会话。 */
export default defineHook({
  event: 'Stop',
  /** no-op 不延长会话，也不执行知识提交。 */
  run() {},
});
