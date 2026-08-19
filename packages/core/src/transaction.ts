import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import type { PackageUnitSnapshot } from './kernel-types.js';
import { AssetRegistry } from './kernel/asset-registry.js';
import {
  compareCodePoints,
  isInsidePath,
  sourceCollisionKey,
  validatePhysicalEntry,
} from './kernel/path-policy.js';
import { materializePackageUnits, scanPhysicalTree, validatePackageUnits } from './package/candidate-materializer.js';

/** 受管输出事务可观测的稳定阶段名称。 */
export type ManagedOutputPhase
  = | 'lock-acquired'
    | 'recovery-complete'
    | 'stage-materialized'
    | 'stage-validated'
    | 'transaction-written'
    | 'backup-created'
    | 'output-swapped';

/** 完整构建替换所有输出；显式 subset 只替换所选 Platform。 */
export type ManagedOutputScope = {
  readonly type: 'full';
} | {
  readonly type: 'subset';
  readonly platforms: readonly string[];
};

/** Package Unit 集合原子提交选项。 */
export interface CommitPackageUnitsOptions {
  /** outDir 必须严格位于该工程根内部。 */
  readonly projectRoot: string;
  /** 默认 full；subset 会在 stage 中保留未选 Platform 的既有输出。 */
  readonly scope?: ManagedOutputScope;
  /**
   * 在事务进入关键阶段时调用，用于内部观测和 fault injection。
   *
   * @param phase 已经完成的事务阶段。
   */
  readonly onPhase?: (phase: ManagedOutputPhase) => void | Promise<void>;
  /** swap 后、删除 rollback backup 前执行的 Core 收尾。 */
  readonly afterSwap?: () => void | Promise<void>;
}

/** 既有未选 Platform 中一个普通文件的稳定快照。 */
interface PreservedFile {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly mode: 0o644 | 0o755;
  readonly size: number;
  readonly sha256: string;
}

/** 一个未选 Platform 的完整旧输出快照。 */
interface PreservedPlatform {
  readonly id: string;
  readonly directories: readonly string[];
  readonly files: readonly PreservedFile[];
}

/** 崩溃恢复所需的最小 rollback record。 */
interface TransactionRecord {
  readonly schemaVersion: 2;
  readonly outDir: string;
  readonly scope: ManagedOutputScope['type'];
  readonly hadOutput: boolean;
}

/** 独占锁完整发布后才允许出现的 owner record。 */
interface ManagedOutputLockRecord {
  readonly schemaVersion: 3;
  readonly pid: number;
  readonly token: string;
}

/** 读取锁时同时保留精确字节，供无 CAS 删除前复核。 */
interface ManagedOutputLockObservation {
  readonly bytes: string;
  readonly metadata: ManagedOutputLockMetadata;
  readonly record?: ManagedOutputLockRecord;
}

/** 路径观察的稳定 inode 与内容 metadata。 */
interface ManagedOutputLockMetadata {
  readonly device: bigint;
  readonly inode: bigint;
  readonly mode: bigint;
  readonly size: bigint;
  readonly modified: bigint;
  readonly changed: bigint;
  readonly created: bigint;
}

/** 锁路径元数据操作使用的唯一、可精确清理 guard。 */
interface ManagedOutputLockGuard {
  readonly path: string;
  readonly pid: number;
  readonly token: string;
}

/** 未完成 marker 只允许存在于这个固定、可恢复的临时后缀。 */
const MARKER_WRITING_SUFFIX = '.writing';

/** 当前进程仍实际持有的 token；清理失败后的同 PID record 不再视为活锁。 */
const ACTIVE_LOCK_TOKENS = new Set<string>();

/** 当前进程正在发布或持有的 lock-metadata guard token。 */
const ACTIVE_LOCK_GUARD_TOKENS = new Set<string>();

/** Platform 和 Unit ID 使用的稳定 lowercase-kebab 规则。 */
const STABLE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

/** randomUUID 的稳定小写文本形态，避免任意 lock 内容进入 owner 判断。 */
const LOCK_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/** 旧 create→write malformed lock 在隔离前必须保持不变的有界观察窗口。 */
const LEGACY_LOCK_STABILITY_DELAY_MS = 25;

/** 关闭当前调用独占的 handle；瞬时失败时再尝试一次，避免泄漏描述符。 */
async function closeOwnedFile(handle: FileHandle): Promise<void> {
  try {
    await handle.close();
  } catch (firstError) {
    try {
      await handle.close();
    } catch {
      throw firstError;
    }
  }
}

/** 删除永不复用或由 metadata guard 保护的自有路径；瞬时失败时安全重试。 */
async function removeOwnedPath(file: string): Promise<void> {
  try {
    await fs.rm(file, { force: true });
  } catch (firstError) {
    try {
      await fs.rm(file, { force: true });
    } catch {
      throw firstError;
    }
  }
}

/** @returns 路径是否存在；ENOENT 以外错误仍按不存在处理到后续操作。 */
async function exists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

/** 从 bigint lstat 提取锁恢复需要比较的稳定 metadata。 */
function managedOutputLockMetadata(stat: BigIntStats): ManagedOutputLockMetadata {
  return Object.freeze({
    device: stat.dev,
    inode: stat.ino,
    mode: stat.mode,
    size: stat.size,
    modified: stat.mtimeNs,
    changed: stat.ctimeNs,
    created: stat.birthtimeNs,
  });
}

/** @returns 两次路径观察是否仍指向同一份未变化内容。 */
function sameManagedOutputLockMetadata(
  left: ManagedOutputLockMetadata,
  right: ManagedOutputLockMetadata,
): boolean {
  return left.device === right.device && left.inode === right.inode && left.mode === right.mode
    && left.size === right.size && left.modified === right.modified && left.changed === right.changed
    && left.created === right.created;
}

/** @returns rename 后的路径是否仍是首次观察的同一个 inode。 */
function sameManagedOutputLockInode(
  left: ManagedOutputLockMetadata,
  right: ManagedOutputLockMetadata,
): boolean {
  return left.device === right.device && left.inode === right.inode && left.created === right.created;
}

/** 读取一个完整锁记录；旧版或截断内容作为可隔离的 malformed observation。 */
async function readManagedOutputLock(file: string): Promise<ManagedOutputLockObservation> {
  /** 锁绝不能借助 symlink 或特殊文件影响同级输出。 */
  const pathBefore = await fs.lstat(file, { bigint: true });
  if (pathBefore.isSymbolicLink() || !pathBefore.isFile())
    throw new Error('Managed output lock must be a regular file.');
  /** FileHandle 把 metadata 与字节绑定到同一 inode，避免 path read 的替换竞态。 */
  const handle = await fs.open(file, 'r');
  /** handle 读取的精确锁字节。 */
  let bytes: string;
  /** handle 读取完成后的稳定 metadata。 */
  let metadata: ManagedOutputLockMetadata;
  try {
    /** open 前后的 inode 必须仍与首次 lstat 一致，且不能变成特殊文件。 */
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()
      || !sameManagedOutputLockMetadata(managedOutputLockMetadata(pathBefore), managedOutputLockMetadata(before)))
      throw new Error('Managed output lock changed while it was being observed.');
    /** 精确原始字节用于隔离时确认没有搬走另一个 writer 的新记录。 */
    bytes = await handle.readFile({ encoding: 'utf8' });
    /** handle 与当前路径在读取后必须仍指向同一份未变化内容。 */
    const after = await handle.stat({ bigint: true });
    /** 当前路径的最终 metadata 用于确认没有 replacement。 */
    const pathAfter = await fs.lstat(file, { bigint: true });
    metadata = managedOutputLockMetadata(after);
    if (!sameManagedOutputLockMetadata(managedOutputLockMetadata(before), metadata)
      || !sameManagedOutputLockMetadata(metadata, managedOutputLockMetadata(pathAfter)))
      throw new Error('Managed output lock changed while it was being observed.');
  } finally {
    await closeOwnedFile(handle);
  }
  try {
    /** 未验证 JSON 只在当前函数局部存在。 */
    const value: unknown = JSON.parse(bytes);
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      return Object.freeze({ bytes, metadata });
    /** schema 3 只允许 pid/token/schemaVersion 三个固定字段。 */
    const record = value as Record<string, unknown>;
    if (Object.keys(record).sort(compareCodePoints).join(',') !== 'pid,schemaVersion,token'
      || record.schemaVersion !== 3 || !Number.isSafeInteger(record.pid) || Number(record.pid) <= 0
      || typeof record.token !== 'string' || !LOCK_TOKEN.test(record.token)) {
      return Object.freeze({ bytes, metadata });
    }
    return Object.freeze({
      bytes,
      metadata,
      record: Object.freeze({ schemaVersion: 3, pid: Number(record.pid), token: record.token }),
    });
  } catch {
    return Object.freeze({ bytes, metadata });
  }
}

/** @returns 已验证 PID 是否仍对应一个可见进程。 */
function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    /** EPERM 同样证明进程存在，只是当前调用者无权发送信号。 */
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** 从 lock sibling 名称读取唯一 guard 的 PID、token 和发布状态。 */
function parseManagedOutputLockGuard(
  lockFile: string,
  name: string,
): (ManagedOutputLockGuard & { readonly draft: boolean }) | undefined {
  /** guard 名称只匹配当前 outDir 的精确 lock basename。 */
  const prefix = `${path.basename(lockFile)}.guard.`;
  if (!name.startsWith(prefix))
    return undefined;
  /** writing 后缀表示完整 record 尚未原子发布。 */
  const draft = name.endsWith('.writing');
  /** 剩余部分固定为 pid.token，UUID 不包含点号。 */
  const identity = name.slice(prefix.length, draft ? -'.writing'.length : undefined);
  /** 第一个点号稳定分隔十进制 PID 与 UUID token。 */
  const separator = identity.indexOf('.');
  if (separator <= 0)
    return undefined;
  /** PID 来自名称即可在部分 draft 上判断 owner 是否仍存活。 */
  const pidText = identity.slice(0, separator);
  /** token 使路径永不被另一个正常调用复用。 */
  const token = identity.slice(separator + 1);
  /** 数值 PID 必须保持在 JavaScript 精确整数范围内。 */
  const pid = Number(pidText);
  if (!/^[1-9][0-9]*$/u.test(pidText) || !Number.isSafeInteger(pid) || pid <= 0 || !LOCK_TOKEN.test(token))
    return undefined;
  /** 绝对 guard 路径只由受管 lock 同级名称组合。 */
  const guardPath = path.join(path.dirname(lockFile), name);
  return Object.freeze({ path: guardPath, pid, token, draft });
}

/** 发布一个唯一 guard；并发调用互不覆盖，进程崩溃后路径仍可精确回收。 */
async function publishManagedOutputLockGuard(lockFile: string): Promise<ManagedOutputLockGuard> {
  /** 名称中的 PID/token 允许在 draft 尚不完整时判断 owner。 */
  const pid = process.pid;
  /** 每个 guard 路径在所有正常调用间永久唯一。 */
  const token = randomUUID();
  /** 最终 guard record 只在完整写入后通过 hard link 出现。 */
  const finalPath = `${lockFile}.guard.${pid}.${token}`;
  /** 同级唯一 draft 不参与互斥，owner identity 已在文件名中。 */
  const draftPath = `${finalPath}.writing`;
  ACTIVE_LOCK_GUARD_TOKENS.add(token);
  try {
    /** draft 从创建起保持私有普通文件。 */
    const handle = await fs.open(draftPath, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify({ schemaVersion: 3, pid, token })}\n`);
      await handle.sync();
    } finally {
      await closeOwnedFile(handle);
    }
    /** 唯一 final path 仍使用 no-replace 发布，避免任何路径覆盖。 */
    await fs.link(draftPath, finalPath);
    await removeOwnedPath(draftPath);
    return Object.freeze({ path: finalPath, pid, token });
  } catch (error) {
    /** 发布失败只清理当前唯一 identity 的两个路径。 */
    await removeOwnedPath(finalPath).catch(() => undefined);
    await removeOwnedPath(draftPath).catch(() => undefined);
    ACTIVE_LOCK_GUARD_TOKENS.delete(token);
    throw error;
  }
}

/** @returns guard 是否仍由一个实际存活的调用持有或发布。 */
function managedOutputLockGuardIsLive(guard: ManagedOutputLockGuard): boolean {
  if (guard.pid === process.pid)
    return ACTIVE_LOCK_GUARD_TOKENS.has(guard.token);
  return processIsAlive(guard.pid);
}

/** 精确释放当前唯一 guard，失败残留由下一次扫描按同一路径回收。 */
async function releaseManagedOutputLockGuard(guard: ManagedOutputLockGuard): Promise<void> {
  try {
    await removeOwnedPath(guard.path);
  } finally {
    ACTIVE_LOCK_GUARD_TOKENS.delete(guard.token);
  }
}

/**
 * 获取 lock path 元数据互斥权。
 *
 * 每个竞争者先发布自己的唯一 intent，再扫描所有 intent；晚到者一定能看到仍在
 * 临界区内的早到者。竞争同时发生时允许双方短暂退避，但绝不允许双方进入。
 */
async function acquireManagedOutputLockGuard(lockFile: string): Promise<ManagedOutputLockGuard> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    /** 当前 attempt 使用全新 identity，旧 attempt 路径不会被复用。 */
    const own = await publishManagedOutputLockGuard(lockFile);
    /** 是否存在另一个仍在发布或持有的 guard。 */
    let conflict = false;
    try {
      /** 目录快照足以建立互斥：任何快照后的新 guard 都必须看到 own。 */
      const names = (await fs.readdir(path.dirname(lockFile))).sort(compareCodePoints);
      for (const name of names) {
        /** 非当前 lock 的普通 sibling 与 transaction helper 不参与 guard 协议。 */
        const candidate = parseManagedOutputLockGuard(lockFile, name);
        if (candidate === undefined || (!candidate.draft && candidate.path === own.path))
          continue;
        if (managedOutputLockGuardIsLive(candidate)) {
          conflict = true;
          continue;
        }
        /** 唯一 PID/token 路径永不复用，因此 stale cleanup 不会删除新 guard。 */
        await removeOwnedPath(candidate.path);
      }
      if (!conflict)
        return own;
    } catch (error) {
      await releaseManagedOutputLockGuard(own).catch(() => undefined);
      throw error;
    }
    await releaseManagedOutputLockGuard(own);
    /** 小幅有界退避避免两个同时到达的调用持续同步冲突。 */
    await new Promise<void>(resolve => setTimeout(resolve, attempt + 1));
  }
  throw new Error('Managed output lock metadata is locked by another process.');
}

/** 确认 guard 内的 lock record 与首次观察完全一致。 */
async function assertManagedOutputLockUnchanged(
  file: string,
  observation: ManagedOutputLockObservation,
): Promise<void> {
  if (observation.record === undefined) {
    /** 旧 writer 可能先创建空文件再写 record，给其一个固定且有界的完成窗口。 */
    await new Promise<void>(resolve => setTimeout(resolve, LEGACY_LOCK_STABILITY_DELAY_MS));
  }
  /** 第二次完整读取是 malformed/stale recovery 的有界 unchanged-record check。 */
  const current = await readManagedOutputLock(file);
  if (current.bytes !== observation.bytes
    || !sameManagedOutputLockMetadata(current.metadata, observation.metadata))
    throw new Error('Managed output lock changed during stale recovery.');
}

/**
 * 原子隔离当前精确观察到的 stale/malformed lock。
 *
 * rename 后只删除字节仍匹配的 inode；若竞争者替换了记录则尽力恢复并失败关闭。
 */
async function quarantineManagedOutputLock(
  file: string,
  observation: ManagedOutputLockObservation,
): Promise<void> {
  /** rename 前在 metadata guard 内完成第二次完整 unchanged-record check。 */
  await assertManagedOutputLockUnchanged(file, observation);
  /** 唯一同级 quarantine 避免并发 cleaner 覆盖彼此。 */
  const quarantine = `${file}.${randomUUID()}.stale`;
  try {
    await fs.rename(file, quarantine);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return;
    throw error;
  }
  try {
    /** random token 使合法 writer replacement 不可能与旧 observation 字节相同。 */
    const moved = await readManagedOutputLock(quarantine);
    if (moved.bytes !== observation.bytes
      || !sameManagedOutputLockInode(moved.metadata, observation.metadata)) {
      try {
        await fs.link(quarantine, file);
      } catch {
        /** 另一个 writer 已占用最终 lock 时不能覆盖它。 */
      }
      throw new Error('Managed output lock changed during stale recovery.');
    }
  } finally {
    await removeOwnedPath(quarantine);
  }
}

/** 把完整 owner record 通过 hard-link no-replace 原子发布为最终锁。 */
async function publishManagedOutputLock(file: string): Promise<string> {
  /** token 同时区分同 PID 的当前 holder 与 cleanup 失败残留。 */
  const token = randomUUID();
  /** 同目录唯一草稿保证 hard-link 发布不跨文件系统。 */
  const draft = `${file}.${token}.writing`;
  /** 草稿从创建起就是私有普通文件。 */
  const handle = await fs.open(draft, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(`${JSON.stringify({ schemaVersion: 3, pid: process.pid, token })}\n`);
      await handle.sync();
    } finally {
      await closeOwnedFile(handle);
    }
    /** final path 要么不存在并完整出现，要么保持既有 writer 不变。 */
    await fs.link(draft, file);
  } finally {
    await removeOwnedPath(draft);
  }
  return token;
}

/** 只释放仍由当前 holder token 标识的最终锁。 */
async function releaseManagedOutputLock(file: string, token: string): Promise<void> {
  /** 删除前重新读取最终锁，避免移除另一个 writer 已替换的记录。 */
  const observation = await readManagedOutputLock(file);
  if (observation.record?.pid !== process.pid || observation.record.token !== token)
    throw new Error('Managed output lock ownership changed before release.');
  await removeOwnedPath(file);
}

/**
 * 持久写入一个不含物理路径的事务 marker。
 *
 * @param file 同一受管输出专属的 marker 路径。
 * @param record 当前事务的稳定恢复信息。
 */
async function writeTransactionMarker(file: string, record: TransactionRecord): Promise<void> {
  /** 临时普通文件先完整落盘，最终 marker 永远不会暴露部分 JSON。 */
  const writing = `${file}${MARKER_WRITING_SUFFIX}`;
  /** `wx` 防止遗留或并发状态被当前事务静默覆盖。 */
  const handle = await fs.open(writing, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`);
    /** 临时 marker 内容先落盘，随后才允许原子发布最终目录项。 */
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    /** 同目录 hard link 原子发布且拒绝覆盖任何既有最终 marker。 */
    await fs.link(writing, file);
  } finally {
    /** 发布前失败或发布后崩溃遗留的临时链接都不参与恢复判断。 */
    await fs.rm(writing, { force: true });
  }
}

/**
 * 读取并验证一个受管事务 marker。
 *
 * @param file 当前输出专属 marker 路径。
 * @param expectedOutDir 当前受管输出 basename。
 * @returns marker 不存在时返回 undefined。
 */
async function readTransactionMarker(file: string, expectedOutDir: string): Promise<TransactionRecord | undefined> {
  /** marker 缺失是正常恢复状态。 */
  const stat = await fs.lstat(file).catch(() => undefined);
  if (stat === undefined)
    return undefined;
  if (stat.isSymbolicLink() || !stat.isFile())
    throw new Error('Managed output transaction marker must be a regular file.');
  /** 未验证 JSON 只能用于恢复状态判断，不能提供任意路径。 */
  const value: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Managed output transaction marker is invalid.');
  /** marker 只允许固定恢复字段。 */
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort(compareCodePoints).join(',') !== 'hadOutput,outDir,schemaVersion,scope'
    || record.schemaVersion !== 2 || record.outDir !== expectedOutDir
    || (record.scope !== 'full' && record.scope !== 'subset') || typeof record.hadOutput !== 'boolean') {
    throw new Error('Managed output transaction marker is invalid.');
  }
  return Object.freeze({
    schemaVersion: 2,
    outDir: record.outDir,
    scope: record.scope,
    hadOutput: record.hadOutput,
  }) as TransactionRecord;
}

/** @returns 字节的 SHA-256 十六进制摘要。 */
function hashBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * 规范化 transaction scope 并校验与 Unit Platform 集合完全一致。
 *
 * @param scope 调用方选择语义。
 * @param units 本轮待提交 Package Units。
 * @returns frozen full/subset scope。
 */
function normalizeScope(
  scope: ManagedOutputScope | undefined,
  units: readonly PackageUnitSnapshot[],
): ManagedOutputScope {
  if (scope === undefined || scope.type === 'full')
    return Object.freeze({ type: 'full' });
  if (scope.type !== 'subset' || !Array.isArray(scope.platforms))
    throw new TypeError('Managed output scope is invalid.');
  /** selected IDs 复制、排序并拒绝不稳定或重复值。 */
  const selected = [...scope.platforms].sort(compareCodePoints);
  if (selected.length === 0 || selected.some(platform => !STABLE_ID.test(platform))
    || new Set(selected).size !== selected.length) {
    throw new TypeError('Subset Platform ids must be unique lowercase kebab-case values.');
  }
  /** 成功提交时每个 selected Platform 必须至少存在一个 Unit。 */
  const actual = [...new Set(units.map(unit => unit.platform))].sort(compareCodePoints);
  if (JSON.stringify(actual) !== JSON.stringify(selected))
    throw new TypeError('Subset Platform ids must exactly match the Package Unit Platform set.');
  return Object.freeze({ type: 'subset', platforms: Object.freeze(selected) });
}

/**
 * 验证 outDir 与 project root 的物理语法边界。
 *
 * @param outDir 受管输出目录。
 * @param projectRoot 工程根目录。
 * @returns outDir、父目录和 basename 的绝对路径集合。
 */
function outputPaths(outDir: string, projectRoot: string): {
  readonly resolved: string;
  readonly parent: string;
  readonly base: string;
} {
  /** 输入路径先解析为绝对位置再判断边界。 */
  const resolved = path.resolve(outDir);
  /** 工程根同样固定为绝对路径。 */
  const project = path.resolve(projectRoot);
  /** basename 用于构造同级事务辅助路径。 */
  const base = path.basename(resolved);
  if (!isInsidePath(project, resolved) || resolved === project
    || resolved === path.parse(resolved).root || base === '' || base === '.' || base === '..') {
    throw new Error('Managed output must stay strictly inside the project root.');
  }
  return Object.freeze({ resolved, parent: path.dirname(resolved), base });
}

/**
 * 读取一个未选 Platform 的完整旧输出，拒绝非普通内容和路径碰撞。
 *
 * @param root Platform 物理根。
 * @param id Platform ID。
 * @returns 可复制并在 swap 前复核的内存快照。
 */
async function snapshotPreservedPlatform(root: string, id: string): Promise<PreservedPlatform> {
  /** scanPhysicalTree 统一拒绝 symlink/special file。 */
  const tree = await scanPhysicalTree(root);
  /** 路径索引额外拒绝大小写和 NFC collision。 */
  const collision = new Map<string, string>();
  for (const relative of [...tree.directories, ...tree.files]) {
    /** 所有目录和文件共享同一个折叠 collision domain。 */
    const key = sourceCollisionKey(relative);
    /** 首次出现的原始 path 用于稳定诊断。 */
    const previous = collision.get(key);
    if (previous !== undefined)
      throw new Error(`Preserved Platform path "${relative}" collides with "${previous}".`);
    collision.set(key, relative);
  }
  /** file snapshots 与目录 closure 分开保存。 */
  const files: PreservedFile[] = [];
  for (const relative of tree.files) {
    /** 文件字节一次性复制，旧输出不会成为新 AssetRef 来源。 */
    const file = path.join(root, ...relative.split('/'));
    /** mode 只接受框架 Asset 支持的两种权限。 */
    const stat = await fs.lstat(file);
    /** 权限去除文件类型位后参与 snapshot。 */
    const mode = stat.mode & 0o777;
    if (mode !== 0o644 && mode !== 0o755)
      throw new Error(`Preserved Platform file has unsupported mode: ${id}/${relative}.`);
    /** 内容 snapshot 同时固定 size/hash。 */
    const bytes = Uint8Array.from(await fs.readFile(file));
    files.push(Object.freeze({
      path: relative,
      bytes,
      mode,
      size: bytes.byteLength,
      sha256: hashBytes(bytes),
    }));
  }
  return Object.freeze({ id, directories: tree.directories, files: Object.freeze(files) });
}

/**
 * 在取得 transaction lock 后快照所有未选 Platform。
 *
 * @param outDir 当前受管输出。
 * @param selected 本轮显式替换的 Platform。
 * @returns 按 Platform ID 排序的旧输出快照。
 */
async function snapshotPreservedPlatforms(
  outDir: string,
  selected: ReadonlySet<string>,
): Promise<readonly PreservedPlatform[]> {
  if (!await exists(outDir))
    return Object.freeze([]);
  /** outDir 自身也不能是 symlink 或普通文件。 */
  const stat = await fs.lstat(outDir);
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw new Error('Managed output root must be a regular directory.');
  /** outDir 顶层只能包含 lowercase-kebab Platform 目录。 */
  const entries = (await fs.readdir(outDir, { withFileTypes: true }))
    .sort((left, right) => compareCodePoints(left.name, right.name));
  /** 未选 Platform 按目录顺序进入快照。 */
  const preserved: PreservedPlatform[] = [];
  /** 顶层 Platform ID 也拒绝 case/NFC collision。 */
  const collisions = new Map<string, string>();
  for (const entry of entries) {
    if (!STABLE_ID.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink())
      throw new Error(`Managed output contains an invalid Platform root: "${entry.name}".`);
    /** Platform ID 使用与 Package path 相同的折叠 key。 */
    const key = sourceCollisionKey(entry.name);
    /** 首次 Platform 名用于冲突诊断。 */
    const previous = collisions.get(key);
    if (previous !== undefined)
      throw new Error(`Managed output Platform "${entry.name}" collides with "${previous}".`);
    collisions.set(key, entry.name);
    if (!selected.has(entry.name))
      preserved.push(await snapshotPreservedPlatform(path.join(outDir, entry.name), entry.name));
  }
  return Object.freeze(preserved);
}

/**
 * 把未选 Platform snapshot 写入 stage。
 *
 * @param stage 当前事务 stage 根。
 * @param platforms 旧输出内存快照。
 */
async function materializePreservedPlatforms(
  stage: string,
  platforms: readonly PreservedPlatform[],
): Promise<void> {
  for (const platform of platforms) {
    /** Platform 根本身即使为空也必须保留。 */
    const root = path.join(stage, platform.id);
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    for (const directory of platform.directories)
      await fs.mkdir(path.join(root, ...directory.split('/')), { recursive: true, mode: 0o700 });
    for (const file of platform.files) {
      /** 文件写入不复用 copyFile，确保使用已快照的确定字节。 */
      const destination = path.join(root, ...file.path.split('/'));
      await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await fs.writeFile(destination, file.bytes, { flag: 'wx', mode: file.mode });
      await fs.chmod(destination, file.mode);
    }
  }
}

/**
 * 复核保留 Platform 的树闭包、字节和 mode。
 *
 * @param parent outDir 或 stage 根。
 * @param platforms 先前建立的完整快照。
 */
async function validatePreservedPlatforms(
  parent: string,
  platforms: readonly PreservedPlatform[],
): Promise<void> {
  for (const platform of platforms) {
    /** preserved validation 始终从 Platform root 开始。 */
    const root = path.join(parent, platform.id);
    /** closure 比较拒绝外部在 snapshot 后增删文件或目录。 */
    const tree = await scanPhysicalTree(root);
    if (JSON.stringify(tree.directories) !== JSON.stringify(platform.directories)
      || JSON.stringify(tree.files) !== JSON.stringify(platform.files.map(file => file.path))) {
      throw new Error(`Preserved Platform tree changed during transaction: ${platform.id}.`);
    }
    for (const expected of platform.files) {
      /** 每个文件重新读取以验证 source/stage 都等于同一 snapshot。 */
      const file = path.join(root, ...expected.path.split('/'));
      /** mode 从 lstat 获取，避免最终 symlink 跟随。 */
      const stat = await fs.lstat(file);
      /** bytes 再次复算 size/hash。 */
      const bytes = Uint8Array.from(await fs.readFile(file));
      if ((stat.mode & 0o777) !== expected.mode || bytes.byteLength !== expected.size
        || hashBytes(bytes) !== expected.sha256) {
        throw new Error(`Preserved Platform file changed during transaction: ${platform.id}/${expected.path}.`);
      }
    }
  }
}

/**
 * 校验 stage 顶层只包含本轮 Unit 与保留 Platform 的完整集合。
 *
 * @param stage 当前 stage 根。
 * @param units 本轮新 Package Units。
 * @param preserved 未选 Platform snapshots。
 */
async function validateStagePlatforms(
  stage: string,
  units: readonly PackageUnitSnapshot[],
  preserved: readonly PreservedPlatform[],
): Promise<void> {
  /** expected 顶层由新 Unit Platform 与 preserved Platform 并集组成。 */
  const expected = [...new Set([
    ...units.map(unit => unit.platform),
    ...preserved.map(platform => platform.id),
  ])].sort(compareCodePoints);
  /** stage 顶层实际目录集合也必须完整闭合。 */
  const actual = (await fs.readdir(stage, { withFileTypes: true }))
    .map((entry) => {
      if (!entry.isDirectory() || entry.isSymbolicLink())
        throw new Error(`Managed stage contains a non-directory Platform root: "${entry.name}".`);
      return entry.name;
    })
    .sort(compareCodePoints);
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error('Managed stage Platform closure mismatch.');
}

/** 把即将 swap 的最终 stage 全部目录规范为公开可遍历的 0755。 */
async function normalizeFinalDirectoryModes(stage: string): Promise<void> {
  if (process.platform === 'win32')
    return;
  /** scan 先证明整棵 stage 不含 symlink 或特殊文件。 */
  const tree = await scanPhysicalTree(stage);
  /** 后代先 chmod，最后处理会成为 outDir 的 stage root。 */
  for (const directory of tree.directories)
    await fs.chmod(path.join(stage, ...directory.split('/')), 0o755);
  await fs.chmod(stage, 0o755);
}

/** 复核 stage 根和所有后代目录的最终 POSIX mode。 */
async function validateFinalDirectoryModes(stage: string): Promise<void> {
  if (process.platform === 'win32')
    return;
  /** scan 同时返回完整目录闭包并拒绝非普通内容。 */
  const tree = await scanPhysicalTree(stage);
  for (const directory of ['', ...tree.directories]) {
    /** 空字符串表示最终 outDir 根自身。 */
    const physical = directory === '' ? stage : path.join(stage, ...directory.split('/'));
    /** lstat 复核当前目录没有被替换且使用最终公开 mode。 */
    const stat = await fs.lstat(physical);
    if ((stat.mode & 0o777) !== 0o755)
      throw new Error('Managed stage directories must use mode 0755.');
  }
}

/**
 * 原子提交全部 selected Package Units。
 *
 * @param outDir 框架完全管理的输出目录。
 * @param units 已完成 candidate/compatibility 校验的 Package Units。
 * @param assets 当前 BuildSession Asset Registry。
 * @param options 工程边界、scope 和 fault-injection hooks。
 */
export async function commitPackageUnits(
  outDir: string,
  units: readonly PackageUnitSnapshot[],
  assets: AssetRegistry,
  options: CommitPackageUnitsOptions,
): Promise<void> {
  /** 所有路径、scope 输入在创建锁或辅助文件前完成验证。 */
  const locations = outputPaths(outDir, options.projectRoot);
  /** scope 与本轮 Unit Platform set 精确绑定。 */
  const scope = normalizeScope(options.scope, units);
  await fs.mkdir(locations.parent, { recursive: true });
  /** project→parent 的每层必须是非 symlink 普通目录。 */
  await validatePhysicalEntry(path.resolve(options.projectRoot), locations.parent, 'directory');
  if (await exists(locations.resolved))
    await validatePhysicalEntry(path.resolve(options.projectRoot), locations.resolved, 'directory');
  /** 三个持久辅助路径与 outDir 同级，保证 rename 不跨文件系统。 */
  const lockPath = path.join(locations.parent, `.${locations.base}.acplugin.lock`);
  /** transaction record 用于崩溃恢复。 */
  const transactionPath = path.join(locations.parent, `.${locations.base}.acplugin-transaction.json`);
  /** transaction marker 写入中断时遗留的非权威临时文件。 */
  const transactionWritingPath = `${transactionPath}${MARKER_WRITING_SUFFIX}`;
  /** cleanup 完成后写入的 marker 将 pending transaction 提升为正式提交。 */
  const committedPath = path.join(locations.parent, `.${locations.base}.acplugin-committed.json`);
  /** committed marker 写入中断时遗留的非权威临时文件。 */
  const committedWritingPath = `${committedPath}${MARKER_WRITING_SUFFIX}`;
  /** backup 保存 swap 前的完整旧目录。 */
  const backupPath = path.join(locations.parent, `.${locations.base}.acplugin-backup`);
  /** 当前调用创建但尚未 swap 的 stage。 */
  let stage: string | undefined;
  /** rollback 判断旧输出是否已经移动。 */
  let backupCreated = false;
  /** rollback 判断新输出是否已经暴露。 */
  let outputSwapped = false;
  /** 仅清理当前调用已经创建的 transaction marker。 */
  let transactionWritten = false;

  /** 创建独占锁；完整 stale/malformed 状态隔离后允许有限重试。 */
  const acquireLock = async (): Promise<string> => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      /** 所有 fixed lock path 读取、发布和恢复都在唯一 guard 内串行化。 */
      const guard = await acquireManagedOutputLockGuard(lockPath);
      try {
        try {
          /** hard-link publication 是多个 acplugin 进程间的原子事务互斥点。 */
          const token = await publishManagedOutputLock(lockPath);
          ACTIVE_LOCK_TOKENS.add(token);
          return token;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
            throw error;
        }
        try {
          /** final lock 从出现起就应当是完整 schema 3 record。 */
          const observation = await readManagedOutputLock(lockPath);
          /** 当前进程仍登记的 token 和任何其他存活 PID 都是活 writer。 */
          const live = observation.record !== undefined
            && ((observation.record.pid === process.pid && ACTIVE_LOCK_TOKENS.has(observation.record.token))
              || (observation.record.pid !== process.pid && processIsAlive(observation.record.pid)));
          if (live)
            throw new Error(`Managed output is locked by process ${observation.record!.pid}.`);
          /** 新协议不会发布 malformed record；旧 create→write 残留经复核后隔离。 */
          await quarantineManagedOutputLock(lockPath, observation);
        } catch (lockError) {
          if ((lockError as NodeJS.ErrnoException).code === 'ENOENT')
            continue;
          throw new Error(`Managed output is locked. ${String(lockError)}`, { cause: lockError });
        }
      } finally {
        await releaseManagedOutputLockGuard(guard).catch(() => undefined);
      }
    }
    throw new Error('Managed output lock could not be acquired after stale recovery.');
  };

  /** lock token 从 recovery 一直持有到 cleanup 完成。 */
  const lockToken = await acquireLock();
  try {
    await options.onPhase?.('lock-acquired');
    /** pending 与 committed marker 共同消除 swap 后崩溃的恢复歧义。 */
    const pendingRecord = await readTransactionMarker(transactionPath, locations.base);
    /** committed marker 必须与 pending record 描述同一个事务。 */
    const committedRecord = await readTransactionMarker(committedPath, locations.base);
    if (pendingRecord !== undefined && committedRecord !== undefined
      && JSON.stringify(pendingRecord) !== JSON.stringify(committedRecord)) {
      throw new Error('Managed output transaction markers do not match.');
    }
    /** 上次事务遗留 backup 的普通目录边界。 */
    const hasBackup = await exists(backupPath);
    if (hasBackup) {
      /** backup 只能是同级普通目录，绝不能恢复一个符号链接。 */
      const backupStat = await fs.lstat(backupPath);
      if (backupStat.isSymbolicLink() || !backupStat.isDirectory())
        throw new Error('Managed output backup must be a regular directory.');
    }
    if (committedRecord !== undefined) {
      /** cleanup 已完成的事务保留新输出；异常缺失时回退到仍完整的旧 backup。 */
      if (!await exists(locations.resolved) && hasBackup)
        await fs.rename(backupPath, locations.resolved);
      else if (hasBackup)
        await fs.rm(backupPath, { recursive: true, force: true });
    } else if (pendingRecord !== undefined) {
      /** 未提交事务必须恢复调用前状态。 */
      if (pendingRecord.hadOutput) {
        if (hasBackup) {
          if (await exists(locations.resolved))
            await fs.rm(locations.resolved, { recursive: true, force: true });
          await fs.rename(backupPath, locations.resolved);
        } else if (!await exists(locations.resolved)) {
          throw new Error('Managed output rollback record lost both output and backup.');
        }
      } else {
        if (hasBackup)
          throw new Error('Managed output rollback record has an unexpected backup.');
        if (await exists(locations.resolved))
          await fs.rm(locations.resolved, { recursive: true, force: true });
      }
    } else if (hasBackup) {
      /** 无 marker 的 backup 只可能来自已提交事务的最后清理窗口。 */
      if (!await exists(locations.resolved))
        await fs.rename(backupPath, locations.resolved);
      else
        await fs.rm(backupPath, { recursive: true, force: true });
    }
    /** recovery 后的正式输出必须仍位于工程内且无 symlink 祖先。 */
    if (await exists(locations.resolved))
      await validatePhysicalEntry(path.resolve(options.projectRoot), locations.resolved, 'directory');
    if (pendingRecord !== undefined)
      await fs.rm(transactionPath, { force: true });
    if (committedRecord !== undefined)
      await fs.rm(committedPath, { force: true });
    /** 未原子发布的 marker 草稿没有恢复权威，统一在锁内清理。 */
    await fs.rm(transactionWritingPath, { force: true });
    await fs.rm(committedWritingPath, { force: true });
    /** 只清理当前 outDir 专属前缀的旧 stage。 */
    const stalePrefix = `.${locations.base}.acplugin-stage-`;
    for (const entry of await fs.readdir(locations.parent, { withFileTypes: true })) {
      if (entry.name.startsWith(stalePrefix))
        await fs.rm(path.join(locations.parent, entry.name), { recursive: true, force: true });
    }
    await options.onPhase?.('recovery-complete');

    /** subset 在锁内快照未选 Platform；full 使用空保留集。 */
    const preserved = scope.type === 'subset'
      ? await snapshotPreservedPlatforms(locations.resolved, new Set(scope.platforms))
      : Object.freeze([]);
    stage = await fs.mkdtemp(path.join(locations.parent, `.${locations.base}.acplugin-stage-`));
    /** 先放入旧未选 Platform，再写入本轮 selected Units。 */
    await materializePreservedPlatforms(stage, preserved);
    /** selected Units 直接从 AssetRegistry 做 TOCTOU materialization。 */
    const materialized = await materializePackageUnits(stage, units, assets);
    /** 只有完整 stage 即将验证/swap 时才从私有 0700 规范为最终 0755。 */
    await normalizeFinalDirectoryModes(stage);
    await options.onPhase?.('stage-materialized');
    /** selected Units、preserved Platforms 与 stage 顶层分别完成闭包验证。 */
    await validatePackageUnits(stage, units, materialized);
    await validatePreservedPlatforms(stage, preserved);
    await validateStagePlatforms(stage, units, preserved);
    await validateFinalDirectoryModes(stage);
    /** swap 前再次复核旧未选 Platform 没有在 snapshot 后变化。 */
    if (preserved.length > 0)
      await validatePreservedPlatforms(locations.resolved, preserved);
    await options.onPhase?.('stage-validated');
    /** record 只含相对 basename、scope 和旧输出存在性，不记录绝对路径。 */
    const transactionRecord: TransactionRecord = Object.freeze({
      schemaVersion: 2,
      outDir: locations.base,
      scope: scope.type,
      hadOutput: await exists(locations.resolved),
    });
    await writeTransactionMarker(transactionPath, transactionRecord);
    transactionWritten = true;
    await options.onPhase?.('transaction-written');

    if (await exists(locations.resolved)) {
      await fs.rename(locations.resolved, backupPath);
      backupCreated = true;
    }
    try {
      await options.onPhase?.('backup-created');
      await fs.rename(stage, locations.resolved);
      stage = undefined;
      outputSwapped = true;
      await options.onPhase?.('output-swapped');
      await options.afterSwap?.();
      /** 只有必要 cleanup 成功后，崩溃恢复才允许保留新输出。 */
      await writeTransactionMarker(committedPath, transactionRecord);
    } catch (error) {
      try {
        /** afterSwap/rename 失败统一恢复旧输出。 */
        if (outputSwapped && await exists(locations.resolved))
          await fs.rm(locations.resolved, { recursive: true, force: true });
        if (backupCreated && await exists(backupPath))
          await fs.rename(backupPath, locations.resolved);
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], 'Managed output rollback failed.', { cause: rollbackError });
      }
      throw error;
    }
    if (await exists(backupPath)) {
      try {
        await fs.rm(backupPath, { recursive: true, force: true });
      } catch {
        /** committed marker 保留到下次 recovery 删除过期 backup。 */
        return;
      }
    }
    /** backup 已清理后才可删除恢复 record；committed marker 最后删除。 */
    try {
      await fs.rm(transactionPath, { force: true });
      transactionWritten = false;
    } catch {
      /** 两个 marker 留给下次 recovery 确认新输出已提交。 */
      return;
    }
    try {
      await fs.rm(committedPath, { force: true });
    } catch {
      /** 单独的 committed marker 同样可由下次 recovery 安全清理。 */
    }
  } catch (error) {
    if (!(error instanceof AggregateError) && transactionWritten) {
      try {
        await fs.rm(transactionPath, { force: true });
        await fs.rm(committedPath, { force: true });
        transactionWritten = false;
      } catch {
        /** 无法清理的 marker 是下一轮可恢复状态。 */
      }
    }
    throw error;
  } finally {
    if (stage !== undefined) {
      try {
        await fs.rm(stage, { recursive: true, force: true });
      } catch {
        /** stage 清理失败不覆盖原始 transaction 结果。 */
      }
    }
    try {
      /** release 也必须与 stale recovery/new publication 使用同一 metadata guard。 */
      const guard = await acquireManagedOutputLockGuard(lockPath);
      try {
        await releaseManagedOutputLock(lockPath, lockToken);
      } finally {
        await releaseManagedOutputLockGuard(guard);
      }
    } catch {
      /** 遗留 token 从 active set 撤销后将被同 PID 的下一轮识别为 stale。 */
    } finally {
      ACTIVE_LOCK_TOKENS.delete(lockToken);
    }
  }
}
