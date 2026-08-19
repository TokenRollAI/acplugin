import { promises as fs } from 'node:fs';
import path from 'node:path';
import { watch, type FSWatcher } from 'chokidar';
import type {
  BuildReport,
  DevSession,
  DevSessionEvent,
  Diagnostic,
  ProjectDevOptions,
} from '../kernel-types.js';
import { createBuildReport } from '../package/report-builder.js';
import {
  createKernelBuildEnvironment,
  disposeKernelBuildEnvironment,
  runKernelBuildSession,
  type KernelBuildSessionResult,
} from './build-session.js';

/** Dev coordinator 向配置 loader 请求的固定命令。 */
export interface DevSessionRoundInput {
  readonly projectRoot: string;
  readonly configFile?: string;
  readonly frameworkVersion: string;
  readonly loadConfig: (environment: Awaited<ReturnType<typeof createKernelBuildEnvironment>>) => Promise<import('./config-resolver.js').ResolvedKernelConfig>;
  readonly options: ProjectDevOptions;
  readonly initialConfigError?: (error: unknown) => readonly Diagnostic[];
  /** Core 单测使用的 watcher I/O 注入点；公开 Project API 不暴露。 */
  readonly watchFactory?: typeof watch;
  /** Core 单测可缩短 readiness fault 的有界等待；默认 5 秒。 */
  readonly watchReadyTimeoutMs?: number;
}

/** Project 配置失败时构造一个可继续 watch 的最小报告。 */
async function failureReport(
  input: DevSessionRoundInput,
  environment: Awaited<ReturnType<typeof createKernelBuildEnvironment>>,
  diagnostics: readonly Diagnostic[],
): Promise<BuildReport> {
  return createBuildReport({
    frameworkVersion: input.frameworkVersion,
    compilerVersion: (await environment.compiler.service('framework:report')).engine.version,
    success: false,
    command: 'dev',
    mode: input.options.mode ?? 'development',
    committed: false,
    components: [],
    runtimes: [],
    extensions: [],
    platforms: [],
    packages: [],
    compatibility: [],
    metadata: [],
    diagnostics,
    assets: environment.assets,
  });
}

/** 使用独立受管环境建立一个不泄漏 watcher 异常的稳定失败报告。 */
async function isolatedFailureReport(
  input: DevSessionRoundInput,
  diagnostic: Diagnostic,
): Promise<BuildReport> {
  /** 失败报告仍使用独占环境取得完整且安全的 schema-v2 字段。 */
  const environment = await createKernelBuildEnvironment(input.projectRoot);
  try {
    return await failureReport(input, environment, Object.freeze([diagnostic]));
  } finally {
    await disposeKernelBuildEnvironment(environment);
  }
}

/** 从文件事件生成工程相对路径或已登记的外部 package identity。 */
function changeIdentity(
  projectRoot: string,
  file: string,
  observations: ReadonlyMap<string, Readonly<{ identity: string; type: 'file' | 'directory'; pending: boolean }>>,
): string | undefined {
  /** Chokidar 与 Watch Registry 均使用绝对规范路径。 */
  const absolute = path.resolve(file);
  /** 精确依赖优先复用 Watch Registry 已验证的稳定 identity。 */
  const direct = observations.get(absolute);
  if (direct !== undefined)
    return direct.identity;
  /** 工程根中的新资源尚未进入 snapshot，仍可安全使用相对路径。 */
  const projectRelative = path.relative(projectRoot, absolute);
  if (projectRelative === '' || (projectRelative !== '..' && !projectRelative.startsWith(`..${path.sep}`) && !path.isAbsolute(projectRelative)))
    return projectRelative === '' ? '.' : projectRelative.split(path.sep).join('/');
  /** 外部目录 observation 可以为其后代生成同一 package identity 下的路径。 */
  const directory = [...observations.entries()]
    .filter(([root, observation]) => observation.type === 'directory' && (() => {
      /** relative 用于证明事件仍位于已授权的外部观察目录内。 */
      const relative = path.relative(root, absolute);
      return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    })())
    .sort(([left], [right]) => right.length - left.length)[0];
  if (directory === undefined)
    return undefined;
  /** 最深匹配目录的安全后代路径附加到其稳定 package identity。 */
  const suffix = path.relative(directory[0], absolute).split(path.sep).join('/');
  return suffix === '' ? directory[1].identity : `${directory[1].identity}/${suffix}`;
}

/**
 * 只忽略本轮解析后的托管输出和仓库元数据。
 *
 * @param projectRoot 固定工程根。
 * @param outputDirectory 最近一次合法配置解析出的输出根。
 * @param candidate Chokidar 正在判定的路径。
 * @returns 该路径是否不应触发重建。
 */
function ignoredPath(projectRoot: string, outputDirectory: string | undefined, candidate: string): boolean {
  /** 工程相对路径只用于判断元数据和中间目录。 */
  const relative = path.relative(projectRoot, candidate).split(path.sep).join('/');
  /** 输出路径按物理包含关系判断，不把名为 dist 的合法 srcDir 特判掉。 */
  const outputRelative = outputDirectory === undefined ? undefined : path.relative(outputDirectory, candidate);
  /** 候选位于最终输出根本身或后代时必须忽略。 */
  const managedOutput = outputRelative !== undefined && (outputRelative === ''
    || (!outputRelative.startsWith(`..${path.sep}`) && outputRelative !== '..' && !path.isAbsolute(outputRelative)));
  /** 输出事务的 lock/stage/backup/record 位于 outDir 同级，同样由 Core 托管。 */
  const outputBase = outputDirectory === undefined ? undefined : path.basename(outputDirectory);
  /** 事务辅助路径共用以 outDir basename 为前缀的稳定命名。 */
  const transactionPrefix = outputBase === undefined ? undefined : `.${outputBase}.acplugin`;
  /** 仅匹配 outDir 父目录中的直属事务路径。 */
  const candidateParent = path.dirname(candidate);
  /** 候选 basename 用于区分作者目录与托管事务元数据。 */
  const candidateBase = path.basename(candidate);
  /** 同级事务路径不得反向触发 dev 重建。 */
  const managedTransaction = outputDirectory !== undefined && transactionPrefix !== undefined
    && candidateParent === path.dirname(outputDirectory)
    && (candidateBase === `${transactionPrefix}.lock`
      || candidateBase === `${transactionPrefix}-transaction.json`
      || candidateBase === `${transactionPrefix}-transaction.json.writing`
      || candidateBase === `${transactionPrefix}-committed.json`
      || candidateBase === `${transactionPrefix}-committed.json.writing`
      || candidateBase === `${transactionPrefix}-backup`
      || candidateBase.startsWith(`${transactionPrefix}-stage-`));
  /** 不跟随的包代理内嵌 node_modules symlink 不是作者变更。 */
  const nestedDependencyLink = relative !== 'node_modules' && relative.endsWith('/node_modules');
  return managedOutput || managedTransaction || nestedDependencyLink || relative === '.git' || relative.startsWith('.git/')
    || relative.startsWith('.acplugin-work-') || relative.startsWith('.acplugin-stage-');
}

/** Core-owned DevSession 的最小 round coordinator。 */
export async function createDevSession(input: DevSessionRoundInput): Promise<DevSession> {
  /** 生产路径始终使用 Chokidar；测试只替换同一 FSWatcher 契约。 */
  const createWatcher = input.watchFactory ?? watch;
  /** readiness deadline 必须是有限正整数。 */
  const watchReadyTimeoutMs = input.watchReadyTimeoutMs ?? 5_000;
  if (!Number.isSafeInteger(watchReadyTimeoutMs) || watchReadyTimeoutMs <= 0)
    throw new TypeError('Dev watcher readiness timeout must be a positive integer.');
  /** Platform subset 在 Session 创建时复制，不观察调用方后续修改。 */
  const selection = input.options.platforms === undefined ? undefined : Object.freeze([...input.options.platforms]);
  /** Dev 默认提交成功输出。 */
  const commit = input.options.commit ?? true;
  /** 订阅者只接收不可变轮次事件。 */
  const listeners = new Set<(event: DevSessionEvent) => void>();
  /** Core 独占的当前文件观察器。 */
  let watcher: FSWatcher | undefined;
  /** 已向 Chokidar 登记的路径快照。 */
  let watchedPaths = new Set<string>();
  /** 首次 ready 时间用于保留最小事件交付窗口。 */
  let watcherReadyAt = 0;
  /** close 完成后的终态标志。 */
  let closed = false;
  /** close 已开始但在途轮次尚未排空的标志。 */
  let closing = false;
  /** 轮次事件的单调序号。 */
  let sequence = 0;
  /** active 轮次后是否需要一次补偿构建。 */
  let pending = false;
  /** 首轮及 watcher 对齐尚未完成的标志。 */
  let initializing = true;
  /** 待合并到下一轮的工程相对变更。 */
  let pendingChanges = new Set<string>();
  /** 唯一在途的 drain Promise。 */
  let active: Promise<void> | undefined;
  /** 空闲期文件事件的短窗口合并计时器。 */
  let debounce: ReturnType<typeof setTimeout> | undefined;
  /** 最近一轮构建已经读取并登记的物理路径。 */
  let knownBuildPaths = new Set<string>();
  /** 物理 watch path 到安全 change identity/type 的当前映射。 */
  let knownObservations = new Map<string, Readonly<{ identity: string; type: 'file' | 'directory'; pending: boolean }>>();
  /** 最近一次成功或首轮失败的可公开报告。 */
  let current: BuildReport;
  /** 配置入口轮询的 mtime/size 组合。 */
  let configStamp: string | undefined;
  /** 配置首次解析前不猜测输出根，每轮解析后立即更新。 */
  let outputDirectory: string | undefined;
  /** 配置缺失或替换时的保守恢复轮询器。 */
  const poller = input.configFile === undefined
    ? undefined
    : setInterval(async () => {
        if (closed || closing)
          return;
        /** 当前配置普通文件状态；缺失时映射为空 stamp。 */
        const stat = await fs.stat(input.configFile!).catch(() => undefined);
        /** 轮询不读取配置内容，只比较稳定文件元数据。 */
        const stamp = stat === undefined ? '' : `${stat.mtimeMs}:${stat.size}`;
        if (configStamp !== undefined && stamp !== configStamp) {
          configStamp = stamp;
          schedule(input.configFile!);
        } else if (configStamp === undefined) {
          configStamp = stamp;
          if (stamp !== '' && current !== undefined && !current.success)
            schedule(input.configFile!);
        }
      }, 100);
  /** close() 完成时解析公开 closed Promise 的函数。 */
  let resolveClosed!: () => void;
  /** 调用方可等待的唯一 Session 关闭信号。 */
  const closedPromise = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  /** 所有并发 close() 调用共享的唯一关闭任务。 */
  let closeTask: Promise<void> | undefined;

  /** 向当前订阅者隔离发布事件。 */
  const emit = (event: DevSessionEvent): void => {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch {
        /** 异常订阅者自动撤销，不能反复影响后续事件分发。 */
        listeners.delete(listener);
      }
    }
  };

  /** 空闲时在短暂安静窗口后启动唯一 drain。 */
  const requestDrain = (): void => {
    if (closed || closing || initializing || active !== undefined)
      return;
    if (debounce !== undefined)
      clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = undefined;
      /** round 自身收敛已知错误；最后防线仍显式观察未知 rejection。 */
      void drain().catch(() => undefined);
    }, 100);
  };

  /** 将一个文件事件合并到最多一次补偿轮次。 */
  const schedule = (file: string, event: string = 'change'): void => {
    if (closed || closing || ignoredPath(input.projectRoot, outputDirectory, file))
      return;
    /** 动态 watcher.add() 会对本轮已读取路径延迟交付 add/addDir，它们不是新变更。 */
    const knownAdd = (event === 'add' || event === 'addDir') && [...knownBuildPaths].some((known) => {
      /** pending 文件的首次 add 是真实恢复事件，不能作为 watcher 合成事件丢弃。 */
      if (known === file)
        return knownObservations.get(known)?.pending !== true;
      if (event !== 'addDir')
        return false;
      /** addDir 候选是已知文件的祖先时同样是合成 ready 事件。 */
      const relative = path.relative(file, known);
      return knownObservations.get(known)?.pending !== true && relative !== '' && relative !== '..'
        && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    });
    if (knownAdd)
      return;
    /** 工程外事件必须已经具有 Watch Registry 签发的逻辑 identity。 */
    const identity = changeIdentity(input.projectRoot, file, knownObservations);
    if (identity === undefined)
      return;
    pending = true;
    pendingChanges.add(identity);
    requestDrain();
  };

  /** 等待动态增加的精确依赖进入 Chokidar 快照。 */
  const waitUntilWatched = async (paths: readonly string[]): Promise<void> => {
    if (paths.length === 0 || watcher === undefined)
      return;
    /** 有限期 ready 窗口避免关闭永久挂起。 */
    const deadline = Date.now() + watchReadyTimeoutMs;
    while (Date.now() < deadline) {
      /** Chokidar 当前目录到直属条目的观察快照。 */
      const watched = watcher.getWatched();
      /** 所有新路径都出现在快照中才可对外发布成功。 */
      const ready = paths.every((candidate) => {
        /** 快照索引使用物理父目录。 */
        const directory = path.dirname(candidate);
        /** 父目录下匹配的精确文件名。 */
        const basename = path.basename(candidate);
        return Array.isArray(watched[directory]) && watched[directory].includes(basename);
      });
      if (ready)
        return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Dev watcher did not become ready for the build dependency graph.');
  };

  /** 用最新 Module/Compiler/Resource 图对齐唯一 watcher。 */
  const updateWatcher = async (result: KernelBuildSessionResult, replace: boolean): Promise<void> => {
    /** 已解析依赖中排除当前托管输出。 */
    const roundObservations = result.watch.observations
      .filter(observation => !ignoredPath(input.projectRoot, outputDirectory, observation.path));
    /** 成功轮原子替换图；失败轮与 last-good 图取并集以保留全部恢复入口。 */
    const nextObservations = replace
      ? new Map<string, Readonly<{ identity: string; type: 'file' | 'directory'; pending: boolean }>>()
      : new Map(knownObservations);
    for (const observation of roundObservations)
      nextObservations.set(observation.path, Object.freeze({
        identity: observation.identity,
        type: observation.type,
        pending: observation.pending,
      }));
    /** watcher 物理输入与公开 identity 映射来自同一个待提交 snapshot。 */
    const exact = [...nextObservations.keys()];
    /** 工程根用于发现新资源，精确路径用于覆盖外部依赖。 */
    const desired = [...new Set([input.projectRoot, ...exact])].sort();
    if (watcher === undefined) {
      watcher = createWatcher(desired, {
        ignoreInitial: true,
        followSymlinks: false,
        /** 忽略策略读取当前动态输出根。 */
        ignored: (candidate: string) => ignoredPath(input.projectRoot, outputDirectory, candidate),
        awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 20 },
      });
      watcher.on('all', (event, file) => schedule(file, event));
      await new Promise<void>((resolve, reject) => {
        watcher!.once('ready', resolve);
        watcher!.once('error', reject);
      });
      watcherReadyAt = Date.now();
      watchedPaths = new Set(desired);
      knownObservations = nextObservations;
      knownBuildPaths = new Set(exact);
      return;
    }
    /** 下一轮观察路径的去重集合。 */
    const next = new Set(desired);
    /** 已不在最新构建图中的路径。 */
    const removed = [...watchedPaths].filter(candidate => !next.has(candidate));
    /** 需在发布成功前完成 ready 的新路径。 */
    const added = desired.filter(candidate => !watchedPaths.has(candidate));
    /** pending 文件不会在出现前进入 getWatched 的直属文件快照。 */
    const readiness = added.filter(candidate => nextObservations.get(candidate)?.pending !== true);
    if (added.length > 0) {
      watcher.add(added);
      await waitUntilWatched(readiness);
    }
    /** 先扩张再收缩可保证任一失败时物理 watcher 至少是 last-good 的超集。 */
    if (removed.length > 0)
      await watcher.unwatch(removed);
    /** 所有物理操作成功后一次提交三份相互一致的逻辑状态。 */
    watchedPaths = next;
    knownObservations = nextObservations;
    knownBuildPaths = new Set(exact);
  };

  /** 使用全新 Kernel environment 执行一个完整构建轮次。 */
  const runRound = async (_changes: readonly string[]): Promise<KernelBuildSessionResult> => {
    /** 本轮独占的 capability 和中间目录环境。 */
    const environment = await createKernelBuildEnvironment(input.projectRoot);
    /** 本轮最终的安全 BuildReport。 */
    let result: BuildReport;
    /** 配置成功进入 BuildSession 后产生的报告与 watch 快照。 */
    let sessionResult: KernelBuildSessionResult | undefined;
    try {
      try {
        /** 每轮 fresh evaluate 后的完整 Kernel 配置。 */
        const config = await input.loadConfig(environment);
        outputDirectory = config.outDirectory;
        sessionResult = await runKernelBuildSession({
          config,
          frameworkVersion: input.frameworkVersion,
          ...(selection === undefined ? {} : { selection }),
          commit,
          environment,
        });
        result = sessionResult.report;
      } catch (error) {
        /** 已知配置异常中允许继续 watch 的稳定诊断。 */
        const diagnostics = error && typeof error === 'object' && 'diagnostics' in error
          ? Reflect.get(error, 'diagnostics')
          : undefined;
        result = await failureReport(input, environment, Array.isArray(diagnostics)
          ? diagnostics as readonly Diagnostic[]
          : [{
              code: 'DEV_BUILD_FAILED', severity: 'error', phase: 'dev', message: 'Dev build failed.',
            }]);
      }
      /** 失败轮也保留在失败前已登记的依赖快照。 */
      const watch = sessionResult?.watch ?? environment.watch.snapshot();
      return Object.freeze({ report: result, watch });
    } finally {
      await disposeKernelBuildEnvironment(environment);
    }
  };

  /** 执行一轮；初始化补偿轮不发布调用方无法订阅的事件。 */
  const round = async (changes: readonly string[], publish = true): Promise<void> => {
    /** 只有 Session resolve 后的公开 rebuild 才占用事件序号。 */
    const number = publish ? ++sequence : 0;
    if (publish)
      emit(Object.freeze({ type: 'build-start', sequence: number, changes: Object.freeze([...changes]) }));
    /** 任意内部异常最终都必须映射为本 sequence 的一个完成报告。 */
    let result: BuildReport;
    try {
      /** 本轮内部报告和依赖快照。 */
      const roundResult = await runRound(changes);
      result = roundResult.report;
      /** closing 不再需要扩张 watcher，但在途轮仍必须完整发布并更新成功报告。 */
      if (!closing) {
        try {
          await updateWatcher(roundResult, result.success);
        } catch {
          result = await isolatedFailureReport(input, Object.freeze({
            code: 'DEV_WATCH_FAILED', severity: 'error', phase: 'dev', message: 'Dev watcher reconciliation failed.',
          }));
        }
      }
    } catch {
      result = await isolatedFailureReport(input, Object.freeze({
        code: 'DEV_BUILD_FAILED', severity: 'error', phase: 'dev', message: 'Dev build failed.',
      }));
    }
    if (result.success)
      current = result;
    if (publish && !closed)
      emit(Object.freeze({ type: 'build-complete', sequence: number, changes: Object.freeze([...changes]), report: result }));
  };

  /** 串行排空所有已合并修改。 */
  const drain = async (publish = true): Promise<void> => {
    if (closed || closing)
      return;
    if (active !== undefined) {
      await active;
      return;
    }
    if (debounce !== undefined) {
      clearTimeout(debounce);
      debounce = undefined;
    }
    active = (async () => {
      do {
        pending = false;
        /** 本轮的稳定变更路径快照。 */
        const changes = [...pendingChanges].sort();
        pendingChanges = new Set();
        await round(changes, publish);
      } while (pending && !closed && !closing);
    })().finally(() => {
      active = undefined;
      if (pending && !closed && !closing)
        requestDrain();
    });
    await active;
  };

  /** 初始化抛出时用于无条件释放 poller/半建立 watcher。 */
  let initializationComplete = false;
  try {
    try {
      /** 首轮构建前先监听工程根，避免构建期间的修改丢失。 */
      watcher = createWatcher([input.projectRoot], {
        ignoreInitial: true,
        followSymlinks: false,
        /** 首轮同样使用可更新的解析输出根。 */
        ignored: (candidate: string) => ignoredPath(input.projectRoot, outputDirectory, candidate),
        awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 20 },
      });
      watcher.on('all', (event, file) => schedule(file, event));
      await new Promise<void>((resolve, reject) => {
        watcher!.once('ready', resolve);
        watcher!.once('error', reject);
      });
      watcherReadyAt = Date.now();
      watchedPaths = new Set([input.projectRoot]);
      /** 首轮在 watcher ready 后开始，使建立期修改可补偿。 */
      const first = await runRound([]);
      current = first.report;
      await updateWatcher(first, first.report.success);
      /** 给 chokidar 一个稳定窗口交付首轮期间发生的写入。 */
      await new Promise(resolve => setTimeout(resolve, Math.max(0, 20 - (Date.now() - watcherReadyAt))));
    } catch (error) {
      /** 失败 watcher 不得进入后续 reconciliation。 */
      if (watcher !== undefined) {
        await watcher.close().catch(() => undefined);
        watcher = undefined;
        watchedPaths = new Set();
      }
      /** watcher 初始化异常的失败报告也需要受管环境。 */
      const environment = await createKernelBuildEnvironment(input.projectRoot);
      try {
        current = await failureReport(input, environment, input.initialConfigError?.(error) ?? [{
          code: 'DEV_WATCH_FAILED', severity: 'error', phase: 'dev', message: 'Dev watcher setup failed.',
        }]);
        await updateWatcher({ report: current, watch: environment.watch.snapshot() }, false);
      } finally {
        await disposeKernelBuildEnvironment(environment);
      }
    }
    initializationComplete = true;
  } finally {
    if (!initializationComplete) {
      if (poller !== undefined)
        clearInterval(poller);
      await watcher?.close().catch(() => undefined);
      watcher = undefined;
    }
  }

  initializing = false;
  if (!current.success && input.configFile !== undefined
    && await fs.stat(input.configFile).then(() => true).catch(() => false)) {
    schedule(input.configFile);
  }
  if (pending && !closed && !closing)
    await drain(false);

  /** 公开 Session 外壳只暴露报告、事件和幂等关闭。 */
  const session: DevSession = {
    /** 返回最近一次可公开的报告。 */
    get current() { return current; },
    /** 登记一个事件订阅者并返回取消函数。 */
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** 排空在途轮次、发布 closed、关闭 watcher 并撤销订阅。 */
    close() {
      if (closeTask !== undefined)
        return closeTask;
      closeTask = (async () => {
        /** cleanup errors 在终态发布后统一交给 close() 调用方。 */
        const failures: unknown[] = [];
        closing = true;
        pending = false;
        pendingChanges = new Set();
        if (debounce !== undefined) {
          clearTimeout(debounce);
          debounce = undefined;
        }
        try {
          try {
            await active;
          } catch (error) {
            failures.push(error);
          }
          if (watcher !== undefined) {
            try {
              await watcher.close();
            } catch (error) {
              failures.push(error);
            } finally {
              watcher = undefined;
            }
          }
        } finally {
          if (poller !== undefined)
            clearInterval(poller);
          closed = true;
          emit(Object.freeze({ type: 'closed', sequence, report: current }));
          listeners.clear();
          resolveClosed();
        }
        if (failures.length > 0)
          throw new AggregateError(failures, 'DevSession cleanup failed.');
      })();
      return closeTask;
    },
    closed: closedPromise,
  };
  return Object.freeze(session);
}
