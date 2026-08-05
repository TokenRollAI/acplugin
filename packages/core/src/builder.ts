import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ArtifactGraph } from './artifacts.js';
import { applyCompatibilityStrictness, DiagnosticCollector, sanitizeReportText, sortCompatibility } from './diagnostics.js';
import { scanProject } from './scanner.js';
import { commitManagedOutput, validateMaterialization } from './transaction.js';
import type {
  AcpluginModule,
  Artifact,
  ArtifactReportEntry,
  BuildReport,
  BuildRequest,
  BuildResult,
  CompatibilityEntry,
  Diagnostic,
  ModuleBaseContext,
  PluginProject,
  TargetContribution,
  TargetId,
} from './types.js';

/** 保存单个 Module 在一次构建生命周期中的隔离目录和阶段状态。 */
interface ModuleRuntime {
  /** 当前执行的 Module 定义。 */
  module: AcpluginModule;
  /** 仅供该 Module 使用的临时工作目录。 */
  workDir: string;
  /** discover 阶段产生并传递给后续 Hook 的状态。 */
  state: unknown;
  /** build 阶段产生并传递给 generate Hook 的状态。 */
  builtState: unknown;
}

/**
 * 按 Module 依赖关系执行稳定的拓扑排序。
 *
 * 没有依赖关系的 Module 保持配置中的相对顺序，以保证构建结果可预测。
 *
 * @param modules 配置解析完成后的 Module 列表。
 * @returns 依赖项始终位于使用方之前的新数组。
 * @throws 依赖缺失或依赖图存在环时抛出异常。
 */
function sortModules(modules: readonly AcpluginModule[]): AcpluginModule[] {
  /** 按唯一名称索引 Module，用于解析 dependsOn。 */
  const byName = new Map(modules.map(module => [module.name, module]));
  /** Module 在用户配置中的位置，用作无依赖节点的稳定排序依据。 */
  const configuredIndex = new Map(modules.map((module, index) => [module.name, index]));
  /** 已完成拓扑排序的 Module。 */
  const result: AcpluginModule[] = [];
  /** 当前深度优先路径上的 Module，用于发现依赖环。 */
  const visiting = new Set<string>();
  /** 已完整访问的 Module，防止重复加入结果。 */
  const visited = new Set<string>();

  /**
   * 深度优先访问单个 Module，并在其依赖完成后加入结果。
   *
   * @param module 当前待访问的 Module。
   * @param stack 不包含当前节点的依赖访问路径，用于生成可读环路。
   */
  const visit = (module: AcpluginModule, stack: string[]): void => {
    if (visited.has(module.name))
      return;
    if (visiting.has(module.name))
      throw new Error(`Module dependency cycle: ${[...stack, module.name].join(' -> ')}`);
    visiting.add(module.name);
    for (const dependency of module.dependsOn ?? []) {
      /** 依赖名称对应的已配置 Module。 */
      const target = byName.get(dependency);
      if (!target)
        throw new Error(`Module "${module.name}" requires missing module "${dependency}".`);
      visit(target, [...stack, module.name]);
    }
    visiting.delete(module.name);
    visited.add(module.name);
    result.push(module);
  };

  for (const module of [...modules].sort((a, b) => (configuredIndex.get(a.name) ?? 0) - (configuredIndex.get(b.name) ?? 0)))
    visit(module, []);
  return result;
}

/**
 * 提取当前 Module 声明依赖的阶段状态，并保持 dependsOn 中的声明顺序。
 *
 * @param runtime 当前 Module 的运行时记录。
 * @param all 全部已配置 Module 的运行时索引。
 * @param field 需要暴露 discover 状态还是 build 状态。
 * @returns 只包含直接依赖的状态映射。
 */
function dependencyMap(
  runtime: ModuleRuntime,
  all: ReadonlyMap<string, ModuleRuntime>,
  field: 'state' | 'builtState',
): ReadonlyMap<string, unknown> {
  return new Map((runtime.module.dependsOn ?? []).map(name => [name, all.get(name)?.[field]]));
}

/**
 * 为 Module Hook 构造统一基础上下文。
 *
 * @param request 本次构建请求。
 * @param diagnostics 构建生命周期共享的诊断收集器。
 * @param runtime 当前 Module 的运行时记录。
 * @param all 全部 Module 的运行时索引。
 * @returns 带隔离工作目录和依赖状态的 Hook 上下文。
 */
function moduleContext(
  request: BuildRequest,
  diagnostics: DiagnosticCollector,
  runtime: ModuleRuntime,
  all: ReadonlyMap<string, ModuleRuntime>,
): ModuleBaseContext {
  return {
    config: request.config,
    diagnostics,
    loadTypeScriptModule: request.loadTypeScriptModule,
    workDir: runtime.workDir,
    dependencyState: dependencyMap(runtime, all, 'state'),
    dependencyBuiltState: dependencyMap(runtime, all, 'builtState'),
  };
}

/**
 * 根据构建最终状态创建可持久化的确定性报告。
 *
 * validate 命令只验证可物化性，不对外承诺产物，因此报告中不会包含 Artifact。
 *
 * @param request 本次构建请求。
 * @param project Scanner 成功产出的规范工程。
 * @param diagnostics 已完成脱敏和排序的诊断。
 * @param compatibility 各 Compiler 与 Module 汇总的兼容性条目。
 * @param artifacts 各目标的产物元数据。
 * @param committed 是否已经完成受管输出目录交换。
 * @returns 构建命令的最终报告。
 */
function createReport(
  request: BuildRequest,
  project: PluginProject | undefined,
  diagnostics: readonly Diagnostic[],
  compatibility: readonly CompatibilityEntry[],
  artifacts: readonly ArtifactReportEntry[],
  committed: boolean,
): BuildReport {
  return {
    schemaVersion: '1',
    command: request.config.command,
    mode: request.config.mode,
    project: { name: request.config.name, version: request.config.version },
    targets: request.config.targets.map(target => target.id),
    diagnostics,
    compatibility: sortCompatibility(compatibility),
    artifacts: request.config.command === 'validate'
      ? []
      : [...artifacts].sort((a, b) => a.target.localeCompare(b.target, 'en') || a.path.localeCompare(b.path, 'en')),
    success: !diagnostics.some(diagnostic => diagnostic.severity === 'error') && project !== undefined,
    committed,
  };
}

/**
 * 执行一次完整的 acplugin 构建或验证 Pipeline。
 *
 * 生命周期顺序固定为 Module configResolved/discover、Core scan、Module validate/build、
 * 逐目标 generate/compile、Artifact 校验与提交，最后逆序执行 buildEnd。
 *
 * @param request 已解析配置、Compiler 注册表和提交策略。
 * @returns 项目快照与不会泄露内部异常内容的构建报告。
 */
export async function buildProject(request: BuildRequest): Promise<BuildResult> {
  /** 在全部 Pipeline 阶段间共享的安全诊断收集器。 */
  const diagnostics = new DiagnosticCollector();
  /** 所有目标和 Module 产生的兼容性说明。 */
  const compatibility: CompatibilityEntry[] = [];
  /** 用于报告且不包含实际内容的 Artifact 元数据。 */
  const artifactReports: ArtifactReportEntry[] = [];
  /** 按目标保存已验证的最终 Artifact 图，供事务阶段统一提交。 */
  const targetArtifacts = new Map<TargetId, readonly Artifact[]>();
  /** 本次构建隔离的 Module 临时目录根节点。 */
  const runtimeRoot = await fs.mkdtemp(path.join(request.config.root, '.acplugin-work-'));
  /** 按 Module 名称索引运行时状态，供依赖方读取。 */
  const runtimes = new Map<string, ModuleRuntime>();
  /** 已成功进入生命周期、因此必须执行 buildEnd 的 Module。 */
  const initialized: ModuleRuntime[] = [];
  /** Scanner 产出的规范工程；扫描发生前保持未定义。 */
  let project: PluginProject | undefined;
  /** 需要传递给 buildEnd 和事务回滚的首个框架异常。 */
  let originalError: unknown;
  /** 受管输出目录是否已经成功完成交换。 */
  let committed = false;
  /** 防止 buildEnd 在正常路径、异常路径和 finally 中重复执行。 */
  let finalized = false;

  /**
   * 以初始化的逆序执行所有 Module 的 buildEnd，并保留最早失败原因。
   *
   * @param cause 触发清理的原始失败；正常结束时为 undefined。
   * @returns 原始失败或第一个 buildEnd 失败。
   */
  const finalizeModules = async (cause: unknown): Promise<unknown> => {
    if (finalized)
      return cause;
    finalized = true;
    /** 向后续 buildEnd 传播且最终决定事务是否回滚的首个清理原因。 */
    let cleanupCause = cause;
    // 逆序收尾与依赖初始化顺序相反，使使用方先于其依赖释放资源。
    for (const runtime of [...initialized].reverse()) {
      try {
        const context = moduleContext(request, diagnostics, runtime, runtimes);
        await runtime.module.buildEnd?.(cleanupCause === undefined ? context : { ...context, error: cleanupCause });
      } catch (error) {
        cleanupCause ??= error;
        diagnostics.error('MODULE_BUILD_END_FAILED', `Module ${runtime.module.name} buildEnd failed.`, { phase: 'buildEnd', module: runtime.module.name });
      }
    }
    return cleanupCause;
  };

  try {
    /** 按依赖顺序排列、可安全启动生命周期的 Module。 */
    let orderedModules: AcpluginModule[];
    try {
      orderedModules = sortModules(request.config.modules);
    } catch {
      diagnostics.error('MODULE_GRAPH_INVALID', 'Module dependency graph is invalid.', { phase: 'config' });
      orderedModules = [];
    }

    for (const module of orderedModules) {
      /** 当前 Module 在本次构建中的隔离运行时记录。 */
      const runtime: ModuleRuntime = {
        module,
        workDir: path.join(runtimeRoot, encodeURIComponent(module.name)),
        state: undefined,
        builtState: undefined,
      };
      await fs.mkdir(runtime.workDir, { recursive: true });
      runtimes.set(module.name, runtime);
      try {
        await module.configResolved?.(request.config);
        // 只有 configResolved 成功的 Module 才进入后续 Hook，并承担 buildEnd 清理责任。
        initialized.push(runtime);
      } catch {
        diagnostics.error('MODULE_HOOK_FAILED', `Module ${module.name} configResolved failed.`, { phase: 'configResolved', module: module.name });
      }
    }

    // discover 仅允许 Module 准备自己的状态；规范 Component 仍由随后执行的 Core Scanner 创建。
    for (const runtime of initialized) {
      try {
        runtime.state = await runtime.module.discover?.(moduleContext(request, diagnostics, runtime, runtimes));
      } catch {
        diagnostics.error('MODULE_HOOK_FAILED', `Module ${runtime.module.name} discover failed.`, { phase: 'discover', module: runtime.module.name });
      }
    }

    /** Core Scanner 返回的规范工程和共享诊断收集器。 */
    const scanned = await scanProject(request.config, diagnostics);
    project = scanned.project;

    for (const runtime of initialized) {
      try {
        await runtime.module.validate?.({ ...moduleContext(request, diagnostics, runtime, runtimes), project }, runtime.state);
      } catch {
        diagnostics.error('MODULE_HOOK_FAILED', `Module ${runtime.module.name} validate failed.`, { phase: 'validate', module: runtime.module.name });
      }
    }

    if (!diagnostics.hasErrors) {
      // validate 产生任何错误后不再执行 build，避免 Module 基于无效工程制造派生状态。
      for (const runtime of initialized) {
        try {
          runtime.builtState = await runtime.module.build?.({ ...moduleContext(request, diagnostics, runtime, runtimes), project }, runtime.state);
        } catch {
          diagnostics.error('MODULE_HOOK_FAILED', `Module ${runtime.module.name} build failed.`, { phase: 'build', module: runtime.module.name });
        }
      }
    }

    if (!diagnostics.hasErrors) {
      for (const target of request.config.targets) {
        /** 进入当前目标生成前的错误数，用于隔离 generate Hook 的失败。 */
        const errorsBeforeTarget = diagnostics.diagnostics.filter(item => item.severity === 'error').length;
        /** 与当前目标 ID 对应的内置 Compiler。 */
        const compiler = request.compilers.get(target.id);
        if (!compiler) {
          diagnostics.error('COMPILER_MISSING', `No Compiler registered for ${target.id}.`, { phase: 'generate', target: target.id });
          continue;
        }
        /** Module 针对当前目标产生的附加 Artifact 和兼容性信息。 */
        const contributions: { module: string; contribution: TargetContribution }[] = [];
        for (const runtime of initialized) {
          try {
            /** 当前 Module 针对目标生成的可选贡献。 */
            const contribution = await runtime.module.generate?.(
              { ...moduleContext(request, diagnostics, runtime, runtimes), project: project!, target: target.id },
              runtime.state,
              runtime.builtState,
            );
            if (contribution)
              contributions.push({ module: runtime.module.name, contribution });
          } catch {
            diagnostics.error('MODULE_HOOK_FAILED', `Module ${runtime.module.name} generate failed.`, { phase: 'generate', module: runtime.module.name, target: target.id });
          }
        }
        if (diagnostics.diagnostics.filter(item => item.severity === 'error').length > errorsBeforeTarget)
          continue;
        try {
          /** Compiler 基于规范 Component 与 Module 贡献生成的目标输出。 */
          const output = await compiler.compile({ config: request.config, project: project!, target, contributions, diagnostics });
          /** 当前目标的 Compiler 与 Module 兼容性条目合集。 */
          const targetCompatibility = [
            ...output.compatibility,
            ...contributions.flatMap(item => item.contribution.compatibility ?? []),
          ];
          compatibility.push(...targetCompatibility);
          applyCompatibilityStrictness(diagnostics, target, targetCompatibility);

          // 所有来源在同一 Graph 内接受路径、碰撞、权限和可信目录校验。
          const graph = new ArtifactGraph([request.config.root, runtimeRoot]);
          for (const publicFile of project!.publicFiles)
            await graph.add('public', { path: publicFile.targetPath, source: { type: 'file', path: publicFile.sourcePath }, mode: publicFile.mode });
          for (const artifact of output.artifacts)
            await graph.add(`compiler:${target.id}`, artifact);
          for (const item of contributions) {
            for (const artifact of item.contribution.artifacts ?? [])
              await graph.add(`module:${item.module}`, artifact);
          }
          targetArtifacts.set(target.id, graph.artifacts);
          for (const artifact of graph.artifacts) {
            artifactReports.push({
              target: target.id,
              path: artifact.path,
              owner: sanitizeReportText(artifact.owner),
              mode: artifact.mode,
              size: artifact.size,
              sha256: artifact.sha256,
            });
          }
        } catch {
          diagnostics.error('TARGET_GENERATION_FAILED', `${target.id} generation failed.`, { phase: 'generate', target: target.id });
        }
      }
    }

    if (!diagnostics.hasErrors && targetArtifacts.size === request.config.targets.length) {
      if (request.commit) {
        // buildEnd 属于提交事务：交换后收尾失败必须触发输出目录回滚。
        await commitManagedOutput(request.config.outDir, targetArtifacts, {
          /** 在旧输出备份仍可恢复时执行 Module 收尾。 */
          async afterSwap() {
            originalError = await finalizeModules(originalError);
            if (originalError !== undefined)
              throw originalError;
          },
        });
        committed = true;
      } else {
        // validate 模式仍完整物化到临时目录，以验证字节摘要和权限，但不会改动 outDir。
        await validateMaterialization(targetArtifacts);
        originalError = await finalizeModules(originalError);
      }
    }
  } catch (error) {
    originalError ??= error;
    if (!diagnostics.hasErrors)
      diagnostics.error('BUILD_INTERNAL_FAILED', 'The build failed inside the framework.', { phase: 'internal' });
  } finally {
    if (originalError === undefined && diagnostics.hasErrors)
      originalError = new Error('Build failed; see diagnostics.');
    originalError = await finalizeModules(originalError);
    // Module 收尾完成后才能删除工作目录，确保 buildEnd 仍可访问自己的临时资源。
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  }

  /** 始终返回的构建结果；业务失败通过 report.success 和 diagnostics 表达。 */
  const result: BuildResult = {
    report: createReport(request, project, diagnostics.diagnostics, compatibility, artifactReports, committed),
  };
  if (project !== undefined)
    result.project = project;
  return result;
}
