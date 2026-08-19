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
} from './common.js';

/** Claude Code matcher 字段存在但当前事件会忽略 matcher 的集合。 */
const MATCHER_IGNORED = new Set([
  'UserPromptSubmit', 'PostToolBatch', 'Stop', 'TeammateIdle', 'TaskCreated', 'TaskCompleted',
  'WorktreeCreate', 'WorktreeRemove', 'MessageDisplay', 'CwdChanged',
]);

/** Claude Code Hook Manifest 中的一组受控 command Handler。 */
interface HookGroup {
  readonly matcher?: string;
  readonly hooks: readonly Readonly<Record<string, JsonValue>>[];
}

/** Claude Code Contributor 使用 Plugin Manifest 的 hooks exact point。 */
export const claudeCodeContributor: PlatformContributor<BuiltHooks> = Object.freeze({
  platform: 'claude-code',
  platformApiVersion: '1',
  /** 生成原生 exec-form hooks.json 并复用 portable Handler refs。 */
  async contribute(context: ContributionContext, built: Readonly<BuiltHooks>) {
    /** output 同时收集 add-only Assets 和兼容性。 */
    const output = collector();
    /** groups 按事件保存，stableJson 最终固定键序。 */
    const groups: Record<string, HookGroup[]> = {};
    for (const hook of built.hooks) {
      /** event 是 descriptor 中已验证的原生或规范事件。 */
      const event = eventName(hook.definition);
      /** applicable false 只报告 unsupported，不能引用 Handler。 */
      const applicable = appliesToPlatform(hook, 'claude-code');
      /** options 已在 validate 阶段通过 Claude Schema。 */
      const options = resolveOptions(hook, 'claude-code');
      reportSupport(output, hook, 'claude-code', applicable
        ? { supported: true, level: 'native', reason: `Claude Code supports local command handlers for ${event}.` }
        : { supported: false, level: 'unsupported', reason: 'The Hook explicitly targets another Platform.' }, options, {
        matcherNative: !MATCHER_IGNORED.has(event),
        statusNative: true,
      });
      if (!applicable)
        continue;
      addHookRuntime(output, hook, 'hooks');
      /** handler 只调用受管 Bundle，不接受作者命令。 */
      const handler: Readonly<Record<string, JsonValue>> = Object.freeze({
        type: 'command',
        command: 'node',
        args: [`\${CLAUDE_PLUGIN_ROOT}/hooks/${hook.id}/handler.mjs`, 'claude-code'],
        ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
        ...(options.statusMessage === undefined ? {} : { statusMessage: options.statusMessage }),
      });
      (groups[event] ??= []).push(Object.freeze({
        ...(options.matcher === undefined ? {} : { matcher: options.matcher }),
        hooks: Object.freeze([handler]),
      }));
    }
    if (Object.keys(groups).length === 0)
      return finishContribution(output);
    if (!hasExtensionPoint(context, 'plugin-manifest', ['hooks'])) {
      context.diagnostics.report({
        code: 'HOOK_PLATFORM_DOCUMENT_MISSING', severity: 'error',
        message: 'Claude Code Platform does not expose plugin-manifest hooks.',
      });
      return finishContribution(output);
    }
    await addJsonAsset(context, output, 'hooks/hooks.json', { hooks: groups } as unknown as JsonValue, built.hooks.map(hook => `hook:${hook.id}`));
    return finishContribution(output, [{ document: 'plugin-manifest', path: ['hooks'], value: './hooks/hooks.json' }]);
  },
});
