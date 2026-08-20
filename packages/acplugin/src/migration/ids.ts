import path from 'node:path';

/** 规范 Component ID 接受的小写 kebab-case 格式。 */
export const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** 按 UTF-16 code unit 比较迁移报告与生成输入，不依赖宿主 locale/ICU。 */
export function compareCodeUnits(left: string, right: string): number {
  if (left === right)
    return 0;
  return left < right ? -1 : 1;
}

/** 生成旧工程内用于报告的 POSIX 相对路径。 */
export function relative(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join('/');
}

/** 把任意旧资源名称收敛为规范 Component ID。 */
export function safeId(value: string): string {
  /** 移除不支持字符并压缩分隔符后的候选 ID。 */
  const id = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return id || 'migrated-item';
}

/** 尚未分配最终 ID 的单个迁移资源及其稳定来源身份。 */
export interface MigrationIdCandidate<T> {
  readonly value: T;
  readonly baseId: string;
  readonly sourcePath: string;
}

/** 已获得唯一最终 ID 的迁移资源。 */
export interface AllocatedMigrationId<T> extends MigrationIdCandidate<T> {
  readonly id: string;
}

/** 为一个资源类别整体分配确定 ID，先保留显式 base 再选择未占用后缀。 */
export function allocateMigrationIds<T>(candidates: readonly MigrationIdCandidate<T>[]): AllocatedMigrationId<T>[] {
  /** 所有候选显式拥有的 base ID；冲突项不得抢占这些名称。 */
  const reserved = new Set(candidates.map(candidate => candidate.baseId));
  /** 已实际分配给前序候选的最终 ID。 */
  const assigned = new Set<string>();
  /** 每个 base 下一次尝试的数字后缀。 */
  const nextSuffix = new Map<string, number>();
  /** 与发现顺序无关的候选处理顺序。 */
  const ordered = [...candidates].sort((left, right) =>
    compareCodeUnits(left.baseId, right.baseId)
    || compareCodeUnits(left.sourcePath, right.sourcePath));
  /** 完成 winner/后缀选择后再按最终 ID 固定写入与报告顺序。 */
  const allocated = ordered.map((candidate) => {
    /** 当前候选优先使用的 base，冲突时再选择数字后缀。 */
    let id = candidate.baseId;
    if (assigned.has(id)) {
      /** 从 `-2` 开始且会跨候选记忆的当前后缀。 */
      let suffix = nextSuffix.get(candidate.baseId) ?? 2;
      do {
        id = `${candidate.baseId}-${suffix}`;
        suffix += 1;
      } while (reserved.has(id) || assigned.has(id));
      nextSuffix.set(candidate.baseId, suffix);
    }
    assigned.add(id);
    return { ...candidate, id };
  });
  return allocated.sort((left, right) =>
    compareCodeUnits(left.id, right.id)
    || compareCodeUnits(left.sourcePath, right.sourcePath));
}
