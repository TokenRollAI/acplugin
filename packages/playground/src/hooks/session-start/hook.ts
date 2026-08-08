import { defineHook } from '@tokenroll/acplugin-extension-hooks';

/** 展示会话开始扩展点；playground 不加载 llmdoc runtime。 */
export default defineHook({
  event: 'SessionStart',
  /** no-op 保持宿主会话流程不变。 */
  run() {},
});
