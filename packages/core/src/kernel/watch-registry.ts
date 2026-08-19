import { promises as fs } from 'node:fs';
import path from 'node:path';
import { BuildSessionScope } from './build-session-scope.js';
import { compareCodePoints, isInsidePath, projectReportPath, sourceCollisionKey } from './path-policy.js';

/** Host 向唯一 Watch Registry 提交的单个物理观察。 */
export interface WatchObservation {
  readonly path: string;
  readonly type: 'file' | 'directory';
  readonly identity?: string;
  readonly pending?: boolean;
}

/** DevSession 将物理事件映射回稳定公开 identity 的已验证 observation。 */
export interface WatchSnapshotObservation {
  readonly path: string;
  readonly type: 'file' | 'directory';
  readonly identity: string;
  readonly pending: boolean;
}

/** DevSession 内部可消费的不可变 watch 快照。 */
export interface WatchSnapshot {
  readonly paths: readonly string[];
  readonly identities: readonly string[];
  readonly observations: readonly WatchSnapshotObservation[];
}

/** 单个 operation 已验证并冻结的 watch 集合。 */
interface WatchRecord {
  readonly paths: readonly string[];
  readonly identities: readonly string[];
  readonly observations: readonly WatchSnapshotObservation[];
  readonly session: object;
}

/** Watch operation 使用的稳定 ID。 */
const WATCH_OPERATION = /^[a-z0-9]+(?:[-.:/][a-z0-9]+)*$/;

/** 外部 package observation 使用的安全 identity。 */
const EXTERNAL_IDENTITY = /^package:(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+@[0-9A-Za-z.+-]+(?:\/[A-Za-z0-9._/-]+)?$/;

/**
 * 校验外部 observation 的稳定逻辑 identity。
 *
 * @param value 调用方 identity。
 * @returns 不含物理路径的 package identity。
 */
function externalIdentity(value: unknown): string {
  if (typeof value !== 'string' || !EXTERNAL_IDENTITY.test(value) || value.split('/').includes('..'))
    throw new Error('External watch observations require a safe package identity.');
  return value;
}

/** 把尚不存在的文件规范到最深已存在祖先的 realpath 基准。 */
async function canonicalPendingFile(candidate: string): Promise<string> {
  /** suffix 从目标向上积累，最终按原顺序接回真实祖先。 */
  const suffix: string[] = [];
  /** 当前候选从最终文件开始逐级寻找已存在祖先。 */
  let current = path.normalize(candidate);
  while (true) {
    /** 当前祖先的文件类型决定是否已经找到安全的真实目录基准。 */
    const stat = await fs.lstat(current).catch(() => undefined);
    if (stat !== undefined) {
      if (stat.isSymbolicLink() || !stat.isDirectory())
        throw new Error('Pending watch file must have a regular directory ancestor.');
      /** 已存在祖先进入真实路径基准后再接回全部未创建 segment。 */
      const real = await fs.realpath(current);
      return path.join(real, ...suffix.reverse());
    }
    /** 父目录用于检测文件系统根并继续向上寻找。 */
    const parent = path.dirname(current);
    if (parent === current)
      throw new Error('Pending watch file has no existing directory ancestor.');
    suffix.push(path.basename(current));
    current = parent;
  }
}

/** BuildSession 唯一、按 owner/operation 原子替换的 Watch Registry。 */
export class WatchRegistry {
  /** 当前 Session 的存活与 identity 边界。 */
  readonly #scope: BuildSessionScope;
  /** 工程真实根，用于生成公开 change identity。 */
  readonly #projectRoot: Promise<string>;
  /** owner 到 operation 再到 immutable observations 的索引。 */
  readonly #owners = new Map<string, Map<string, WatchRecord>>();

  /**
   * 创建当前 BuildSession 唯一 Watch Registry。
   *
   * @param scope 当前 Session scope。
   * @param projectRoot 工程物理根。
   */
  constructor(scope: BuildSessionScope, projectRoot: string) {
    this.#scope = scope;
    this.#projectRoot = fs.realpath(path.resolve(projectRoot));
  }

  /**
   * 原子替换一个 owner operation 的完整 observation 集。
   *
   * @param owner Kernel 固定 owner。
   * @param operation owner 内稳定 operation ID。
   * @param observations 当前操作完整依赖集合。
   */
  async replace(owner: string, operation: string, observations: readonly WatchObservation[]): Promise<void> {
    this.#scope.assertActive();
    if (typeof owner !== 'string' || owner.length === 0)
      throw new Error('Watch owner must be a non-empty string.');
    if (!WATCH_OPERATION.test(operation))
      throw new Error('Watch operation must be a stable lowercase identifier.');
    if (!Array.isArray(observations))
      throw new Error('Watch observations must be an array.');
    /** 相同 physical file 只能对应一个逻辑 identity。 */
    const entries = new Map<string, string>();
    /** realpath 后的 observation type 与 path/identity 同步保存。 */
    const entryTypes = new Map<string, WatchObservation['type']>();
    /** pending 状态决定 DevSession readiness 与首次 add 事件语义。 */
    const entryPending = new Map<string, boolean>();
    /** 相同逻辑 identity 也只能指向一个物理文件。 */
    const identityFiles = new Map<string, string>();
    /** Dev change identity 采用与输出相同的 case/NFC 歧义规则。 */
    const collisionKeys = new Map<string, string>();
    /** 系统临时目录祖先可能是 symlink，因此工程根也统一使用 realpath。 */
    const projectRoot = await this.#projectRoot;
    for (const observation of [...observations]) {
      if (typeof observation !== 'object' || observation === null
        || Object.keys(observation).some(field => field !== 'path' && field !== 'type' && field !== 'identity' && field !== 'pending')) {
        throw new Error('Watch observation must contain path, type and optional identity/pending state.');
      }
      if (typeof observation.path !== 'string' || !path.isAbsolute(observation.path) || observation.path.includes('\0'))
        throw new Error('Watch observation path must be absolute.');
      if (observation.type !== 'file' && observation.type !== 'directory')
        throw new Error('Watch observation type must be file or directory.');
      if (observation.pending !== undefined && typeof observation.pending !== 'boolean')
        throw new Error('Watch observation pending state must be boolean.');
      /** 最终路径本身不能是 symlink；package manager 的祖先链接仍被允许。 */
      const direct = await fs.lstat(observation.path).catch(() => undefined);
      /** 调用方声明 pending 但文件已出现时直接升级为普通 observation。 */
      const pending = direct === undefined && observation.pending === true;
      if (direct === undefined && !pending) {
        throw new Error(`Watch observation must reference a regular ${observation.type}.`);
      }
      if (pending && observation.type !== 'file')
        throw new Error('Only file watch observations may be pending.');
      if (direct !== undefined && (direct.isSymbolicLink()
        || (observation.type === 'file' ? !direct.isFile() : !direct.isDirectory()))) {
        throw new Error(`Watch observation must reference a regular ${observation.type}.`);
      }
      /** existing 与 pending 两条路径最终都进入真实祖先的同一规范基准。 */
      const real = pending ? await canonicalPendingFile(observation.path) : await fs.realpath(observation.path);
      if (!pending) {
        /** realpath 目标的最终普通文件状态。 */
        const stat = await fs.lstat(real).catch(() => undefined);
        if (stat === undefined || stat.isSymbolicLink()
          || (observation.type === 'file' ? !stat.isFile() : !stat.isDirectory())) {
          throw new Error(`Watch observation must reference a regular ${observation.type}.`);
        }
      }
      /** 显式 package identity 在 node_modules 位于工程内时也不能退化为物理路径。 */
      const identity = observation.identity === undefined
        ? isInsidePath(projectRoot, real)
          ? projectReportPath(projectRoot, real) || '.'
          : externalIdentity(undefined)
        : externalIdentity(observation.identity);
      /** 当前物理路径已登记的可选先前 identity。 */
      const previous = entries.get(real);
      if (previous !== undefined && previous !== identity)
        throw new Error('One watch file must not have multiple logical identities.');
      /** 一个 identity 指向多个 store copy 会让 change event 变得含糊。 */
      const previousFile = identityFiles.get(identity);
      if (previousFile !== undefined && previousFile !== real)
        throw new Error('One watch identity must not reference multiple files.');
      /** 大小写或 Unicode 归一化后相同的 identity 同样拒绝。 */
      const collision = sourceCollisionKey(identity);
      /** 当前折叠键已占用的原始 identity。 */
      const previousIdentity = collisionKeys.get(collision);
      if (previousIdentity !== undefined && previousIdentity !== identity)
        throw new Error('Watch identities contain a case or Unicode normalization collision.');
      entries.set(real, identity);
      entryTypes.set(real, observation.type);
      entryPending.set(real, pending);
      identityFiles.set(identity, real);
      collisionKeys.set(collision, identity);
    }
    /** physical file 与公开 identity 分别稳定排序。 */
    const paths = Object.freeze([...entries.keys()].sort(compareCodePoints));
    /** 对外变更 identity 去重后的稳定集合。 */
    const identities = Object.freeze([...new Set(entries.values())].sort(compareCodePoints));
    /** path/identity/type 关系由 DevSession 保留，不能退化为两个无关数组。 */
    const snapshotObservations = Object.freeze([...entries.entries()]
      .sort(([left], [right]) => compareCodePoints(left, right))
      .map(([observedPath, identity]) => Object.freeze({
        path: observedPath,
        identity,
        type: entryTypes.get(observedPath)!,
        pending: entryPending.get(observedPath)!,
      })));
    /** 当前 owner 已存在或新建的 operation map。 */
    const operations = this.#owners.get(owner) ?? new Map<string, WatchRecord>();
    operations.set(operation, Object.freeze({ paths, identities, observations: snapshotObservations, session: this.#scope.token }));
    this.#owners.set(owner, operations);
  }

  /**
   * 删除已不再存在的 owner operation watch 集。
   *
   * @param owner 当前 operation owner。
   * @param operation 稳定 operation ID。
   */
  remove(owner: string, operation: string): void {
    this.#scope.assertActive();
    this.#owners.get(owner)?.delete(operation);
  }

  /**
   * 返回当前 Session 全部 owner/operation 合并后的不可变快照。
   *
   * @returns 物理 watcher 输入和安全 change identities。
   */
  snapshot(): WatchSnapshot {
    this.#scope.assertActive();
    /** 所有有效 record 合并去重。 */
    const paths = new Set<string>();
    /** 所有公开安全 change identities 的并集。 */
    const identities = new Set<string>();
    /** 物理 path 与公开 identity/type 的完整映射。 */
    const observations = new Map<string, WatchSnapshotObservation>();
    for (const operations of this.#owners.values()) {
      for (const record of operations.values()) {
        if (record.session !== this.#scope.token)
          throw new Error('Watch observation belongs to another BuildSession.');
        for (const observedPath of record.paths)
          paths.add(observedPath);
        for (const identity of record.identities)
          identities.add(identity);
        for (const observation of record.observations) {
          /** 跨 owner operation 的相同物理路径也必须保持同一 identity/type。 */
          const previous = observations.get(observation.path);
          if (previous !== undefined && (previous.identity !== observation.identity || previous.type !== observation.type
            || previous.pending !== observation.pending))
            throw new Error('One watch file must not have multiple logical observations.');
          observations.set(observation.path, observation);
        }
      }
    }
    return Object.freeze({
      paths: Object.freeze([...paths].sort(compareCodePoints)),
      identities: Object.freeze([...identities].sort(compareCodePoints)),
      observations: Object.freeze([...observations.values()].sort((left, right) => compareCodePoints(left.path, right.path))),
    });
  }
}
