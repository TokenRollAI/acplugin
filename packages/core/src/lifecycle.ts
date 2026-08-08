import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CompatibilityCollector,
  type CompatibilityDependency,
  DiagnosticCollector,
  MetadataDispositionCollector,
  sanitizeReportText,
  type ReportRedactionOptions,
} from './diagnostics.js';
import type { ArtifactSourcePolicies, ArtifactSourcePolicy } from './artifacts.js';
import { DeliveryUnitRegistry } from './delivery-units.js';
import { PlatformDraftRegistry } from './documents.js';
import { normalizeOutputPath } from './output-paths.js';
import { createBuildResult } from './reports.js';
import { scanProject } from './scanner.js';
import {
  commitDeliveryUnits,
  validateDeliveryUnitMaterialization,
  withMaterializedDeliveryUnitCandidate,
} from './transaction.js';
import type {
  AcpluginExtension,
  BuildEndContext,
  BuildFailureSummary,
  CompatibilityInput,
  ConfigResolvedContext,
  DiagnosticInput,
  DeliveryUnit,
  DocumentAddPatch,
  ExtensionDescription,
  MetadataDispositionInput,
  PlatformAdapterContext,
  PlatformDescription,
} from './contracts.js';
import type {
  ArtifactInput,
  BuildResult,
  ComponentReport,
  DeliveryUnitReport,
  DocumentReport,
  PluginProject,
  ResolvedConfig,
  ResolvedPlatform,
  TypeScriptModuleLoader,
} from './types.js';

/** 调用最终固定生命周期所需的已解析依赖。 */
export interface LifecycleRequest {
  readonly config: ResolvedConfig;
  readonly loadTypeScriptModule: TypeScriptModuleLoader;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  /** 是否在完整验证成功后提交 outDir；validate/inspect 调用方应保持 false。 */
  readonly commit?: boolean;
  /** 接收 Extension 构建器实际读取的绝对文件，仅供 dev 建立依赖监听图。 */
  readonly onWatchFile?: (file: string) => void;
}

/** 单个 Platform 在当前运行中的隔离状态。 */
interface PlatformRuntime {
  readonly resolved: ResolvedPlatform;
  readonly workDir: string;
  initialized: boolean;
  active: boolean;
}

/** 单个 Extension 的隔离目录与阶段状态。 */
interface ExtensionRuntime {
  readonly extension: AcpluginExtension;
  readonly workDir: string;
  initialized: boolean;
  active: boolean;
  discovered: unknown;
  built: unknown;
  hasResources: boolean;
}

/** 逆序 buildEnd 队列中的对象类别与运行时引用。 */
type InitializedRuntime
  = { readonly kind: 'platform'; readonly runtime: PlatformRuntime }
    | { readonly kind: 'extension'; readonly runtime: ExtensionRuntime };

/**
 * 计算当前诊断集合中的错误数量。
 *
 * @param diagnostics 构建共享诊断收集器。
 * @returns error 严重级别的条目数。
 */
function errorCount(diagnostics: DiagnosticCollector): number {
  return diagnostics.diagnostics.filter(diagnostic => diagnostic.severity === 'error').length;
}

/**
 * 创建固定附加 Platform 或 Extension 身份的诊断出口。
 *
 * @param diagnostics 构建共享诊断收集器。
 * @param identity 当前生命周期对象身份。
 * @param defaultPhase 调用方未声明 phase 时使用的阶段。
 * @returns Context 可见的最小诊断提交函数。
 */
function diagnosticReporter(
  diagnostics: DiagnosticCollector,
  identity: { readonly platform?: PlatformDescription['id']; readonly extension?: string },
  defaultPhase: string,
): (input: DiagnosticInput) => void {
  return input => diagnostics.add({
    ...input,
    phase: input.phase ?? defaultPhase,
    ...(identity.platform === undefined ? {} : { platform: identity.platform }),
    ...(identity.extension === undefined ? {} : { extension: identity.extension }),
  });
}

/**
 * 把任意异常收敛为不包含堆栈、路径或凭据的 buildEnd 摘要。
 *
 * @param error 生命周期捕获的原始异常。
 * @param redaction 当前构建的路径和环境脱敏边界。
 * @returns 可安全提供给清理 Hook 的名称与消息。
 */
function failureSummary(error: unknown, redaction: ReportRedactionOptions): BuildFailureSummary {
  if (error instanceof Error) {
    return Object.freeze({
      name: sanitizeReportText(error.name || 'Error', redaction),
      message: sanitizeReportText(error.message || 'Lifecycle failed.', redaction),
    });
  }
  return Object.freeze({ name: 'Error', message: 'Lifecycle failed.' });
}

/**
 * 为当前生命周期构造严格按 owner 隔离的 Artifact 文件来源授权。
 *
 * @param project Scanner 已确认的规范工程和精确来源文件。
 * @param platforms 当前配置中的 Platform 独占工作目录。
 * @param extensions 当前配置中的 Extension 独占工作目录。
 * @returns Platform、Extension 与 Public 之间不可互相回退的授权表。
 */
function artifactSourcePolicies(
  project: PluginProject,
  platforms: readonly PlatformRuntime[],
  extensions: readonly ExtensionRuntime[],
): ArtifactSourcePolicies {
  /** Platform 可以引用的已扫描 Component 主文件和 Skill 辅助文件。 */
  const componentFiles = [
    ...project.commands.map(component => component.sourcePath),
    ...project.skills.flatMap(component => [component.sourcePath, ...component.auxiliaryFiles.map(file => file.sourcePath)]),
    ...project.agents.map(component => component.sourcePath),
  ].map(sourcePath => Object.freeze({
    // 主 Component 使用工程相对报告路径，辅助文件使用绝对来源；统一以 project.root 为解析基准。
    path: path.resolve(project.root, sourcePath),
    root: project.root,
  }));
  /** 每个 owner 的目录或精确文件授权，不包含工程根和 runtime 共同父目录。 */
  const policies = new Map<string, ArtifactSourcePolicy>();
  for (const runtime of platforms) {
    policies.set(`platform:${runtime.resolved.platform.id}`, {
      roots: [runtime.workDir],
      files: componentFiles,
    });
  }
  for (const runtime of extensions)
    policies.set(`extension:${runtime.extension.name}`, { roots: [runtime.workDir] });
  policies.set('public', {
    files: project.publicFiles.map(file => ({ path: path.resolve(project.root, file.sourcePath), root: project.root })),
  });
  return policies;
}

/**
 * 将 PluginProject Component 依赖转换为兼容性传播边。
 *
 * @param project 已完成图校验的规范工程。
 * @returns 使用 `kind:id` Subject 约定的稳定依赖列表。
 */
function compatibilityDependencies(project: PluginProject): CompatibilityDependency[] {
  return [...project.commands, ...project.skills, ...project.agents].map(component => ({
    subject: `${component.kind}:${component.id}`,
    dependsOn: [
      ...component.requires.skills.map(id => `skill:${id}`),
      ...component.requires.agents.map(id => `agent:${id}`),
    ],
  }));
}

/**
 * 把最终 DeliveryUnit 转换为不含内容字节的报告条目。
 *
 * @param units 全局 Registry 的不可变单元快照。
 * @returns Schema v1 使用的稳定摘要。
 */
function deliveryUnitReports(units: readonly DeliveryUnit[]): DeliveryUnitReport[] {
  return units.map(unit => ({
    platform: unit.platform,
    id: unit.id,
    role: unit.role,
    type: unit.type,
    artifacts: unit.artifacts.map(artifact => ({
      path: artifact.path,
      owner: artifact.owner,
      mode: artifact.mode,
      size: artifact.size,
      sha256: artifact.sha256,
    })),
  }));
}

/**
 * 执行唯一、平台中立的 acplugin Core 生命周期。
 *
 * 具体 Platform 与 Extension 只能通过公开 Hook 和最小 Context 参与，Core 不包含任何内置
 * Platform、Hooks 或 MCP 名称分支。
 *
 * @param request 已解析配置、TS 模块加载能力和可选环境快照。
 * @returns 不含工程绝对路径和 Artifact 内容的 Schema v1 BuildResult。
 */
export async function executeLifecycle(request: LifecycleRequest): Promise<BuildResult> {
  /** buildStart/buildEnd 可见但不会自动加载 dotenv 的环境快照。 */
  const environment = Object.freeze({ ...(request.environment ?? process.env) });
  /** 当前运行所有隔离工作目录的共同临时父目录。 */
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-work-'));
  /** 程序化结果、JSON 报告和 buildEnd 错误摘要共同使用的脱敏边界。 */
  const reportRedaction = Object.freeze({ roots: [request.config.root, runtimeRoot], environment });
  /** 所有 Hook、Scanner、Registry 与事务共享的诊断容器。 */
  const diagnostics = new DiagnosticCollector(reportRedaction);
  /** Platform 和 Adapter 产生的功能兼容性结论。 */
  const compatibility = new CompatibilityCollector();
  /** Platform 对统一元数据字段的处理结果。 */
  const metadata = new MetadataDispositionCollector(diagnostics);
  /** 按配置顺序建立的 Platform 运行时。 */
  const platforms: PlatformRuntime[] = request.config.platforms.map((resolved, index) => ({
    resolved,
    workDir: path.join(runtimeRoot, 'platforms', `${index}-${encodeURIComponent(resolved.platform.id)}`),
    initialized: false,
    active: true,
  }));
  /** 按配置顺序建立且不提供依赖图的 Extension 运行时。 */
  const extensions: ExtensionRuntime[] = request.config.extensions.map((extension, index) => ({
    extension,
    workDir: path.join(runtimeRoot, 'extensions', `${index}-${encodeURIComponent(extension.name)}`),
    initialized: false,
    active: true,
    discovered: undefined,
    built: undefined,
    hasResources: false,
  }));
  /** configResolved 开始后需要逆序执行 buildEnd 的对象。 */
  const initialized: InitializedRuntime[] = [];
  /** 全局 owner-aware DeliveryUnit Registry。 */
  let sourcePolicies: ArtifactSourcePolicies = new Map();
  /** 全局 owner-aware DeliveryUnit Registry；Scanner 完成后替换为精确授权实例。 */
  let units = new DeliveryUnitRegistry(sourcePolicies);
  /** Scanner 产出的只读工程；扫描异常前保持未定义。 */
  let project: PluginProject | undefined;
  /** 各 Platform 完成 Adapter 应用后的结构化 Document 报告。 */
  const documentReports: DocumentReport[] = [];
  /** 不被 cleanup 错误覆盖的首个异常。 */
  let originalError: unknown;
  /** 输出目录是否完成原子交换。 */
  let committed = false;
  /** 防止事务 afterSwap 与 finally 重复清理。 */
  let finalized = false;

  /** Platform 的配置顺序描述快照。 */
  const platformDescriptions = Object.freeze(platforms.map(item => Object.freeze({
    id: item.resolved.platform.id,
    apiVersion: item.resolved.platform.apiVersion,
    deliveryType: item.resolved.platform.deliveryType,
    strict: item.resolved.strict,
  })));
  /** Extension 的配置顺序描述快照。 */
  const extensionDescriptions: readonly ExtensionDescription[] = Object.freeze(extensions.map(item => Object.freeze({
    name: item.extension.name,
    apiVersion: item.extension.apiVersion,
  })));
  /** configResolved Hook 只能读取的最小配置快照。 */
  const configSnapshot = Object.freeze({
    root: request.config.root,
    srcDir: request.config.srcDir,
    metadata: request.config.metadata,
    strict: request.config.strict,
  });

  /**
   * 逆序执行所有已初始化对象的 buildEnd，并把清理失败追加为诊断。
   *
   * @param cause 进入清理前的首个异常。
   * @returns 保留原始异常优先级的最终失败原因。
   */
  const finalize = async (cause: unknown): Promise<unknown> => {
    if (finalized)
      return cause;
    finalized = true;
    /** 后续 buildEnd 可观察且不会覆盖原始异常的失败原因。 */
    let finalCause = cause;
    for (const item of [...initialized].reverse()) {
      /** 当前对象自己的隔离工作目录与身份。 */
      const workDir = item.runtime.workDir;
      /** 当前清理阶段的安全失败摘要。 */
      const error = finalCause === undefined ? undefined : failureSummary(finalCause, reportRedaction);
      if (item.kind === 'platform') {
        /** 当前执行 buildEnd 的 Platform 实例。 */
        const platform = item.runtime.resolved.platform;
        try {
          /** 仅包含安全失败摘要和最小运行信息的 Platform 清理上下文。 */
          const context: BuildEndContext = Object.freeze({
            command: request.config.command,
            mode: request.config.mode,
            projectRoot: request.config.root,
            workDir,
            environment,
            status: finalCause === undefined && !diagnostics.hasErrors ? 'success' : 'failed',
            ...(error === undefined ? {} : { error }),
            reportDiagnostic: diagnosticReporter(diagnostics, { platform: platform.id }, 'buildEnd'),
          });
          await platform.buildEnd?.(context);
        } catch /** cleanupError 保存当前操作捕获的异常，供本阶段转换或恢复。 */ (cleanupError) {
          finalCause ??= cleanupError;
          diagnostics.error('PLATFORM_BUILD_END_FAILED', `Platform "${platform.id}" buildEnd failed.`, {
            phase: 'buildEnd', platform: platform.id,
          });
        }
      } else {
        /** 当前执行 buildEnd 的 Extension 实例。 */
        const extension = item.runtime.extension;
        try {
          /** 仅包含安全失败摘要和最小运行信息的 Extension 清理上下文。 */
          const context: BuildEndContext = Object.freeze({
            command: request.config.command,
            mode: request.config.mode,
            projectRoot: request.config.root,
            workDir,
            environment,
            status: finalCause === undefined && !diagnostics.hasErrors ? 'success' : 'failed',
            ...(error === undefined ? {} : { error }),
            reportDiagnostic: diagnosticReporter(diagnostics, { extension: extension.name }, 'buildEnd'),
          });
          await extension.buildEnd?.(context);
        } catch /** cleanupError 保存当前操作捕获的异常，供本阶段转换或恢复。 */ (cleanupError) {
          finalCause ??= cleanupError;
          diagnostics.error('EXTENSION_BUILD_END_FAILED', `Extension "${extension.name}" buildEnd failed.`, {
            phase: 'buildEnd', extension: extension.name,
          });
        }
      }
    }
    return finalCause;
  };

  try {
    await fs.mkdir(path.join(runtimeRoot, 'platforms'), { recursive: true });
    await fs.mkdir(path.join(runtimeRoot, 'extensions'), { recursive: true });

    // configResolved 固定先执行 Platform，再执行 Extension，且都保持用户配置顺序。
    for (const runtime of platforms) {
      await fs.mkdir(runtime.workDir, { recursive: true });
      runtime.initialized = true;
      initialized.push({ kind: 'platform', runtime });
      /** 当前进入 configResolved 阶段的 Platform。 */
      const platform = runtime.resolved.platform;
      try {
        /** Platform 可见的冻结配置与生态描述快照。 */
        const context: ConfigResolvedContext = Object.freeze({
          command: request.config.command,
          mode: request.config.mode,
          config: configSnapshot,
          platforms: platformDescriptions,
          extensions: extensionDescriptions,
          reportDiagnostic: diagnosticReporter(diagnostics, { platform: platform.id }, 'configResolved'),
        });
        await platform.configResolved?.(context);
      } catch {
        runtime.active = false;
        diagnostics.error('PLATFORM_HOOK_FAILED', `Platform "${platform.id}" configResolved failed.`, {
          phase: 'configResolved', platform: platform.id,
        });
      }
    }
    for (const runtime of extensions) {
      await fs.mkdir(runtime.workDir, { recursive: true });
      runtime.initialized = true;
      initialized.push({ kind: 'extension', runtime });
      try {
        /** Extension 可见的冻结配置与生态描述快照。 */
        const context: ConfigResolvedContext = Object.freeze({
          command: request.config.command,
          mode: request.config.mode,
          config: configSnapshot,
          platforms: platformDescriptions,
          extensions: extensionDescriptions,
          reportDiagnostic: diagnosticReporter(diagnostics, { extension: runtime.extension.name }, 'configResolved'),
        });
        await runtime.extension.configResolved?.(context);
      } catch {
        runtime.active = false;
        diagnostics.error('EXTENSION_HOOK_FAILED', `Extension "${runtime.extension.name}" configResolved failed.`, {
          phase: 'configResolved', extension: runtime.extension.name,
        });
      }
    }

    // buildStart 仍固定 Platform 在前、Extension 在后；失败对象不再进入后续业务 Hook。
    for (const runtime of platforms.filter(item => item.active)) {
      try {
        await runtime.resolved.platform.buildStart?.(Object.freeze({
          command: request.config.command,
          mode: request.config.mode,
          projectRoot: request.config.root,
          workDir: runtime.workDir,
          environment,
          reportDiagnostic: diagnosticReporter(diagnostics, { platform: runtime.resolved.platform.id }, 'buildStart'),
        }));
      } catch {
        runtime.active = false;
        diagnostics.error('PLATFORM_HOOK_FAILED', `Platform "${runtime.resolved.platform.id}" buildStart failed.`, {
          phase: 'buildStart', platform: runtime.resolved.platform.id,
        });
      }
    }
    for (const runtime of extensions.filter(item => item.active)) {
      try {
        await runtime.extension.buildStart?.(Object.freeze({
          command: request.config.command,
          mode: request.config.mode,
          projectRoot: request.config.root,
          workDir: runtime.workDir,
          environment,
          reportDiagnostic: diagnosticReporter(diagnostics, { extension: runtime.extension.name }, 'buildStart'),
        }));
      } catch {
        runtime.active = false;
        diagnostics.error('EXTENSION_HOOK_FAILED', `Extension "${runtime.extension.name}" buildStart failed.`, {
          phase: 'buildStart', extension: runtime.extension.name,
        });
      }
    }

    for (const runtime of extensions.filter(item => item.active)) {
      try {
        runtime.discovered = await runtime.extension.discover?.(Object.freeze({
          command: request.config.command,
          mode: request.config.mode,
          srcDir: request.config.srcDir,
          workDir: runtime.workDir,
          loadTypeScriptModule: request.loadTypeScriptModule,
          reportDiagnostic: diagnosticReporter(diagnostics, { extension: runtime.extension.name }, 'discover'),
        }));
        // discover 返回 undefined 是通用的“未发现资源”信号，空 Extension 不影响兼容性。
        runtime.hasResources = runtime.discovered !== undefined;
      } catch {
        runtime.active = false;
        diagnostics.error('EXTENSION_HOOK_FAILED', `Extension "${runtime.extension.name}" discover failed.`, {
          phase: 'discover', extension: runtime.extension.name,
        });
      }
    }

    /** Core Scanner 始终在 Extension discover 后建立唯一 PluginProject。 */
    const scanned = await scanProject(request.config, diagnostics);
    project = scanned.project;
    /** Scanner 之后才能把工程来源收窄为实际发现的精确文件。 */
    sourcePolicies = artifactSourcePolicies(project, platforms, extensions);
    units = new DeliveryUnitRegistry(sourcePolicies);

    for (const runtime of extensions.filter(item => item.active)) {
      try {
        await runtime.extension.validate?.(Object.freeze({
          command: request.config.command,
          mode: request.config.mode,
          project,
          reportDiagnostic: diagnosticReporter(diagnostics, { extension: runtime.extension.name }, 'validate'),
        }), runtime.discovered as never);
      } catch {
        runtime.active = false;
        diagnostics.error('EXTENSION_HOOK_FAILED', `Extension "${runtime.extension.name}" validate failed.`, {
          phase: 'validate', extension: runtime.extension.name,
        });
      }
    }

    if (!diagnostics.hasErrors) {
      for (const runtime of extensions.filter(item => item.active)) {
        try {
          runtime.built = await runtime.extension.build?.(Object.freeze({
            command: request.config.command,
            mode: request.config.mode,
            project,
            workDir: runtime.workDir,
            /** Extension 只能登记明确的绝对文件，避免相对路径随进程 cwd 漂移。 */
            addWatchFile: (file: string): void => {
              if (typeof file !== 'string' || file.includes('\0') || !path.isAbsolute(file))
                throw new TypeError('Extension watch files must be absolute paths without NUL bytes.');
              request.onWatchFile?.(path.normalize(file));
            },
            reportDiagnostic: diagnosticReporter(diagnostics, { extension: runtime.extension.name }, 'build'),
          }), runtime.discovered as never);
        } catch {
          runtime.active = false;
          diagnostics.error('EXTENSION_HOOK_FAILED', `Extension "${runtime.extension.name}" build failed.`, {
            phase: 'build', extension: runtime.extension.name,
          });
        }
      }
    }

    /** Platform 阶段开始前的结构错误会阻止所有产物生成。 */
    const generationAllowed = !diagnostics.hasErrors;
    if (generationAllowed) {
      for (const runtime of platforms) {
        /** 当前串行执行产物生成的 Platform。 */
        const platform = runtime.resolved.platform;
        /** 当前 Platform 新增错误不会阻止后续 Platform 收集自己的诊断。 */
        const errorsBeforePlatform = errorCount(diagnostics);
        if (!runtime.active)
          continue;
        try {
          /** Platform prepare 产生的兼容性出口自动附加当前 Platform ID。 */
          const reportCompatibility = (entry: CompatibilityInput): void => compatibility.add({ ...entry, platform: platform.id });
          /** Platform 对统一元数据的处理结论同样由 Core 固定附加身份。 */
          const reportMetadata = (entry: MetadataDispositionInput): void => metadata.add({ ...entry, platform: platform.id });
          /** Platform 初始结构化 Draft。 */
          const draftInput = await platform.prepare(Object.freeze({
            command: request.config.command,
            mode: request.config.mode,
            project,
            options: platform.options ?? Object.freeze({}),
            workDir: runtime.workDir,
            reportCompatibility,
            reportMetadata,
            reportDiagnostic: diagnosticReporter(diagnostics, { platform: platform.id }, 'prepare'),
          }));
          /** Draft Registry 同时允许当前 Platform、工程扫描来源和 Extension 临时产物。 */
          const draft = await PlatformDraftRegistry.create(platform.id, draftInput, sourcePolicies);
          for (const publicFile of project.publicFiles) {
            await draft.injectPublicArtifact({
              path: publicFile.targetPath,
              source: { type: 'file', path: publicFile.sourcePath },
              mode: publicFile.mode,
            });
          }

          for (const extensionRuntime of extensions.filter(item => item.active && item.hasResources)) {
            /** 当前 Extension 对该 Platform 的唯一 Adapter。 */
            const adapter = extensionRuntime.extension.adapters.find(item => item.platform === platform.id);
            if (!adapter) {
              compatibility.add({
                platform: platform.id,
                subject: `extension:${extensionRuntime.extension.name}`,
                capability: extensionRuntime.extension.name,
                level: 'unsupported',
                reason: `Extension "${extensionRuntime.extension.name}" has resources but no Adapter for Platform "${platform.id}".`,
              });
              continue;
            }
            /** Adapter 同步 API 提交的异步 Artifact 校验任务。 */
            const pendingArtifacts: Promise<unknown>[] = [];
            /** Adapter 只能访问当前 Draft 的 add-only 受限上下文。 */
            const context: PlatformAdapterContext = Object.freeze({
              command: request.config.command,
              mode: request.config.mode,
              platform: Object.freeze({
                id: platform.id,
                apiVersion: platform.apiVersion,
                deliveryType: platform.deliveryType,
              }),
              project,
              /** getDocument 提供当前对象协议要求的回调实现。 */ getDocument: <T>(id: string): Readonly<T> | undefined => draft.getDocument<T>(id),
              /** emitArtifact 提供当前对象协议要求的回调实现。 */ emitArtifact: (input: ArtifactInput): void => {
                pendingArtifacts.push(draft.emitArtifact(`extension:${extensionRuntime.extension.name}`, input));
              },
              /** patchDocument 提供当前对象协议要求的回调实现。 */ patchDocument: (input: DocumentAddPatch): void => draft.patchDocument(`extension:${extensionRuntime.extension.name}`, input),
              /** reportCompatibility 提供当前对象协议要求的回调实现。 */ reportCompatibility: (entry: CompatibilityInput): void => compatibility.add({ ...entry, platform: platform.id }),
              reportDiagnostic: diagnosticReporter(diagnostics, {
                platform: platform.id,
                extension: extensionRuntime.extension.name,
              }, 'adapter'),
            });
            await adapter.apply(context, extensionRuntime.built as never);
            await Promise.all(pendingArtifacts);
          }

          /** document 表示当前 Platform 在 Adapter 完成后的最终结构化 Document。 */
          for (const document of draft.documents) {
            documentReports.push({
              platform: platform.id,
              id: document.id,
              path: document.path,
              format: document.format,
              owner: document.owner,
            });
          }

          // 当前 Platform 的全部 Adapter 结论完成后应用 strictness；错误只跳过当前 Platform。
          compatibility.applyStrictness(diagnostics, { id: platform.id, strict: runtime.resolved.strict });
          if (errorCount(diagnostics) > errorsBeforePlatform)
            continue;

          /** generateBundle 新增的兼容性结论只在本 checkpoint 之后再次应用 strictness。 */
          const generateCompatibilityStart = compatibility.size;
          /** Platform 读取完成 owner merge 的只读 Draft 并生成主单元。 */
          const primaryInput = await platform.generateBundle(Object.freeze({
            command: request.config.command,
            mode: request.config.mode,
            project,
            documents: draft.documents,
            artifacts: draft.artifacts,
            workDir: runtime.workDir,
            reportCompatibility,
            reportDiagnostic: diagnosticReporter(diagnostics, { platform: platform.id }, 'generateBundle'),
          }));
          compatibility.applyStrictness(
            diagnostics,
            { id: platform.id, strict: runtime.resolved.strict },
            generateCompatibilityStart,
          );
          if (errorCount(diagnostics) > errorsBeforePlatform)
            continue;
          if (primaryInput.id !== platform.deliveryType || primaryInput.role !== 'primary' || primaryInput.type !== platform.deliveryType)
            throw new Error(`Platform "${platform.id}" returned an invalid primary DeliveryUnit contract.`);
          /** Platform 必须序列化全部 Document 并透传全部 Public/Extension Artifact。 */
          const outputPaths = new Set(primaryInput.artifacts.map(artifact => normalizeOutputPath(artifact.path)));
          for (const document of draft.documents) {
            /** omit-if-empty 只在 Adapter 合并后仍为空对象时允许不生成物理文件。 */
            const canOmit = document.emission === 'omit-if-empty'
              && document.value !== null
              && typeof document.value === 'object'
              && !Array.isArray(document.value)
              && Object.keys(document.value).length === 0;
            if (!canOmit && !outputPaths.has(document.path))
              throw new Error(`Platform "${platform.id}" omitted Document "${document.id}" from its primary unit.`);
          }
          for (const artifact of draft.artifacts) {
            if (!outputPaths.has(artifact.path))
              throw new Error(`Platform "${platform.id}" omitted inherited Artifact "${artifact.path}" from its primary unit.`);
          }
          /** owner 完整且已进入全局 tuple 唯一性的主单元。 */
          const primary = await units.add(platform.id, primaryInput, draft.artifacts);
          await withMaterializedDeliveryUnitCandidate(primary, candidate => platform.validateBundle(Object.freeze({
            command: request.config.command,
            mode: request.config.mode,
            candidate,
            reportDiagnostic: diagnosticReporter(diagnostics, { platform: platform.id }, 'validateBundle'),
          })), runtime.workDir);
          if (errorCount(diagnostics) > errorsBeforePlatform) {
            units.removePlatform(platform.id);
            continue;
          }

          if (platform.generateDistributions) {
            /** Platform 只能组合自己已经验证的主单元。 */
            const distributions = await platform.generateDistributions(Object.freeze({
              command: request.config.command,
              mode: request.config.mode,
              project,
              options: platform.options ?? Object.freeze({}),
              workDir: runtime.workDir,
              reportDiagnostic: diagnosticReporter(diagnostics, { platform: platform.id }, 'generateDistributions'),
            }), Object.freeze([primary]));
            for (const distributionInput of distributions) {
              if (distributionInput.id !== 'marketplace' || distributionInput.role !== 'distribution' || distributionInput.type !== 'marketplace')
                throw new Error(`Platform "${platform.id}" returned an invalid Distribution contract.`);
              /** 每个 Distribution 独立进入全局 Registry 和候选 Validator。 */
              const distribution = await units.add(platform.id, distributionInput, primary.artifacts);
              await withMaterializedDeliveryUnitCandidate(distribution, candidate => platform.validateBundle(Object.freeze({
                command: request.config.command,
                mode: request.config.mode,
                candidate,
                reportDiagnostic: diagnosticReporter(diagnostics, { platform: platform.id }, 'validateBundle'),
              })), runtime.workDir);
            }
          }
          if (errorCount(diagnostics) > errorsBeforePlatform)
            units.removePlatform(platform.id);
        } catch {
          units.removePlatform(platform.id);
          diagnostics.error('PLATFORM_GENERATION_FAILED', `Platform "${platform.id}" generation failed.`, {
            phase: 'generate', platform: platform.id,
          });
        }
      }
    }

    /** 只对依赖传播新产生的结论追加 strict/relaxed Diagnostic，避免重复直接结论。 */
    const propagatedCompatibilityStart = compatibility.size;
    if (project)
      compatibility.propagateDependencies(compatibilityDependencies(project));
    for (const runtime of platforms) {
      compatibility.applyStrictness(
        diagnostics,
        { id: runtime.resolved.platform.id, strict: runtime.resolved.strict },
        propagatedCompatibilityStart,
      );
    }
    /** 全局 Registry 完整且无错误时才允许物化或提交任何单元。 */
    const finalUnits = units.snapshot();
    /** 已成功建立主单元的 Platform 集合。 */
    const successfulPlatforms = new Set(finalUnits.filter(unit => unit.role === 'primary').map(unit => unit.platform));
    /** 配置中的每个 Platform 是否都完成了主单元生成。 */
    const allPlatformsGenerated = platforms.every(runtime => successfulPlatforms.has(runtime.resolved.platform.id));
    if (!diagnostics.hasErrors && generationAllowed && allPlatformsGenerated) {
      /** 显式策略优先；Core 直接调用仍按命令使用符合直觉的默认提交行为。 */
      const commit = request.commit ?? (request.config.command === 'build' || request.config.command === 'dev');
      if (commit) {
        await commitDeliveryUnits(request.config.outDir, finalUnits, {
          projectRoot: request.config.root,
          /** buildEnd 仍处于 backup 可回滚窗口，清理失败不会留下部分提交。 */
          async afterSwap() {
            originalError = await finalize(originalError);
            if (originalError !== undefined || diagnostics.hasErrors)
              throw originalError ?? new Error('Lifecycle cleanup failed.');
          },
        });
        committed = true;
      } else {
        await validateDeliveryUnitMaterialization(finalUnits);
        originalError = await finalize(originalError);
      }
    }
  } catch /** error 保存当前操作捕获的异常，供本阶段转换或恢复。 */ (error) {
    originalError ??= error;
    if (!diagnostics.hasErrors)
      diagnostics.error('LIFECYCLE_INTERNAL_FAILED', 'The lifecycle failed inside Core.', { phase: 'internal' });
  } finally {
    if (originalError === undefined && diagnostics.hasErrors)
      originalError = new Error('Lifecycle failed; see diagnostics.');
    originalError = await finalize(originalError);
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  }

  /** buildEnd 之后的最终不可变单元快照。 */
  const finalUnits = units.snapshot();
  /** Scanner 成功时由三种规范资源组成的无路径 Component 摘要。 */
  const components: ComponentReport[] = project === undefined
    ? []
    : [...project.commands, ...project.skills, ...project.agents].map(component => ({
        kind: component.kind,
        id: component.id,
      }));
  return createBuildResult({
    command: request.config.command,
    success: !diagnostics.hasErrors && originalError === undefined
      && platforms.every(runtime => finalUnits.some(unit => unit.platform === runtime.resolved.platform.id && unit.role === 'primary')),
    committed,
    platforms: platforms.map(runtime => runtime.resolved.platform.id),
    platformDetails: platformDescriptions,
    components,
    extensions: extensionDescriptions.map((extension, index) => ({
      ...extension,
      hasResources: extensions[index]?.hasResources ?? false,
    })),
    documents: documentReports,
    deliveryUnits: deliveryUnitReports(finalUnits),
    diagnostics: diagnostics.diagnostics,
    compatibility: compatibility.entries,
    metadata: metadata.entries,
  }, reportRedaction);
}
