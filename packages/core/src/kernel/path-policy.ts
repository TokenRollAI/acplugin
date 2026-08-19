import { promises as fs } from 'node:fs';
import path from 'node:path';

/** 被授权路径的已验证普通文件或目录类型。 */
export type SafeEntryType = 'file' | 'directory';

/**
 * 按 Unicode code point 比较文本，不依赖 locale 或 ICU 排序规则。
 *
 * @param left 左侧文本。
 * @param right 右侧文本。
 * @returns 与 Array.sort 约定一致的比较结果。
 */
export function compareCodePoints(left: string, right: string): number {
  /** 两侧文本的 Unicode code point 序列。 */
  const leftPoints = [...left].map(character => character.codePointAt(0)!);
  /** 右侧文本的 Unicode code point 序列。 */
  const rightPoints = [...right].map(character => character.codePointAt(0)!);
  /** 两个序列共同拥有的可比较长度。 */
  const sharedLength = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < sharedLength; index += 1) {
    if (leftPoints[index] !== rightPoints[index])
      return leftPoints[index]! < rightPoints[index]! ? -1 : 1;
  }
  if (leftPoints.length === rightPoints.length)
    return 0;
  return leftPoints.length < rightPoints.length ? -1 : 1;
}

/**
 * 验证 Integration 提交的 project-relative POSIX 路径。
 *
 * @param value 未知路径文本。
 * @param options 是否允许用空字符串表达当前目录。
 * @returns 未经静默折叠或 Unicode 改写的原始安全路径。
 */
export function safeRelativePath(value: unknown, options: { readonly allowEmpty?: boolean } = {}): string {
  if (typeof value !== 'string' || (value.length === 0 && options.allowEmpty !== true))
    throw new Error('Relative path must be a non-empty string.');
  if (value.length === 0)
    return value;
  if (value.includes('\\'))
    throw new Error('Relative path must use POSIX separators.');
  if (value.includes('\0'))
    throw new Error('Relative path must not contain NUL bytes.');
  if (path.posix.isAbsolute(value))
    throw new Error('Relative path must not be absolute.');
  /** 原始 segment 逐项拒绝，避免 normalize 静默接受模糊输入。 */
  const segments = value.split('/');
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..'))
    throw new Error('Relative path must not contain empty, dot, or parent-directory segments.');
  return value;
}

/**
 * 判断候选路径是否位于指定根内或与根相同。
 *
 * @param root 已规范化的绝对根目录。
 * @param candidate 待验证绝对路径。
 * @returns 候选未通过父目录或盘符逃逸时返回 true。
 */
export function isInsidePath(root: string, candidate: string): boolean {
  /** path.relative 能正确区分具有相同文本前缀的兄弟目录。 */
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

/**
 * 生成跨大小写和 Unicode NFC 文件系统的路径冲突键。
 *
 * @param value 安全 project-relative POSIX 路径。
 * @returns 逐 segment NFC 与小写折叠后的比较键。
 */
export function sourceCollisionKey(value: string): string {
  return value.split('/').map(segment => segment.normalize('NFC').toLowerCase()).join('/');
}

/** Author source 树中 exact/case/NFC 路径的内部唯一性索引。 */
export class SourcePathCollisionRegistry {
  /** 折叠后的路径键到首次来源的映射。 */
  readonly #entries = new Map<string, { readonly path: string; readonly identity: string }>();

  /**
   * 登记一个安全报告路径。
   *
   * @param reportPath 工程相对 POSIX 路径。
   * @param identity 对应物理来源的内部唯一身份。
   */
  reserve(reportPath: string, identity: string): void {
    /** 大小写与 NFC 折叠后的键用于模拟最严格目标文件系统。 */
    const key = sourceCollisionKey(reportPath);
    /** 同一物理来源重复签发合法，两个不同来源折叠到同一键则失败。 */
    const existing = this.#entries.get(key);
    if (existing !== undefined && existing.identity !== identity)
      throw new Error(`Author source path collision between "${existing.path}" and "${reportPath}".`);
    this.#entries.set(key, Object.freeze({ path: reportPath, identity }));
  }
}

/**
 * 验证根目录后代的每个路径层级均不是符号链接，并检查最终类型。
 *
 * @param physicalRoot 已解析且可信的物理根。
 * @param candidate 根内候选绝对路径。
 * @param type 期望的最终类型。
 * @returns 最终路径的 lstat 结果。
 */
export async function validatePhysicalEntry(
  physicalRoot: string,
  candidate: string,
  type: SafeEntryType,
): Promise<import('node:fs').Stats> {
  if (!path.isAbsolute(physicalRoot) || !path.isAbsolute(candidate) || !isInsidePath(physicalRoot, candidate))
    throw new Error('Authorized source path escapes its physical root.');
  /** 根后每个后代 segment 都必须逐级 lstat。 */
  const segments = path.relative(physicalRoot, candidate).split(path.sep).filter(Boolean);
  /** 当前待 lstat 的逐级物理路径。 */
  let current = physicalRoot;
  for (const segment of segments) {
    current = path.join(current, segment);
    /** lstat 不跟随 symlink，确保逃逸在 realpath 前被拒绝。 */
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink())
      throw new Error('Author source trees must not contain symbolic links.');
    if (current !== candidate && !stat.isDirectory())
      throw new Error('Author source path contains a non-directory ancestor.');
  }
  /** 根本身或最终后代的准确文件类型。 */
  const finalStat = segments.length === 0 ? await fs.lstat(physicalRoot) : await fs.lstat(candidate);
  if (finalStat.isSymbolicLink())
    throw new Error('Author source trees must not contain symbolic links.');
  if ((type === 'file' && !finalStat.isFile()) || (type === 'directory' && !finalStat.isDirectory()))
    throw new Error(`Author source must be a regular ${type}.`);
  /** realpath 在 lstat 后复核最终解析位置仍位于根内。 */
  /** 宿主临时根的祖先可能自身是系统 symlink，因此比较双方 realpath。 */
  const realRoot = await fs.realpath(physicalRoot);
  /** 候选最终解析位置必须仍位于同一真实根内。 */
  const real = await fs.realpath(candidate);
  if (!isInsidePath(realRoot, real))
    throw new Error('Author source realpath escapes its physical root.');
  return finalStat;
}

/**
 * 把工程内绝对路径转换为安全、POSIX 且不含绝对前缀的报告路径。
 *
 * @param projectRoot 工程绝对根。
 * @param candidate 工程内绝对路径。
 * @returns project-relative POSIX 路径。
 */
export function projectReportPath(projectRoot: string, candidate: string): string {
  if (!isInsidePath(projectRoot, candidate))
    throw new Error('Source path is outside the project root.');
  /** path.relative 输出转换为平台无关的 POSIX 分隔符。 */
  return path.relative(projectRoot, candidate).split(path.sep).join('/');
}
