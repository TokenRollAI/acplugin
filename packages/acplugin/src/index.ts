import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createJiti } from 'jiti';
import {
  buildProject,
  resolveConfig,
  type BuildCommand,
  type BuildMode,
  type BuildResult,
  type ResolvedConfig,
  type TargetId,
  type UserConfig,
  type UserConfigExport,
} from '@acplugin/core';
import { claudeCodeCompiler } from '@acplugin/compiler-claude-code';
import { codexCompiler } from '@acplugin/compiler-codex';

export * from '@acplugin/core';
export * from './init.js';

/** 当前 CLI 与公开运行时 API 的版本号。 */
export const ACPLUGIN_VERSION = '1.0.0';

/**
 * 表示配置文件读取、执行或 Core 配置解析失败，并携带可安全展示的结构化诊断。
 */
export class ProjectConfigError extends Error {
  /** 可直接写入 CLI JSON 报告的配置诊断。 */
  readonly diagnostics: readonly import('@acplugin/core').Diagnostic[];

  /**
   * 创建配置加载错误并保留底层原因供内部调试。
   *
   * @param message 面向用户的安全错误摘要。
   * @param diagnostics 已清理的结构化配置诊断。
   * @param cause 不直接展示给用户的底层异常。
   */
  constructor(
    message: string,
    diagnostics: readonly import('@acplugin/core').Diagnostic[],
    cause?: unknown,
  ) {
    if (cause === undefined)
      super(message);
    else
      super(message, { cause });
    this.name = 'ProjectConfigError';
    this.diagnostics = diagnostics;
  }
}

/**
 * 为 `acplugin.config.ts` 提供类型推断友好的恒等辅助函数。
 *
 * @param config 静态配置对象或按命令和模式生成配置的函数。
 * @returns 未修改的配置导出。
 */
export function defineConfig(config: UserConfigExport): UserConfigExport {
  return config;
}

/** 控制项目配置文件的定位方式和配置函数执行上下文。 */
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

/** 已解析 Core 配置及其共享 TypeScript Module 加载能力。 */
export interface LoadedProjectConfig {
  /** 完成默认值、路径和 Module 校验的不可变配置。 */
  config: ResolvedConfig;
  /**
   * 使用与配置文件相同的 Jiti 实例加载 Module 引用。
   *
   * @param path TypeScript Module 文件路径。
   */
  loadTypeScriptModule(path: string): Promise<unknown>;
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
 * 安全加载、执行并解析项目的 TypeScript 配置入口。
 *
 * 配置文件必须是普通非符号链接文件；每次调用使用无缓存 Jiti，确保 dev 重建读取最新内容。
 *
 * @param options 配置路径与执行上下文。
 * @returns Core 已解析配置和后续 Module 共用的 TypeScript 加载函数。
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
    const stat = await fs.lstat(configPath);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error('Configuration must be a regular non-symlink file.');
  } catch (error) {
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

  /** 当前配置及其引用 Module 共用的无缓存 TypeScript 执行器。 */
  const jiti = createJiti(import.meta.url, {
    interopDefault: true,
    moduleCache: false,
    fsCache: false,
  });
  /** 配置文件尚未调用的默认导出。 */
  let exported: UserConfigExport;
  try {
    exported = await importDefault(jiti, configPath) as UserConfigExport;
  } catch (error) {
    /** 配置代码无法求值时使用的安全消息。 */
    const message = `Cannot evaluate ${displayPath}.`;
    throw new ProjectConfigError(message, [{
      code: 'CONFIG_EVALUATION_FAILED',
      severity: 'error',
      message,
      phase: 'config',
      location: { path: displayPath },
    }], error);
  }
  /** 静态导出或配置函数执行后得到的原始用户配置。 */
  let value: UserConfig;
  try {
    value = (typeof exported === 'function'
      ? await exported({ command: options.command, mode: options.mode })
      : exported) as UserConfig;
  } catch (error) {
    /** 配置函数执行失败时使用的安全消息。 */
    const message = `Configuration function in ${displayPath} failed.`;
    throw new ProjectConfigError(message, [{
      code: 'CONFIG_FUNCTION_FAILED',
      severity: 'error',
      message,
      phase: 'config',
      location: { path: displayPath },
    }], error);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new ProjectConfigError('acplugin.config.ts must export a config object or a function returning one.', [{
      code: 'CONFIG_EXPORT_INVALID',
      severity: 'error',
      message: 'acplugin.config.ts must export a config object or a function returning one.',
      phase: 'config',
      location: { path: displayPath },
    }]);

  /** Core 配置解析结果，包含诊断以及成功时的 ResolvedConfig。 */
  const resolved = resolveConfig(value, configPath, options.command, options.mode);
  if (!resolved.config) {
    /** 为非 CLI API 调用方组合的简要错误文本；结构化诊断仍完整保留。 */
    const details = resolved.diagnostics.map(diagnostic => `${diagnostic.code}: ${diagnostic.message}`).join('\n');
    throw new ProjectConfigError(details || 'Configuration is invalid.', resolved.diagnostics);
  }

  return {
    config: resolved.config,
    loadTypeScriptModule: modulePath => importDefault(jiti, modulePath),
  };
}

/** 在加载配置的基础上控制目标覆盖、严格模式和真实提交。 */
export interface RunProjectOptions extends LoadProjectConfigOptions {
  /** 可选的目标平台集合覆盖。 */
  targets?: readonly TargetId[];
  /** 可选的统一目标兼容性严格度覆盖。 */
  strict?: boolean;
  /** 是否把生成结果提交到 outDir。 */
  commit?: boolean;
}

/**
 * 使用官方 Compiler 注册表运行一个项目构建请求。
 *
 * @param options 配置定位、命令模式和运行时覆盖选项。
 * @returns Core Pipeline 产生的项目与构建报告。
 */
export async function runProject(options: RunProjectOptions): Promise<BuildResult> {
  /** 已加载的配置和 TypeScript Module 解析能力。 */
  const loaded = await loadProjectConfig(options);
  /** 可能应用 CLI 目标覆盖的最终运行配置。 */
  let config = loaded.config;
  if (options.targets || options.strict !== undefined) {
    /** CLI 指定或配置原有的目标 ID 列表。 */
    const targetIds = options.targets ?? config.targets.map(target => target.id);
    /** 对全部选中目标应用的可选严格度覆盖。 */
    const strict = options.strict;
    config = {
      ...config,
      targets: targetIds.map(id => ({
        id,
        strict: strict ?? config.targets.find(target => target.id === id)?.strict ?? config.strict,
      })),
    };
  }
  return buildProject({
    config,
    // Compiler 是框架内置能力，不由用户配置替换，Module 只能通过标准贡献接口增强。
    compilers: new Map([
      ['claude-code', claudeCodeCompiler],
      ['codex', codexCompiler],
    ]),
    loadTypeScriptModule: loaded.loadTypeScriptModule,
    commit: options.commit ?? (options.command === 'build' || options.command === 'dev'),
  });
}
