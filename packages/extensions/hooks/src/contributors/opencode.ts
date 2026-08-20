import type { ContributionContext, PlatformContributor } from '@tokenroll/acplugin/sdk';
import type { BuiltHook, BuiltHooks } from '../build.js';
import { eventName } from '../discovery.js';
import { createOpenCodePluginSource, runtimeHookDescriptor } from '../runtime/integration.js';
import {
  addHookRuntime,
  addRuntimeAsset,
  appliesToPlatform,
  collector,
  finishContribution,
  reportSupport,
  resolveOptions,
  type HookEventSupport,
} from './common.js';

/** OpenCode runtime Plugin 对 canonical 事件的固定映射。 */
const EVENTS: Readonly<Record<string, HookEventSupport>> = Object.freeze({
  SessionStart: { supported: true, level: 'native', nativeEvent: 'session.created', reason: 'OpenCode exposes session.created.' },
  SessionEnd: { supported: true, level: 'degraded', nativeEvent: 'session.deleted', reason: 'OpenCode session.deleted cannot preserve every completion result.' },
  UserPromptSubmit: { supported: true, level: 'native', nativeEvent: 'chat.message', reason: 'OpenCode exposes chat.message.' },
  PreToolUse: { supported: true, level: 'native', nativeEvent: 'tool.execute.before', reason: 'OpenCode exposes tool.execute.before.' },
  PermissionRequest: { supported: false, level: 'unsupported', reason: 'OpenCode has no distinct permission request Hook.' },
  PostToolUse: { supported: true, level: 'native', nativeEvent: 'tool.execute.after', reason: 'OpenCode exposes tool.execute.after.' },
  PreCompact: { supported: false, level: 'unsupported', reason: 'OpenCode has no verified pre-compaction Hook.' },
  PostCompact: { supported: true, level: 'native', nativeEvent: 'session.compacted', reason: 'OpenCode exposes session.compacted.' },
  SubagentStart: { supported: false, level: 'unsupported', reason: 'OpenCode has no stable subagent-start Hook.' },
  SubagentStop: { supported: false, level: 'unsupported', reason: 'OpenCode has no stable subagent-stop Hook.' },
  Stop: { supported: true, level: 'degraded', nativeEvent: 'session.idle', reason: 'OpenCode session.idle cannot preserve all stop decisions.' },
});

/** OpenCode Contributor 生成 workspace runtime Plugin。 */
export const openCodeContributor: PlatformContributor<BuiltHooks> = Object.freeze({
  platform: 'opencode',
  platformApiVersion: '1',
  /** 以只读 Built State 追加 OpenCode 的 Hook 运行时和兼容性。 */
  async contribute(context: ContributionContext, built: Readonly<BuiltHooks>) {
    /** output 汇聚 workspace Assets 与完整 compatibility。 */
    const output = collector();
    /** supported 保存实际会出现在 runtime Plugin 中的 Hook。 */
    const supported: BuiltHook[] = [];
    for (const hook of built.hooks) {
      /** event 选择固定 runtime event。 */
      const event = eventName(hook.definition);
      /** support 对 Claude-only event 返回 unsupported。 */
      const support = appliesToPlatform(hook, 'opencode')
        ? EVENTS[event] ?? { supported: false, level: 'unsupported' as const, reason: `OpenCode does not recognize ${event}.` }
        : { supported: false, level: 'unsupported' as const, reason: 'The Hook explicitly targets another Platform.' };
      /** options 进入静态 runtime descriptor。 */
      const options = resolveOptions(hook, 'opencode');
      reportSupport(output, hook, 'opencode', support, options, {
        matcherNative: event === 'PreToolUse' || event === 'PostToolUse', statusNative: false,
      });
      if (!support.supported)
        continue;
      supported.push(hook);
      addHookRuntime(output, hook, '.opencode/acplugin-hooks');
    }
    if (supported.length > 0) {
      /** descriptors 不包含函数、SourceRef 或物理路径。 */
      const descriptors = supported.map((hook) => {
        /** options 决定 matcher 和固定子进程 timeout。 */
        const options = resolveOptions(hook, 'opencode');
        return runtimeHookDescriptor(hook, options.matcher, options.timeout);
      });
      await addRuntimeAsset(context, output, '.opencode/plugins/acplugin-hooks.mjs', createOpenCodePluginSource(descriptors), supported.map(hook => `hook:${hook.id}`));
    }
    return finishContribution(output);
  },
});
