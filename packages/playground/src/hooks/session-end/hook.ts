import { defineHook } from '@tokenroll/acplugin-extension-hooks';

/** 展示会话结束 advisory，不执行写入或清理副作用。 */
export default defineHook({
  event: 'SessionEnd',
  /** 返回无副作用的会话结束提示。 */
  run() {
    return { systemMessage: 'ACPlugin playground session finished without persistent runtime state.' };
  },
});
