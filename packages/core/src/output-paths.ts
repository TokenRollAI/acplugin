import path from 'node:path';

/** 输出路径占用记录的来源类别。 */
export type OutputPathKind = 'document' | 'artifact';

/** 已被某个所有者占用的规范输出路径。 */
export interface OutputPathReservation {
  readonly path: string;
  readonly owner: string;
  readonly kind: OutputPathKind;
}

/**
 * 将产物路径规范化为安全、稳定的 POSIX 相对路径。
 *
 * @param value Platform 或 Extension 提供的目标路径。
 * @returns 经过分隔符、逃逸和 Unicode 检查的 NFC 路径。
 */
export function normalizeOutputPath(value: string): string {
  if (typeof value !== 'string' || value === '')
    throw new Error('Output path must be a non-empty string.');
  if (value.includes('\\'))
    throw new Error(`Output path must use POSIX separators: ${value}`);
  if (value.includes('\0'))
    throw new Error('Output path must not contain NUL bytes.');
  if (path.posix.isAbsolute(value))
    throw new Error(`Output path must be relative: ${value}`);
  if (value.split('/').includes('..'))
    throw new Error(`Output path escapes its root through a parent-directory segment: ${value}`);
  /** 折叠点片段并统一 Unicode 组合形式后的最终路径。 */
  const normalized = path.posix.normalize(value).normalize('NFC');
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../'))
    throw new Error(`Output path escapes the DeliveryUnit root: ${value}`);
  return normalized;
}

/**
 * 生成跨大小写和 Unicode 归一化文件系统使用的路径冲突键。
 *
 * @param value 已规范化的 POSIX 输出路径。
 * @returns 按路径片段折叠后的稳定冲突键。
 */
function collisionKey(value: string): string {
  return value.split('/')
    .map(segment => segment.normalize('NFC').toLocaleLowerCase('en-US'))
    .join('/');
}

/** 管理一个 Draft 或 DeliveryUnit 中全部文件路径的唯一占用关系。 */
export class OutputPathRegistry {
  /** 以跨文件系统冲突键索引的路径占用记录。 */
  readonly #reservations = new Map<string, OutputPathReservation>();

  /**
   * 验证并占用一个文件路径。
   *
   * @param owner Platform 或 Extension 的稳定所有者。
   * @param kind Document 或普通 Artifact。
   * @param value 未经校验的相对输出路径。
   * @returns 已规范化并冻结的占用记录。
   */
  reserve(owner: string, kind: OutputPathKind, value: string): OutputPathReservation {
    if (typeof owner !== 'string' || owner.trim() === '')
      throw new Error('Output owner must be a non-empty string.');
    /** 经过路径边界和 Unicode 规范化的文件路径。 */
    const outputPath = normalizeOutputPath(value);
    /** 用于跨平台冲突和文件/目录前缀检查的比较键。 */
    const key = collisionKey(outputPath);
    for (const [existingKey, existing] of this.#reservations) {
      if (key === existingKey) {
        throw new Error(`Output path collision between ${existing.kind} "${existing.path}" owned by "${existing.owner}" and ${kind} "${outputPath}" owned by "${owner}".`);
      }
      if (key.startsWith(`${existingKey}/`) || existingKey.startsWith(`${key}/`)) {
        throw new Error(`Output file/directory conflict between "${existing.path}" and "${outputPath}".`);
      }
    }
    /** 成功占用后保存的不可变路径记录。 */
    const reservation = Object.freeze({ path: outputPath, owner, kind });
    this.#reservations.set(key, reservation);
    return reservation;
  }

  /**
   * 释放一次尚未完成内容验证的路径占用。
   *
   * @param value reserve 返回的规范路径。
   */
  release(value: string): void {
    this.#reservations.delete(collisionKey(value));
  }
}
