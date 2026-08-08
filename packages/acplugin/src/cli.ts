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
  serializeBuildResult,
  type BuildMode,
  type BuildResult,
  type Diagnostic,
  type InitPlatformId,
  type PlatformId,
} from './index.js';
import { InitError } from './init.js';
import { executeProject, type ProjectExecution } from './run-project.js';

/** validate、inspect、build 和 dev 命令共享的 CLI 选项。 */
interface ProjectCliOptions {
  /** 可选的 TypeScript 配置文件覆盖路径。 */
  config?: string;
  /** 可选的已配置 Platform 子集。 */
  platform?: string[];
  /** 传递给配置函数的开发或生产模式。 */
  mode: BuildMode;
  /** 是否覆盖配置中的兼容性严格度；未传参数时保持 undefined。 */
  strict?: boolean;
  /** 是否只在 stdout 输出一个稳定 JSON 对象。 */
  json?: boolean;
}

/**
 * 为项目 Pipeline 子命令注册一致的配置、Platform、模式和报告选项。
 *
 * @param command 待扩展的 Commander 子命令。
 * @param defaultMode 该子命令使用的默认配置模式。
 * @returns 同一个 Command，便于继续链式注册 action。
 */
function addProjectOptions(command: Command, defaultMode: BuildMode): Command {
  return command
    .option('-c, --config <path>', 'Use another TypeScript config file')
    .addOption(new Option('--platform <id...>', 'Select a subset of configured Platforms'))
    .addOption(new Option('--mode <mode>', 'Config mode').choices(['development', 'production']).default(defaultMode))
    .option('--strict', 'Reject degraded or unsupported Platform compatibility')
    .option('--no-strict', 'Allow degraded or unsupported Platform compatibility')
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
function writeReport(report: BuildResult, json: boolean | undefined): void {
  if (json) {
    process.stdout.write(serializeBuildResult(report));
    return;
  }
  /** 普通文本摘要使用的稳定状态词。 */
  const status = report.success ? 'success' : 'failed';
  process.stdout.write(`${report.command}: ${status} (${report.platforms.join(', ')})\n`);
  if (report.command === 'inspect') {
    /** component 表示 Scanner 发现且不暴露来源路径的规范资源。 */
    for (const component of report.components)
      process.stdout.write(`component ${component.kind}/${component.id}\n`);
    /** extension 表示配置中的 Extension 与本次资源发现状态。 */
    for (const extension of report.extensions)
      process.stdout.write(`extension ${extension.name} api:${extension.apiVersion} resources:${extension.hasResources}\n`);
    /** platform 表示配置中的 Platform 交付形态与最终严格度。 */
    for (const platform of report.platformDetails)
      process.stdout.write(`platform ${platform.id} api:${platform.apiVersion} delivery:${platform.deliveryType} strict:${platform.strict}\n`);
    /** document 表示 Adapter 应用完成后的结构化 Platform Document。 */
    for (const document of report.documents)
      process.stdout.write(`document ${document.platform}/${document.id} ${document.format} ${document.path} ${document.owner}\n`);
    for (const unit of report.deliveryUnits) {
      process.stdout.write(`unit ${unit.platform}/${unit.id} ${unit.role}:${unit.type}\n`);
      for (const artifact of unit.artifacts)
        process.stdout.write(`  artifact ${artifact.path} ${artifact.owner} ${artifact.mode.toString(8)} ${artifact.size} ${artifact.sha256}\n`);
    }
    for (const entry of report.compatibility)
      process.stdout.write(`compatibility ${entry.platform} ${entry.subject} ${entry.level}: ${entry.reason}\n`);
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

/** 在 Pipeline 尚未产生 BuildResult 时使用的最小 CLI 失败报告。 */
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
  /** 配置和已知 init 输入错误保留安全诊断，其他异常只输出固定消息。 */
  const diagnostics = error instanceof ProjectConfigError
    ? error.diagnostics
    : error instanceof InitError
      ? [{ code: 'INIT_INVALID', severity: 'error' as const, message: error.message, phase: command }]
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
 * 根据最终结构化诊断区分项目失败与框架内部失败。
 *
 * @param result 固定生命周期产生的完整报告。
 * @returns 成功为 0、项目失败为 1、Core 内部失败为 2。
 */
function exitCodeFor(result: BuildResult): 0 | 1 | 2 {
  if (result.success)
    return 0;
  return result.diagnostics.some(diagnostic => diagnostic.phase === 'internal' || diagnostic.code === 'LIFECYCLE_INTERNAL_FAILED') ? 2 : 1;
}

/**
 * 运行一次 validate、inspect 或 build，并按失败类型设置进程退出码。
 *
 * @param commandName 待执行的非持续型 Pipeline 命令。
 * @param options Commander 解析后的共享项目选项。
 */
async function runPipeline(commandName: 'validate' | 'inspect' | 'build', options: ProjectCliOptions): Promise<void> {
  try {
    /** 固定 Platform/Extension Pipeline 的执行结果。 */
    const result = await runProject({
      command: commandName,
      mode: options.mode,
      ...(options.config === undefined ? {} : { configPath: options.config }),
      ...(options.platform === undefined ? {} : { platforms: options.platform as PlatformId[] }),
      ...(options.strict === undefined ? {} : { strict: options.strict }),
      commit: commandName === 'build',
    });
    writeReport(result, options.json);
    process.exitCode = exitCodeFor(result);
  } catch /** error 保存当前操作捕获的异常，供本阶段转换或恢复。 */ (error) {
    /** 配置类错误属于用户输入问题，其余未预期异常使用内部错误退出码。 */
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
  /** 当前构建期间是否至少收到过一次新的文件变化。 */
  let pending = false;
  /** 当前唯一在途的串行重建队列，signal 清理必须等待它收敛。 */
  let activeRebuild: Promise<void> | undefined;
  /** 首次构建后正在等待 ready 的初始 watcher setup。 */
  let activeWatcherSetup: Promise<boolean> | undefined;
  /** 收到首个终止信号后阻止重复 JSON、重建和 watcher 清理。 */
  let stopping = false;
  /** 唤醒正在等待动态 watcher ready 的重建任务。 */
  let notifyStopRequested: (() => void) | undefined;
  /** signal 到达后只完成一次的取消通知。 */
  const stopRequested = new Promise<void>((resolve) => {
    notifyStopRequested = resolve;
  });
  /** 完成 signal 清理后唤醒 runDev 主流程。 */
  let resolveStopped: (() => void) | undefined;
  /** 正常 dev 生命周期只在收到 signal 并完成资源清理后结束。 */
  const stopped = new Promise<void>((resolve) => {
    resolveStopped = resolve;
  });
  /** JSON 模式退出时唯一写入 stdout 的最近一次报告。 */
  let finalJsonReport: BuildResult | CliFailureReport | undefined;
  /** 当前已加入 Chokidar 的配置、工程根与 descriptor 路径。 */
  const watchPaths = new Set<string>();
  /** 已解析 Extension 依赖可递归穿过 node_modules 过滤的真实 Package 根。 */
  const dependencyRoots = new Set<string>();
  /** 用于判断 dist、Git 与依赖忽略边界的全部工程根。 */
  const projectRoots = new Set<string>();
  /** 必须排除以防构建产物再次触发 dev 的全部托管输出目录。 */
  const outputRoots = new Set<string>();
  /** 初始路径与后续新增路径分别使用的监听器，退出时统一关闭。 */
  const watchers = new Set<ReturnType<typeof watch>>();
  /** 至少一个监听器完成首次扫描后才允许向调用方发布构建结果。 */
  let watcherReady = false;
  /** 合并短时间文件事件使用的定时器。 */
  let debounce: NodeJS.Timeout | undefined;
  /** dev 模式实际使用的配置绝对路径。 */
  const configPath = path.resolve(options.config ?? 'acplugin.config.ts');
  watchPaths.add(configPath);

  /**
   * 判断候选路径是否等于指定根或位于根目录内部。
   *
   * @param root 已规范化的绝对根目录。
   * @param candidate Chokidar 提供的候选绝对路径。
   * @returns 候选位于根边界内时返回 true。
   */
  const isInside = (root: string, candidate: string): boolean => {
    /** 从根目录指向候选的相对路径。 */
    const relative = path.relative(root, candidate);
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
  };

  /**
   * 判断候选是否是显式监听文件本身或其必要祖先目录。
   *
   * @param candidate Chokidar 正在遍历的绝对路径。
   * @returns 显式文件需要经过该路径时返回 true。
   */
  const isExplicitWatchBoundary = (candidate: string): boolean => [...watchPaths].some(watched =>
    watched === candidate || watched.startsWith(`${candidate}${path.sep}`))
  || [...dependencyRoots].some(root => isInside(root, candidate) || root.startsWith(`${candidate}${path.sep}`));

  /**
   * 排除托管输出、Git、无关 node_modules 与事务临时目录。
   *
   * 显式 descriptor 及其祖先优先放行，因此位于 node_modules 的已解析 Extension 文件仍可监听。
   *
   * @param candidate Chokidar 正在判断的文件或目录。
   * @returns 当前路径不应产生监听事件时返回 true。
   */
  const ignored = (candidate: string): boolean => {
    /** Chokidar 可能提供的相对路径统一转换为绝对路径。 */
    const absolute = path.resolve(candidate);
    // 托管输出和事务目录必须优先于显式依赖根排除，防止本地 descriptor 放行构建产物。
    if ([...outputRoots].some(root => isInside(root, absolute)))
      return true;
    /** 用于匹配系统 workDir 与 `.<outDir>.acplugin-*` 同级事务项的 POSIX 路径。 */
    const posixAbsolute = absolute.split(path.sep).join('/');
    if (/(^|\/)(?:acplugin-work(?:-|\/|$)|\.[^/]+\.acplugin(?:\.lock|-backup|-transaction\.json|-stage-[^/]+)(?:\/|$))/.test(posixAbsolute))
      return true;
    /** root 表示当前用于优先排除 Git 元数据的配置根。 */
    for (const root of projectRoots) {
      /** 候选路径相对于当前工程根的 POSIX 表示。 */
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      if (relative === '.git' || relative.startsWith('.git/'))
        return true;
    }
    if (isExplicitWatchBoundary(absolute))
      return false;
    /** root 表示当前用于解释标准工程目录名称的配置根。 */
    for (const root of projectRoots) {
      /** 候选路径相对于当前工程根的 POSIX 表示。 */
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      if (relative === 'node_modules' || relative.startsWith('node_modules/'))
        return true;
    }
    return false;
  };

  /**
   * 登记成功执行发现的工程、输出与 descriptor 路径。
   *
   * @param execution 最近一次固定 Pipeline 的内部执行快照。
   * @returns 本次首次发现且需要建立就绪监听器的路径。
   */
  const registerWatchPaths = (execution: ProjectExecution): readonly string[] => {
    projectRoots.add(execution.projectRoot);
    outputRoots.add(execution.outDir);
    /** root 表示当前允许递归监听的 Extension 依赖包根。 */
    for (const root of execution.dependencyRoots)
      dependencyRoots.add(root);
    /** 本次执行首次发现且需要增量加入 Chokidar 的路径。 */
    const added = execution.watchPaths.filter(candidate => !watchPaths.has(candidate));
    /** candidate 表示当前登记到稳定监听集合的绝对路径。 */
    for (const candidate of added)
      watchPaths.add(candidate);
    return added;
  };

  /**
   * 把一次或多次底层文件事件防抖合并为下一次串行重建。
   */
  function scheduleRebuild(): void {
    if (stopping)
      return;
    if (debounce)
      clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = undefined;
      void rebuild();
    }, 50);
  }

  /**
   * 为一批静态路径建立独立监听器，并等待该批路径完成首次扫描。
   *
   * Chokidar 的 `add()` 不提供可等待的新增路径 ready 语义，因此动态路径不能复用旧监听器。
   *
   * @param paths 本批首次发现的配置、工程或 Extension 依赖路径。
   * @returns 路径完成 ready 时返回 true，收到 stop 通知时返回 false。
   */
  async function createReadyWatcher(paths: readonly string[]): Promise<boolean> {
    /** 当前批次独占的 Chokidar 监听器。 */
    const watcher = watch([...paths], {
      ignoreInitial: true,
      ignored,
      // FSEvents 可能把一次 truncate/write 拆成间隔较长的多个 change；先等待文件稳定，
      // 再交给队列级防抖，避免同一次作者保存跨过构建边界而产生额外重建。
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 20 },
    });
    watchers.add(watcher);
    watcher.on('all', scheduleRebuild);
    try {
      /** readyResult 区分正常完成首次扫描与 signal 主动取消。 */
      const readyResult = await Promise.race([
        new Promise<true>((resolve, reject) => {
          watcher.once('ready', () => resolve(true));
          watcher.once('error', reject);
        }),
        stopRequested.then(() => false as const),
      ]);
      if (!readyResult) {
        watchers.delete(watcher);
        await watcher.close();
      }
      return readyResult;
    } catch /** error 保存监听器初始化异常并确保不会遗留活动句柄。 */ (error) {
      watchers.delete(watcher);
      await watcher.close();
      throw error;
    }
  }

  /**
   * 执行一次 dev 构建；signal 后不再登记路径、发布报告或创建 watcher。
   */
  async function performRebuild(): Promise<void> {
    try {
      /** 当前 dev 重建的 Pipeline 结果。 */
      const execution = await executeProject({
        command: 'dev',
        mode: options.mode,
        ...(options.config === undefined ? {} : { configPath: options.config }),
        ...(options.platform === undefined ? {} : { platforms: options.platform as PlatformId[] }),
        ...(options.strict === undefined ? {} : { strict: options.strict }),
        commit: true,
      });
      if (stopping)
        return;
      /** 固定 Pipeline 当前一次 dev 重建的公开报告。 */
      const result = execution.result;
      /** 当前执行首次发现、旧监听器尚未覆盖的动态路径。 */
      const added = registerWatchPaths(execution);
      if (watcherReady && added.length > 0) {
        try {
          /** dynamicReady 表示本批动态路径是否在取消前完成首次扫描。 */
          const dynamicReady = await createReadyWatcher(added);
          if (!dynamicReady || stopping)
            return;
          // ready 只表示初始目录扫描结束；扫描期间的变化因 ignoreInitial 不会产生事件。
          // 丢弃本轮旧快照并让串行队列立即补偿构建，成功提示才是可靠同步边界。
          pending = true;
          return;
        } catch /** error 保存动态监听器初始化异常，并允许后续配置事件重试。 */ (error) {
          /** candidate 表示当前尚未成功建立监听、需要撤销登记的路径。 */
          for (const candidate of added)
            watchPaths.delete(candidate);
          throw error;
        }
      }
      if (stopping)
        return;
      /** 发布本次成功执行结果；首次结果必须等到监听器确实就绪。 */
      const publish = (): void => {
        if (options.json) {
          finalJsonReport = result;
          process.stderr.write(`dev: ${result.success ? 'success' : 'failed'}\n`);
        } else {
          writeReport(result, false);
        }
      };
      if (watcherReady)
        publish();
      process.exitCode = exitCodeFor(result);
    } catch /** error 保存当前操作捕获的异常，供本阶段转换或恢复。 */ (error) {
      if (stopping)
        return;
      /** 配置错误可通过后续文件变更恢复，内部异常仍以独立退出状态标识。 */
      const internal = !(error instanceof ProjectConfigError);
      /** 发布本次失败结果；首次失败同样在配置监听已经就绪后再提示可恢复。 */
      const publish = (): void => {
        if (options.json) {
          finalJsonReport = failureReport('dev', error, internal);
          process.stderr.write('dev: failed\n');
        } else {
          writeFailure('dev', error, false, internal);
        }
      };
      if (watcherReady)
        publish();
      process.exitCode = internal ? 2 : 1;
    }
  }

  /**
   * 消费构建期间合并到 pending 的变化，直到队列稳定或收到 signal。
   */
  async function runRebuildQueue(): Promise<void> {
    do {
      pending = false;
      await performRebuild();
    } while (pending && !stopping);
  }

  /**
   * 请求一次串行重建，并返回当前唯一可等待的在途队列。
   *
   * @returns 当前或新建的重建队列 Promise。
   */
  function rebuild(): Promise<void> {
    if (stopping)
      return Promise.resolve();
    if (activeRebuild) {
      pending = true;
      return activeRebuild;
    }
    /** task 表示本次创建且会在稳定后清除引用的重建队列。 */
    const task = runRebuildQueue();
    activeRebuild = task;
    void task.then(() => {
      if (activeRebuild === task)
        activeRebuild = undefined;
    });
    return task;
  }

  /**
   * 响应任意启动阶段的终止信号，等待在途任务并关闭最终 watcher 集合。
   */
  function stop(): void {
    if (stopping)
      return;
    stopping = true;
    notifyStopRequested?.();
    if (debounce)
      clearTimeout(debounce);
    if (options.json && finalJsonReport) {
      /** BuildResult 使用稳定 serializer，配置前失败使用固定字段顺序。 */
      const json = 'deliveryUnits' in finalJsonReport
        ? serializeBuildResult(finalJsonReport)
        : `${JSON.stringify(finalJsonReport, null, 2)}\n`;
      process.stdout.write(json);
    }
    process.exitCode = 130;
    /** cleanup 表示等待首次或动态任务后对最终 watcher 集合执行的统一清理。 */
    const cleanup = async (): Promise<void> => {
      try {
        await activeRebuild;
        await activeWatcherSetup;
        /** closeTasks 包含停止后不再增长的全部初始或动态监听器。 */
        const closeTasks = [...watchers].map(watcher => watcher.close());
        await Promise.all(closeTasks);
      } catch {
        // signal 的公开退出语义固定为 130，清理异常不能产生未处理 Promise rejection。
        process.exitCode = 130;
      } finally {
        resolveStopped?.();
      }
    };
    void cleanup();
  }

  // 使用持久监听器直到 finally 主动卸载，避免构建依赖在后注册的 signal-exit
  // 把“当前只剩自身监听器”误判为无人处理，并重新发送信号绕过异步清理。
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    await rebuild();
    if (!stopping) {
      /** 监听配置、工程根和 descriptor 的初始 setup，也必须能被 signal 等待。 */
      const setup = createReadyWatcher([...watchPaths]);
      activeWatcherSetup = setup;
      /** initialReady 表示首次路径扫描是否在 signal 前正常完成。 */
      const initialReady = await setup;
      if (activeWatcherSetup === setup)
        activeWatcherSetup = undefined;
      if (initialReady && !stopping) {
        watcherReady = true;
        // 首次 Pipeline 与 watcher ready 之间存在 ignoreInitial 窗口；旧报告不能发布。
        await rebuild();
      }
    }
    await stopped;
  } catch /** error 表示初始化与 signal 同时发生时可能到达的 watcher 异常。 */ (error) {
    if (!stopping)
      throw error;
    await stopped;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
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
          ...(options.install === undefined ? {} : { install: options.install }),
        });
        if (options.json)
          process.stdout.write(`${JSON.stringify({ schemaVersion: '1', success: true, ...result }, null, 2)}\n`);
        else
          process.stdout.write(`Created ${result.directory}\nNext: cd ${result.directory} && pnpm install && pnpm build\n`);
        if (options.install && !result.installed)
          process.exitCode = 1;
      } catch /** error 保存当前操作捕获的异常，供本阶段转换或恢复。 */ (error) {
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
      } catch /** error 保存当前操作捕获的异常，供本阶段转换或恢复。 */ (error) {
        writeFailure('migrate', error, options.json, false);
        process.exitCode = 1;
      }
    });

  addProjectOptions(program.command('validate').description('Validate all selected Platform delivery units'), 'production')
    .action((options: ProjectCliOptions) => runPipeline('validate', options));
  addProjectOptions(program.command('inspect').description('Inspect all selected Platform delivery units'), 'production')
    .action((options: ProjectCliOptions) => runPipeline('inspect', options));
  addProjectOptions(program.command('build').description('Build and atomically commit selected Platforms'), 'production')
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
    /** 旧参数只用于产生定向 usage error，不注册为可运行 alias。 */
    const flagArguments = argv.slice(2);
    /** `--` 之后的值属于位置参数，不再参与 legacy option 探测。 */
    const terminator = flagArguments.indexOf('--');
    /** Commander option 终止符之前的真实选项候选。 */
    const scannedArguments = terminator === -1 ? flagArguments : flagArguments.slice(0, terminator);
    if (scannedArguments.some(argument => argument === '--target' || argument === '-t' || argument.startsWith('--target='))) {
      program.error('option \'--target\' has been removed; use \'--platform <id...>\' instead', {
        exitCode: 2,
        code: 'acplugin.legacyTarget',
      });
    }
    await program.parseAsync(argv);
  } catch /** error 保存当前操作捕获的异常，供本阶段转换或恢复。 */ (error) {
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
