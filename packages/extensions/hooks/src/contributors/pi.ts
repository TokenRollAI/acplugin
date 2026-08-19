import type { ContributionContext, PlatformContributor } from '@tokenroll/acplugin/sdk';
import type { BuiltHook, BuiltHooks } from '../build.js';
import { eventName } from '../discovery.js';
import { createPiExtensionSource, runtimeHookDescriptor } from '../runtime-integration-source.js';
import {
  addHookRuntime,
  addRuntimeAsset,
  appliesToPlatform,
  collector,
  finishContribution,
  hasExtensionPoint,
  reportSupport,
  resolveOptions,
  type HookEventSupport,
} from './common.js';

/** Pi runtime Extension 对 canonical 事件的固定映射。 */
const EVENTS: Readonly<Record<string, HookEventSupport>> = Object.freeze({
  SessionStart: { supported: true, level: 'native', nativeEvent: 'session_start', reason: 'Pi exposes session_start.' },
  SessionEnd: { supported: true, level: 'native', nativeEvent: 'session_shutdown', reason: 'Pi exposes session_shutdown.' },
  UserPromptSubmit: { supported: true, level: 'native', nativeEvent: 'input', reason: 'Pi exposes input.' },
  PreToolUse: { supported: true, level: 'native', nativeEvent: 'tool_call', reason: 'Pi exposes tool_call.' },
  PermissionRequest: { supported: false, level: 'unsupported', reason: 'Pi has no distinct permission request event.' },
  PostToolUse: { supported: true, level: 'native', nativeEvent: 'tool_result', reason: 'Pi exposes tool_result.' },
  PreCompact: { supported: true, level: 'native', nativeEvent: 'session_before_compact', reason: 'Pi exposes session_before_compact.' },
  PostCompact: { supported: true, level: 'native', nativeEvent: 'session_compact', reason: 'Pi exposes session_compact.' },
  SubagentStart: { supported: false, level: 'unsupported', reason: 'Pi has no canonical subagent-start event.' },
  SubagentStop: { supported: false, level: 'unsupported', reason: 'Pi has no canonical subagent-stop event.' },
  Stop: { supported: true, level: 'degraded', nativeEvent: 'agent_end', reason: 'Pi agent_end cannot enforce every stop decision.' },
});

/** Pi Contributor 生成一个 npm Package Extension 和 portable Handlers。 */
export const piContributor: PlatformContributor<BuiltHooks> = Object.freeze({
  platform: 'pi',
  platformApiVersion: '1',
  /** 以只读 Built State 追加 Pi 的 Hook 运行时和兼容性。 */
  async contribute(context: ContributionContext, built: Readonly<BuiltHooks>) {
    /** output 汇聚 Package Assets 与完整 compatibility。 */
    const output = collector();
    /** supported 保存实际注册到 Pi Extension 的 Hook。 */
    const supported: BuiltHook[] = [];
    for (const hook of built.hooks) {
      /** event 选择 Pi runtime event。 */
      const event = eventName(hook.definition);
      /** support 对平台限定事件不伪造交付。 */
      const support = appliesToPlatform(hook, 'pi')
        ? EVENTS[event] ?? { supported: false, level: 'unsupported' as const, reason: `Pi does not recognize ${event}.` }
        : { supported: false, level: 'unsupported' as const, reason: 'The Hook explicitly targets another Platform.' };
      /** options 进入 runtime descriptor 和 compatibility。 */
      const options = resolveOptions(hook, 'pi');
      reportSupport(output, hook, 'pi', support, options, {
        matcherNative: event === 'PreToolUse' || event === 'PostToolUse', statusNative: false,
      });
      if (!support.supported)
        continue;
      supported.push(hook);
      addHookRuntime(output, hook, 'extensions/acplugin-hooks');
    }
    if (supported.length === 0)
      return finishContribution(output);
    if (!hasExtensionPoint(context, 'package-manifest', ['pi', 'extensions'])) {
      context.diagnostics.report({ code: 'HOOK_PLATFORM_DOCUMENT_MISSING', severity: 'error', message: 'Pi Platform does not expose package-manifest pi.extensions.' });
      return finishContribution(output);
    }
    /** descriptors 是 Pi Extension 内嵌的纯静态 Hook 数据。 */
    const descriptors = supported.map((hook) => {
      /** options 决定 matcher 和子进程 timeout。 */
      const options = resolveOptions(hook, 'pi');
      return runtimeHookDescriptor(hook, options.matcher, options.timeout);
    });
    await addRuntimeAsset(context, output, 'extensions/acplugin-hooks.mjs', createPiExtensionSource(descriptors), supported.map(hook => `hook:${hook.id}`));
    return finishContribution(output, [{
      document: 'package-manifest', path: ['pi', 'extensions'], value: ['./extensions/acplugin-hooks.mjs'],
    }]);
  },
});
