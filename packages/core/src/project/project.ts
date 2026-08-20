import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  BuildReport,
  Diagnostic,
} from '../contracts/reports.js';
import type {
  ConfigEnvironment,
  UserConfig,
  UserConfigExport,
} from '../contracts/config.js';
import type {
  CreateProjectOptions,
  DevSession,
  Project,
  ProjectDevOptions,
  ProjectRunOptions,
  RunProjectOptions,
} from '../contracts/project.js';
import {
  normalizeProjectRunOptions,
  runKernelBuildSession,
} from '../lifecycle/build-session.js';
import {
  createKernelBuildEnvironment,
  disposeKernelBuildEnvironment,
} from '../lifecycle/build-environment.js';
import { createDevSession } from '../lifecycle/dev-session.js';
import { resolveKernelConfig } from '../config/resolver.js';
import { isInsidePath, safeRelativePath } from '../security/path-policy.js';

/** 配置定位、模块执行或 schema/brand 失败的唯一公开异常。 */
export class ProjectConfigError extends Error {
  /** 可供 CLI/API 消费的稳定配置诊断。 */
  readonly diagnostics: readonly Diagnostic[];

  /** @param message 安全摘要。 @param diagnostics 稳定配置诊断。 @param cause 内部原始原因。 */
  constructor(message: string, diagnostics: readonly Diagnostic[], cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ProjectConfigError';
    this.diagnostics = Object.freeze([...diagnostics]);
  }
}

/** Project 内部固定且不允许 run() 改写的工程身份。 */
interface ProjectIdentity {
  readonly projectRoot: string;
  readonly configRelative: string;
  readonly configFile: string;
}

/** config error 的稳定诊断构造器。 */
function configDiagnostic(code: string, message: string, location?: string): Diagnostic {
  return Object.freeze({
    code,
    severity: 'error',
    message,
    phase: 'config',
    ...(location === undefined ? {} : { location: Object.freeze({ path: location }) }),
  });
}

/** 同步规范化 Project identity，不访问配置内容。 */
function projectIdentity(options: CreateProjectOptions = {}): ProjectIdentity {
  if (typeof options !== 'object' || options === null || Array.isArray(options)
    || Object.keys(options).some(field => field !== 'cwd' && field !== 'configFile')) {
    throw new ProjectConfigError('Project options are invalid.', [
      configDiagnostic('PROJECT_OPTIONS_INVALID', 'Project options may contain only cwd and configFile.'),
    ]);
  }
  if (options.cwd !== undefined && typeof options.cwd !== 'string') {
    throw new ProjectConfigError('Project cwd is invalid.', [
      configDiagnostic('PROJECT_CWD_INVALID', 'Project cwd must be a path string.'),
    ]);
  }
  /** cwd 是 Project 唯一根身份；配置位置不会改变它。 */
  const projectRoot = path.resolve(options.cwd ?? process.cwd());
  /** 显式 configFile 使用与输出一致的严格 project-relative POSIX 语法。 */
  let configRelative = 'acplugin.config.ts';
  if (options.configFile !== undefined) {
    try {
      if (typeof options.configFile !== 'string')
        throw new TypeError('invalid');
      configRelative = safeRelativePath(options.configFile);
    } catch {
      throw new ProjectConfigError('Project configFile is invalid.', [
        configDiagnostic('CONFIG_FILE_PATH_INVALID', 'configFile must be a project-relative POSIX path.'),
      ]);
    }
  }
  if (!configRelative.endsWith('.ts')) {
    throw new ProjectConfigError('Project configFile is invalid.', [
      configDiagnostic('CONFIG_FILE_EXTENSION_INVALID', 'configFile must reference a TypeScript file.', configRelative),
    ]);
  }
  /** safeRelativePath 与逐 segment join 共同避免宿主路径 normalize 接受歧义输入。 */
  const configFile = path.join(projectRoot, ...configRelative.split('/'));
  if (!isInsidePath(projectRoot, configFile))
    throw new ProjectConfigError('Project configFile escapes the project root.', [
      configDiagnostic('CONFIG_FILE_OUTSIDE_PROJECT', 'configFile must stay inside the project root.'),
    ]);
  return Object.freeze({ projectRoot, configRelative, configFile });
}

/** 验证工程根和配置入口的物理普通文件边界。 */
async function validateConfigEntry(identity: ProjectIdentity): Promise<void> {
  /** root 必须是非 symlink 的真实目录。 */
  const root = await fs.lstat(identity.projectRoot).catch(() => undefined);
  if (root === undefined || !root.isDirectory() || root.isSymbolicLink()) {
    throw new ProjectConfigError('Project cwd is not a usable directory.', [
      configDiagnostic('PROJECT_CWD_INVALID', 'Project cwd must be a regular directory.'),
    ]);
  }
  /** entry 必须是 Project identity 内的非 symlink 普通文件。 */
  const entry = await fs.lstat(identity.configFile).catch(() => undefined);
  if (entry === undefined || !entry.isFile() || entry.isSymbolicLink()) {
    throw new ProjectConfigError(`Cannot load ${identity.configRelative}.`, [
      configDiagnostic('CONFIG_LOAD_FAILED', 'Configuration must be a regular non-symlink file.', identity.configRelative),
    ]);
  }
}

/** 在当前 BuildSession 的唯一 Module Host 内 fresh evaluate 配置。 */
async function loadConfig(
  identity: ProjectIdentity,
  environment: Awaited<ReturnType<typeof createKernelBuildEnvironment>>,
  command: ConfigEnvironment['command'],
  mode: ConfigEnvironment['mode'],
): Promise<import('../config/resolver.js').ResolvedKernelConfig> {
  await validateConfigEntry(identity);
  /** config owner 只获得 Project root 下当前显式入口的 Source capability。 */
  const root = await environment.sources.issueRoot('framework:config', identity.projectRoot);
  /** entry ref 与当前 BuildSession owner/session identity 绑定。 */
  const entry = await environment.sources.service('framework:config').file(root, identity.configRelative);
  /** exported 在 Module Host fresh evaluation 后才进入 config data boundary。 */
  let exported: UserConfigExport;
  try {
    exported = await environment.modules.service('framework:config').loadDefault<UserConfigExport>({
      id: 'project-config',
      entry,
    });
  } catch (error) {
    throw new ProjectConfigError(`Cannot evaluate ${identity.configRelative}.`, [
      configDiagnostic('CONFIG_EVALUATION_FAILED', 'Configuration module evaluation failed.', identity.configRelative),
    ], error);
  }
  /** 函数式配置只观察冻结 command/mode，不接触路径或环境值。 */
  let value: UserConfig;
  try {
    value = (typeof exported === 'function'
      ? await exported(Object.freeze({ command, mode }))
      : exported) as UserConfig;
  } catch (error) {
    throw new ProjectConfigError(`Configuration function in ${identity.configRelative} failed.`, [
      configDiagnostic('CONFIG_FUNCTION_FAILED', 'Configuration function failed.', identity.configRelative),
    ], error);
  }
  /** Core resolver 负责完整 plain-data/brand/path/schema 边界。 */
  const resolved = resolveKernelConfig(value, {
    projectRoot: identity.projectRoot,
    configFile: identity.configFile,
    command,
    mode,
  });
  if (resolved.config === undefined) {
    throw new ProjectConfigError('Project configuration is invalid.', resolved.diagnostics);
  }
  return resolved.config;
}

/** 使用固定 Project identity 创建只委托唯一 BuildSession 的程序化对象。 */
export function createKernelProject(options: CreateProjectOptions, frameworkVersion: string): Project {
  /** identity 在 Project 创建时固定，后续 run/dev 不可切换。 */
  const identity = projectIdentity(options);
  return Object.freeze({
    /** 每次 run 创建全新 capability/Host/Integration Session。 */
    async run(runOptions: ProjectRunOptions = {}): Promise<BuildReport> {
      /** normalized 固定 command/mode/selection/commit 语义。 */
      const normalized = normalizeProjectRunOptions(runOptions);
      /** 每轮 run 使用独立 environment，支持同一 Project 并发调用。 */
      const environment = await createKernelBuildEnvironment(identity.projectRoot);
      try {
        /** config 必须在当前 environment 的唯一 Module Host 中执行。 */
        const config = await loadConfig(identity, environment, normalized.command, normalized.mode);
        /** result 来自唯一 Kernel BuildSession，不经过 facade 二次转换。 */
        const result = await runKernelBuildSession({
          config,
          frameworkVersion,
          ...(normalized.selection === undefined ? {} : { selection: normalized.selection }),
          commit: normalized.commit,
          environment,
        });
        return result.report;
      } finally {
        await disposeKernelBuildEnvironment(environment);
      }
    },
    /** DevSession watcher ownership与 one-shot BuildSession 共用同一 Core coordinator。 */
    async dev(devOptions: ProjectDevOptions = {}): Promise<DevSession> {
      return createDevSession({
        projectRoot: identity.projectRoot,
        configFile: identity.configFile,
        frameworkVersion,
        options: devOptions,
        /** 每轮 DevSession 都在自己的受管环境执行配置。 */
        loadConfig: async roundEnvironment => loadConfig(identity, roundEnvironment, 'dev', devOptions.mode ?? 'development'),
        /** 首轮配置失败保留可恢复的稳定诊断。 */
        initialConfigError: error => error instanceof ProjectConfigError ? error.diagnostics : [],
      });
    },
  });
}

/** runProject 是 createProject().run() 的无逻辑 convenience。 */
export async function runKernelProject(options: RunProjectOptions, frameworkVersion: string): Promise<BuildReport> {
  /** Project identity options 与单轮 run options 只在此拆分一次。 */
  const { cwd, configFile, ...runOptions } = options;
  return createKernelProject({
    ...(cwd === undefined ? {} : { cwd }),
    ...(configFile === undefined ? {} : { configFile }),
  }, frameworkVersion).run(runOptions);
}
