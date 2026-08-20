/** Public Resource Provider 发现并签发静态公开文件。 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { PublicResourceFile } from '../contracts/components.js';
import type {
  SourceAssetRef,
  SourceFileRef,
} from '../contracts/services.js';
import { AssetRegistry } from '../services/assets.js';
import type { ResolvedKernelConfig, ResolvedPublicCopyRule } from '../config/resolver.js';
import { DiagnosticRegistry } from '../services/diagnostics.js';
import { compareCodePoints, safeRelativePath, sourceCollisionKey } from '../security/path-policy.js';
import { SourceRegistry } from '../services/sources.js';
import { WatchRegistry, type WatchObservation } from '../services/watch.js';

/** Public 收集阶段带完整来源 identity 的内部记录。 */
interface PublicSource {
  readonly path: string;
  readonly source: SourceFileRef;
  readonly asset: SourceAssetRef;
}

/**
 * 返回路径是否不存在。
 *
 * @param file 候选物理路径。
 * @returns ENOENT 为 true。
 */
async function missing(file: string): Promise<boolean> {
  return fs.lstat(file).then(() => false, error => (error as NodeJS.ErrnoException).code === 'ENOENT');
}

/**
 * 签发 Public source root 并递归产生映射文件。
 *
 * @param rule 当前精确 copy rule；undefined 表示全树复制。
 * @param config Kernel 私有配置。
 * @param sources Source Registry。
 * @param assets Asset Registry。
 * @param diagnostics 当前诊断集合。
 * @returns 当前来源映射产生的文件。
 */
async function collect(
  rule: ResolvedPublicCopyRule | undefined,
  config: ResolvedKernelConfig,
  sources: SourceRegistry,
  assets: AssetRegistry,
  diagnostics: DiagnosticRegistry,
): Promise<readonly PublicSource[]> {
  /** Public 资源的固定 issuer 不能由配置覆盖。 */
  const owner = 'framework:public';
  /** 精确规则优先，否则使用完整 Public directory。 */
  const source = rule?.source ?? config.public.directory;
  /** 缺省 public root 不存在时静默；显式 copy 缺失必须失败。 */
  if (await missing(source)) {
    if (rule !== undefined) {
      diagnostics.report('discover', {
        code: 'PUBLIC_SOURCE_MISSING', severity: 'error', message: 'Public copy source does not exist.',
        location: { path: path.relative(config.projectRoot, source).split(path.sep).join('/') },
      }, { owner });
    }
    return Object.freeze([]);
  }
  /** lstat 在读取前拒绝根节点自身的符号链接。 */
  const stat = await fs.lstat(source);
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
    diagnostics.report('discover', {
      code: 'PUBLIC_SOURCE_INVALID', severity: 'error', message: 'Public source must be a regular file or directory without symbolic links.',
      location: { path: path.relative(config.projectRoot, source).split(path.sep).join('/') },
    }, { owner });
    return Object.freeze([]);
  }
  /** Source Registry root 只能是目录；单文件 rule 使用其父目录作为最小授权 root。 */
  const physicalRoot = stat.isDirectory() ? source : path.dirname(source);
  /** Source Registry 只签发目录能力。 */
  let root: import('../contracts/services.js').SourceDirectoryRef;
  try {
    root = await sources.issueRoot(owner, physicalRoot);
    /** 目录 mapping 校验完整子树；单文件 mapping 不读取其未授权 siblings。 */
    if (stat.isDirectory())
      await sources.validateTree(owner, root);
  } catch {
    diagnostics.report('discover', {
      code: 'PUBLIC_SOURCE_INVALID', severity: 'error', message: 'Public source tree contains an unsafe entry.',
      location: { path: path.relative(config.projectRoot, source).split(path.sep).join('/') },
    }, { owner });
    return Object.freeze([]);
  }
  /** 后续来源访问全部绑定 framework:public owner。 */
  const sourceService = sources.service(owner);
  /** Asset 转换保留原始 Public provenance 和 mode。 */
  const assetService = assets.service(owner);
  /** 单文件映射直接签发；目录映射递归展开。 */
  const entries: { readonly file: SourceFileRef; readonly relative: string }[] = [];
  if (stat.isFile()) {
    entries.push(Object.freeze({ file: await sourceService.file(root, path.basename(source)), relative: '' }));
  } else {
    for (const entry of await sourceService.list(root, { recursive: true })) {
      if (entry.type === 'file') {
        entries.push(Object.freeze({
          file: entry.file,
          relative: entry.path.slice(`${root.path}/`.length),
        }));
      }
    }
  }
  /** target 指向文件时保持精确路径，指向目录时追加完整相对后代。 */
  const target = rule?.to ?? '';
  /** 当前 rule 的合法输出集合。 */
  const result: PublicSource[] = [];
  for (const entry of entries) {
    /** 目录来源追加后代路径，单文件来源精确使用 to。 */
    const mapped = entry.relative.length === 0
      ? target
      : target.length === 0 ? entry.relative : `${target}/${entry.relative}`;
    try {
      result.push(Object.freeze({
        path: safeRelativePath(mapped),
        source: entry.file,
        asset: await assetService.fromSource(entry.file),
      }));
    } catch {
      diagnostics.report('discover', {
        code: 'PUBLIC_TARGET_INVALID', severity: 'error', message: 'Public target must be a non-empty package-relative POSIX path.',
        location: { path: entry.file.path },
      }, { owner });
    }
  }
  return Object.freeze(result);
}

/**
 * 发现 Public exact mapping 并签发 SourceAssetRef。
 *
 * @param options 当前 BuildSession registries 与配置。
 * @returns 按 package-relative path 排序的 Public 资源。
 */
export async function discoverPublicResources(options: {
  readonly config: ResolvedKernelConfig;
  readonly sources: SourceRegistry;
  readonly assets: AssetRegistry;
  readonly watch: WatchRegistry;
  readonly diagnostics: DiagnosticRegistry;
}): Promise<readonly PublicResourceFile[]> {
  if (!options.config.public.enabled)
    return Object.freeze([]);
  /** 无 copy rules 时用 undefined sentinel 表示完整树映射。 */
  const rules = options.config.public.copy ?? [undefined];
  /** Public 来源 watch 使用每条精确 source 的最近现有目录。 */
  const observations: WatchObservation[] = [];
  for (const rule of rules) {
    /** 每条精确 source 独立寻找可观察祖先。 */
    const source = rule?.source ?? options.config.public.directory;
    /** 尚不存在的文件逐级回退到现有目录。 */
    let candidate = source;
    while (candidate !== options.config.projectRoot) {
      /** Watch root 本身也不能是作者 symlink。 */
      const stat = await fs.lstat(candidate).catch(() => undefined);
      if (stat?.isDirectory() === true && !stat.isSymbolicLink()) {
        observations.push(Object.freeze({ path: candidate, type: 'directory' as const }));
        break;
      }
      candidate = path.dirname(candidate);
    }
  }
  if (observations.length > 0)
    await options.watch.replace('framework:public', 'resource/public', observations);
  /** 独立 copy rule 可并行展开；碰撞在集中阶段确定性处理。 */
  const discovered = (await Promise.all(rules.map(rule => collect(rule, options.config, options.sources, options.assets, options.diagnostics)))).flat();
  /** 折叠目标到首次来源的索引用于稳定报告冲突。 */
  const targets = new Map<string, PublicSource>();
  /** 最终暴露给 Project Graph 的精简资源列表。 */
  const result: PublicResourceFile[] = [];
  for (const file of discovered.sort((left, right) => compareCodePoints(left.path, right.path) || compareCodePoints(left.source.path, right.source.path))) {
    /** 目标 collision key 同时折叠大小写和 Unicode NFC。 */
    const key = sourceCollisionKey(file.path);
    /** existing 用于 related location 和 add-only 冲突判定。 */
    const existing = targets.get(key);
    if (existing !== undefined) {
      options.diagnostics.report('validate', {
        code: 'PUBLIC_TARGET_COLLISION', severity: 'error', message: `Public target "${file.path}" has multiple sources.`, location: { path: file.source.path },
      }, { owner: 'framework:public', related: [{ path: existing.source.path }] });
      continue;
    }
    targets.set(key, file);
    result.push(Object.freeze({ path: file.path, asset: file.asset }));
  }
  return Object.freeze(result);
}
