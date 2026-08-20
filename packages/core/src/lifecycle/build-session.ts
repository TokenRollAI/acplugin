/** Core 固定生命周期的唯一 BuildSession orchestrator。 */
import type {
  IntegrationDescription,
} from '../contracts/integrations.js';
import type {
  BuildMode,
  ConfigCommand,
  ResolvedConfigSummary,
} from '../contracts/config.js';
import type {
  BuildReport,
  ExtensionReport,
  PlatformReport,
} from '../contracts/reports.js';
import type { CanonicalProject } from '../contracts/components.js';
import type { PackageUnitSnapshot } from '../contracts/packages.js';
import type { ProjectRunOptions } from '../contracts/project.js';
import { commitPackageUnits } from '../output/transaction.js';
import { CompatibilityRegistry } from '../package/compatibility.js';
import { createBuildReport } from '../package/report-builder.js';
import { discoverCanonicalProject } from '../resources/canonical/provider.js';
import {
  buildExtension,
  discoverExtension,
  preflightExtensionConsumers,
  validateExtension,
  type BuiltExtensionState,
  type ExtensionConsumerPlan,
} from '../resources/extensions.js';
import { assembleProjectGraph } from '../resources/project-graph.js';
import { discoverPublicResources } from '../resources/public.js';
import { ResourceRegistry } from '../resources/registry.js';
import {
  buildNodeRuntime,
  discoverNodeRuntime,
  platformSupportsNodeRuntime,
  type BuiltNodeRuntime,
} from '../resources/runtime/provider.js';
import type { ResolvedKernelConfig, ResolvedPlatform } from '../config/resolver.js';
import { compareCodePoints } from '../security/path-policy.js';
import type { WatchSnapshot } from '../services/watch.js';
import {
  createKernelBuildEnvironment,
  disposeKernelBuildEnvironment,
  type KernelBuildEnvironment,
} from './build-environment.js';

export {
  createKernelBuildEnvironment,
  disposeKernelBuildEnvironment,
  type KernelBuildEnvironment,
} from './build-environment.js';

/** Kernel one-shot 执行所需的内部输入。 */
export interface KernelBuildSessionInput {
  readonly config: ResolvedKernelConfig;
  readonly frameworkVersion: string;
  readonly selection?: readonly string[];
  readonly commit: boolean;
  /** 配置加载阶段已经创建的 Session 服务；省略时由本函数完整拥有。 */
  readonly environment?: KernelBuildEnvironment;
}

/** 内部执行结果为 DevSession 保留安全 Watch snapshot。 */
export interface KernelBuildSessionResult {
  readonly report: BuildReport;
  readonly watch: WatchSnapshot;
}

import {
  closeIntegrations,
  extensionDescription,
  extensionSession,
  hasMatchingError,
  platformDescription,
  platformHasErrors,
  platformSession,
  projectHasErrors,
  reportFailure,
  selectPlatforms,
  type ExtensionPlanBuildStatus,
  type ExtensionRuntime,
  type InitializedIntegration,
  type PlatformRuntime,
} from './integration-sessions.js';
import { runPlatformPipeline, validateCompleteMaterialization } from './platform-pipeline.js';

/** 建立 Component 的稳定报告列表。 */
function componentReports(project: CanonicalProject): BuildReport['components'] {
  return Object.freeze([...project.commands, ...project.skills, ...project.agents].map(component => Object.freeze({
    kind: component.kind,
    id: component.id,
    location: Object.freeze({ path: component.location.path, line: component.location.bodyLine }),
  })));
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
      const packageResults = projectFailed
        ? Object.freeze([])
        : await Promise.all(platforms.map(platform => runPlatformPipeline({
            platform,
            project,
            runtime: builtRuntime,
            plans,
            built,
            planBuilds,
            command: input.config.command,
            mode: input.config.mode,
            compiler,
            assets,
            workDirectories,
            diagnostics,
          })));

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
