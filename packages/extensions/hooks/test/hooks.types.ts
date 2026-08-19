import type { Hook } from '../src/index.js';

/** PreToolUse 定义用于验证事件级输入和结果推断。 */
const preToolUse = {
  event: 'PreToolUse',
  /** 类型检查同时确认运行时上下文使用最终 platform 术语。 */
  run(input, context) {
    /** 事件判别后可直接读取 PreToolUse 专属输入。 */
    const toolName: string = input.toolName;
    /** 所有 Hook 上下文统一暴露当前目标 Platform。 */
    const platform: string = context.platform;
    return {
      decision: 'allow' as const,
      reason: `${platform}:${toolName}`,
      updatedInput: { command: 'pnpm test' },
    };
  },
} satisfies Hook<'PreToolUse'>;
void preToolUse;

/** Claude Code 专属事件必须使用显式 Platform 对象。 */
const platformHook = {
  event: { platform: 'claude-code', name: 'Setup' } as const,
  /** Platform 专属事件输入保留结构化事件判别值。 */
  run(input) {
    /** 收窄后的事件能够读取固定 Platform ID。 */
    const platform: string = input.event.platform;
    return { systemMessage: platform };
  },
} satisfies Hook<{ readonly platform: 'claude-code'; readonly name: 'Setup' }>;
void platformHook;

/** advisory 事件返回控制流决策时必须触发类型错误。 */
const invalidSessionEnd = {
  event: 'SessionEnd',
  // @ts-expect-error SessionEnd 是 advisory 事件，不能声明控制流决策。
  run: () => ({ decision: 'stop' }),
} satisfies Hook<'SessionEnd'>;
void invalidSessionEnd;

/** 非规范 PreToolUse decision 必须触发类型错误。 */
const invalidPreToolUse = {
  event: 'PreToolUse',
  // @ts-expect-error PreToolUse 只接受 allow 或 deny 规范决策。
  run: () => ({ decision: 'block' }),
} satisfies Hook<'PreToolUse'>;
void invalidPreToolUse;

/** Stop 返回其他事件专属字段时必须触发类型错误。 */
const invalidStop = {
  event: 'Stop',
  // @ts-expect-error Stop 不允许返回 PreToolUse 的 updatedInput 字段。
  run: () => ({ updatedInput: { command: 'unsafe' } }),
} satisfies Hook<'Stop'>;
void invalidStop;

/** 未注册的裸事件名称不能扩展规范事件联合。 */
const invalidEvent = {
  // @ts-expect-error 非规范事件不能作为裸字符串扩入联合类型。
  event: 'Setup',
  /** 无效事件仍提供最小函数以隔离 event 字段错误。 */
  run() {},
} satisfies Hook;
void invalidEvent;
