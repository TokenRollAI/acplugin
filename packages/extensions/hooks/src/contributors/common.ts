import {
  stableJson,
  type CompatibilityInput,
  type ContributionContext,
  type DocumentFieldPath,
  type JsonValue,
  type PackageAssetInput,
  type PackageContribution,
} from '@tokenroll/acplugin/sdk';
import type { BuiltHook, BuiltHooks } from '../build.js';
import { eventCapability, platformForEvent, platformOptions } from '../discovery.js';

/** Contributor 合并顶层默认值与平台覆盖后的配置。 */
export interface ResolvedHookOptions {
  readonly matcher?: string;
  readonly timeout?: number;
  readonly statusMessage?: string;
  readonly additionalContextLimit?: number;
}

/** 非默认 Platform 对一个规范事件的固定支持结论。 */
export interface HookEventSupport {
  readonly supported: boolean;
  readonly level: 'native' | 'transform' | 'degraded' | 'unsupported';
  readonly nativeEvent?: string;
  readonly reason: string;
}

/** Contributor 构建结果时使用的 mutable 收集器。 */
export interface ContributionCollector {
  readonly assets: PackageAssetInput[];
  readonly compatibility: CompatibilityInput[];
}

/** @returns Hook 是否声明为当前 Platform 可消费。 */
export function appliesToPlatform(hook: BuiltHook, platform: string): boolean {
  /** target 省略表示规范事件面向全部 Platform。 */
  const target = platformForEvent(hook.definition);
  return target === undefined || target === platform;
}

/** @returns 当前 Platform 合并后的纯数据 Hook options。 */
export function resolveOptions(hook: BuiltHook, platform: string): ResolvedHookOptions {
  /** override 已在 validate 阶段通过对应 Contributor Schema。 */
  const override = platformOptions(hook.definition, platform);
  /** 每项只在覆盖类型准确时替换顶层值。 */
  const matcher = typeof override?.matcher === 'string'
    ? override.matcher
    : typeof hook.definition.matcher === 'string' ? hook.definition.matcher : undefined;
  /** timeout 使用相同的显式覆盖优先级。 */
  const timeout = typeof override?.timeout === 'number'
    ? override.timeout
    : typeof hook.definition.timeout === 'number' ? hook.definition.timeout : undefined;
  /** statusMessage 不进入不支持的平台 wire。 */
  const statusMessage = typeof override?.statusMessage === 'string'
    ? override.statusMessage
    : typeof hook.definition.statusMessage === 'string' ? hook.definition.statusMessage : undefined;
  /** additionalContextLimit 只属于 Codex 覆盖。 */
  const additionalContextLimit = typeof override?.additionalContextLimit === 'number'
    ? override.additionalContextLimit
    : undefined;
  return Object.freeze({
    ...(matcher === undefined ? {} : { matcher }),
    ...(timeout === undefined ? {} : { timeout }),
    ...(statusMessage === undefined ? {} : { statusMessage }),
    ...(additionalContextLimit === undefined ? {} : { additionalContextLimit }),
  });
}

/** @returns matcher 是否实际缩小事件范围。 */
export function meaningfulMatcher(value: string | undefined): boolean {
  return value !== undefined && value !== '' && value !== '*';
}

/** @returns base Document 是否公开当前 exact add-only point。 */
export function hasExtensionPoint(
  context: ContributionContext,
  documentId: string,
  path: DocumentFieldPath,
): boolean {
  /** key 采用 JSON tuple，避免字段分隔符歧义。 */
  const key = JSON.stringify(path);
  /** document 只来自当前 Platform base snapshot。 */
  const document = context.base.documents.find(candidate => candidate.id === documentId);
  return document?.extensionPoints.some(candidate => JSON.stringify(candidate) === key) === true;
}

/** 对一个支持结论追加事件 tuple 和可选 matcher/status 差异。 */
export function reportSupport(
  collector: ContributionCollector,
  hook: BuiltHook,
  platform: string,
  support: HookEventSupport,
  options: ResolvedHookOptions,
  input: { readonly matcherNative: boolean; readonly statusNative: boolean },
): void {
  collector.compatibility.push(Object.freeze({
    subject: `hook:${hook.id}`,
    capability: `event.${eventCapability(hook.definition)}`,
    level: support.level,
    ...(support.nativeEvent === undefined ? {} : { transformation: support.nativeEvent.toLowerCase().replaceAll('_', '-') }),
    reason: support.reason,
  }));
  if (!support.supported)
    return;
  if (meaningfulMatcher(options.matcher) && !input.matcherNative) {
    collector.compatibility.push(Object.freeze({
      subject: `hook:${hook.id}`,
      capability: 'matcher',
      level: 'degraded',
      reason: `${platform} cannot preserve this matcher for the selected event.`,
    }));
  }
  if (options.statusMessage !== undefined && !input.statusNative) {
    collector.compatibility.push(Object.freeze({
      subject: `hook:${hook.id}`,
      capability: 'status-message',
      level: 'degraded',
      reason: `${platform} has no stable Hook status message field in this protocol.`,
    }));
  }
}

/** 把同一个 Core GeneratedAssetRef 映射到当前 Platform 固定 Handler 根。 */
export function addHookRuntime(
  collector: ContributionCollector,
  hook: BuiltHook,
  root: string,
): void {
  collector.assets.push(Object.freeze({ path: `${root}/${hook.id}/handler.mjs`, asset: hook.handler }));
  if (hook.licenses !== undefined) {
    collector.assets.push(Object.freeze({
      path: `${root}/${hook.id}/THIRD_PARTY_LICENSES.txt`,
      asset: hook.licenses,
    }));
  }
}

/** 通过 Extension owner Asset Service 创建稳定 JSON Package Asset。 */
export async function addJsonAsset(
  context: ContributionContext,
  collector: ContributionCollector,
  path: string,
  value: JsonValue,
  subjects: readonly string[],
): Promise<void> {
  /** asset bytes 来自 SDK stable codec，不写 dist/workDir。 */
  const asset = await context.assets.fromBytes({
    bytes: stableJson(value),
    origin: { operation: 'hook-platform-config', subjects },
  });
  collector.assets.push(Object.freeze({ path, asset }));
}

/** 通过 Extension owner Asset Service 创建固定运行时桥接 Asset。 */
export async function addRuntimeAsset(
  context: ContributionContext,
  collector: ContributionCollector,
  path: string,
  bytes: string,
  subjects: readonly string[],
): Promise<void> {
  /** 运行时桥只包含 Extension 自有代码和静态 descriptor。 */
  const asset = await context.assets.fromBytes({
    bytes,
    origin: { operation: 'hook-platform-runtime', subjects },
  });
  collector.assets.push(Object.freeze({ path, asset }));
}

/** @returns 冻结且满足 Contribution 必填 compatibility 的最终对象。 */
export function finishContribution(
  collector: ContributionCollector,
  documentFields: PackageContribution['documentFields'] = [],
): PackageContribution {
  return Object.freeze({
    ...(documentFields.length === 0 ? {} : { documentFields: Object.freeze([...documentFields]) }),
    ...(collector.assets.length === 0 ? {} : { assets: Object.freeze(collector.assets) }),
    compatibility: Object.freeze(collector.compatibility),
  });
}

/** 创建一个空的 Contributor 收集器。 */
export function collector(): ContributionCollector {
  return { assets: [], compatibility: [] };
}

/** @returns 所有 Hook 的稳定 subject 列表。 */
export function hookSubjects(built: Readonly<BuiltHooks>): readonly string[] {
  return Object.freeze(built.hooks.map(hook => `hook:${hook.id}`));
}
