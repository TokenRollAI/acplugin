/** Resource Registry 统一分配 Core 与 Extension 作者来源根。 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AcpluginExtension } from '../contracts/integrations.js';
import type { SourceDirectoryRef } from '../contracts/services.js';
import { DiagnosticRegistry } from '../services/diagnostics.js';
import { compareCodePoints } from '../security/path-policy.js';
import { SourceRegistry } from '../services/sources.js';
import { WatchRegistry } from '../services/watch.js';
import type { ResolvedKernelConfig } from '../config/resolver.js';

/** Framework 内建来源根名称。 */
export type CanonicalResourceRoot = 'commands' | 'skills' | 'agents';

/** Resource Registry 完成 root 所有权分配后的不可变集合。 */
export interface ResourceClaims {
  readonly canonical: Readonly<Partial<Record<CanonicalResourceRoot, SourceDirectoryRef>>>;
  readonly runtime?: SourceDirectoryRef;
  readonly extensions: Readonly<Record<string, Readonly<Record<string, SourceDirectoryRef>>>>;
}

/** root claim 的内部 owner 记录。 */
interface RootClaim {
  readonly owner: string;
  readonly kind: 'canonical' | 'runtime' | 'extension';
  readonly extension?: AcpluginExtension;
}

/**
 * 为所有已配置 Extension 建立稳定、不可变的 root snapshot。
 *
 * @param extensions 已配置 Extension definitions。
 * @param discovered 已发现的可选 root records。
 * @returns 按 Extension ID 排序且不暴露可变 Map 的 plain-data record。
 */
function extensionClaims(
  extensions: readonly AcpluginExtension[],
  discovered: ReadonlyMap<string, Readonly<Record<string, SourceDirectoryRef>>> = new Map(),
): Readonly<Record<string, Readonly<Record<string, SourceDirectoryRef>>>> {
  return Object.freeze(Object.fromEntries(
    [...extensions]
      .sort((left, right) => compareCodePoints(left.id, right.id))
      .map(extension => [extension.id, Object.freeze({ ...(discovered.get(extension.id) ?? {}) })]),
  ));
}

/**
 * 判断目录是否存在任何直接或后代内容。
 *
 * @param directory 未被 claim 的候选目录。
 * @returns 空目录为 false，首个后代存在即为 true。
 */
async function hasContent(directory: string): Promise<boolean> {
  /** 一级存在任意目录项即可证明 root 并非无意留下的空目录。 */
  const entries = await fs.readdir(directory, { withFileTypes: true });
  if (entries.length === 0)
    return false;
  return true;
}

/**
 * 返回待观察路径的最近现有普通目录。
 *
 * @param projectRoot 工程根。
 * @param desired 可能尚不存在的来源目录。
 * @returns Dev watcher 可以实际注册的工程内目录。
 */
async function nearestExistingDirectory(projectRoot: string, desired: string): Promise<string> {
  /** 从目标向工程根回溯，确保空/缺失 root 仍可触发 rebuild。 */
  let candidate = desired;
  while (candidate !== projectRoot) {
    /** lstat 避免把 symlink 祖先登记为可信 Watch root。 */
    const stat = await fs.lstat(candidate).catch(() => undefined);
    if (stat?.isDirectory() === true && !stat.isSymbolicLink())
      return candidate;
    candidate = path.dirname(candidate);
  }
  return projectRoot;
}

/** BuildSession 中唯一的 source-root ownership registry。 */
export class ResourceRegistry {
  /** Kernel 私有最终配置。 */
  readonly #config: ResolvedKernelConfig;
  /** 当前 Session SourceRef issuer。 */
  readonly #sources: SourceRegistry;
  /** 当前 Session Watch Registry。 */
  readonly #watch: WatchRegistry;
  /** 当前 Session 稳定诊断集合。 */
  readonly #diagnostics: DiagnosticRegistry;

  /**
   * 创建 Resource Registry。
   *
   * @param options 当前 BuildSession 依赖。
   */
  constructor(options: {
    readonly config: ResolvedKernelConfig;
    readonly sources: SourceRegistry;
    readonly watch: WatchRegistry;
    readonly diagnostics: DiagnosticRegistry;
  }) {
    this.#config = options.config;
    this.#sources = options.sources;
    this.#watch = options.watch;
    this.#diagnostics = options.diagnostics;
  }

  /**
   * 建立内建与 Extension root claims 并拒绝未知内容。
   *
   * @returns 只包含当前实际存在目录的不可变 SourceRef 集合。
   */
  async claim(): Promise<ResourceClaims> {
    /** 所有声明在接触文件系统前先完成冲突检查。 */
    const claims = new Map<string, RootClaim>();
    for (const root of ['commands', 'skills', 'agents'] as const)
      claims.set(root, Object.freeze({ owner: 'framework:canonical', kind: 'canonical' as const }));
    if (this.#config.runtime.enabled)
      claims.set('runtime', Object.freeze({ owner: 'framework:node-runtime', kind: 'runtime' as const }));
    for (const extension of [...this.#config.extensions].sort((left, right) => compareCodePoints(left.id, right.id))) {
      for (const root of extension.resourceRoots) {
        /** 第一个 claim 固定 owner，后续同名声明只产生诊断。 */
        const existing = claims.get(root);
        if (existing !== undefined) {
          this.#diagnostics.report('setup', {
            code: 'RESOURCE_ROOT_CONFLICT',
            severity: 'error',
            message: `Source root "${root}" is claimed by both ${existing.owner} and extension:${extension.id}.`,
            location: { path: `${path.relative(this.#config.projectRoot, this.#config.srcDirectory).split(path.sep).join('/')}/${root}` },
          });
          continue;
        }
        claims.set(root, Object.freeze({ owner: `extension:${extension.id}`, kind: 'extension' as const, extension }));
      }
    }

    /** srcDir 不存在时观察最近祖先并返回空资源图。 */
    const srcStat = await fs.lstat(this.#config.srcDirectory).catch(() => undefined);
    /** Watch Registry 接收实际存在的最近目录而非虚构路径。 */
    const watchedSource = await nearestExistingDirectory(this.#config.projectRoot, this.#config.srcDirectory);
    await this.#watch.replace('framework:resource', 'resource/src', [{ path: watchedSource, type: 'directory' }]);
    if (srcStat === undefined)
      return Object.freeze({ canonical: Object.freeze({}), extensions: extensionClaims(this.#config.extensions) });
    if (!srcStat.isDirectory() || srcStat.isSymbolicLink()) {
      this.#diagnostics.report('discover', {
        code: 'SOURCE_ROOT_INVALID', severity: 'error', message: 'srcDir must be a regular directory without symbolic links.',
        location: { path: path.relative(this.#config.projectRoot, this.#config.srcDirectory).split(path.sep).join('/') },
      });
      return Object.freeze({ canonical: Object.freeze({}), extensions: extensionClaims(this.#config.extensions) });
    }
    /** framework owner 用于安全枚举 srcDir 一级目录。 */
    let sourceRoot: SourceDirectoryRef;
    try {
      sourceRoot = await this.#sources.issueRoot('framework:resource', this.#config.srcDirectory);
    } catch {
      this.#diagnostics.report('discover', {
        code: 'SOURCE_ROOT_INVALID', severity: 'error', message: 'srcDir failed the author source boundary.',
        location: { path: path.relative(this.#config.projectRoot, this.#config.srcDirectory).split(path.sep).join('/') },
      });
      return Object.freeze({ canonical: Object.freeze({}), extensions: extensionClaims(this.#config.extensions) });
    }
    /** 一级枚举通用拒绝 symlink/special/collision。 */
    let entries: Awaited<ReturnType<ReturnType<SourceRegistry['service']>['list']>>;
    try {
      entries = await this.#sources.service('framework:resource').list(sourceRoot);
    } catch {
      this.#diagnostics.report('discover', {
        code: 'SOURCE_ROOT_CONTENT_INVALID', severity: 'error', message: 'srcDir contains an unsafe or ambiguous source entry.',
        location: { path: sourceRoot.path },
      });
      return Object.freeze({ canonical: Object.freeze({}), extensions: extensionClaims(this.#config.extensions) });
    }
    /** 各 owner 最终实际存在的 root refs。 */
    const canonical: Partial<Record<CanonicalResourceRoot, SourceDirectoryRef>> = {};
    /** Extension ID 到其现有 root refs。 */
    const extensionRoots = new Map<string, Record<string, SourceDirectoryRef>>();
    /** 当前可选 Runtime root。 */
    let runtime: SourceDirectoryRef | undefined;
    for (const entry of entries) {
      /** 一级名称直接映射到此前完成冲突校验的 claim。 */
      const claim = claims.get(entry.name);
      if (entry.type === 'file') {
        this.#diagnostics.report('discover', {
          code: 'RESOURCE_ROOT_UNKNOWN', severity: 'error', message: `srcDir direct file "${entry.name}" has no Resource owner.`, location: { path: entry.path },
        });
        continue;
      }
      if (claim === undefined) {
        if (await hasContent(path.join(this.#config.srcDirectory, entry.name))) {
          this.#diagnostics.report('discover', {
            code: 'RESOURCE_ROOT_UNKNOWN', severity: 'error', message: `Non-empty source root "${entry.name}" has no configured Resource owner.`, location: { path: entry.path },
          });
        }
        continue;
      }
      /** 每个 Resource owner 收到以自身身份签发的独占 root ref。 */
      try {
        /** 物理 root 永远由最终 srcDirectory 和直接子目录组成。 */
        const physical = path.join(this.#config.srcDirectory, entry.name);
        /** Source Registry 使用 owner+Session 身份签发 root。 */
        const root = await this.#sources.issueRoot(claim.owner, physical);
        await this.#sources.validateTree(claim.owner, root);
        if (claim.kind === 'canonical')
          canonical[entry.name as CanonicalResourceRoot] = root;
        else if (claim.kind === 'runtime')
          runtime = root;
        else {
          /** Extension ID 是最终 roots snapshot 的第一层稳定键。 */
          const id = claim.extension!.id;
          /** 同一 Extension 可声明多个互不重叠的一级 root。 */
          const roots = extensionRoots.get(id) ?? {};
          roots[entry.name] = root;
          extensionRoots.set(id, roots);
        }
      } catch {
        this.#diagnostics.report('discover', {
          code: 'RESOURCE_ROOT_CONTENT_INVALID', severity: 'error', message: `Source root "${entry.name}" contains an unsafe entry.`, location: { path: entry.path },
        });
      }
    }
    /** 即使某 Extension root 缺失，也用冻结空对象保留 Extension ID 的稳定索引。 */
    return Object.freeze({
      canonical: Object.freeze({ ...canonical }),
      ...(runtime === undefined ? {} : { runtime }),
      extensions: extensionClaims(this.#config.extensions, extensionRoots),
    });
  }
}
