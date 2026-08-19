import type { Hook } from '@tokenroll/acplugin-extension-hooks';

/** 展示会话开始扩展点；只追加能力模板的边界说明。 */
export default {
  event: 'SessionStart',
  statusMessage: 'Loading the ACPlugin playground boundary.',
  /** 明确继续会话，并提供可移植的上下文和 advisory 结果。 */
  run() {
    return {
      decision: 'continue',
      reason: 'The playground only contributes static template guidance.',
      additionalContext: 'This project is an ACPlugin capability template; example handlers do not implement product-specific behavior.',
      systemMessage: 'ACPlugin playground template loaded.',
    };
  },
} satisfies Hook<'SessionStart'>;
