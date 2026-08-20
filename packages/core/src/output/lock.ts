/** 受管输出的跨进程锁协议。 */
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { compareCodePoints } from '../security/path-policy.js';

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

/** 当前进程仍实际持有的 token；清理失败后的同 PID record 不再视为活锁。 */
const ACTIVE_LOCK_TOKENS = new Set<string>();

/** 当前进程正在发布或持有的 lock-metadata guard token。 */
const ACTIVE_LOCK_GUARD_TOKENS = new Set<string>();

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
async function removeManagedOutputLockRecord(file: string, token: string): Promise<void> {
  /** 删除前重新读取最终锁，避免移除另一个 writer 已替换的记录。 */
  const observation = await readManagedOutputLock(file);
  if (observation.record?.pid !== process.pid || observation.record.token !== token)
    throw new Error('Managed output lock ownership changed before release.');
  await removeOwnedPath(file);
}

/** 创建独占锁；完整 stale/malformed 状态隔离后允许有限重试。 */
export async function acquireManagedOutputLock(lockPath: string): Promise<string> {
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
}

/** 在 metadata guard 内释放当前 holder，并撤销当前进程的 active token。 */
export async function releaseManagedOutputLock(lockPath: string, token: string): Promise<void> {
  try {
    /** release 必须与 stale recovery/new publication 使用同一 metadata guard。 */
    const guard = await acquireManagedOutputLockGuard(lockPath);
    try {
      await removeManagedOutputLockRecord(lockPath, token);
    } finally {
      await releaseManagedOutputLockGuard(guard);
    }
  } finally {
    /** 清理失败后的同 PID record 在下一轮应被识别为 stale。 */
    ACTIVE_LOCK_TOKENS.delete(token);
  }
}
