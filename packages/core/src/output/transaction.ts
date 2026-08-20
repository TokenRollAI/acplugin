import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { PackageUnitSnapshot } from '../contracts/packages.js';
import { AssetRegistry } from '../services/assets.js';
import { validatePhysicalEntry } from '../security/path-policy.js';
import { materializePackageUnits, validatePackageUnits } from '../package/candidate-materializer.js';
import { acquireManagedOutputLock, releaseManagedOutputLock } from './lock.js';
import { recoverManagedOutput } from './recovery.js';
import {
  exists,
  materializePreservedPlatforms,
  normalizeFinalDirectoryModes,
  normalizeScope,
  outputPaths,
  snapshotPreservedPlatforms,
  validateFinalDirectoryModes,
  validatePreservedPlatforms,
  validateStagePlatforms,
  writeTransactionMarker,
  type ManagedOutputScope,
  type TransactionRecord,
} from './transaction-files.js';

export type { ManagedOutputScope } from './transaction-files.js';

/** 受管输出事务可观测的稳定阶段名称。 */
export type ManagedOutputPhase
  = | 'lock-acquired'
    | 'recovery-complete'
    | 'stage-materialized'
    | 'stage-validated'
    | 'transaction-written'
    | 'backup-created'
    | 'output-swapped';

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
  const lockPath = locations.lock;
  /** transaction record 用于崩溃恢复。 */
  const transactionPath = locations.transaction;
  /** cleanup 完成后写入的 marker 将 pending transaction 提升为正式提交。 */
  const committedPath = locations.committed;
  /** backup 保存 swap 前的完整旧目录。 */
  const backupPath = locations.backup;
  /** 当前调用创建但尚未 swap 的 stage。 */
  let stage: string | undefined;
  /** rollback 判断旧输出是否已经移动。 */
  let backupCreated = false;
  /** rollback 判断新输出是否已经暴露。 */
  let outputSwapped = false;
  /** 仅清理当前调用已经创建的 transaction marker。 */
  let transactionWritten = false;

  /** lock token 从 recovery 一直持有到 cleanup 完成。 */
  const lockToken = await acquireManagedOutputLock(lockPath);
  try {
    await options.onPhase?.('lock-acquired');
    await recoverManagedOutput(locations, options.projectRoot);
    await options.onPhase?.('recovery-complete');

    /** subset 在锁内快照未选 Platform；full 使用空保留集。 */
    const preserved = scope.type === 'subset'
      ? await snapshotPreservedPlatforms(locations.resolved, new Set(scope.platforms))
      : Object.freeze([]);
    stage = await fs.mkdtemp(path.join(locations.parent, locations.stagePrefix));
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
      await releaseManagedOutputLock(lockPath, lockToken);
    } catch {
      /** 遗留 record 已撤销 active token，将由同 PID 的下一轮识别为 stale。 */
    }
  }
}
