import type { ContributionContext, JsonValue, PlatformContributor } from '@tokenroll/acplugin/sdk';
import type { BuiltHooks } from '../build.js';
import { eventName } from '../discovery.js';
import {
  addHookRuntime,
  addJsonAsset,
  appliesToPlatform,
  collector,
  finishContribution,
  hasExtensionPoint,
  reportSupport,
  resolveOptions,
  type HookEventSupport,
} from './common.js';

/** Cursor 对 canonical Hook 事件的固定映射。 */
const EVENTS: Readonly<Record<string, HookEventSupport>> = Object.freeze({
  SessionStart: { supported: true, level: 'transform', nativeEvent: 'sessionStart', reason: 'Cursor provides sessionStart.' },
  SessionEnd: { supported: true, level: 'transform', nativeEvent: 'sessionEnd', reason: 'Cursor provides sessionEnd.' },
  UserPromptSubmit: { supported: true, level: 'transform', nativeEvent: 'beforeSubmitPrompt', reason: 'Cursor provides beforeSubmitPrompt.' },
  PreToolUse: { supported: true, level: 'transform', nativeEvent: 'preToolUse', reason: 'Cursor provides preToolUse.' },
  PermissionRequest: { supported: false, level: 'unsupported', reason: 'Cursor has no verified distinct permission request Hook.' },
  PostToolUse: { supported: true, level: 'transform', nativeEvent: 'postToolUse', reason: 'Cursor provides postToolUse.' },
  PreCompact: { supported: true, level: 'transform', nativeEvent: 'preCompact', reason: 'Cursor provides preCompact.' },
  PostCompact: { supported: false, level: 'unsupported', reason: 'Cursor has no verified post-compaction Hook.' },
  SubagentStart: { supported: true, level: 'transform', nativeEvent: 'subagentStart', reason: 'Cursor provides subagentStart.' },
  SubagentStop: { supported: true, level: 'transform', nativeEvent: 'subagentStop', reason: 'Cursor provides subagentStop.' },
  Stop: { supported: true, level: 'transform', nativeEvent: 'stop', reason: 'Cursor provides stop.' },
});

/** Cursor Contributor 生成 version 1 command Hooks。 */
export const cursorContributor: PlatformContributor<BuiltHooks> = Object.freeze({
  platform: 'cursor',
  platformApiVersion: '1',
  /** 以只读 Built State 追加 Cursor 的 Hook 文档和兼容性。 */
  async contribute(context: ContributionContext, built: Readonly<BuiltHooks>) {
    /** output 汇聚 Cursor 自有 add-only 结果。 */
    const output = collector();
    /** groups 映射 Cursor 原生事件到命令数组。 */
    const groups: Record<string, Readonly<Record<string, JsonValue>>[]> = {};
    for (const hook of built.hooks) {
      /** event 决定固定支持矩阵。 */
      const event = eventName(hook.definition);
      /** support 对平台限定事件显式 unsupported。 */
      const support = appliesToPlatform(hook, 'cursor')
        ? EVENTS[event] ?? { supported: false, level: 'unsupported' as const, reason: `Cursor does not recognize ${event}.` }
        : { supported: false, level: 'unsupported' as const, reason: 'The Hook explicitly targets another Platform.' };
      /** options 用于 matcher/status 兼容结论。 */
      const options = resolveOptions(hook, 'cursor');
      reportSupport(output, hook, 'cursor', support, options, {
        matcherNative: event === 'PreToolUse' || event === 'PostToolUse',
        statusNative: false,
      });
      if (!support.supported || support.nativeEvent === undefined)
        continue;
      addHookRuntime(output, hook, 'hooks');
      /** command 只引用 Cursor Plugin root 下的受管 Handler。 */
      const command = `node "\${CURSOR_PLUGIN_ROOT}/hooks/${hook.id}/handler.mjs" cursor`;
      (groups[support.nativeEvent] ??= []).push(Object.freeze({ command }));
    }
    if (Object.keys(groups).length === 0)
      return finishContribution(output);
    if (!hasExtensionPoint(context, 'plugin-manifest', ['hooks'])) {
      context.diagnostics.report({ code: 'HOOK_PLATFORM_DOCUMENT_MISSING', severity: 'error', message: 'Cursor Platform does not expose plugin-manifest hooks.' });
      return finishContribution(output);
    }
    await addJsonAsset(context, output, 'hooks/hooks.json', { version: 1, hooks: groups } as unknown as JsonValue, built.hooks.map(hook => `hook:${hook.id}`));
    return finishContribution(output, [{ document: 'plugin-manifest', path: ['hooks'], value: './hooks/hooks.json' }]);
  },
});
