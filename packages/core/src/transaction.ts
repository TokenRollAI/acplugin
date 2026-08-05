import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hashFile } from './artifacts.js';
import type { Artifact, TargetId } from './types.js';

/** 受管输出事务可观测的稳定阶段名称。 */
export type ManagedOutputPhase
  = | 'lock-acquired'
    | 'recovery-complete'
    | 'stage-materialized'
    | 'stage-validated'
    | 'transaction-written'
    | 'backup-created'
    | 'output-swapped';

/** 控制受管输出提交阶段通知和交换后收尾行为。 */
export interface CommitManagedOutputOptions {
  /**
   * 在事务进入关键阶段时调用，主要用于日志、测试故障注入和外部观测。
   *
   * @param phase 已经完成的事务阶段。
   */
  onPhase?(phase: ManagedOutputPhase): void | Promise<void>;
  /**
   * 新输出完成交换后、删除回滚备份前调用；失败会触发整个目录回滚。
   */
  afterSwap?(): void | Promise<void>;
}

/**
 * 判断事务辅助路径当前是否存在。
 *
 * @param candidate 待检查的文件或目录路径。
 * @returns 可访问时返回 true，否则返回 false。
 */
async function exists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

/**
 * 将单个已经过 ArtifactGraph 验证的产物写入阶段目录。
 *
 * @param root 当前目标平台的阶段目录。
 * @param artifact 包含可信来源、摘要和权限的产物。
 */
async function materializeFile(root: string, artifact: Artifact): Promise<void> {
  /** 由受控 POSIX 相对路径解析出的最终阶段文件路径。 */
  const destination = path.join(root, ...artifact.path.split('/'));
  await fs.mkdir(path.dirname(destination), { recursive: true });
  if (artifact.source.type === 'bytes')
    await fs.writeFile(destination, artifact.source.value, { mode: artifact.mode });
  else
    await fs.copyFile(artifact.source.path, destination);
  await fs.chmod(destination, artifact.mode);
}

/**
 * 将各目标 Artifact 以稳定顺序物化到指定根目录。
 *
 * @param root 物化根目录，每个 Target ID 会成为其一级子目录。
 * @param targets 各目标已完成 Graph 校验的 Artifact 列表。
 */
export async function materializeTargets(
  root: string,
  targets: ReadonlyMap<TargetId, readonly Artifact[]>,
): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  for (const target of [...targets.keys()].sort()) {
    /** 当前目标在物化根目录下的隔离子目录。 */
    const targetRoot = path.join(root, target);
    await fs.mkdir(targetRoot, { recursive: true });
    for (const artifact of targets.get(target) ?? [])
      await materializeFile(targetRoot, artifact);
  }
}

/**
 * 重新读取已物化文件，验证文件类型、内容摘要、大小和权限。
 *
 * @param root 先前执行物化操作的根目录。
 * @param targets 作为完整性基准的 Artifact 列表。
 * @throws 物化内容与 Artifact 契约不一致时抛出异常。
 */
async function validateMaterializedTargets(
  root: string,
  targets: ReadonlyMap<TargetId, readonly Artifact[]>,
): Promise<void> {
  for (const target of [...targets.keys()].sort()) {
    /** 当前目标已物化文件的根目录。 */
    const targetRoot = path.join(root, target);
    for (const artifact of targets.get(target) ?? []) {
      /** 当前 Artifact 实际写入的文件路径。 */
      const destination = path.join(targetRoot, ...artifact.path.split('/'));
      /** 用于拒绝符号链接和非普通文件的实际元数据。 */
      const stat = await fs.lstat(destination);
      if (stat.isSymbolicLink() || !stat.isFile())
        throw new Error(`Materialized Artifact is not a regular file: ${target}/${artifact.path}`);
      /** 从磁盘重新计算的字节数与摘要。 */
      const actual = await hashFile(destination);
      if (actual.size !== artifact.size || actual.sha256 !== artifact.sha256)
        throw new Error(`Materialized Artifact integrity mismatch: ${target}/${artifact.path}`);
      if ((stat.mode & 0o777) !== artifact.mode)
        throw new Error(`Materialized Artifact mode mismatch: ${target}/${artifact.path}`);
    }
  }
}

/**
 * 在系统临时目录中完整演练物化和完整性校验，但不修改真实输出目录。
 *
 * @param targets 各目标已完成 Graph 校验的 Artifact 列表。
 */
export async function validateMaterialization(
  targets: ReadonlyMap<TargetId, readonly Artifact[]>,
): Promise<void> {
  /** 本次验证独占且无论成功失败都会删除的临时目录。 */
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-validate-'));
  try {
    await materializeTargets(temporary, targets);
    await validateMaterializedTargets(temporary, targets);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

/**
 * 通过加锁、阶段目录、备份和目录交换原子提交全部目标输出。
 *
 * 同级事务记录与备份允许下一次调用修复进程中断留下的状态；交换后 Hook 失败时，
 * 当前调用会删除新输出并恢复旧目录，保证调用方只观察到完整的新旧版本之一。
 *
 * @param outDir 由 acplugin 完全管理的输出目录。
 * @param targets 各目标已完成 Graph 校验的 Artifact 列表。
 * @param options 阶段通知与交换后事务 Hook。
 * @throws 输出路径不安全、存在活跃锁、物化失败或回滚失败时抛出异常。
 */
export async function commitManagedOutput(
  outDir: string,
  targets: ReadonlyMap<TargetId, readonly Artifact[]>,
  options: CommitManagedOutputOptions = {},
): Promise<void> {
  /** 规范化后的受管输出绝对路径。 */
  const resolved = path.resolve(outDir);
  /** 存放输出、锁、阶段目录和备份的共同父目录。 */
  const parent = path.dirname(resolved);
  /** 用于构造同级事务辅助路径的输出目录名称。 */
  const base = path.basename(resolved);
  if (resolved === path.parse(resolved).root || base === '' || base === '.' || base === '..')
    throw new Error(`Unsafe managed output path: ${outDir}`);

  await fs.mkdir(parent, { recursive: true });
  /** 防止多个进程并发提交同一输出目录的独占锁文件。 */
  const lockPath = path.join(parent, `.${base}.acplugin.lock`);
  /** 标记输出交换尚未完成清理的持久事务记录。 */
  const transactionPath = path.join(parent, `.${base}.acplugin-transaction.json`);
  /** 目录交换期间保存旧输出、用于恢复的同级备份路径。 */
  const backupPath = path.join(parent, `.${base}.acplugin-backup`);
  /** 当前调用创建、尚未交换或删除的阶段目录。 */
  let stage: string | undefined;
  /** 当前事务是否已经把旧输出移动为备份。 */
  let backupCreated = false;
  /** 当前事务是否已经把新阶段目录交换到正式输出路径。 */
  let outputSwapped = false;

  /**
   * 创建独占进程锁；发现死进程遗留锁时清理并重试一次。
   *
   * @returns 当前进程持有且需要在 finally 中关闭的锁文件句柄。
   */
  const acquireLock = async (): Promise<import('node:fs/promises').FileHandle> => {
    try {
      /** 通过 `wx` 原子创建的独占锁句柄。 */
      const handle = await fs.open(lockPath, 'wx');
      await handle.writeFile(`${JSON.stringify({ schemaVersion: 1, pid: process.pid })}\n`);
      return handle;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
        throw error;
      try {
        /** 旧锁记录的进程号，用于区分活跃锁和崩溃遗留锁。 */
        const record = JSON.parse(await fs.readFile(lockPath, 'utf8')) as { pid?: number };
        if (typeof record.pid !== 'number')
          throw new Error('lock has no process id', { cause: error });
        try {
          process.kill(record.pid, 0);
          throw new Error(`Managed output is locked by process ${record.pid}: ${outDir}`, { cause: error });
        } catch (processError) {
          if ((processError as NodeJS.ErrnoException).code !== 'ESRCH')
            throw processError;
        }
        await fs.rm(lockPath, { force: true });
        /** 清理死进程锁后由当前进程重新取得的句柄。 */
        const handle = await fs.open(lockPath, 'wx');
        await handle.writeFile(`${JSON.stringify({ schemaVersion: 1, pid: process.pid })}\n`);
        return handle;
      } catch (lockError) {
        throw new Error(`Managed output is locked: ${outDir}. ${String(lockError)}`, { cause: lockError });
      }
    }
  };
  /** 当前进程持有到事务 finally 结束的锁文件句柄。 */
  const lock = await acquireLock();

  try {
    await options.onPhase?.('lock-acquired');
    // 上次进程若在交换期间退出：缺少正式输出时恢复备份，否则删除已经过期的备份。
    if (await exists(backupPath)) {
      if (!await exists(resolved))
        await fs.rename(backupPath, resolved);
      else
        await fs.rm(backupPath, { recursive: true, force: true });
    }
    if (await exists(transactionPath))
      await fs.rm(transactionPath, { force: true });
    await options.onPhase?.('recovery-complete');

    // 阶段目录必须与输出同级，后续 rename 才能保持同一文件系统内的原子交换语义。
    stage = await fs.mkdtemp(path.join(parent, `.${base}.acplugin-stage-`));
    await materializeTargets(stage, targets);
    await options.onPhase?.('stage-materialized');
    await validateMaterializedTargets(stage, targets);
    await options.onPhase?.('stage-validated');
    await fs.writeFile(transactionPath, JSON.stringify({ schemaVersion: 1, outDir: base }) + '\n', { flag: 'wx' });
    await options.onPhase?.('transaction-written');

    if (await exists(resolved)) {
      await fs.rename(resolved, backupPath);
      backupCreated = true;
    }
    try {
      await options.onPhase?.('backup-created');
      await fs.rename(stage, resolved);
      stage = undefined;
      outputSwapped = true;
      await options.onPhase?.('output-swapped');
      await options.afterSwap?.();
      try {
        await fs.rm(transactionPath, { force: true });
      } catch {
        // 完整输出已经提交；遗留事务记录可由下次调用删除，不应把清理失败升级为构建失败。
      }
    } catch (error) {
      // 交换或 afterSwap 失败时，先移除不完整的新输出，再把旧备份恢复到正式路径。
      try {
        if (outputSwapped && await exists(resolved))
          await fs.rm(resolved, { recursive: true, force: true });
        if (backupCreated && await exists(backupPath))
          await fs.rename(backupPath, resolved);
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], `Managed output rollback failed: ${outDir}`, { cause: rollbackError });
      }
      throw error;
    }
    if (await exists(backupPath)) {
      try {
        await fs.rm(backupPath, { recursive: true, force: true });
      } catch {
        // 正式输出已经完整；下次调用会处理遗留备份，不应推翻成功的目录交换。
      }
    }
  } catch (error) {
    if (!(error instanceof AggregateError)) {
      try {
        await fs.rm(transactionPath, { force: true });
      } catch {
        // 遗留事务记录是可恢复状态，下次取得锁后会统一清理。
      }
    }
    throw error;
  } finally {
    if (stage) {
      try {
        await fs.rm(stage, { recursive: true, force: true });
      } catch {
        // 阶段目录清理失败可由人工或后续维护处理，不能覆盖原始事务结果。
      }
    }
    try {
      await lock.close();
    } catch {
      // 当前进程独占该句柄；关闭失败不改变已经确定的提交或回滚结果。
    }
    try {
      await fs.rm(lockPath, { force: true });
    } catch {
      // 遗留锁记录会在后续调用中通过进程存活检查完成协调。
    }
  }
}
