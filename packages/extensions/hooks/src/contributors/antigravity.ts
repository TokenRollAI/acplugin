import type { ContributionContext, JsonValue, PlatformContributor } from '@tokenroll/acplugin/sdk';
import type { BuiltHooks } from '../build.js';
import { eventName } from '../discovery.js';
import {
  addHookRuntime,
  addJsonAsset,
  appliesToPlatform,
  collector,
  finishContribution,
  reportSupport,
  resolveOptions,
  type HookEventSupport,
} from './common.js';

/** Antigravity 对 canonical Hook 事件的固定映射。 */
const EVENTS: Readonly<Record<string, HookEventSupport>> = Object.freeze({
  SessionStart: { supported: true, level: 'native', nativeEvent: 'SessionStart', reason: 'Antigravity supports SessionStart.' },
  SessionEnd: { supported: true, level: 'native', nativeEvent: 'SessionEnd', reason: 'Antigravity supports SessionEnd.' },
  UserPromptSubmit: { supported: false, level: 'unsupported', reason: 'Antigravity has no documented prompt-submit Hook.' },
  PreToolUse: { supported: true, level: 'native', nativeEvent: 'PreToolUse', reason: 'Antigravity supports PreToolUse.' },
  PermissionRequest: { supported: false, level: 'unsupported', reason: 'Antigravity has no distinct permission request Hook.' },
  PostToolUse: { supported: true, level: 'native', nativeEvent: 'PostToolUse', reason: 'Antigravity supports PostToolUse.' },
  PreCompact: { supported: true, level: 'native', nativeEvent: 'PreCompact', reason: 'Antigravity supports PreCompact.' },
  PostCompact: { supported: false, level: 'unsupported', reason: 'Antigravity has no documented post-compaction Hook.' },
  SubagentStart: { supported: false, level: 'unsupported', reason: 'Antigravity has no documented subagent-start Hook.' },
  SubagentStop: { supported: false, level: 'unsupported', reason: 'Antigravity has no documented subagent-stop Hook.' },
  Stop: { supported: false, level: 'unsupported', reason: 'Antigravity has no documented stop Hook.' },
});

/** Antigravity Contributor 只追加根 hooks.json 和支持事件的 Handler。 */
export const antigravityContributor: PlatformContributor<BuiltHooks> = Object.freeze({
  platform: 'antigravity',
  platformApiVersion: '1',
  /** 以只读 Built State 追加 Antigravity 的 Hook 文档和兼容性。 */
  async contribute(context: ContributionContext, built: Readonly<BuiltHooks>) {
    /** output 汇聚根 Asset 和完整 compatibility。 */
    const output = collector();
    /** groups 使用 Antigravity matcher + hooks 结构。 */
    const groups: Record<string, { readonly matcher?: string; readonly hooks: readonly Readonly<Record<string, JsonValue>>[] }[]> = {};
    for (const hook of built.hooks) {
      /** event 选择固定支持项。 */
      const event = eventName(hook.definition);
      /** support 对平台限定事件不伪造 fallback。 */
      const support = appliesToPlatform(hook, 'antigravity')
        ? EVENTS[event] ?? { supported: false, level: 'unsupported' as const, reason: `Antigravity does not recognize ${event}.` }
        : { supported: false, level: 'unsupported' as const, reason: 'The Hook explicitly targets another Platform.' };
      /** options 已由共享 validate Schema 约束。 */
      const options = resolveOptions(hook, 'antigravity');
      reportSupport(output, hook, 'antigravity', support, options, {
        matcherNative: event === 'PreToolUse' || event === 'PostToolUse', statusNative: false,
      });
      if (!support.supported || support.nativeEvent === undefined)
        continue;
      addHookRuntime(output, hook, 'hooks');
      /** 固定命令只调用当前 Plugin 内 Handler。 */
      const handler = Object.freeze({
        type: 'command',
        command: `node "\${ANTIGRAVITY_PLUGIN_ROOT}/hooks/${hook.id}/handler.mjs" antigravity`,
      });
      (groups[support.nativeEvent] ??= []).push(Object.freeze({
        ...(options.matcher === undefined ? {} : { matcher: options.matcher }),
        hooks: Object.freeze([handler]),
      }));
    }
    if (Object.keys(groups).length > 0)
      await addJsonAsset(context, output, 'hooks.json', { hooks: groups } as unknown as JsonValue, built.hooks.map(hook => `hook:${hook.id}`));
    return finishContribution(output);
  },
});
