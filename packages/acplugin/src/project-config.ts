import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createJiti } from 'jiti';
import {
  resolveConfig,
  type BuildCommand,
  type BuildMode,
  type Diagnostic,
  type ResolvedConfig,
  type UserConfig,
  type UserConfigExport,
} from '@acplugin/core';
import { claudeCode } from '@acplugin/platform-claude-code';
import { codex } from '@acplugin/platform-codex';

/** 表示配置文件读取、执行或 Core 配置解析失败，并携带可安全展示的结构化诊断。 */
export class ProjectConfigError extends Error {
  /** 可直接写入 CLI JSON 报告的配置诊断。 */
  readonly diagnostics: readonly Diagnostic[];

  /**
   * 创建配置加载错误并保留底层原因供内部调试。
   *
   * @param message 面向用户的安全错误摘要。
   * @param diagnostics 已清理的结构化配置诊断。
   * @param cause 不直接展示给用户的底层异常。
   */
  constructor(message: string, diagnostics: readonly Diagnostic[], cause?: unknown) {
    if (cause === undefined)
      super(message);
    else
      super(message, { cause });
    this.name = 'ProjectConfigError';
    this.diagnostics = diagnostics;
  }
}

/** Core 内部配置加载器使用的文件定位与执行上下文。 */
export interface LoadProjectConfigOptions {
  /** 解析相对路径使用的工作目录，默认为当前进程目录。 */
  cwd?: string;
  /** 相对于 cwd 的配置路径，默认为 `acplugin.config.ts`。 */
  configPath?: string;
  /** 当前执行的 CLI/运行时命令。 */
  command: BuildCommand;
  /** 传递给配置函数的开发或生产模式。 */
  mode: BuildMode;
}

/** Core 内部消费的已解析配置及共享 TypeScript Module 加载能力。 */
export interface LoadedProjectConfig {
  /** 完成默认值、路径和 Extension 校验的不可变配置。 */
  readonly config: ResolvedConfig;
  /** 配置入口和通过共享加载器实际读取的 Extension descriptor 绝对路径。 */
  readonly watchFiles: ReadonlySet<string>;
  /** descriptor 所属且需要递归监听解析依赖的真实 Package 根。 */
  readonly watchRoots: ReadonlySet<string>;
  /**
   * 使用与配置文件相同的 Jiti 实例加载 Extension 引用。
   *
   * @param modulePath TypeScript Module 文件路径。
   * @returns 模块的默认导出。
   */
  loadTypeScriptModule(modulePath: string): Promise<unknown>;
}

/**
 * 通过 Jiti 导入模块的默认导出，并屏蔽其泛型返回细节。
 *
 * @param jiti 当前项目配置专用且禁用缓存的 Jiti 实例。
 * @param modulePath 待执行模块路径。
 * @returns 模块默认导出。
 */
async function importDefault(jiti: ReturnType<typeof createJiti>, modulePath: string): Promise<unknown> {
  return jiti.import(modulePath, { default: true });
}

/**
 * 查找 descriptor 所属的最近 package 根，以覆盖其同包解析依赖。
 *
 * @param modulePath 已解析的 descriptor 绝对文件路径。
 * @returns 最近含 package.json 的目录；找不到时回退到文件所在目录。
 */
async function nearestPackageRoot(modulePath: string): Promise<string> {
  /** 未找到 package.json 时使用的 descriptor 所在目录。 */
  const fallback = path.dirname(modulePath);
  /** 从 descriptor 目录逐级向上查找的当前候选。 */
  let current = fallback;
  while (true) {
    try {
      await fs.access(path.join(current, 'package.json'));
      return current;
    } catch {
      /** 当前目录的父目录；到达文件系统根时停止。 */
      const parent = path.dirname(current);
      if (parent === current)
        return fallback;
      current = parent;
    }
  }
}

/**
 * 安全加载、执行并解析项目的 TypeScript 配置入口。
 *
 * 配置文件必须是普通非符号链接文件；每次调用使用无缓存 Jiti，确保 dev 重建读取最新内容。
 *
 * @param options 配置路径与执行上下文。
 * @returns Core 已解析配置和后续 Extension 共用的 TypeScript 加载函数。
 * @throws 配置访问、执行或语义校验失败时抛出 ProjectConfigError。
 */
export async function loadProjectConfig(options: LoadProjectConfigOptions): Promise<LoadedProjectConfig> {
  /** 所有配置相对路径解析使用的绝对工作目录。 */
  const cwd = path.resolve(options.cwd ?? process.cwd());
  /** 本次运行实际加载的配置绝对路径。 */
  const configPath = path.resolve(cwd, options.configPath ?? 'acplugin.config.ts');
  /** 可安全展示且不泄露 cwd 前缀的配置路径。 */
  const displayPath = path.relative(cwd, configPath).split(path.sep).join('/') || path.basename(configPath);
  try {
    /** 配置入口自身的文件类型和符号链接状态。 */
    const stat = await fs.lstat(configPath);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error('Configuration must be a regular non-symlink file.');
  } catch /** error 保存当前操作捕获的异常，供本阶段转换或恢复。 */ (error) {
    /** 根据文件是否缺失生成稳定且不暴露底层异常文本的失败原因。 */
    const reason = (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? 'file does not exist.'
      : 'file cannot be accessed as a regular non-symlink file.';
    /** 配置访问失败时供异常与诊断共用的消息。 */
    const message = `Cannot load ${displayPath}: ${reason}`;
    throw new ProjectConfigError(message, [{
      code: 'CONFIG_LOAD_FAILED',
      severity: 'error',
      message,
      phase: 'config',
      location: { path: displayPath },
    }], error);
  }

  /** 当前配置及其引用 Extension 共用的无缓存 TypeScript 执行器。 */
  const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false, fsCache: false });
  /** dev 需要监听的配置入口与后续实际加载 descriptor 路径。 */
  const watchFiles = new Set<string>([configPath]);
  /** dev 需要递归监听且不能被 node_modules 通用规则过滤的依赖根。 */
  const watchRoots = new Set<string>();
  /** 配置文件尚未调用的默认导出。 */
  let exported: UserConfigExport;
  try {
    exported = await importDefault(jiti, configPath) as UserConfigExport;
  } catch /** error 保存当前操作捕获的异常，供本阶段转换或恢复。 */ (error) {
    /** 配置代码无法求值时使用的安全消息。 */
    const message = `Cannot evaluate ${displayPath}.`;
    throw new ProjectConfigError(message, [{
      code: 'CONFIG_EVALUATION_FAILED', severity: 'error', message, phase: 'config', location: { path: displayPath },
    }], error);
  }
  /** 静态导出或配置函数执行后得到的原始用户配置。 */
  let value: UserConfig;
  try {
    value = (typeof exported === 'function'
      ? await exported({ command: options.command, mode: options.mode })
      : exported) as UserConfig;
  } catch /** error 保存当前操作捕获的异常，供本阶段转换或恢复。 */ (error) {
    /** 配置函数执行失败时使用的安全消息。 */
    const message = `Configuration function in ${displayPath} failed.`;
    throw new ProjectConfigError(message, [{
      code: 'CONFIG_FUNCTION_FAILED', severity: 'error', message, phase: 'config', location: { path: displayPath },
    }], error);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProjectConfigError('acplugin.config.ts must export a config object or a function returning one.', [{
      code: 'CONFIG_EXPORT_INVALID',
      severity: 'error',
      message: 'acplugin.config.ts must export a config object or a function returning one.',
      phase: 'config',
      location: { path: displayPath },
    }]);
  }

  /** Core 配置解析结果，包含诊断以及成功时的 ResolvedConfig。 */
  const resolved = resolveConfig(value, configPath, options.command, options.mode, {
    defaultPlatforms: [claudeCode(), codex()],
  });
  if (!resolved.config) {
    /** 为 CLI 与程序化 API 组合的简要错误文本；结构化诊断仍完整保留。 */
    const details = resolved.diagnostics.map(diagnostic => `${diagnostic.code}: ${diagnostic.message}`).join('\n');
    throw new ProjectConfigError(details || 'Configuration is invalid.', resolved.diagnostics);
  }
  /** 通过错误分支后已确认存在的最终解析配置。 */
  const config = resolved.config;
  /** 用于避免把本就递归监听的工程根重复提升为依赖包根的真实路径。 */
  const projectRealRoot = await fs.realpath(config.root).catch(() => config.root);
  return {
    config,
    watchFiles,
    watchRoots,
    /** loadTypeScriptModule 提供当前对象协议要求的回调实现。 */ loadTypeScriptModule: async (modulePath) => {
      /** descriptor 的逻辑绝对路径，用于保留符号链接入口的变化事件。 */
      const resolvedPath = path.resolve(modulePath);
      /** descriptor 的真实路径，用于 pnpm 符号链接后的包源码监听。 */
      const realPath = await fs.realpath(resolvedPath).catch(() => resolvedPath);
      watchFiles.add(resolvedPath);
      watchFiles.add(realPath);
      /** descriptor 所属包根；工程自身无需绕过 node_modules 忽略规则。 */
      const packageRoot = await nearestPackageRoot(realPath);
      if (packageRoot !== projectRealRoot)
        watchRoots.add(packageRoot);
      return importDefault(jiti, modulePath);
    },
  };
}
