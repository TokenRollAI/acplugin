import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { commitDeliveryUnits, type ManagedOutputPhase } from '../src/index.js';

/** 锁与崩溃恢复测试创建并统一清理的临时工程。 */
const temporaryDirectories: string[] = [];

/** @returns 已登记清理的临时工程根。 */
async function temporaryRoot(): Promise<string> {
  /** 当前测试独占的临时目录。 */
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-locking-test-'));
  temporaryDirectories.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

describe('managed output locking and recovery', () => {
  it('rejects a concurrent writer while the first process holds the lock', async () => {
    /** 两个 writer 竞争的受管输出工程。 */
    const root = await temporaryRoot();
    /** 两个事务共同竞争锁的输出目录。 */
    const outDir = path.join(root, 'dist');
    /** 第一事务取得锁后通知测试的 resolver。 */
    let notifyLocked!: () => void;
    /** 测试允许第一事务继续执行的 resolver。 */
    let releaseLock!: () => void;
    /** 确认第一事务已经持锁的同步 Promise。 */
    const locked = new Promise<void>((resolve) => {
      notifyLocked = resolve;
    });
    /** 第一事务在 lock-acquired 阶段等待的门闩。 */
    const gate = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    /** 持锁但尚未进入 recovery 的第一事务。 */
    const first = commitDeliveryUnits(outDir, [], {
      projectRoot: root,
      /** onPhase 在取得锁后暂停第一事务，供第二事务验证互斥。 */
      async onPhase(phase: ManagedOutputPhase): Promise<void> {
        if (phase === 'lock-acquired') {
          notifyLocked();
          await gate;
        }
      },
    });
    await locked;

    await expect(commitDeliveryUnits(outDir, [], { projectRoot: root })).rejects.toThrow('locked');
    releaseLock();
    await first;
    expect((await fs.readdir(root)).filter(name => name.endsWith('.acplugin.lock'))).toEqual([]);
  });

  it('recovers backup state and removes stale stages before starting a new transaction', async () => {
    /** 模拟进程在旧输出备份后退出的工程。 */
    const root = await temporaryRoot();
    /** 恢复后应重新出现的正式输出目录。 */
    const outDir = path.join(root, 'dist');
    /** 模拟崩溃时保留完整旧输出的备份目录。 */
    const backup = path.join(root, '.dist.acplugin-backup');
    /** 恢复阶段必须清理的不完整 Stage。 */
    const staleStage = path.join(root, '.dist.acplugin-stage-crashed');
    /** 描述崩溃事务状态的记录文件。 */
    const transaction = path.join(root, '.dist.acplugin-transaction.json');
    await fs.mkdir(backup, { recursive: true });
    await fs.writeFile(path.join(backup, 'old.txt'), 'old');
    await fs.mkdir(staleStage, { recursive: true });
    await fs.writeFile(path.join(staleStage, 'partial.txt'), 'partial');
    await fs.writeFile(transaction, '{"schemaVersion":1}\n');

    await expect(commitDeliveryUnits(outDir, [], {
      projectRoot: root,
      /** onPhase 在恢复完成后停止新事务，便于观察恢复结果。 */
      onPhase(phase) {
        if (phase === 'recovery-complete')
          throw new Error('stop after recovery');
      },
    })).rejects.toThrow('stop after recovery');

    expect(await fs.readFile(path.join(outDir, 'old.txt'), 'utf8')).toBe('old');
    await expect(fs.access(staleStage)).rejects.toThrow();
    await expect(fs.access(transaction)).rejects.toThrow();
  });

  it('removes a lock owned by a dead process and completes the commit', async () => {
    /** 带死进程锁记录的受管输出工程。 */
    const root = await temporaryRoot();
    /** 死锁清理后应完成提交的输出目录。 */
    const outDir = path.join(root, 'dist');
    /** 指向不存在进程的陈旧锁文件。 */
    const lock = path.join(root, '.dist.acplugin.lock');
    await fs.writeFile(lock, `${JSON.stringify({ schemaVersion: 1, pid: 99_999_999 })}\n`);

    await commitDeliveryUnits(outDir, [], { projectRoot: root });

    expect(await fs.readdir(outDir)).toEqual([]);
    await expect(fs.access(lock)).rejects.toThrow();
  });
});
