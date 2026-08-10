import { defineHook } from '@tokenroll/acplugin-extension-hooks';

/** 展示子代理启动时的上下文补充。 */
export default defineHook({
  event: 'SubagentStart',
  /** 返回子代理启动时的模板上下文。 */
  run() {
    return {
      additionalContext: 'Use the investigator, recorder, and reflector roles as template guidance only.',
      systemMessage: 'ACPlugin playground subagent template activated.',
    };
  },
});
