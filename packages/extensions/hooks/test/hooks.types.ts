import { defineHook, type HookDefinition } from '../src/index.js';

/** PreToolUse 定义用于验证事件级输入和结果推断。 */
const preToolUse = defineHook({
  event: 'PreToolUse',
  /** 类型检查同时确认运行时上下文使用最终 platform 术语。 */
  run(input, context) {
    /** 从精确事件输入读取的工具名称。 */
    const toolName: string = input.toolName;
    /** 从运行时上下文读取的开放 Platform ID。 */
    const platform: string = context.platform;
    return {
      decision: 'allow',
      reason: `${platform}:${toolName}`,
      updatedInput: { command: 'pnpm test' },
    };
  },
});

/** 品牌化定义仍可赋给公开 HookDefinition 契约。 */
const branded: HookDefinition<'PreToolUse'> = preToolUse;
void branded;

/** Claude Code 专属事件必须使用显式 Platform 对象。 */
defineHook({
  event: { platform: 'claude-code', name: 'Setup' },
  /** 平台事件仍获得共享运行时上下文和扩展输入。 */
  run(input) {
    /** 平台事件输入保留完整事件对象和开放扩展字段。 */
    const platform: string = input.event.platform;
    return { systemMessage: platform };
  },
});

defineHook({
  event: 'SessionEnd',
  // @ts-expect-error SessionEnd 是 advisory 事件，不能声明控制流决策。
  run: () => ({ decision: 'stop' }),
});

defineHook({
  event: 'PreToolUse',
  // @ts-expect-error PreToolUse 只接受 allow 或 deny 规范决策。
  run: () => ({ decision: 'block' }),
});

defineHook({
  event: 'Stop',
  // @ts-expect-error Stop 不允许返回 PreToolUse 的 updatedInput 字段。
  run: () => ({ updatedInput: { command: 'unsafe' } }),
});

defineHook({
  // @ts-expect-error 非规范事件不能作为裸字符串扩入联合类型。
  event: 'Setup',
  /** 非法事件用最小实现隔离事件字段本身的类型错误。 */
  run() {},
});
