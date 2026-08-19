import type { Hook } from '@tokenroll/acplugin-extension-hooks';

/** 展示用户提示提交前的允许决策和上下文补充。 */
export default {
  event: 'UserPromptSubmit',
  /** 返回允许用户提示继续处理的决策。 */
  run() {
    return {
      decision: 'allow',
      reason: 'The playground does not restrict author prompts.',
      additionalContext: 'Keep conclusions tied to files that exist in this template repository.',
    };
  },
} satisfies Hook<'UserPromptSubmit'>;
