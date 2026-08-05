#!/usr/bin/env node

import process from 'node:process';
import path from 'node:path';
import { Command, CommanderError, Option } from 'commander';
import { watch } from 'chokidar';
import {
  ACPLUGIN_VERSION,
  initializeProject,
  ProjectConfigError,
  runProject,
  type BuildMode,
  type BuildReport,
  type Diagnostic,
  type TargetId,
} from './index.js';

/** validate、inspect、build 和 dev 命令共享的 CLI 选项。 */
interface ProjectCliOptions {
  /** 可选的 TypeScript 配置文件覆盖路径。 */
  config?: string;
  /** 可选的目标平台集合覆盖。 */
  target?: string[];
  /** 传递给配置函数的开发或生产模式。 */
  mode: BuildMode;
  /** 是否把能力降级和不支持视为错误。 */
  strict: boolean;
  /** 是否只在 stdout 输出一个稳定 JSON 对象。 */
  json?: boolean;
}

/**
 * 为项目 Pipeline 子命令注册一致的配置、目标、模式和报告选项。
 *
 * @param command 待扩展的 Commander 子命令。
 * @param defaultMode 该子命令使用的默认配置模式。
 * @returns 同一个 Command，便于继续链式注册 action。
 */
function addProjectOptions(command: Command, defaultMode: BuildMode): Command {
  return command
    .option('-c, --config <path>', 'Use another TypeScript config file')
    .addOption(new Option('-t, --target <target...>', 'Replace the configured target set').choices(['claude-code', 'codex']))
    .addOption(new Option('--mode <mode>', 'Config mode').choices(['development', 'production']).default(defaultMode))
    .option('--no-strict', 'Allow degraded or unsupported target compatibility')
    .option('--json', 'Emit one stable JSON report on stdout');
}

/**
 * 按人类可读或机器可读模式输出完整构建报告。
 *
 * JSON 模式严格只写 stdout；普通模式把摘要写 stdout、问题写 stderr。
 *
 * @param report Core Pipeline 产生的构建报告。
 * @param json 是否启用稳定 JSON 输出。
 */
function writeReport(report: BuildReport, json: boolean | undefined): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  /** 普通文本摘要使用的稳定状态词。 */
  const status = report.success ? 'success' : 'failed';
  process.stdout.write(`${report.command}: ${status} (${report.targets.join(', ')})\n`);
  for (const diagnostic of report.diagnostics)
    process.stderr.write(`${diagnostic.severity} ${diagnostic.code}: ${diagnostic.message}\n`);
  for (const entry of report.compatibility) {
    if (entry.level === 'degraded' || entry.level === 'unsupported')
      process.stderr.write(`warning ${entry.target} ${entry.subject}: ${entry.reason}\n`);
  }
}

/** 在 Pipeline 尚未产生 BuildReport 时使用的最小 CLI 失败报告。 */
interface CliFailureReport {
  /** CLI 失败报告协议版本。 */
  schemaVersion: '1';
  /** 触发失败的子命令名称。 */
  command: string;
  /** 可安全向用户展示的诊断。 */
  diagnostics: readonly Diagnostic[];
  /** 失败报告固定为 false。 */
  success: false;
}

/**
 * 将配置错误或其他命令异常转换为不会泄露内部详情的 CLI 报告。
 *
 * @param command 当前子命令名称。
 * @param error 捕获到的未知异常。
 * @param internal 是否属于框架内部失败。
 * @returns 可序列化的统一失败报告。
 */
function failureReport(command: string, error: unknown, internal: boolean): CliFailureReport {
  /** 配置错误保留原诊断，其他异常只输出固定安全消息。 */
  const diagnostics = error instanceof ProjectConfigError
    ? error.diagnostics
    : [{
        code: internal ? 'FRAMEWORK_INTERNAL_FAILED' : 'COMMAND_FAILED',
        severity: 'error' as const,
        message: internal ? 'The command failed inside the framework.' : `${command} failed.`,
        phase: internal ? 'internal' : command,
      }];
  return { schemaVersion: '1', command, diagnostics, success: false };
}

/**
 * 按 CLI 输出模式展示尚未进入 Core 报告阶段的失败。
 *
 * @param command 当前子命令名称。
 * @param error 捕获到的未知异常。
 * @param json 是否启用稳定 JSON 输出。
 * @param internal 是否属于框架内部失败。
 */
function writeFailure(command: string, error: unknown, json: boolean | undefined, internal: boolean): void {
  /** 从未知异常收敛出的安全失败报告。 */
  const report = failureReport(command, error, internal);
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  for (const diagnostic of report.diagnostics)
    process.stderr.write(`${diagnostic.severity} ${diagnostic.code}: ${diagnostic.message}\n`);
}

/**
 * 运行一次 validate、inspect 或 build，并按失败类型设置进程退出码。
 *
 * @param commandName 待执行的非持续型 Pipeline 命令。
 * @param options Commander 解析后的共享项目选项。
 */
async function runPipeline(commandName: 'validate' | 'inspect' | 'build', options: ProjectCliOptions): Promise<void> {
  try {
    /** 官方 Compiler Pipeline 的执行结果。 */
    const result = await runProject({
      command: commandName,
      mode: options.mode,
      ...(options.config === undefined ? {} : { configPath: options.config }),
      ...(options.target === undefined ? {} : { targets: options.target as TargetId[] }),
      strict: options.strict,
      commit: commandName === 'build',
    });
    writeReport(result.report, options.json);
    if (!result.report.success) {
      process.exitCode = result.report.diagnostics.some(diagnostic => diagnostic.code === 'BUILD_INTERNAL_FAILED') ? 2 : 1;
    }
  } catch (error) {
    const internal = !(error instanceof ProjectConfigError);
    writeFailure(commandName, error, options.json, internal);
    process.exitCode = internal ? 2 : 1;
  }
}

/**
 * 启动监听模式，并串行合并构建期间到达的文件变化。
 *
 * 始终保留最后一次成功提交的输出；同一时刻最多运行一个构建，期间的多次变化合并为一次补充重建。
 *
 * @param options Commander 解析后的共享项目选项。
 */
async function runDev(options: ProjectCliOptions): Promise<void> {
  /** 当前是否已有构建正在执行。 */
  let running = false;
  /** 当前构建期间是否至少收到过一次新的文件变化。 */
  let pending = false;
  /**
   * 串行执行一次 dev 构建，必要时在完成后消费合并的待处理变化。
   */
  const rebuild = async (): Promise<void> => {
    if (running) {
      pending = true;
      return;
    }
    running = true;
    try {
      /** 当前 dev 重建的 Pipeline 结果。 */
      const result = await runProject({
        command: 'dev',
        mode: options.mode,
        ...(options.config === undefined ? {} : { configPath: options.config }),
        ...(options.target === undefined ? {} : { targets: options.target as TargetId[] }),
        strict: options.strict,
        commit: true,
      });
      writeReport(result.report, options.json);
      if (!result.report.success)
        process.exitCode = result.report.diagnostics.some(diagnostic => diagnostic.code === 'BUILD_INTERNAL_FAILED') ? 2 : 1;
    } catch (error) {
      writeFailure('dev', error, options.json, !(error instanceof ProjectConfigError));
    } finally {
      running = false;
      if (pending) {
        pending = false;
        await rebuild();
      }
    }
  };

  await rebuild();
  /** dev 模式实际使用的配置绝对路径。 */
  const configPath = path.resolve(options.config ?? 'acplugin.config.ts');
  /** 监听范围以配置文件目录为工程根目录。 */
  const projectRoot = path.dirname(configPath);
  /** 忽略依赖、产物、Git 和 acplugin 事务目录的递归文件监听器。 */
  const watcher = watch(projectRoot, {
    ignoreInitial: true,
    ignored: (candidate) => {
      /** 候选路径相对于监听根目录的 POSIX 表示。 */
      const relative = path.relative(projectRoot, candidate).split(path.sep).join('/');
      return relative === 'node_modules'
        || relative.startsWith('node_modules/')
        || relative === 'dist'
        || relative.startsWith('dist/')
        || relative === '.git'
        || relative.startsWith('.git/')
        || /(^|\/)\.acplugin-(?:work|stage|backup|transaction|lock)/.test(relative);
    },
  });
  /** 合并短时间文件事件使用的定时器。 */
  let debounce: NodeJS.Timeout | undefined;
  watcher.on('all', () => {
    if (debounce)
      clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = undefined;
      void rebuild();
    }, 50);
  });
  await new Promise<void>((resolve) => {
    /**
     * 响应终止信号，清理定时器和 watcher，并使用 130 表示信号中断。
     */
    const stop = (): void => {
      if (debounce)
        clearTimeout(debounce);
      process.exitCode = 130;
      void watcher.close().then(resolve);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

/**
 * 构造完整 Commander 命令树，但不读取 argv 或退出进程。
 *
 * @returns 可供 main、测试或嵌入方调用的根 Command。
 */
export function createCli(): Command {
  /** 注册全局元数据和错误处理策略的 CLI 根命令。 */
  const program = new Command()
    .name('acplugin')
    .description('Build canonical AI plugins for Claude Code and Codex')
    .version(ACPLUGIN_VERSION)
    .showHelpAfterError()
    .exitOverride();

  program.command('init')
    .description('Create an opinionated canonical plugin project')
    .argument('[directory]', 'New or empty destination directory')
    .option('-y, --yes', 'Accept deterministic defaults')
    .option('--name <name>', 'Plugin machine name')
    .option('--display-name <name>', 'Plugin display name')
    .option('--description <description>', 'Plugin description')
    .option('--hooks', 'Enable the official Hooks Module')
    .option('--mcp', 'Enable the official MCP Module')
    .option('--install', 'Run pnpm install after scaffolding')
    .option('--json', 'Emit one stable JSON result on stdout')
    .action(async (directory: string | undefined, options: {
      yes?: boolean;
      name?: string;
      displayName?: string;
      description?: string;
      hooks?: boolean;
      mcp?: boolean;
      install?: boolean;
      json?: boolean;
    }) => {
      try {
        /** init 参数与交互结果共同生成的脚手架结果。 */
        const result = await initializeProject({
          ...(directory === undefined ? {} : { directory }),
          ...(options.yes === undefined ? {} : { yes: options.yes }),
          ...(options.name === undefined ? {} : { name: options.name }),
          ...(options.displayName === undefined ? {} : { displayName: options.displayName }),
          ...(options.description === undefined ? {} : { description: options.description }),
          ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
          ...(options.mcp === undefined ? {} : { mcp: options.mcp }),
          ...(options.install === undefined ? {} : { install: options.install }),
        });
        if (options.json)
          process.stdout.write(`${JSON.stringify({ schemaVersion: '1', success: true, ...result }, null, 2)}\n`);
        else
          process.stdout.write(`Created ${result.directory}\nNext: cd ${result.directory} && pnpm install && pnpm build\n`);
        if (options.install && !result.installed)
          process.exitCode = 1;
      } catch (error) {
        writeFailure('init', error, options.json, false);
        process.exitCode = 1;
      }
    });

  program.command('migrate')
    .description('Migrate a legacy Claude project or plugin into canonical source')
    .argument('<source>', 'Local path or supported GitHub source')
    .argument('[destination]', 'New destination directory')
    .option('-p, --path <subpath>', 'Sub-path inside a GitHub repository')
    .option('--plugin <name>', 'Select one marketplace plugin')
    .option('--all', 'Migrate all marketplace plugins')
    .option('--name <name>', 'Canonical plugin name for project input')
    .option('--description <description>', 'Canonical plugin description for project input')
    .option('--dry-run', 'Generate and validate in temporary storage without committing')
    .option('--strict', 'Fail when any resource is degraded or unmapped')
    .option('--json', 'Emit one stable JSON report on stdout')
    .action(async (source: string, destination: string | undefined, options: {
      path?: string;
      plugin?: string;
      all?: boolean;
      name?: string;
      description?: string;
      dryRun?: boolean;
      strict?: boolean;
      json?: boolean;
    }) => {
      try {
        // Migration 通过动态导入保持在独立 chunk 中，不进入常规构建和配置加载路径。
        const { migrate } = await import('./migration/index.js');
        /** 旧工程转换产生的结构化迁移报告。 */
        const report = await migrate({
          source,
          ...(destination === undefined ? {} : { destination }),
          ...(options.path === undefined ? {} : { subPath: options.path }),
          ...(options.plugin === undefined ? {} : { plugin: options.plugin }),
          ...(options.all === undefined ? {} : { all: options.all }),
          ...(options.name === undefined ? {} : { name: options.name }),
          ...(options.description === undefined ? {} : { description: options.description }),
          ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
          ...(options.strict === undefined ? {} : { strict: options.strict }),
        });
        if (options.json)
          process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        else
          process.stdout.write(`Migration ${report.success ? 'succeeded' : 'failed'}: ${report.items.length} resource(s)\n`);
        if (!report.success)
          process.exitCode = 1;
      } catch (error) {
        writeFailure('migrate', error, options.json, false);
        process.exitCode = 1;
      }
    });

  addProjectOptions(program.command('validate').description('Validate the complete generated target graphs'), 'production')
    .action((options: ProjectCliOptions) => runPipeline('validate', options));
  addProjectOptions(program.command('inspect').description('Inspect the complete generated target graphs'), 'production')
    .action((options: ProjectCliOptions) => runPipeline('inspect', options));
  addProjectOptions(program.command('build').description('Build and atomically commit selected targets'), 'production')
    .action((options: ProjectCliOptions) => runPipeline('build', options));
  addProjectOptions(program.command('dev').description('Watch and retain the last successful output'), 'development')
    .action((options: ProjectCliOptions) => runDev(options));

  return program;
}

/**
 * 解析 CLI 参数并把 Commander 使用错误与框架内部错误映射为稳定退出码。
 *
 * @param argv 完整进程参数，默认为 process.argv。
 */
export async function main(argv: readonly string[] = process.argv): Promise<void> {
  /** 当前调用独占的 Commander 命令树。 */
  const program = createCli();
  if (argv.length <= 2) {
    program.outputHelp();
    return;
  }
  try {
    await program.parseAsync(argv);
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.code === 'commander.helpDisplayed' || error.code === 'commander.version')
        return;
      process.exitCode = 2;
      return;
    }
    process.stderr.write('internal error: the CLI failed inside the framework\n');
    process.exitCode = 2;
  }
}

// 仅 CLI 入口模块执行 main；库入口不会触发参数解析。
await main();
