import {
  ProjectConfigError,
  runProject,
} from '../../index.js';
import { exitCodeFor, writeFailure, writeReport } from '../output.js';
import type { ProjectCliOptions } from '../options.js';

/** 运行一次 validate、inspect 或 build。 */
export async function runPipeline(
  command: 'validate' | 'inspect' | 'build',
  options: ProjectCliOptions,
): Promise<void> {
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
