/** 受管输出在持锁状态下的崩溃恢复。 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { validatePhysicalEntry } from '../security/path-policy.js';
import {
  exists,
  readTransactionMarker,
  type ManagedOutputPaths,
} from './transaction-files.js';

/**
 * 恢复或清理上一次事务留下的确定状态。
 *
 * 调用方必须已经持有 `paths.lock`，本函数不负责锁生命周期。
 */
export async function recoverManagedOutput(
  paths: ManagedOutputPaths,
  projectRoot: string,
): Promise<void> {
  /** pending 与 committed marker 共同消除 swap 后崩溃的恢复歧义。 */
  const pendingRecord = await readTransactionMarker(paths.transaction, paths.base);
  /** committed marker 必须与 pending record 描述同一个事务。 */
  const committedRecord = await readTransactionMarker(paths.committed, paths.base);
  if (pendingRecord !== undefined && committedRecord !== undefined
    && JSON.stringify(pendingRecord) !== JSON.stringify(committedRecord)) {
    throw new Error('Managed output transaction markers do not match.');
  }
  /** 上次事务遗留 backup 的普通目录边界。 */
  const hasBackup = await exists(paths.backup);
  if (hasBackup) {
    /** backup 只能是同级普通目录，绝不能恢复一个符号链接。 */
    const backupStat = await fs.lstat(paths.backup);
    if (backupStat.isSymbolicLink() || !backupStat.isDirectory())
      throw new Error('Managed output backup must be a regular directory.');
  }
  if (committedRecord !== undefined) {
    /** cleanup 已完成的事务保留新输出；异常缺失时回退到仍完整的旧 backup。 */
    if (!await exists(paths.resolved) && hasBackup)
      await fs.rename(paths.backup, paths.resolved);
    else if (hasBackup)
      await fs.rm(paths.backup, { recursive: true, force: true });
  } else if (pendingRecord !== undefined) {
    /** 未提交事务必须恢复调用前状态。 */
    if (pendingRecord.hadOutput) {
      if (hasBackup) {
        if (await exists(paths.resolved))
          await fs.rm(paths.resolved, { recursive: true, force: true });
        await fs.rename(paths.backup, paths.resolved);
      } else if (!await exists(paths.resolved)) {
        throw new Error('Managed output rollback record lost both output and backup.');
      }
    } else {
      if (hasBackup)
        throw new Error('Managed output rollback record has an unexpected backup.');
      if (await exists(paths.resolved))
        await fs.rm(paths.resolved, { recursive: true, force: true });
    }
  } else if (hasBackup) {
    /** 无 marker 的 backup 只可能来自已提交事务的最后清理窗口。 */
    if (!await exists(paths.resolved))
      await fs.rename(paths.backup, paths.resolved);
    else
      await fs.rm(paths.backup, { recursive: true, force: true });
  }
  /** recovery 后的正式输出必须仍位于工程内且无 symlink 祖先。 */
  if (await exists(paths.resolved))
    await validatePhysicalEntry(path.resolve(projectRoot), paths.resolved, 'directory');
  if (pendingRecord !== undefined)
    await fs.rm(paths.transaction, { force: true });
  if (committedRecord !== undefined)
    await fs.rm(paths.committed, { force: true });
  /** 未原子发布的 marker 草稿没有恢复权威，统一在锁内清理。 */
  await fs.rm(paths.transactionWriting, { force: true });
  await fs.rm(paths.committedWriting, { force: true });
  /** 只清理当前 outDir 专属前缀的旧 stage。 */
  for (const entry of await fs.readdir(paths.parent, { withFileTypes: true })) {
    if (entry.name.startsWith(paths.stagePrefix))
      await fs.rm(path.join(paths.parent, entry.name), { recursive: true, force: true });
  }
}
