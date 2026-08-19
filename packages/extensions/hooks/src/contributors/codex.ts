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

/** Codex Hook Manifest 中的一组 command Handler。 */
interface HookGroup {
  readonly matcher?: string;
  readonly hooks: readonly Readonly<Record<string, JsonValue>>[];
}

/** Codex Contributor 生成当前字符串命令协议。 */
export const codexContributor: PlatformContributor<BuiltHooks> = Object.freeze({
  platform: 'codex',
  platformApiVersion: '1',
  /** 以只读 Built State 追加 Codex 的 Hook 文档和兼容性。 */
  async contribute(context: ContributionContext, built: Readonly<BuiltHooks>) {
    /** output 汇聚同 owner 的配置、Handler 与兼容性。 */
    const output = collector();
    /** groups 按规范事件名建立。 */
    const groups: Record<string, HookGroup[]> = {};
    for (const hook of built.hooks) {
      /** event 经过 Extension validate。 */
      const event = eventName(hook.definition);
      /** applicable 区分规范事件和 Claude-only 事件。 */
      const applicable = appliesToPlatform(hook, 'codex');
      /** options 是 Codex 精确覆盖结果。 */
      const options = resolveOptions(hook, 'codex');
      reportSupport(output, hook, 'codex', applicable
        ? { supported: true, level: 'native', reason: `Codex supports local command handlers for ${event}.` }
        : { supported: false, level: 'unsupported', reason: 'The Hook explicitly targets another Platform.' }, options, {
        matcherNative: event !== 'UserPromptSubmit' && event !== 'Stop',
        statusNative: true,
      });
      if (!applicable)
        continue;
      addHookRuntime(output, hook, 'hooks');
      /** Codex 当前 command 字段使用固定 Plugin root 模板。 */
      const handler: Readonly<Record<string, JsonValue>> = Object.freeze({
        type: 'command',
        command: `node "\${PLUGIN_ROOT}/hooks/${hook.id}/handler.mjs" codex`,
        ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
        ...(options.statusMessage === undefined ? {} : { statusMessage: options.statusMessage }),
        ...(options.additionalContextLimit === undefined ? {} : { additionalContextLimit: options.additionalContextLimit }),
      });
      (groups[event] ??= []).push(Object.freeze({
        ...(options.matcher === undefined ? {} : { matcher: options.matcher }),
        hooks: Object.freeze([handler]),
      }));
    }
    if (Object.keys(groups).length === 0)
      return finishContribution(output);
    if (!hasExtensionPoint(context, 'plugin-manifest', ['hooks'])) {
      context.diagnostics.report({ code: 'HOOK_PLATFORM_DOCUMENT_MISSING', severity: 'error', message: 'Codex Platform does not expose plugin-manifest hooks.' });
      return finishContribution(output);
    }
    await addJsonAsset(context, output, 'hooks/hooks.json', { hooks: groups } as unknown as JsonValue, built.hooks.map(hook => `hook:${hook.id}`));
    return finishContribution(output, [{ document: 'plugin-manifest', path: ['hooks'], value: './hooks/hooks.json' }]);
  },
});
