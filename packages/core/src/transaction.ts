import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hashFile } from './artifacts.js';
import type { Awaitable, DeliveryUnit, MaterializedCandidate } from './contracts.js';
import type { Artifact } from './types.js';

/** 受管输出事务可观测的稳定阶段名称。 */
export type ManagedOutputPhase
  = | 'lock-acquired'
    | 'recovery-complete'
    | 'stage-materialized'
    | 'stage-validated'
    | 'transaction-written'
    | 'backup-created'
    | 'output-swapped';

/** 控制 DeliveryUnit 集合提交阶段通知和交换后收尾行为。 */
export interface CommitDeliveryUnitsOptions {
  /** 可选工程根；提供时 outDir 必须严格位于其内部且不能等于工程根。 */
  projectRoot?: string;
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
 * 将单个已经过 ArtifactRegistry 验证的产物写入阶段目录。
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
 * 重新读取一个目录内的 Artifact，复核类型、摘要、大小和权限。
 *
 * @param root Artifact 已物化到的单元根目录。
 * @param artifacts Registry 提供的完整性基准。
 * @param label 错误消息使用的稳定单元标签。
 */
async function validateMaterializedArtifacts(
  root: string,
  artifacts: readonly Artifact[],
  label: string,
): Promise<void> {
  for (const artifact of artifacts) {
    /** 当前 Artifact 实际写入的文件路径。 */
    const destination = path.join(root, ...artifact.path.split('/'));
    /** 用于拒绝符号链接和非普通文件的实际元数据。 */
    const stat = await fs.lstat(destination);
    if (stat.isSymbolicLink() || !stat.isFile())
      throw new Error(`Materialized Artifact is not a regular file: ${label}/${artifact.path}`);
    /** 从磁盘重新计算的字节数与摘要。 */
    const actual = await hashFile(destination);
    if (actual.size !== artifact.size || actual.sha256 !== artifact.sha256)
      throw new Error(`Materialized Artifact integrity mismatch: ${label}/${artifact.path}`);
    if ((stat.mode & 0o777) !== artifact.mode)
      throw new Error(`Materialized Artifact mode mismatch: ${label}/${artifact.path}`);
  }
}

/**
 * 将各 DeliveryUnit 根的 Artifact 以稳定顺序物化到指定目录。
 *
 * @param root 全部 DeliveryUnit 共同使用的物化根目录。
 * @param unitRoots 单元相对根到已完成 Registry 校验的 Artifact 列表。
 */
async function materializeUnitRoots(
  root: string,
  unitRoots: ReadonlyMap<string, readonly Artifact[]>,
): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  for (const unitRoot of [...unitRoots.keys()].sort()) {
    /** 当前 DeliveryUnit 在物化根目录下的隔离子目录。 */
    const directory = path.join(root, unitRoot);
    await fs.mkdir(directory, { recursive: true });
    for (const artifact of unitRoots.get(unitRoot) ?? [])
      await materializeFile(directory, artifact);
  }
}

/**
 * 重新读取已物化文件，验证文件类型、内容摘要、大小和权限。
 *
 * @param root 先前执行物化操作的根目录。
 * @param unitRoots 单元相对根到完整性基准 Artifact 的映射。
 * @throws 物化内容与 Artifact 契约不一致时抛出异常。
 */
async function validateMaterializedUnitRoots(
  root: string,
  unitRoots: ReadonlyMap<string, readonly Artifact[]>,
): Promise<void> {
  for (const unitRoot of [...unitRoots.keys()].sort()) {
    /** 当前 DeliveryUnit 已物化文件的根目录。 */
    const directory = path.join(root, unitRoot);
    await validateMaterializedArtifacts(directory, unitRoots.get(unitRoot) ?? [], unitRoot);
  }
}

/**
 * 在系统临时目录中完整演练物化和完整性校验，但不修改真实输出目录。
 *
 * @param unitRoots 单元相对根到已完成 Registry 校验的 Artifact 列表。
 */
async function validateUnitRootMaterialization(
  unitRoots: ReadonlyMap<string, readonly Artifact[]>,
): Promise<void> {
  /** 本次验证独占且无论成功失败都会删除的临时目录。 */
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-validate-'));
  try {
    await materializeUnitRoots(temporary, unitRoots);
    await validateMaterializedUnitRoots(temporary, unitRoots);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

/** 独立候选目录及其幂等清理函数。 */
export interface MaterializedCandidateHandle {
  readonly candidate: MaterializedCandidate;
  readonly cleanup: () => Promise<void>;
}

/**
 * 在独占临时目录中物化一个 DeliveryUnit 候选并复核完整性。
 *
 * @param unit 已通过全局 Registry 的交付单元。
 * @param temporaryParent 可选的 Platform 独占临时目录。
 * @returns 可交给 Platform Validator 的只读候选与清理函数。
 */
export async function materializeDeliveryUnitCandidate(
  unit: DeliveryUnit,
  temporaryParent: string = os.tmpdir(),
): Promise<MaterializedCandidateHandle> {
  await fs.mkdir(temporaryParent, { recursive: true });
  /** 当前候选独占且不包含最终 outDir 信息的临时根。 */
  const root = await fs.mkdtemp(path.join(temporaryParent, 'acplugin-candidate-'));
  try {
    for (const artifact of unit.artifacts)
      await materializeFile(root, artifact);
    await validateMaterializedArtifacts(root, unit.artifacts, `${unit.platform}/${unit.id}`);
  } catch /** error 保存当前操作捕获的异常，供本阶段转换或恢复。 */ (error) {
    await fs.rm(root, { recursive: true, force: true });
    throw error;
  }
  /** 只读类型和冻结外壳阻止 Validator 替换候选身份。 */
  const candidate = Object.freeze({ root, unit });
  return Object.freeze({
    candidate,
    /** Platform Validator 返回后删除整个独占候选目录。 */
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  });
}

/**
 * 在独立候选上执行 Platform Validator，并在其返回后再次复核文件完整性。
 *
 * @param unit 已通过 Registry 的交付单元。
 * @param validate 只读观察候选内容的平台校验函数。
 * @param temporaryParent 可选的 Platform 独占临时目录。
 */
export async function withMaterializedDeliveryUnitCandidate(
  unit: DeliveryUnit,
  validate: (candidate: MaterializedCandidate) => Awaitable<void>,
  temporaryParent?: string,
): Promise<void> {
  /** 当前 Validator 独占的候选句柄。 */
  const handle = await materializeDeliveryUnitCandidate(unit, temporaryParent);
  try {
    await validate(handle.candidate);
    // Validator 契约是只读的；返回后复核可在运行时发现意外或恶意修改。
    await validateMaterializedArtifacts(handle.candidate.root, unit.artifacts, `${unit.platform}/${unit.id}`);
  } finally {
    await handle.cleanup();
  }
}

/**
 * 把 DeliveryUnit 集合转换为受管输出树路径映射。
 *
 * @param units 全局 Registry 的稳定单元快照。
 * @returns `<platform>/<unit-id>` 到 Artifact 列表的唯一映射。
 */
function deliveryUnitRoots(units: readonly DeliveryUnit[]): ReadonlyMap<string, readonly Artifact[]> {
  /** 单元物理根到 Artifact 列表的稳定映射。 */
  const roots = new Map<string, readonly Artifact[]>();
  for (const unit of units) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(unit.platform) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(unit.id))
      throw new Error('DeliveryUnit Platform and id must use lowercase kebab-case.');
    /** 最终 outDir 内的两级受管相对路径。 */
    const key = `${unit.platform}/${unit.id}`;
    if (roots.has(key))
      throw new Error(`Duplicate DeliveryUnit "${key}".`);
    roots.set(key, unit.artifacts);
  }
  return roots;
}

/**
 * 将全部 DeliveryUnit 物化为最终两级目录布局。
 *
 * @param root 候选或 stage 根目录。
 * @param units 全局 Registry 的单元快照。
 */
export async function materializeDeliveryUnits(root: string, units: readonly DeliveryUnit[]): Promise<void> {
  await materializeUnitRoots(root, deliveryUnitRoots(units));
}

/**
 * 在临时目录演练全部 DeliveryUnit 的物化和完整性复核。
 *
 * @param units 全局 Registry 的单元快照。
 */
export async function validateDeliveryUnitMaterialization(units: readonly DeliveryUnit[]): Promise<void> {
  await validateUnitRootMaterialization(deliveryUnitRoots(units));
}

/**
 * 原子提交全部 DeliveryUnit；任意失败都不会形成部分 Platform 输出。
 *
 * @param outDir 框架完全管理的输出目录。
 * @param units 全局 Registry 的完整单元快照。
 * @param options 锁、边界和故障注入选项。
 */
export async function commitDeliveryUnits(
  outDir: string,
  units: readonly DeliveryUnit[],
  options: CommitDeliveryUnitsOptions = {},
): Promise<void> {
  await commitUnitRoots(outDir, deliveryUnitRoots(units), options);
}

/**
 * 通过加锁、阶段目录、备份和目录交换原子提交全部 DeliveryUnit 根。
 *
 * 同级事务记录与备份允许下一次调用修复进程中断留下的状态；交换后 Hook 失败时，
 * 当前调用会删除新输出并恢复旧目录，保证调用方只观察到完整的新旧版本之一。
 *
 * @param outDir 由 acplugin 完全管理的输出目录。
 * @param unitRoots 单元相对根到已完成 Registry 校验的 Artifact 列表。
 * @param options 阶段通知与交换后事务 Hook。
 * @throws 输出路径不安全、存在活跃锁、物化失败或回滚失败时抛出异常。
 */
async function commitUnitRoots(
  outDir: string,
  unitRoots: ReadonlyMap<string, readonly Artifact[]>,
  options: CommitDeliveryUnitsOptions = {},
): Promise<void> {
  /** 规范化后的受管输出绝对路径。 */
  const resolved = path.resolve(outDir);
  /** 存放输出、锁、阶段目录和备份的共同父目录。 */
  const parent = path.dirname(resolved);
  /** 用于构造同级事务辅助路径的输出目录名称。 */
  const base = path.basename(resolved);
  if (resolved === path.parse(resolved).root || base === '' || base === '.' || base === '..')
    throw new Error(`Unsafe managed output path: ${outDir}`);
  if (options.projectRoot !== undefined) {
    /** 调用方提供并解析后的可信工程根。 */
    const projectRoot = path.resolve(options.projectRoot);
    /** outDir 相对于工程根的位置，用于拒绝工程根本身和目录逃逸。 */
    const outputRelative = path.relative(projectRoot, resolved);
    if (outputRelative === '' || path.isAbsolute(outputRelative) || outputRelative === '..' || outputRelative.startsWith(`..${path.sep}`))
      throw new Error(`Managed output must stay strictly inside the project root: ${outDir}`);
  }

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
    } catch /** error 保存当前操作捕获的异常，供本阶段转换或恢复。 */ (error) {
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
        } catch /** processError 保存当前操作捕获的异常，供本阶段转换或恢复。 */ (processError) {
          if ((processError as NodeJS.ErrnoException).code !== 'ESRCH')
            throw processError;
        }
        await fs.rm(lockPath, { force: true });
        /** 清理死进程锁后由当前进程重新取得的句柄。 */
        const handle = await fs.open(lockPath, 'wx');
        await handle.writeFile(`${JSON.stringify({ schemaVersion: 1, pid: process.pid })}\n`);
        return handle;
      } catch /** lockError 保存当前操作捕获的异常，供本阶段转换或恢复。 */ (lockError) {
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
    /** 清理由任何上次中断阶段遗留、且具有当前 outDir 专属前缀的 stage。 */
    const staleStagePrefix = `.${base}.acplugin-stage-`;
    for (const entry of await fs.readdir(parent, { withFileTypes: true })) {
      if (entry.name.startsWith(staleStagePrefix))
        await fs.rm(path.join(parent, entry.name), { recursive: true, force: true });
    }
    await options.onPhase?.('recovery-complete');

    // 阶段目录必须与输出同级，后续 rename 才能保持同一文件系统内的原子交换语义。
    stage = await fs.mkdtemp(path.join(parent, `.${base}.acplugin-stage-`));
    await materializeUnitRoots(stage, unitRoots);
    await options.onPhase?.('stage-materialized');
    await validateMaterializedUnitRoots(stage, unitRoots);
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
    } catch /** error 保存当前操作捕获的异常，供本阶段转换或恢复。 */ (error) {
      // 交换或 afterSwap 失败时，先移除不完整的新输出，再把旧备份恢复到正式路径。
      try {
        if (outputSwapped && await exists(resolved))
          await fs.rm(resolved, { recursive: true, force: true });
        if (backupCreated && await exists(backupPath))
          await fs.rename(backupPath, resolved);
      } catch /** rollbackError 保存当前操作捕获的异常，供本阶段转换或恢复。 */ (rollbackError) {
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
  } catch /** error 保存当前操作捕获的异常，供本阶段转换或恢复。 */ (error) {
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
