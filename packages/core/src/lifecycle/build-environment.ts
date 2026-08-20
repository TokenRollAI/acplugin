import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CompilerHost } from '../compiler/compiler-service.js';
import { AssetRegistry } from '../services/assets.js';
import { DiagnosticRegistry } from '../services/diagnostics.js';
import { ExecutionHost } from '../services/execution.js';
import { ModuleHost } from '../services/modules.js';
import { SourceRegistry } from '../services/sources.js';
import { WatchRegistry } from '../services/watch.js';
import { WorkDirectoryRegistry } from '../services/work-directories.js';
import { BuildSessionScope } from './session-scope.js';

/** Project config loader 与 BuildSession 共享的唯一 Host/Registry 环境。 */
export interface KernelBuildEnvironment {
  readonly scope: BuildSessionScope;
  readonly workRoot: string;
  readonly sources: SourceRegistry;
  readonly workDirectories: WorkDirectoryRegistry;
  readonly watch: WatchRegistry;
  readonly assets: AssetRegistry;
  readonly modules: ModuleHost;
  readonly compiler: CompilerHost;
  readonly execution: ExecutionHost;
  readonly diagnostics: DiagnosticRegistry;
}

/** 创建一次 BuildSession 唯一的 Host/Registry 图。 */
export async function createKernelBuildEnvironment(projectRoot: string): Promise<KernelBuildEnvironment> {
  /** 所有 Integration 中间文件共享一个由 Core 独占的临时父目录。 */
  const workRoot = await fs.mkdtemp(path.join(os.tmpdir(), '.acplugin-work-'));
  /** capability scope 在最终报告建立后统一撤销。 */
  const scope = new BuildSessionScope();
  /** Source/Watch/Work registries 是全部 Host 的共同授权基础。 */
  const sources = new SourceRegistry(scope, projectRoot);
  /** 每个 owner 只会获得自己的不可伪造 workDir handle。 */
  const workDirectories = new WorkDirectoryRegistry(scope, workRoot);
  /** Watch Registry 集中接收 Resource、Module 和 Compiler observations。 */
  const watch = new WatchRegistry(scope, projectRoot);
  /** Asset Registry 绑定当前 Source 与 workDir identities。 */
  const assets = new AssetRegistry(scope, sources, workDirectories);
  /** Module Host 只读取同一组 Session Registry。 */
  const modules = new ModuleHost({ projectRoot, sources, workDirectories, watch });
  /** Compiler Host 是当前 BuildSession 唯一 Rolldown compile owner。 */
  const compiler = new CompilerHost({ projectRoot, sources, workDirectories, assets, watch });
  /** Execution Host 只运行本 Session 的 portable generated refs。 */
  const execution = new ExecutionHost({ assets, workDirectories });
  return Object.freeze({
    scope,
    workRoot,
    sources,
    workDirectories,
    watch,
    assets,
    modules,
    compiler,
    execution,
    diagnostics: new DiagnosticRegistry(),
  });
}

/** 撤销全部 capability 并删除当前 Session 中间文件。 */
export async function disposeKernelBuildEnvironment(environment: KernelBuildEnvironment): Promise<void> {
  environment.scope.close();
  await fs.rm(environment.workRoot, { recursive: true, force: true });
}
