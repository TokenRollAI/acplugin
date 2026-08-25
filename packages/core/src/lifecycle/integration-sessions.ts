import type {
  AcpluginExtension,
  ExtensionIntegrationDescription,
  ExtensionSession,
  IntegrationCloseContext,
  PlatformIntegrationDescription,
  PlatformSession,
} from '../contracts/integrations.js';
import type { JsonObject } from '../contracts/common.js';
import type { BuildReport } from '../contracts/reports.js';
import type { ResolvedKernelConfig, ResolvedPlatform } from '../config/resolver.js';
import type { BuiltExtensionState, ExtensionConsumerPlan } from '../resources/extensions.js';
import { dataObjectFields } from '../security/data-boundary.js';
import { compareCodePoints } from '../security/path-policy.js';
import { sanitizeStableText } from '../security/report-safety.js';
import { DiagnosticRegistry } from '../services/diagnostics.js';

/** 已完成 setup 且必须逆序关闭的 Integration。 */
export type InitializedIntegration = {
  readonly kind: 'platform';
  readonly id: string;
  readonly session: PlatformSession<JsonObject>;
} | {
  readonly kind: 'extension';
  readonly id: string;
  readonly session: ExtensionSession<unknown, unknown, unknown>;
};

/** 选中 Platform 与其 setup Session。 */
export interface PlatformRuntime {
  readonly resolved: ResolvedPlatform;
  readonly description: PlatformIntegrationDescription;
  /** 异构配置数组在 Core runtime 边界擦除各 Platform 的具体 payload union。 */
  readonly session: PlatformSession<JsonObject>;
}

/** Extension definition 与其 setup Session。 */
export interface ExtensionRuntime {
  readonly definition: AcpluginExtension;
  readonly description: ExtensionIntegrationDescription;
  readonly session: ExtensionSession<unknown, unknown, unknown>;
}

/** 每个 validated consumer plan 的显式 build 终态。 */
export type ExtensionPlanBuildStatus = Readonly<{
  readonly plan: ExtensionConsumerPlan<unknown, unknown>;
  readonly status: 'skipped' | 'failed';
}> | Readonly<{
  readonly plan: ExtensionConsumerPlan<unknown, unknown>;
  readonly status: 'built';
  readonly built: BuiltExtensionState<unknown>;
}>;

/** @returns 当前 Platform 是否依赖一个已失败 Extension 的 Built State。 */
export function platformConsumesFailedExtension(
  platform: string,
  builds: readonly ExtensionPlanBuildStatus[],
): boolean {
  return builds.some(build => build.status === 'failed'
    && build.plan.consumers.some(consumer => consumer.platform.id === platform && consumer.contributor !== undefined));
}

/** 生命周期内部可稳定传递的首个失败摘要。 */
export interface FailureSummary {
  readonly code: string;
  readonly phase: string;
  readonly message: string;
}

/** 生命周期失败优先级用于 cleanup 摘要，不依赖并发完成或诊断字典序。 */
const FAILURE_PHASE_ORDER = Object.freeze([
  'config', 'setup', 'discover', 'validate', 'compile', 'package', 'contribute', 'finalize',
  'materialize', 'platform-validate', 'compatibility', 'transaction', 'cleanup', 'dev', 'internal',
] as const);

/** @returns 当前稳定诊断集合是否包含匹配的 error。 */
export function hasMatchingError(
  diagnostics: DiagnosticRegistry,
  predicate: (diagnostic: BuildReport['diagnostics'][number]) => boolean,
): boolean {
  return diagnostics.diagnostics.some(diagnostic => diagnostic.severity === 'error' && predicate(diagnostic));
}

/** @returns 当前 Platform 是否已经在自己的 validate/package 阶段失败。 */
export function platformHasErrors(diagnostics: DiagnosticRegistry, platform: string): boolean {
  return hasMatchingError(diagnostics, diagnostic => diagnostic.platform === platform);
}

/** @returns 不属于单一 Integration 的工程级失败是否阻止全部 Package 消费。 */
export function projectHasErrors(diagnostics: DiagnosticRegistry): boolean {
  return hasMatchingError(diagnostics, diagnostic => diagnostic.platform === undefined && diagnostic.extension === undefined);
}

/** @returns Platform 的不可变公开身份。 */
export function platformDescription(platform: ResolvedPlatform): PlatformIntegrationDescription {
  return Object.freeze({
    kind: 'platform',
    id: platform.definition.id,
    apiVersion: platform.definition.apiVersion,
    ...(platform.definition.options === undefined ? {} : { options: platform.definition.options }),
    ...(platform.definition.capabilities === undefined ? {} : { capabilities: platform.definition.capabilities }),
  });
}

/** @returns Extension 的不可变公开身份。 */
export function extensionDescription(extension: AcpluginExtension): ExtensionIntegrationDescription {
  return Object.freeze({
    kind: 'extension',
    id: extension.id,
    apiVersion: extension.apiVersion,
    ...(extension.options === undefined ? {} : { options: extension.options }),
    resourceRoots: extension.resourceRoots,
  });
}

/** 解析显式 Platform subset 并保持原配置顺序。 */
export function selectPlatforms(config: ResolvedKernelConfig, selection: readonly string[] | undefined): readonly ResolvedPlatform[] {
  if (selection === undefined)
    return config.platforms;
  if (!Array.isArray(selection) || selection.length === 0)
    throw new TypeError('Platform selection must contain at least one configured Platform.');
  /** 选择输入在任何 Session factory 运行前拒绝重复与未知 ID。 */
  const requested = [...selection];
  if (requested.some(id => typeof id !== 'string') || new Set(requested).size !== requested.length)
    throw new TypeError('Platform selection must contain unique Platform ids.');
  /** configured 用于在 setup 前拒绝未知 Platform。 */
  const configured = new Set(config.platforms.map(platform => platform.definition.id));
  /** unknown 按稳定键排序后只进入内部异常，不泄露配置对象。 */
  const unknown = requested.filter(id => !configured.has(id));
  if (unknown.length > 0)
    throw new TypeError(`Platform selection contains an unconfigured id: ${unknown.sort(compareCodePoints)[0]}.`);
  /** 返回顺序始终使用配置顺序而非 CLI 参数顺序。 */
  const selected = new Set(requested);
  return Object.freeze(config.platforms.filter(platform => selected.has(platform.definition.id)));
}

/** 验证 Platform Session 精确方法面。 */
export function platformSession(value: unknown, id: string): PlatformSession<JsonObject> {
  /** fields 拒绝旧生命周期方法与未知行为面。 */
  const fields = dataObjectFields(value, new Set([
    'validateComponent', 'createPackage', 'finalizePackage', 'validatePackage', 'createDistributions', 'close',
  ]), `Platform "${id}" Session`);
  for (const required of ['createPackage', 'finalizePackage', 'validatePackage']) {
    if (typeof fields[required]?.value !== 'function')
      throw new TypeError(`Platform "${id}" Session must provide ${required}().`);
  }
  for (const optional of ['validateComponent', 'createDistributions', 'close']) {
    if (fields[optional] !== undefined && typeof fields[optional].value !== 'function')
      throw new TypeError(`Platform "${id}" Session ${optional} must be a function.`);
  }
  return value as PlatformSession<JsonObject>;
}

/** 验证 Extension Session 精确方法面。 */
export function extensionSession(value: unknown, id: string): ExtensionSession<unknown, unknown, unknown> {
  /** fields 固定 Extension v2 Session 的完整方法面。 */
  const fields = dataObjectFields(value, new Set(['discover', 'validate', 'build', 'contributors', 'close']), `Extension "${id}" Session`);
  for (const required of ['discover', 'validate', 'build']) {
    if (typeof fields[required]?.value !== 'function')
      throw new TypeError(`Extension "${id}" Session must provide ${required}().`);
  }
  if (!Array.isArray(fields.contributors?.value))
    throw new TypeError(`Extension "${id}" Session must provide contributors.`);
  if (fields.close !== undefined && typeof fields.close.value !== 'function')
    throw new TypeError(`Extension "${id}" Session close must be a function.`);
  return value as ExtensionSession<unknown, unknown, unknown>;
}

/** @returns 报告与 close 共用的首个错误摘要。 */
export function firstFailure(diagnostics: DiagnosticRegistry): FailureSummary | undefined {
  /** 同阶段使用 Registry 的稳定排序，跨阶段选择最早的实际生命周期失败。 */
  const failures = diagnostics.diagnostics.filter(diagnostic => diagnostic.severity === 'error');
  /** failure 在稳定诊断顺序相同时按固定 lifecycle phase 决定。 */
  const failure = failures.sort((left, right) => FAILURE_PHASE_ORDER.indexOf(left.phase) - FAILURE_PHASE_ORDER.indexOf(right.phase))[0];
  if (failure === undefined)
    return undefined;
  return Object.freeze({ code: failure.code, phase: failure.phase, message: failure.message });
}

/** 把未预期异常收敛为不包含第三方原始错误的稳定诊断。 */
export function reportFailure(
  diagnostics: DiagnosticRegistry,
  phase: Parameters<DiagnosticRegistry['report']>[0],
  code: string,
  message: string,
  identity: Parameters<DiagnosticRegistry['report']>[2] = {},
): void {
  diagnostics.report(phase, { code, severity: 'error', message: sanitizeStableText(message) }, identity);
}

/** Platform 单阶段调用的显式成功/失败联合，避免异常跨阶段重新归类。 */
export type PlatformStageResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false }>;

/**
 * 在一个真实 Platform 阶段边界内收敛未知异常。
 *
 * @param diagnostics 当前 BuildSession 诊断集合。
 * @param phase 报告中的精确阶段。
 * @param code 当前阶段的稳定错误码。
 * @param message 不包含原始异常的稳定摘要。
 * @param platform 当前 Platform ID。
 * @param action 只执行当前阶段工作的回调。
 * @returns 带显式判别字段的阶段结果。
 */
export async function runPlatformStage<T>(
  diagnostics: DiagnosticRegistry,
  phase: Parameters<DiagnosticRegistry['report']>[0],
  code: string,
  message: string,
  platform: string,
  action: () => T | PromiseLike<T>,
): Promise<PlatformStageResult<T>> {
  try {
    return Object.freeze({ ok: true as const, value: await action() });
  } catch {
    reportFailure(diagnostics, phase, code, message, { owner: `platform:${platform}`, platform });
    return Object.freeze({ ok: false as const });
  }
}

/** 对 initialized stack 逆序恰好关闭一次并保留首次业务失败优先级。 */
export async function closeIntegrations(
  initialized: InitializedIntegration[],
  diagnostics: DiagnosticRegistry,
  committed: boolean,
): Promise<void> {
  /** close 上下文在 cleanup 前固定，cleanup failure 不递归传给后续 close。 */
  const failure = firstFailure(diagnostics);
  /** context 不暴露原始异常或物理路径。 */
  const context: IntegrationCloseContext = Object.freeze({
    outcome: failure === undefined ? 'success' : 'failed',
    committed,
    ...(failure === undefined ? {} : { failure }),
  });
  /** 全部已初始化 Integration 即使前一个 close 失败也必须继续关闭。 */
  let failed = false;
  for (const integration of initialized.reverse()) {
    try {
      await integration.session.close?.(context);
    } catch {
      failed = true;
      reportFailure(
        diagnostics,
        'cleanup',
        integration.kind === 'platform' ? 'PLATFORM_CLOSE_FAILED' : 'EXTENSION_CLOSE_FAILED',
        `${integration.kind === 'platform' ? 'Platform' : 'Extension'} "${integration.id}" close failed.`,
        integration.kind === 'platform'
          ? { owner: `platform:${integration.id}`, platform: integration.id }
          : { owner: `extension:${integration.id}`, extension: integration.id },
      );
    }
  }
  initialized.splice(0);
  if (failed)
    throw new Error('Integration cleanup failed.');
}
