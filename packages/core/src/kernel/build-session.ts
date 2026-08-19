import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  AcpluginExtension,
  BuildMode,
  BuildReport,
  CanonicalProject,
  ConfigCommand,
  ExtensionIntegrationDescription,
  ExtensionReport,
  ExtensionSession,
  IntegrationCloseContext,
  IntegrationDescription,
  PackageUnitSnapshot,
  PlatformIntegrationDescription,
  PlatformReport,
  PlatformSession,
  ProjectRunOptions,
  ResolvedConfigSummary,
} from '../kernel-types.js';
import { CompilerHost } from '../compiler/compiler-host.js';
import { commitPackageUnits } from '../transaction.js';
import { collectDistributionPackages } from '../package/distribution-registry.js';
import { CompatibilityRegistry } from '../package/compatibility-registry.js';
import { withPackageCandidate, materializePackageUnits, validatePackageUnits } from '../package/candidate-materializer.js';
import {
  createBasePackage,
  finalizePrimaryPackage,
  mergePackageContributions,
  type OwnedPackageContribution,
} from '../package/package-registry.js';
import { createBuildReport } from '../package/report-builder.js';
import { discoverCanonicalProject } from '../resources/canonical-provider.js';
import {
  buildExtension,
  collectExtensionContributions,
  discoverExtension,
  preflightExtensionConsumers,
  validateExtension,
  type BuiltExtensionState,
  type ExtensionConsumerPlan,
} from '../resources/extension-provider.js';
import { assembleProjectGraph } from '../resources/project-graph.js';
import { discoverPublicResources } from '../resources/public-provider.js';
import { ResourceRegistry } from '../resources/resource-registry.js';
import {
  buildNodeRuntime,
  discoverNodeRuntime,
  nodeRuntimeContribution,
  platformSupportsNodeRuntime,
  type BuiltNodeRuntime,
} from '../resources/runtime-provider.js';
import { AssetRegistry } from './asset-registry.js';
import { BuildSessionScope } from './build-session-scope.js';
import type { ResolvedKernelConfig, ResolvedPlatform } from './config-resolver.js';
import { dataObjectFields } from './data-boundary.js';
import { DiagnosticRegistry } from './diagnostic-registry.js';
import { ExecutionHost } from './execution-host.js';
import { ModuleHost } from './module-host.js';
import { compareCodePoints } from './path-policy.js';
import { sanitizeStableText } from './report-safety.js';
import { SourceRegistry } from './source-registry.js';
import { WatchRegistry, type WatchSnapshot } from './watch-registry.js';
import { WorkDirectoryRegistry } from './work-directories.js';

/** Kernel one-shot 执行所需的内部输入。 */
export interface KernelBuildSessionInput {
  readonly config: ResolvedKernelConfig;
  readonly frameworkVersion: string;
  readonly selection?: readonly string[];
  readonly commit: boolean;
  /** 配置加载阶段已经创建的 Session 服务；省略时由本函数完整拥有。 */
  readonly environment?: KernelBuildEnvironment;
}

/** Project config loader 与 BuildSession 共享的唯一 Host/Registry 环境。 */
export interface KernelBuildEnvironment {
  readonly scope: BuildSessionScope;
  readonly workRoot: string;
  readonly sources: SourceRegistry;
  readonly workDirectories: WorkDirectoryRegistry;
  readonly watch: WatchRegistry;
  readonly assets: AssetRegistry;
  readonly modules: ModuleHost;
  readonly compiler: CompilerHost;
  readonly execution: ExecutionHost;
  readonly diagnostics: DiagnosticRegistry;
}

/** 内部执行结果为 DevSession 保留安全 Watch snapshot。 */
export interface KernelBuildSessionResult {
  readonly report: BuildReport;
  readonly watch: WatchSnapshot;
}

/** 已完成 setup 且必须逆序关闭的 Integration。 */
type InitializedIntegration = {
  readonly kind: 'platform';
  readonly id: string;
  readonly session: PlatformSession;
} | {
  readonly kind: 'extension';
  readonly id: string;
  readonly session: ExtensionSession<unknown, unknown, unknown>;
};

/** 选中 Platform 与其 setup Session。 */
interface PlatformRuntime {
  readonly resolved: ResolvedPlatform;
  readonly description: PlatformIntegrationDescription;
  readonly session: PlatformSession;
}

/** Extension definition 与其 setup Session。 */
interface ExtensionRuntime {
  readonly definition: AcpluginExtension;
  readonly description: ExtensionIntegrationDescription;
  readonly session: ExtensionSession<unknown, unknown, unknown>;
}

/** 每个 validated consumer plan 的显式 build 终态。 */
type ExtensionPlanBuildStatus = Readonly<{
  readonly plan: ExtensionConsumerPlan<unknown, unknown>;
  readonly status: 'skipped' | 'failed';
}> | Readonly<{
  readonly plan: ExtensionConsumerPlan<unknown, unknown>;
  readonly status: 'built';
  readonly built: BuiltExtensionState<unknown>;
}>;

/** @returns 当前 Platform 是否依赖一个已失败 Extension 的 Built State。 */
function platformConsumesFailedExtension(
  platform: string,
  builds: readonly ExtensionPlanBuildStatus[],
): boolean {
  return builds.some(build => build.status === 'failed'
    && build.plan.consumers.some(consumer => consumer.platform.id === platform && consumer.contributor !== undefined));
}

/** 生命周期内部可稳定传递的首个失败摘要。 */
interface FailureSummary {
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
function hasMatchingError(
  diagnostics: DiagnosticRegistry,
  predicate: (diagnostic: BuildReport['diagnostics'][number]) => boolean,
): boolean {
  return diagnostics.diagnostics.some(diagnostic => diagnostic.severity === 'error' && predicate(diagnostic));
}

/** @returns 当前 Platform 是否已经在自己的 validate/package 阶段失败。 */
function platformHasErrors(diagnostics: DiagnosticRegistry, platform: string): boolean {
  return hasMatchingError(diagnostics, diagnostic => diagnostic.platform === platform);
}

/** @returns 不属于单一 Integration 的工程级失败是否阻止全部 Package 消费。 */
function projectHasErrors(diagnostics: DiagnosticRegistry): boolean {
  return hasMatchingError(diagnostics, diagnostic => diagnostic.platform === undefined && diagnostic.extension === undefined);
}

/** 创建一次 BuildSession 唯一的 Host/Registry 图。 */
export async function createKernelBuildEnvironment(projectRoot: string): Promise<KernelBuildEnvironment> {
  /** 所有 Integration 中间文件共享一个由 Core 独占的临时父目录。 */
  const workRoot = await fs.mkdtemp(path.join(os.tmpdir(), '.acplugin-work-'));
  /** capability scope 在最终报告建立后统一撤销。 */
  const scope = new BuildSessionScope();
  /** Source/Watch/Work registries 是全部 Host 的共同授权基础。 */
  const sources = new SourceRegistry(scope, projectRoot);
  /** 每个 owner 只会获得自己的不可伪造 workDir handle。 */
  const workDirectories = new WorkDirectoryRegistry(scope, workRoot);
  /** Watch Registry 集中接收 Resource、Module 和 Compiler observations。 */
  const watch = new WatchRegistry(scope, projectRoot);
  /** Asset Registry 绑定当前 Source 与 workDir identities。 */
  const assets = new AssetRegistry(scope, sources, workDirectories);
  /** 三个 Host 只读取上述同一组 Registry。 */
  const modules = new ModuleHost({ projectRoot, sources, workDirectories, watch });
  /** Compiler Host 是当前 BuildSession 唯一 Rolldown compile owner。 */
  const compiler = new CompilerHost({ projectRoot, sources, workDirectories, assets, watch });
  /** Execution Host 只运行本 Session 的 portable generated refs。 */
  const execution = new ExecutionHost({ assets, workDirectories });
  return Object.freeze({
    scope,
    workRoot,
    sources,
    workDirectories,
    watch,
    assets,
    modules,
    compiler,
    execution,
    diagnostics: new DiagnosticRegistry(),
  });
}

/** 撤销全部 capability 并删除当前 Session 中间文件。 */
export async function disposeKernelBuildEnvironment(environment: KernelBuildEnvironment): Promise<void> {
  environment.scope.close();
  await fs.rm(environment.workRoot, { recursive: true, force: true });
}

/** @returns Platform 的不可变公开身份。 */
function platformDescription(platform: ResolvedPlatform): PlatformIntegrationDescription {
  return Object.freeze({
    kind: 'platform',
    id: platform.definition.id,
    apiVersion: platform.definition.apiVersion,
    ...(platform.definition.options === undefined ? {} : { options: platform.definition.options }),
    ...(platform.definition.capabilities === undefined ? {} : { capabilities: platform.definition.capabilities }),
  });
}

/** @returns Extension 的不可变公开身份。 */
function extensionDescription(extension: AcpluginExtension): ExtensionIntegrationDescription {
  return Object.freeze({
    kind: 'extension',
    id: extension.id,
    apiVersion: extension.apiVersion,
    ...(extension.options === undefined ? {} : { options: extension.options }),
    resourceRoots: extension.resourceRoots,
  });
}

/** 解析显式 Platform subset 并保持原配置顺序。 */
function selectPlatforms(config: ResolvedKernelConfig, selection: readonly string[] | undefined): readonly ResolvedPlatform[] {
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
function platformSession(value: unknown, id: string): PlatformSession {
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
  return value as PlatformSession;
}

/** 验证 Extension Session 精确方法面。 */
function extensionSession(value: unknown, id: string): ExtensionSession<unknown, unknown, unknown> {
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
function firstFailure(diagnostics: DiagnosticRegistry): FailureSummary | undefined {
  /** 同阶段使用 Registry 的稳定排序，跨阶段选择最早的实际生命周期失败。 */
  const failures = diagnostics.diagnostics.filter(diagnostic => diagnostic.severity === 'error');
  /** failure 在稳定诊断顺序相同时按固定 lifecycle phase 决定。 */
  const failure = failures.sort((left, right) => FAILURE_PHASE_ORDER.indexOf(left.phase) - FAILURE_PHASE_ORDER.indexOf(right.phase))[0];
  if (failure === undefined)
    return undefined;
  return Object.freeze({ code: failure.code, phase: failure.phase, message: failure.message });
}

/** 把未预期异常收敛为不包含第三方原始错误的稳定诊断。 */
function reportFailure(
  diagnostics: DiagnosticRegistry,
  phase: Parameters<DiagnosticRegistry['report']>[0],
  code: string,
  message: string,
  identity: Parameters<DiagnosticRegistry['report']>[2] = {},
): void {
  diagnostics.report(phase, { code, severity: 'error', message: sanitizeStableText(message) }, identity);
}

/** Platform 单阶段调用的显式成功/失败联合，避免异常跨阶段重新归类。 */
type PlatformStageResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false }>;

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
async function runPlatformStage<T>(
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
async function closeIntegrations(
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

/** 向单个选中 Platform 授予 canonical auxiliary 和 Public AssetRef。 */
function grantProjectAssets(project: CanonicalProject, platform: string, assets: AssetRegistry): void {
  /** grantee 与 Platform Session 的 owner identity 完全一致。 */
  const grantee = `platform:${platform}`;
  for (const skill of project.skills) {
    for (const auxiliary of skill.auxiliaryFiles)
      assets.grant('framework:canonical', grantee, auxiliary.asset);
  }
  for (const file of project.publicFiles)
    assets.grant('framework:public', grantee, file.asset);
}

/** Framework Resource 对当前 Platform 的 add-only Contributions。 */
function frameworkContributions(
  project: CanonicalProject,
  runtime: BuiltNodeRuntime | undefined,
  platform: PlatformIntegrationDescription,
  assets: AssetRegistry,
): readonly OwnedPackageContribution[] {
  /** Public 与 Runtime 使用独立 owner，保持来源、冲突和 report 可审计。 */
  const contributions: OwnedPackageContribution[] = [];
  if (project.publicFiles.length > 0) {
    contributions.push(Object.freeze({
      owner: 'framework:public',
      contribution: Object.freeze({
        assets: Object.freeze(project.publicFiles.map(file => Object.freeze({ path: file.path, asset: file.asset }))),
        compatibility: Object.freeze([]),
      }),
    }));
  }
  if (project.runtime !== undefined) {
    /** 支持 Platform 获得相同 GeneratedAssetRef 的显式继承 grant。 */
    if (runtime !== undefined && platformSupportsNodeRuntime(platform)) {
      for (const entry of runtime.entries) {
        assets.grant('framework:node-runtime', `platform:${platform.id}`, entry.main);
        if (entry.licenses !== undefined)
          assets.grant('framework:node-runtime', `platform:${platform.id}`, entry.licenses);
      }
    }
    contributions.push(Object.freeze({
      owner: 'framework:node-runtime',
      contribution: nodeRuntimeContribution(project.runtime, runtime, platform),
    }));
  }
  return Object.freeze(contributions);
}

/**
 * 分离 Core candidate 物化完整性与 Platform validator 两个错误阶段。
 *
 * @param options 当前 Platform、Unit 和 Session-owned Registry。
 * @returns candidate 与 validator 都成功且没有 Platform error 时返回 true。
 */
async function validatePlatformCandidate(options: {
  readonly platform: PlatformRuntime;
  readonly unit: PackageUnitSnapshot;
  readonly command: ConfigCommand;
  readonly mode: BuildMode;
  readonly assets: AssetRegistry;
  readonly workDirectories: WorkDirectoryRegistry;
  readonly diagnostics: DiagnosticRegistry;
}): Promise<boolean> {
  /** id 同时绑定 candidate 临时目录、诊断 owner 和 Platform Session。 */
  const id = options.platform.description.id;
  /** 每个平台的 candidate 只能位于其 Core-owned workDir。 */
  const temporaryParent = options.workDirectories.physicalRoot(
    `platform:${id}`,
    await options.workDirectories.directory(`platform:${id}`),
  );
  /** 外层只捕获 candidate materialize、post-validate integrity 与 cleanup failure。 */
  const materialization = await runPlatformStage(
    options.diagnostics,
    'materialize',
    'PACKAGE_CANDIDATE_MATERIALIZATION_FAILED',
    `Platform "${id}" Package "${options.unit.id}" candidate materialization failed.`,
    id,
    async () => {
      /** validatorSucceeded 让 validator failure 不必冒充 materialization exception。 */
      let validatorSucceeded = true;
      await withPackageCandidate(options.unit, options.assets, async (candidate) => {
        /** validation 只收敛 Platform callback，本地候选完整性仍交给外层。 */
        const validation = await runPlatformStage(
          options.diagnostics,
          'platform-validate',
          'PLATFORM_VALIDATE_PACKAGE_FAILED',
          `Platform "${id}" Package "${options.unit.id}" validation failed.`,
          id,
          () => options.platform.session.validatePackage(Object.freeze({
            command: options.command,
            mode: options.mode,
            candidate,
            diagnostics: options.diagnostics.service('platform-validate', { owner: `platform:${id}`, platform: id }),
          })),
        );
        /** Platform 自己报告 error 而未 throw 时也必须阻止当前 Unit 成功。 */
        validatorSucceeded = validation.ok && !platformHasErrors(options.diagnostics, id);
      }, temporaryParent);
      return validatorSucceeded;
    },
  );
  return materialization.ok && materialization.value && !platformHasErrors(options.diagnostics, id);
}

/** 建立 Component 的稳定报告列表。 */
function componentReports(project: CanonicalProject): BuildReport['components'] {
  return Object.freeze([...project.commands, ...project.skills, ...project.agents].map(component => Object.freeze({
    kind: component.kind,
    id: component.id,
    location: Object.freeze({ path: component.location.path, line: component.location.bodyLine }),
  })));
}

/** 在独立临时根复核全部 Unit 的 aggregate materialization closure。 */
async function validateCompleteMaterialization(
  units: readonly PackageUnitSnapshot[],
  assets: AssetRegistry,
  workRoot: string,
): Promise<void> {
  /** complete candidate 使用当前 BuildSession workRoot 下的独立临时根。 */
  const root = await fs.mkdtemp(path.join(workRoot, 'complete-'));
  try {
    /** materialized 索引用于复核 aggregate Unit closure。 */
    const materialized = await materializePackageUnits(root, units, assets);
    await validatePackageUnits(root, units, materialized);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

/**
 * 执行 Kernel v2 唯一 one-shot BuildSession state machine。
 *
 * @param input 已解析配置、选择和事务控制。
 * @returns immutable BuildReport 及 Dev 使用的 Watch snapshot。
 */
export async function runKernelBuildSession(input: KernelBuildSessionInput): Promise<KernelBuildSessionResult> {
  /** environment 是否由本次 direct Core 调用创建并负责释放。 */
  const ownEnvironment = input.environment === undefined;
  /** 配置 loader 传入的 environment 保证 Config 与 Build 共用一组 Host。 */
  const environment = input.environment ?? await createKernelBuildEnvironment(input.config.projectRoot);
  /** 所有 Host/Registry 只从当前唯一 environment 取得。 */
  const { assets, compiler, diagnostics, execution, modules, sources, watch, workDirectories } = environment;
  /** 所有报告集合先以空状态存在，确保任一 Kernel 阶段失败仍可形成报告。 */
  let project: CanonicalProject = Object.freeze({
    metadata: input.config.metadata,
    commands: Object.freeze([]), skills: Object.freeze([]), agents: Object.freeze([]), publicFiles: Object.freeze([]),
  });
  /** setup 成功即压栈，最终只通过 closeIntegrations 消费。 */
  const initialized: InitializedIntegration[] = [];
  /** 选中 Platform 在 setup 前完成纯选择校验。 */
  let selected: readonly ResolvedPlatform[] = Object.freeze([]);
  /** selection 失败属于唯一阻止 Integration setup 的 config 前置错误。 */
  let selectionValid = true;
  /** setup 成功的平台与扩展运行时。 */
  const platforms: PlatformRuntime[] = [];
  /** Extension 运行时保持配置顺序。 */
  const extensions: ExtensionRuntime[] = [];
  /** Extension 各阶段报告状态。 */
  const extensionReports = new Map<string, ExtensionReport>();
  /** validated consumer plans 和 built state 在所有 Platform 间共享。 */
  const plans: ExtensionConsumerPlan<unknown, unknown>[] = [];
  /** Built State 不允许由其他 Extension 读取。 */
  const built: BuiltExtensionState<unknown>[] = [];
  /** 每个 plan 的 skipped/built/failed 状态阻止 missing State 被误归为 Platform failure。 */
  const planBuilds: ExtensionPlanBuildStatus[] = [];
  /** Runtime Built State 只由 Framework contribution 读取。 */
  let builtRuntime: BuiltNodeRuntime | undefined;
  /** 完成 primary/distribution candidate 校验的最终 Units。 */
  const units: PackageUnitSnapshot[] = [];
  /** 报告中精确标记 validated candidate 的 Unit key。 */
  const validatedPackages = new Set<string>();
  /** 每个 Platform 是否完成全部 package stages。 */
  const platformSucceeded = new Set<string>();
  /** Compatibility Registry 必须等 Project Graph 固定后再创建。 */
  let compatibility: ReturnType<CompatibilityRegistry['finalize']> = Object.freeze({ compatibility: Object.freeze([]), metadata: Object.freeze([]) });
  /** committed 只在 transaction afterSwap close 全部成功后变为 true。 */
  let committed = false;
  /** 防止 commit afterSwap 和 finally cleanup 重复关闭。 */
  let integrationsClosed = false;

  try {
    try {
      selected = selectPlatforms(input.config, input.selection);
    } catch {
      selectionValid = false;
      reportFailure(diagnostics, 'config', 'PLATFORM_SELECTION_INVALID', 'Selected Platforms are invalid.');
    }
    /** integrations snapshot 在任何 factory 调用前固定。 */
    const platformDescriptions = selected.map(platformDescription);
    /** Extension descriptions 与 Platform descriptions 共同形成只读 setup 视图。 */
    const extensionDescriptions = input.config.extensions.map(extensionDescription);
    /** integrations 不包含 Session 或可变配置引用。 */
    const integrations: readonly IntegrationDescription[] = Object.freeze([...platformDescriptions, ...extensionDescriptions]);
    /** setup Context 不暴露物理路径或 mutable config。 */
    const summary: ResolvedConfigSummary = Object.freeze({
      metadata: input.config.metadata,
      command: input.config.command,
      mode: input.config.mode,
      strict: input.config.strict,
    });

    /** Platform Session 必须先按配置顺序逐一创建。 */
    for (const [index, resolved] of selected.entries()) {
      /** description 与当前 resolved Platform 使用相同配置槽位。 */
      const description = platformDescriptions[index]!;
      try {
        /** session 一经 shape 校验即进入 initialized close stack。 */
        const session = platformSession(await resolved.definition.createSession(Object.freeze({
          command: input.config.command,
          mode: input.config.mode,
          options: resolved.definition.options ?? Object.freeze({}),
          config: summary,
          integrations,
        })), resolved.definition.id);
        platforms.push(Object.freeze({ resolved, description, session }));
        initialized.push(Object.freeze({ kind: 'platform', id: resolved.definition.id, session }));
      } catch {
        reportFailure(diagnostics, 'setup', 'PLATFORM_SETUP_FAILED', `Platform "${resolved.definition.id}" setup failed.`, {
          owner: `platform:${resolved.definition.id}`, platform: resolved.definition.id,
        });
      }
    }
    /** Extension Session 在 Platform setup 尝试结束后按配置顺序独立创建。 */
    if (selectionValid) {
      for (const [index, definition] of input.config.extensions.entries()) {
        /** description 与当前 Extension 使用相同配置槽位。 */
        const description = extensionDescriptions[index]!;
        try {
          /** session 一经 shape 校验即进入 initialized close stack。 */
          const session = extensionSession(await definition.createSession(Object.freeze({
            command: input.config.command,
            mode: input.config.mode,
            options: definition.options ?? Object.freeze({}),
            config: summary,
            integrations,
          })), definition.id);
          extensions.push(Object.freeze({ definition, description, session }));
          initialized.push(Object.freeze({ kind: 'extension', id: definition.id, session }));
          extensionReports.set(definition.id, Object.freeze({ id: definition.id, discovered: false, subjects: Object.freeze([]) }));
        } catch {
          reportFailure(diagnostics, 'setup', 'EXTENSION_SETUP_FAILED', `Extension "${definition.id}" setup failed.`, {
            owner: `extension:${definition.id}`, extension: definition.id,
          });
        }
      }
    }

    if (selectionValid) {
      /** Resource claims 固定 canonical/runtime/Extension root ownership。 */
      const claims = await new ResourceRegistry({ config: input.config, sources, watch, diagnostics }).claim();
      /** 独立 Resource discover 共享 registries，但不共享 mutable State。 */
      const canonicalPromise = discoverCanonicalProject({
        metadata: input.config.metadata,
        platformIds: selected.map(platform => platform.definition.id),
        claims,
        sources,
        assets,
        diagnostics,
      });
      /** Public Provider 与 canonical/runtime discover 并行且无共享 mutable state。 */
      const publicPromise = discoverPublicResources({ config: input.config, sources, assets, watch, diagnostics });
      /** Runtime Provider 当前只发现 framework-owned entry state。 */
      const runtimePromise = discoverNodeRuntime({
        ...(claims.runtime === undefined ? {} : { root: claims.runtime }),
        config: input.config.runtime,
        sources,
        diagnostics,
      });
      /** 每个 Extension discover 独立捕获并绑定自己的失败身份。 */
      const discoveredExtensions = extensions.map(async (runtime) => {
        try {
          /** discovered State 立即通过 Extension Provider 建立 owner-bound snapshot。 */
          const discovered = await discoverExtension({
            extension: runtime.definition,
            session: runtime.session,
            roots: claims.extensions[runtime.definition.id] ?? Object.freeze({}),
            command: input.config.command,
            mode: input.config.mode,
            sources,
            assets,
            modules: modules.service(`extension:${runtime.definition.id}`),
            diagnostics,
          });
          /** discover 主动报告 error 与 throw 使用相同失败语义。 */
          if (hasMatchingError(diagnostics, item => item.extension === runtime.definition.id))
            return Object.freeze({ runtime, discovered: undefined });
          return Object.freeze({ runtime, discovered });
        } catch {
          reportFailure(diagnostics, 'discover', 'EXTENSION_DISCOVER_FAILED', `Extension "${runtime.definition.id}" discover failed.`, {
            owner: `extension:${runtime.definition.id}`, extension: runtime.definition.id,
          });
          return Object.freeze({ runtime, discovered: undefined });
        }
      });
      /** 聚合只按 Promise 输入槽位读取，不观察完成顺序。 */
      const [canonical, publicFiles, runtime, discovered] = await Promise.all([
        canonicalPromise, publicPromise, runtimePromise, Promise.all(discoveredExtensions),
      ]);
      /** 唯一 Project Graph 在全部 Resource discover 后一次性冻结。 */
      project = assembleProjectGraph(canonical, publicFiles, runtime);

      /** Stage 5 对每个 canonical Component/selected Platform 恰好调用一次 hook。 */
      const components = [...project.commands, ...project.skills, ...project.agents];
      /** 独立验证并行运行，诊断由 Registry 稳定排序。 */
      await Promise.all(platforms.flatMap(platform => components.map(async (component) => {
        try {
          await platform.session.validateComponent?.(Object.freeze({
            project,
            component,
            diagnostics: diagnostics.service('validate', {
              owner: `platform:${platform.description.id}`,
              platform: platform.description.id,
              component: { kind: component.kind, id: component.id },
            }),
          }));
        } catch {
          reportFailure(diagnostics, 'validate', 'PLATFORM_COMPONENT_VALIDATION_FAILED',
            `Platform "${platform.description.id}" could not validate ${component.kind} "${component.id}".`, {
              owner: `platform:${platform.description.id}`,
              platform: platform.description.id,
              component: { kind: component.kind, id: component.id },
            });
        }
      })));

      /** Extension validate 只运行实际发现了作者资源的 State。 */
      const validated = await Promise.all(discovered.map(async ({ runtime: extension, discovered: state }) => {
        if (state === undefined)
          return undefined;
        try {
          /** result 立即跨越 Extension State snapshot 与 subject contract。 */
          const result = await validateExtension({
            discovered: state,
            session: extension.session,
            project,
            command: input.config.command,
            mode: input.config.mode,
            sources,
            assets,
            diagnostics,
          });
          extensionReports.set(extension.definition.id, Object.freeze({
            id: extension.definition.id,
            discovered: true,
            subjects: result.subjects,
          }));
          if (hasMatchingError(diagnostics, diagnostic => diagnostic.extension === extension.definition.id))
            return undefined;
          return Object.freeze({ runtime: extension, validated: result });
        } catch {
          reportFailure(diagnostics, 'validate', 'EXTENSION_VALIDATE_FAILED', `Extension "${extension.definition.id}" validate failed.`, {
            owner: `extension:${extension.definition.id}`, extension: extension.definition.id,
          });
          return undefined;
        }
      }));

      /** consumer preflight 在 build 前固定 missing contributor/skip 语义。 */
      for (const item of validated) {
        if (item === undefined)
          continue;
        try {
          plans.push(preflightExtensionConsumers({
            validated: item.validated,
            session: item.runtime.session,
            platforms: platformDescriptions,
          }));
        } catch {
          reportFailure(diagnostics, 'validate', 'EXTENSION_CONTRIBUTOR_INVALID', `Extension "${item.runtime.definition.id}" contributors are invalid.`, {
            owner: `extension:${item.runtime.definition.id}`, extension: item.runtime.definition.id,
          });
        }
      }

      /** Stage 6 只构建拥有至少一个 consumer 的 Extension。 */
      const buildResults = await Promise.all(plans.map(async (plan) => {
        if (!plan.requiresBuild)
          return Object.freeze({ plan, status: 'skipped' as const });
        /** runtime 仅用于取得当前 plan 自己的 Session。 */
        const runtime = extensions.find(item => item.definition.id === plan.extension.id)!;
        try {
          /** result 在写入 shared built array 前保持 plan 槽位顺序。 */
          const result = await buildExtension({
            plan,
            session: runtime.session,
            project,
            command: input.config.command,
            mode: input.config.mode,
            compiler: await compiler.service(`extension:${plan.extension.id}`),
            execution: execution.service(`extension:${plan.extension.id}`),
            assets,
            sources,
            diagnostics,
          });
          return hasMatchingError(diagnostics, diagnostic => diagnostic.extension === plan.extension.id) || result === undefined
            ? Object.freeze({ plan, status: 'failed' as const })
            : Object.freeze({ plan, status: 'built' as const, built: result });
        } catch {
          reportFailure(diagnostics, 'compile', 'EXTENSION_BUILD_FAILED', `Extension "${plan.extension.id}" build failed.`, {
            owner: `extension:${plan.extension.id}`, extension: plan.extension.id,
          });
          return Object.freeze({ plan, status: 'failed' as const });
        }
      }));
      planBuilds.push(...buildResults);
      built.push(...buildResults
        .filter((value): value is Extract<ExtensionPlanBuildStatus, { readonly status: 'built' }> => value.status === 'built')
        .map(value => value.built));

      /** Runtime 只在至少一个选中且已 setup Platform 声明能力时编译一次。 */
      if (project.runtime !== undefined && platforms.some(platform => platformSupportsNodeRuntime(platform.description))) {
        try {
          builtRuntime = await buildNodeRuntime(project.runtime, await compiler.service('framework:node-runtime'));
        } catch {
          reportFailure(diagnostics, 'compile', 'NODE_RUNTIME_BUILD_FAILED', 'Node Runtime compilation failed.', {
            owner: 'framework:node-runtime',
          });
        }
      }

      /** Package stages 对 selected Platforms 独立执行；报告合并按稳定键完成。 */
      const projectFailed = projectHasErrors(diagnostics);
      /** packageResults 保留 Platform 配置槽位，与并发完成顺序无关。 */
      const packageResults = await Promise.all(platforms.map(async (platform) => {
        /** id 同时绑定 Context owner、诊断和最终 Package namespace。 */
        const id = platform.description.id;
        /** 工程级或本 Platform validation 失败不影响其他独立 Platform。 */
        if (projectFailed || platformHasErrors(diagnostics, id) || platformConsumesFailedExtension(id, planBuilds))
          return undefined;
        /** createPackage 与 base snapshot validation 属于 package 阶段。 */
        const created = await runPlatformStage(
          diagnostics,
          'package',
          'PLATFORM_CREATE_PACKAGE_FAILED',
          `Platform "${id}" createPackage failed.`,
          id,
          async () => {
            grantProjectAssets(project, id, assets);
            return createBasePackage(id, await platform.session.createPackage(Object.freeze({
              command: input.config.command,
              mode: input.config.mode,
              project,
              compiler: await compiler.service(`platform:${id}`),
              assets: assets.service(`platform:${id}`),
              diagnostics: diagnostics.service('package', { owner: `platform:${id}`, platform: id }),
            })), assets);
          },
        );
        if (!created.ok || platformHasErrors(diagnostics, id))
          return undefined;
        /** Contributor collection、Framework contribution 与集中 merge 共用 contribute 边界。 */
        const contributed = await runPlatformStage(
          diagnostics,
          'contribute',
          'PLATFORM_CONTRIBUTION_FAILED',
          `Platform "${id}" Package contribution failed.`,
          id,
          async () => {
            /** Extension Contribution 全部读取 created.value 的同一对象身份。 */
            const extensionContributions = await collectExtensionContributions({
              platform: platform.description,
              base: created.value,
              project,
              command: input.config.command,
              mode: input.config.mode,
              plans,
              built,
              assets,
              diagnostics,
            });
            return mergePackageContributions(id, created.value, [
              ...frameworkContributions(project, builtRuntime, platform.description, assets),
              ...extensionContributions,
            ], assets);
          },
        );
        if (!contributed.ok || platformHasErrors(diagnostics, id))
          return undefined;
        /** Platform finalization 只确定主 Package 身份并追加 Platform Asset。 */
        const finalized = await runPlatformStage(
          diagnostics,
          'finalize',
          'PLATFORM_FINALIZE_PACKAGE_FAILED',
          `Platform "${id}" primary Package finalization failed.`,
          id,
          async () => finalizePrimaryPackage(id, platform.resolved.definition.deliveryType, contributed.value,
            await platform.session.finalizePackage(Object.freeze({
              command: input.config.command,
              mode: input.config.mode,
              project,
              package: contributed.value,
              compiler: await compiler.service(`platform:${id}`),
              assets: assets.service(`platform:${id}`),
              diagnostics: diagnostics.service('finalize', { owner: `platform:${id}`, platform: id }),
            })), assets),
        );
        if (!finalized.ok || platformHasErrors(diagnostics, id))
          return undefined;
        if (!await validatePlatformCandidate({
          platform,
          unit: finalized.value,
          command: input.config.command,
          mode: input.config.mode,
          assets,
          workDirectories,
          diagnostics,
        }))
          return undefined;
        /** Distribution creation 是从已验证 primary 派生的 finalization 子阶段。 */
        const distributions = await runPlatformStage(
          diagnostics,
          'finalize',
          'PLATFORM_FINALIZE_PACKAGE_FAILED',
          `Platform "${id}" Distribution finalization failed.`,
          id,
          async () => platform.session.createDistributions === undefined
            ? Object.freeze([])
            : collectDistributionPackages({
                platform: id,
                primary: finalized.value,
                assets,
                /** create callback 不暴露 Registry，只委托当前 Platform Session。 */
                create: scopedAssets => Promise.resolve(platform.session.createDistributions!(Object.freeze({
                  command: input.config.command,
                  mode: input.config.mode,
                  project,
                  primary: finalized.value,
                  assets: scopedAssets,
                  diagnostics: diagnostics.service('finalize', { owner: `platform:${id}`, platform: id }),
                }))),
              }),
        );
        if (!distributions.ok || platformHasErrors(diagnostics, id))
          return undefined;
        for (const distribution of distributions.value) {
          if (!await validatePlatformCandidate({
            platform,
            unit: distribution,
            command: input.config.command,
            mode: input.config.mode,
            assets,
            workDirectories,
            diagnostics,
          }))
            return undefined;
        }
        return Object.freeze({
          platform,
          merged: contributed.value,
          units: Object.freeze([finalized.value, ...distributions.value]),
        });
      }));

      /** 每个 Platform 独立完成 compatibility graph，错误不抑制其他 Platform。 */
      const compatibilityEntries: typeof compatibility.compatibility[number][] = [];
      /** metadata dispositions 与 compatibility 使用相同 Platform 隔离。 */
      const metadataEntries: typeof compatibility.metadata[number][] = [];
      for (const result of packageResults) {
        if (result === undefined)
          continue;
        units.push(...result.units);
        for (const unit of result.units)
          validatedPackages.add(`${unit.platform}/${unit.id}`);
        /** id 固定当前独立 compatibility Registry 的 Platform identity。 */
        const id = result.platform.description.id;
        try {
          /** registry 只接收当前 Platform 的 graph，避免跨平台失败抑制。 */
          const registry = new CompatibilityRegistry({ project, diagnostics });
          registry.addCompatibility(id, result.merged.compatibility);
          registry.addMetadata(id, result.merged.metadata);
          /** finalized 在完整当前 Platform graph 上执行一次 strictness。 */
          const finalized = registry.finalize([Object.freeze({ id, strict: result.platform.resolved.strict })]);
          compatibilityEntries.push(...finalized.compatibility);
          metadataEntries.push(...finalized.metadata);
          if (!platformHasErrors(diagnostics, id))
            platformSucceeded.add(id);
        } catch {
          reportFailure(diagnostics, 'compatibility', 'COMPATIBILITY_FINALIZATION_FAILED',
            `Platform "${id}" compatibility finalization failed.`, { platform: id, owner: `platform:${id}` });
        }
      }
      compatibility = Object.freeze({
        compatibility: Object.freeze(compatibilityEntries),
        metadata: Object.freeze(metadataEntries),
      });
      /** 无 commit 或已有错误时不会进入 transaction，必须在此完成 aggregate 复核。 */
      if (!input.commit || diagnostics.hasErrors) {
        try {
          await validateCompleteMaterialization(units, assets, environment.workRoot);
        } catch {
          reportFailure(diagnostics, 'materialize', 'PACKAGE_MATERIALIZATION_FAILED', 'Complete Package materialization failed.');
        }
      }
    }

    /** validate/inspect 已由 Project 层强制 commit=false；错误报告也绝不进入事务。 */
    if (input.commit && !diagnostics.hasErrors) {
      try {
        await commitPackageUnits(input.config.outDirectory, units, assets, {
          projectRoot: input.config.projectRoot,
          scope: input.selection === undefined
            ? Object.freeze({ type: 'full' as const })
            : Object.freeze({ type: 'subset' as const, platforms: Object.freeze(selected.map(item => item.definition.id)) }),
          /** close 属于 swap 后仍可 rollback 的 commit 必要条件。 */
          afterSwap: async () => {
            try {
              await closeIntegrations(initialized, diagnostics, true);
            } finally {
              /** stack 已消费，即使 close 失败也不能在 rollback 后重复调用。 */
              integrationsClosed = true;
            }
          },
        });
        committed = true;
      } catch {
        if (!diagnostics.diagnostics.some(item => item.phase === 'cleanup'))
          reportFailure(diagnostics, 'transaction', 'TRANSACTION_FAILED', 'Managed output transaction failed.');
      }
    }
  } catch {
    reportFailure(diagnostics, 'internal', 'INTERNAL_ERROR', 'The Kernel could not complete the BuildSession.');
  } finally {
    if (!integrationsClosed) {
      try {
        await closeIntegrations(initialized, diagnostics, false);
      } catch {
        /** closeIntegrations 已记录每个 cleanup failure。 */
      }
    }
  }

  /** Platform/Extension 未 setup 或未选中状态也必须显式出现在稳定报告。 */
  for (const extension of input.config.extensions) {
    if (!extensionReports.has(extension.id))
      extensionReports.set(extension.id, Object.freeze({ id: extension.id, discovered: false, subjects: Object.freeze([]) }));
  }
  /** selectedIds 用于报告配置中未选 Platform 的显式状态。 */
  const selectedIds = new Set(selected.map(platform => platform.definition.id));
  /** platformReports 从配置全集稳定投影，不从成功 Unit 反推选择状态。 */
  const platformReports: PlatformReport[] = input.config.platforms.map(platform => Object.freeze({
    id: platform.definition.id,
    selected: selectedIds.has(platform.definition.id),
    success: platformSucceeded.has(platform.definition.id) && !diagnostics.diagnostics.some(item => item.platform === platform.definition.id && item.severity === 'error'),
    packageIds: Object.freeze(units.filter(unit => unit.platform === platform.definition.id).map(unit => unit.id).sort(compareCodePoints)),
  }));
  /** BuildSession 成功同时要求无诊断、全部选中 Platform 成功和必要提交完成。 */
  const success = !diagnostics.hasErrors
    && selected.every(platform => platformSucceeded.has(platform.definition.id))
    && (!input.commit || committed);
  /** Report 必须在 capability scope 撤销和 workDir 删除前读取 Asset provenance。 */
  const report = createBuildReport({
    frameworkVersion: input.frameworkVersion,
    compilerVersion: (await compiler.service('framework:report')).engine.version,
    success,
    command: input.config.command,
    mode: input.config.mode,
    committed,
    components: componentReports(project),
    runtimes: Object.freeze((project.runtime?.entries ?? []).map(entry => Object.freeze({
      id: entry.id, kind: entry.kind, location: Object.freeze({ path: entry.source.path }),
      built: builtRuntime?.entries.some(candidate => candidate.id === entry.id) ?? false,
    }))),
    extensions: Object.freeze([...extensionReports.values()]),
    platforms: Object.freeze(platformReports),
    packages: Object.freeze(units),
    validatedPackages: Object.freeze([...validatedPackages]),
    compatibility: compatibility.compatibility,
    metadata: compatibility.metadata,
    diagnostics: diagnostics.diagnostics,
    assets,
  });
  /** Watch snapshot 在关闭 capability scope 前完成不可变复制。 */
  const watchSnapshot = watch.snapshot();
  if (ownEnvironment)
    await disposeKernelBuildEnvironment(environment);
  return Object.freeze({ report, watch: watchSnapshot });
}

/** Project 层规范化 one-shot command/mode/commit defaults。 */
export function normalizeProjectRunOptions(options: ProjectRunOptions = {}): {
  readonly command: Exclude<ConfigCommand, 'dev'>;
  readonly mode: BuildMode;
  readonly selection?: readonly string[];
  readonly commit: boolean;
} {
  /** command 缺省为唯一可提交的一次性 build。 */
  const command = options.command ?? 'build';
  if (command !== 'validate' && command !== 'inspect' && command !== 'build')
    throw new TypeError('Project command must be validate, inspect or build.');
  /** mode 只进入 ConfigEnvironment，不改变 command/commit 规则。 */
  const mode = options.mode ?? 'production';
  if (mode !== 'development' && mode !== 'production')
    throw new TypeError('Project mode must be development or production.');
  if (options.commit !== undefined && typeof options.commit !== 'boolean')
    throw new TypeError('Project commit must be boolean.');
  return Object.freeze({
    command,
    mode,
    ...(options.platforms === undefined ? {} : { selection: Object.freeze([...options.platforms]) }),
    commit: command === 'build' && (options.commit ?? true),
  });
}
