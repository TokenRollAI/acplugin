import { promises as fs } from 'node:fs';
import {
  executeLifecycle,
  type BuildResult,
  type Diagnostic,
  type PlatformId,
} from '@acplugin/core';
import {
  loadProjectConfig,
  ProjectConfigError,
  type LoadProjectConfigOptions,
} from './project-config.js';

/**
 * 按 UTF-16 code unit 比较内部监听路径，避免宿主 locale/ICU 改变顺序。
 *
 * @param left 左侧路径。
 * @param right 右侧路径。
 * @returns 与 Array.sort 约定一致的 -1、0 或 1。
 */
function compareCodeUnits(left: string, right: string): number {
  if (left === right)
    return 0;
  return left < right ? -1 : 1;
}

/** 公开程序化 Pipeline 的配置定位和运行控制选项。 */
export interface RunProjectOptions extends LoadProjectConfigOptions {
  /** 可选的已配置 Platform 子集；不能凭 ID 临时实例化 Platform。 */
  platforms?: readonly PlatformId[];
  /** 可选的统一 Platform 兼容性严格度覆盖。 */
  strict?: boolean;
  /** 是否把生成结果提交到 outDir。 */
  commit?: boolean;
}

/** CLI dev 在公开报告之外需要的内部执行与监听快照。 */
export interface ProjectExecution {
  /** 固定生命周期产生的公开构建报告。 */
  readonly result: BuildResult;
  /** 配置解析后的工程绝对根目录。 */
  readonly projectRoot: string;
  /** 当前构建完全托管且必须从监听中排除的输出目录。 */
  readonly outDir: string;
  /** 配置、工程根和已加载 Extension descriptor 组成的绝对监听路径。 */
  readonly watchPaths: readonly string[];
  /** 允许递归穿过 node_modules 忽略规则的已解析依赖包根。 */
  readonly dependencyRoots: readonly string[];
}

/**
 * 执行项目 Pipeline，并为 CLI dev 返回不进入公开报告的监听快照。
 *
 * @param options 配置定位、命令模式和运行时覆盖选项。
 * @returns 公开构建报告与内部绝对监听路径。
 */
export async function executeProject(options: RunProjectOptions): Promise<ProjectExecution> {
  /** 已加载的配置、TypeScript Module 解析能力与加载路径记录。 */
  const loaded = await loadProjectConfig(options);
  /** Extension bundler 在本轮生命周期内实际读取的 Handler/Server 模块图。 */
  const lifecycleWatchFiles = new Set<string>();
  /** 可能应用 CLI Platform 子集覆盖的最终运行配置。 */
  let config = loaded.config;
  if (options.platforms !== undefined || options.strict !== undefined) {
    /** CLI 指定或配置原有的 Platform ID 列表。 */
    const platformIds = options.platforms ?? config.platforms.map(item => item.platform.id);
    /** 显式 Platform 子集自身违反的选择约束。 */
    const selectionDiagnostics: Diagnostic[] = [];
    if (options.platforms?.length === 0) {
      selectionDiagnostics.push({
        code: 'CLI_PLATFORM_SELECTION_EMPTY',
        severity: 'error',
        message: 'Platform selection must contain at least one configured Platform.',
        phase: 'config',
      });
    }
    /** 选择列表中按首次重复顺序稳定排列的 Platform ID。 */
    const duplicates = [...new Set(platformIds.filter((id, index) => platformIds.indexOf(id) !== index))];
    /** id 表示当前只报告一次的重复 Platform ID。 */
    for (const id of duplicates) {
      selectionDiagnostics.push({
        code: 'CLI_PLATFORM_SELECTION_DUPLICATE',
        severity: 'error',
        message: `Platform "${id}" is selected more than once.`,
        phase: 'config',
        platform: id,
      });
    }
    /** CLI 请求但配置中不存在的 Platform ID。 */
    const missing = [...new Set(platformIds.filter(id => !config.platforms.some(item => item.platform.id === id)))];
    selectionDiagnostics.push(...missing.map(id => ({
      code: 'CLI_PLATFORM_NOT_CONFIGURED',
      severity: 'error' as const,
      message: `Platform "${id}" is not configured; add its factory to platforms first.`,
      phase: 'config',
      platform: id,
    })));
    if (selectionDiagnostics.length > 0)
      throw new ProjectConfigError('CLI Platform selection is invalid.', selectionDiagnostics);
    /** 对全部选中 Platform 应用的可选严格度覆盖。 */
    const strict = options.strict;
    /** 保持配置顺序且只包含所选 ID 的最终 Platform 列表。 */
    const platforms = config.platforms
      .filter(item => platformIds.includes(item.platform.id))
      .map(item => ({ ...item, strict: strict ?? item.strict }));
    config = { ...config, strict: strict ?? config.strict, platforms };
  }
  /** validate/inspect 永不提交；build/dev 允许程序化调用方显式关闭事务提交。 */
  const commit = (options.command === 'build' || options.command === 'dev') && (options.commit ?? true);
  /** 唯一固定生命周期产生的公开结果。 */
  const result = await executeLifecycle({
    config,
    loadTypeScriptModule: loaded.loadTypeScriptModule,
    commit,
    /** 生命周期只登记依赖，本层决定它们如何进入 dev 监听边界。 */
    onWatchFile: file => lifecycleWatchFiles.add(file),
  });
  /** 同时保留解析路径与真实路径，使 symlink workspace 的依赖编辑同样可触发重建。 */
  const watchedModuleFiles = new Set<string>();
  for (const file of lifecycleWatchFiles) {
    watchedModuleFiles.add(file);
    try {
      watchedModuleFiles.add(await fs.realpath(file));
    } catch {
      // 构建后立即删除的依赖由原路径继续监听，下一次重建负责给出正式诊断。
    }
  }
  /** 配置入口、工程根、描述文件和实际 Bundle 模块图组成的去重监听边界。 */
  const watchPaths = [...new Set([
    config.root,
    ...loaded.watchFiles,
    ...loaded.watchRoots,
    ...watchedModuleFiles,
  ])].sort(compareCodeUnits);
  /** Extension descriptor 所属且需要递归监听的去重真实包根。 */
  const dependencyRoots = [...loaded.watchRoots].sort(compareCodeUnits);
  return { result, projectRoot: config.root, outDir: config.outDir, watchPaths, dependencyRoots };
}
