import type { BuildMode } from './config.js';
import type { BuildReport } from './reports.js';

/** Project 创建时固定的工程身份选项。 */
export interface CreateProjectOptions {
  readonly cwd?: string;
  readonly configFile?: string;
}

/** 单次 Project 执行选项。 */
export interface ProjectRunOptions {
  readonly command?: 'validate' | 'inspect' | 'build';
  readonly mode?: BuildMode;
  readonly platforms?: readonly string[];
  readonly commit?: boolean;
}

/** 持续构建 Session 选项。 */
export interface ProjectDevOptions {
  readonly mode?: BuildMode;
  readonly platforms?: readonly string[];
  readonly commit?: boolean;
}

/** runProject convenience 的组合选项。 */
export interface RunProjectOptions extends CreateProjectOptions, ProjectRunOptions {}

/** DevSession 发布的稳定事件。 */
export type DevSessionEvent = {
  readonly type: 'build-start';
  readonly sequence: number;
  readonly changes: readonly string[];
} | {
  readonly type: 'build-complete';
  readonly sequence: number;
  readonly changes: readonly string[];
  readonly report: BuildReport;
} | {
  readonly type: 'closed';
  readonly sequence: number;
  readonly report: BuildReport;
};

/** Core 独占 Watch ownership 的持续构建句柄。 */
export interface DevSession {
  /** 最近一次成功报告；首次构建失败时由该初始失败报告暂时播种。 */
  readonly current: BuildReport;
  /** 订阅稳定 DevSession 事件并返回取消函数。 */
  subscribe(listener: (event: DevSessionEvent) => void): () => void;
  /** 幂等关闭 Watch 与当前 BuildSession；cleanup 失败也会先完成 closed 终态。 */
  close(): Promise<void>;
  /** 无论 cleanup 是否失败都在唯一 closed 事件发布后解析。 */
  readonly closed: Promise<void>;
}

/** 绑定同一工程配置身份的程序化 Project。 */
export interface Project {
  /** 使用固定工程身份执行一次 BuildSession。 */
  run(options?: ProjectRunOptions): Promise<BuildReport>;
  /** 使用相同 Kernel 创建持续构建 Session。 */
  dev(options?: ProjectDevOptions): Promise<DevSession>;
}
