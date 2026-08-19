#!/usr/bin/env node

import process from 'node:process';
import { Command, CommanderError, Option } from 'commander';
import {
  ACPLUGIN_VERSION,
  createProject,
  initializeProject,
  ProjectConfigError,
  runProject,
  serializeBuildReport,
  type BuildMode,
  type BuildReport,
  type InitPlatformId,
} from './index.js';
import { InitError } from './init.js';

/** validate、inspect、build 和 dev 命令共享的 CLI 选项。 */
interface ProjectCliOptions {
  /** 可选的工程相对 TypeScript 配置文件。 */
  config?: string;
  /** 可选的已配置 Platform 子集。 */
  platform?: string[];
  /** 传递给配置函数的开发或生产模式。 */
  mode: BuildMode;
  /** 是否只在 stdout 输出一个稳定 JSON 对象。 */
  json?: boolean;
}

/** CLI 边界失败使用的脱敏诊断。 */
interface CliFailureDiagnostic {
  /** 稳定错误代码。 */
  code: string;
  /** 配置诊断可保留 warning，命令边界本身只创建 error。 */
  severity: 'error' | 'warning';
  /** 不包含原始异常、绝对路径或凭据的安全消息。 */
  message: string;
  /** 配置、命令或内部边界阶段。 */
  phase: string;
}

/** 尚未产生 BuildReport 时使用的最小 CLI 失败报告。 */
interface CliFailureReport {
  /** Kernel v2 报告 schema。 */
  schemaVersion: 2;
  /** 触发失败的子命令。 */
  command: string;
  /** 可安全向用户展示的诊断。 */
  diagnostics: readonly CliFailureDiagnostic[];
  /** 边界失败固定为 false。 */
  success: false;
}

/** 为 Project 子命令注册一致且不覆盖配置语义的选项。 */
function addProjectOptions(command: Command, defaultMode: BuildMode): Command {
  return command
    .option('-c, --config <path>', 'Use another project-relative TypeScript config file')
    .addOption(new Option('--platform <id...>', 'Select a subset of configured Platforms'))
    .addOption(new Option('--mode <mode>', 'Config mode').choices(['development', 'production']).default(defaultMode))
    .option('--json', 'Emit one stable JSON report on stdout');
}

/** 按机器或人类可读模式输出完整 Kernel v2 报告。 */
function writeReport(report: BuildReport, json: boolean | undefined): void {
  if (json) {
    process.stdout.write(serializeBuildReport(report));
    return;
  }
  /** 普通文本摘要使用的稳定状态词。 */
  const status = report.success ? 'success' : 'failed';
  /** 本次真正选中的 Platform ID。 */
  const selected = report.platforms.filter(platform => platform.selected).map(platform => platform.id);
  process.stdout.write(`${report.command}: ${status} (${selected.join(', ')})\n`);
  if (report.command === 'inspect') {
    for (const component of report.components)
      process.stdout.write(`component ${component.kind}/${component.id}\n`);
    for (const runtime of report.runtimes)
      process.stdout.write(`runtime ${runtime.id} ${runtime.kind} built:${runtime.built}\n`);
    for (const extension of report.extensions)
      process.stdout.write(`extension ${extension.id} resources:${extension.discovered}\n`);
    for (const platform of report.platforms)
      process.stdout.write(`platform ${platform.id} selected:${platform.selected} success:${platform.success} packages:${platform.packageIds.join(',')}\n`);
    for (const unit of report.packages) {
      process.stdout.write(`package ${unit.platform}/${unit.id} ${unit.role}:${unit.type}\n`);
      for (const asset of unit.assets)
        process.stdout.write(`  asset ${asset.path} ${asset.owner} ${asset.mode.toString(8)} ${asset.size} ${asset.sha256}\n`);
    }
    for (const entry of report.compatibility)
      process.stdout.write(`compatibility ${entry.platform} ${entry.subject}/${entry.capability} ${entry.level}: ${entry.reason}\n`);
    for (const entry of report.metadata)
      process.stdout.write(`metadata ${entry.platform} ${entry.field} ${entry.disposition}: ${entry.reason}\n`);
  }
  for (const diagnostic of report.diagnostics)
    process.stderr.write(`${diagnostic.severity} ${diagnostic.code}: ${diagnostic.message}\n`);
  for (const entry of report.compatibility) {
    if (entry.level === 'degraded' || entry.level === 'unsupported')
      process.stderr.write(`warning ${entry.platform} ${entry.subject}: ${entry.reason}\n`);
  }
}

/** JSON dev 不占用 stdout，只在 stderr 发布可观测轮次摘要。 */
function writeDevProgress(report: BuildReport): void {
  /** 与人类可读摘要一致的稳定状态词。 */
  const status = report.success ? 'success' : 'failed';
  /** 本轮实际选中的 Platform ID。 */
  const selected = report.platforms.filter(platform => platform.selected).map(platform => platform.id);
  process.stderr.write(`${report.command}: ${status} (${selected.join(', ')})\n`);
  for (const diagnostic of report.diagnostics)
    process.stderr.write(`${diagnostic.severity} ${diagnostic.code}: ${diagnostic.message}\n`);
}

/** 将配置或命令异常转换为不泄露内部详情的 CLI 报告。 */
function failureReport(command: string, error: unknown, internal: boolean): CliFailureReport {
  /** 配置和 init 错误保留安全原因，其余异常只输出固定消息。 */
  const diagnostics: readonly CliFailureDiagnostic[] = error instanceof ProjectConfigError
    ? error.diagnostics
    : error instanceof InitError
      ? [{ code: 'INIT_INVALID', severity: 'error', message: error.message, phase: command }]
      : [{
          code: internal ? 'FRAMEWORK_INTERNAL_FAILED' : 'COMMAND_FAILED',
          severity: 'error',
          message: internal ? 'The command failed inside the framework.' : `${command} failed.`,
          phase: internal ? 'internal' : command,
        }];
  return { schemaVersion: 2, command, diagnostics, success: false };
}

/** 展示尚未进入 Core 报告阶段的失败。 */
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

/** 根据最终结构化诊断区分成功、项目失败和框架内部失败。 */
function exitCodeFor(report: BuildReport): 0 | 1 | 2 {
  if (report.success)
    return 0;
  return report.diagnostics.some(diagnostic => diagnostic.code === 'INTERNAL_ERROR') ? 2 : 1;
}

/** 运行一次 validate、inspect 或 build。 */
async function runPipeline(command: 'validate' | 'inspect' | 'build', options: ProjectCliOptions): Promise<void> {
  try {
    /** Project facade 与程序化 API 共用的唯一 BuildSession 报告。 */
    const report = await runProject({
      command,
      mode: options.mode,
      ...(options.config === undefined ? {} : { configFile: options.config }),
      ...(options.platform === undefined ? {} : { platforms: options.platform }),
      commit: command === 'build',
    });
    writeReport(report, options.json);
    process.exitCode = exitCodeFor(report);
  } catch (error) {
    /** 配置错误属于项目输入，其余未预期异常属于框架内部失败。 */
    const internal = !(error instanceof ProjectConfigError);
    writeFailure(command, error, options.json, internal);
    process.exitCode = internal ? 2 : 1;
  }
}

/** 只消费 Core Project DevSession，不在 CLI 维护第二套 Watch 或重建队列。 */
async function runDev(options: ProjectCliOptions): Promise<void> {
  /** Project 固定工程与配置身份，DevSession 独占 Watch 和 BuildSession 调度。 */
  const project = createProject({
    ...(options.config === undefined ? {} : { configFile: options.config }),
  });
  /** 成功创建后由 signal 幂等关闭的持续 Session。 */
  let session: Awaited<ReturnType<typeof project.dev>> | undefined;
  /** 防止多个终止信号重复处理退出。 */
  let stopping = false;
  /** JSON 模式关闭时唯一输出的最近报告。 */
  let current: BuildReport | undefined;
  /** 终止处理只请求 Core 关闭，不接管它的内部资源。 */
  const stop = (): void => {
    if (stopping)
      return;
    stopping = true;
    process.exitCode = 130;
    /** close 可在完成终态后报告 cleanup 失败；signal 路径必须显式观察 rejection。 */
    void session?.close().catch(() => undefined);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    session = await project.dev({
      mode: options.mode,
      ...(options.platform === undefined ? {} : { platforms: options.platform }),
      commit: true,
    });
    current = session.current;
    if (stopping) {
      await session.close();
      return;
    }
    if (!options.json)
      writeReport(current, false);
    else
      writeDevProgress(current);
    /** 订阅只负责 presentation，不参与调度、Watch 或事务。 */
    session.subscribe((event) => {
      if (event.type !== 'build-complete')
        return;
      current = event.report;
      if (!options.json)
        writeReport(event.report, false);
      else
        writeDevProgress(event.report);
    });
    await session.closed;
    if (options.json && current !== undefined)
      process.stdout.write(serializeBuildReport(current));
    if (!stopping && current !== undefined)
      process.exitCode = exitCodeFor(current);
  } catch (error) {
    if (!stopping) {
      /** 配置错误属于项目输入，其余 DevSession 创建异常属于框架内部失败。 */
      const internal = !(error instanceof ProjectConfigError);
      writeFailure('dev', error, options.json, internal);
      process.exitCode = internal ? 2 : 1;
    }
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}

/** 构造完整 Commander 命令树，但不读取 argv 或退出进程。 */
export function createCli(): Command {
  /** 注册全局元数据和错误处理策略的 CLI 根命令。 */
  const program = new Command()
    .name('acplugin')
    .description('Build canonical AI plugin deliveries for configured Platforms')
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
    .option('--platform <platforms...>', 'Select one or more configured Platforms')
    .option('--hooks', 'Enable the official Hooks Extension')
    .option('--mcp', 'Enable the official MCP Extension')
    .option('--node-runtime', 'Generate a built-in Node Runtime entry')
    .option('--install', 'Run pnpm install after scaffolding')
    .option('--json', 'Emit one stable JSON result on stdout')
    .action(async (directory: string | undefined, options: {
      yes?: boolean;
      name?: string;
      displayName?: string;
      description?: string;
      platform?: InitPlatformId[];
      hooks?: boolean;
      mcp?: boolean;
      nodeRuntime?: boolean;
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
          ...(options.platform === undefined ? {} : { platforms: options.platform }),
          ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
          ...(options.mcp === undefined ? {} : { mcp: options.mcp }),
          ...(options.nodeRuntime === undefined ? {} : { nodeRuntime: options.nodeRuntime }),
          ...(options.install === undefined ? {} : { install: options.install }),
        });
        if (options.json)
          process.stdout.write(`${JSON.stringify({ schemaVersion: 2, success: true, ...result }, null, 2)}\n`);
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
        // Migration 动态导入保持在独立 chunk，不进入正常配置与构建启动路径。
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

  addProjectOptions(program.command('validate').description('Validate all selected Platform packages'), 'production')
    .action((options: ProjectCliOptions) => runPipeline('validate', options));
  addProjectOptions(program.command('inspect').description('Inspect all selected Platform packages'), 'production')
    .action((options: ProjectCliOptions) => runPipeline('inspect', options));
  addProjectOptions(program.command('build').description('Build and atomically commit selected Platforms'), 'production')
    .action((options: ProjectCliOptions) => runPipeline('build', options));
  addProjectOptions(program.command('dev').description('Watch and retain the last successful output'), 'development')
    .action((options: ProjectCliOptions) => runDev(options));

  return program;
}

/** 解析 CLI 参数并把使用错误与框架内部错误映射为稳定退出码。 */
export async function main(argv: readonly string[] = process.argv): Promise<void> {
  /** 当前调用独占的 Commander 命令树。 */
  const program = createCli();
  if (argv.length <= 2) {
    program.outputHelp();
    return;
  }
  try {
    /** `--` 之前用于识别已移除参数的真实选项候选。 */
    const argumentsAfterBinary = argv.slice(2);
    /** Commander option 终止符位置。 */
    const terminator = argumentsAfterBinary.indexOf('--');
    /** 不包含位置参数文本的选项扫描范围。 */
    const scanned = terminator === -1 ? argumentsAfterBinary : argumentsAfterBinary.slice(0, terminator);
    if (scanned.some(argument => argument === '--target' || argument === '-t' || argument.startsWith('--target='))) {
      program.error('option \'--target\' has been removed; use \'--platform <id...>\' instead', {
        exitCode: 2,
        code: 'acplugin.legacyTarget',
      });
    }
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
