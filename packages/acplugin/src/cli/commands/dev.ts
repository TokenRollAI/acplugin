import process from 'node:process';
import type { Command } from 'commander';
import {
  createProject,
  ProjectConfigError,
  serializeBuildReport,
  type BuildReport,
} from '../../index.js';
import { exitCodeFor, writeDevProgress, writeFailure, writeReport } from '../output.js';
import { addProjectOptions, type ProjectCliOptions } from '../options.js';

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

/** 注册 dev 命令并保持 Core DevSession 的唯一所有权。 */
export function registerDevCommand(program: Command): void {
  addProjectOptions(program.command('dev').description('Watch and retain the last successful output'), 'development')
    .action((options: ProjectCliOptions) => runDev(options));
}
