import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PackageUnitSnapshot } from '../../src/contracts/index.js';
import { AssetRegistry } from '../../src/services/assets.js';
import { BuildSessionScope } from '../../src/lifecycle/session-scope.js';
import { SourceRegistry } from '../../src/services/sources.js';
import { WorkDirectoryRegistry } from '../../src/services/work-directories.js';
import { commitPackageUnits, type ManagedOutputPhase } from '../../src/output/transaction.js';

/** Transaction 测试统一清理的临时工程根。 */
const roots: string[] = [];

/** @returns 一个工程根和当前 BuildSession Asset Registry。 */
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-transaction-v2-'));
  roots.push(root);
  const scope = new BuildSessionScope();
  const sources = new SourceRegistry(scope, root);
  const work = new WorkDirectoryRegistry(scope, path.join(root, '.work'));
  const assets = new AssetRegistry(scope, sources, work);
  return { root, assets };
}

/** @returns 指定 Platform/version 的主 Package Unit。 */
async function unit(assets: AssetRegistry, platform: string, version: string): Promise<PackageUnitSnapshot> {
  /** 当前 Platform 签发自己的稳定版本 Asset。 */
  const asset = await assets.service(`platform:${platform}`).fromBytes({
    bytes: version, origin: { operation: 'version' },
  });
  return Object.freeze({
    platform, id: 'plugin', type: 'plugin', role: 'primary',
    assets: Object.freeze([{ path: 'version.txt', owner: `platform:${platform}`, asset }]),
    compatibility: Object.freeze([]), metadata: Object.freeze([]),
  });
}

/** @returns 当前工程内的受管输出辅助文件。 */
async function helpers(root: string): Promise<readonly string[]> {
  return (await fs.readdir(root))
    .filter(name => name.startsWith('.dist.acplugin-') || name.startsWith('.dist.acplugin.lock'))
    .sort();
}

/** 写入模拟进程崩溃后遗留的稳定事务 marker。 */
async function transactionMarker(root: string, name: 'transaction' | 'committed', hadOutput: boolean): Promise<void> {
  await fs.writeFile(path.join(root, `.dist.acplugin-${name}.json`), `${JSON.stringify({
    schemaVersion: 2,
    outDir: 'dist',
    scope: 'full',
    hadOutput,
  })}\n`);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe('Package Unit atomic transaction', () => {
  it('preserves the previous complete output at every fault-injection phase', async () => {
    const phases: readonly ManagedOutputPhase[] = [
      'lock-acquired', 'recovery-complete', 'stage-materialized', 'stage-validated',
      'transaction-written', 'backup-created', 'output-swapped',
    ];
    for (const phase of phases) {
      const current = await fixture();
      const outDir = path.join(current.root, 'dist');
      await fs.mkdir(path.join(outDir, 'target', 'plugin'), { recursive: true });
      await fs.writeFile(path.join(outDir, 'target', 'plugin', 'version.txt'), 'old');
      const packageUnit = await unit(current.assets, 'target', 'new');

      await expect(commitPackageUnits(outDir, [packageUnit], current.assets, {
        projectRoot: current.root,
        onPhase(stage) {
          if (stage === phase)
            throw new Error(`fail at ${phase}`);
        },
      })).rejects.toThrow(`fail at ${phase}`);

      expect(await fs.readFile(path.join(outDir, 'target', 'plugin', 'version.txt'), 'utf8')).toBe('old');
      expect(await helpers(current.root)).toEqual([]);
    }
  });

  it('rolls back when atomic committed-marker publication fails', async () => {
    const current = await fixture();
    const outDir = path.join(current.root, 'dist');
    await fs.mkdir(path.join(outDir, 'target', 'plugin'), { recursive: true });
    await fs.writeFile(path.join(outDir, 'target', 'plugin', 'version.txt'), 'old');
    const packageUnit = await unit(current.assets, 'target', 'new');
    /** 只注入 committed marker，避免 lock/guard 的原子发布改变调用序号。 */
    const realLink = fs.link.bind(fs);
    const link = vi.spyOn(fs, 'link').mockImplementation(async (existingPath, newPath) => {
      if (String(newPath).endsWith('.dist.acplugin-committed.json'))
        throw new Error('committed marker publication failed');
      await realLink(existingPath, newPath);
    });
    try {
      await expect(commitPackageUnits(outDir, [packageUnit], current.assets, {
        projectRoot: current.root,
      })).rejects.toThrow('committed marker publication failed');
    } finally {
      link.mockRestore();
    }

    expect(await fs.readFile(path.join(outDir, 'target', 'plugin', 'version.txt'), 'utf8')).toBe('old');
    expect(await helpers(current.root)).toEqual([]);
  });

  it.each(['writeFile', 'sync'] as const)(
    'cleans a final lock draft when %s fails',
    async (operation) => {
      const current = await fixture();
      const outDir = path.join(current.root, 'dist');
      const lock = path.join(current.root, '.dist.acplugin.lock');
      await fs.mkdir(path.join(outDir, 'target', 'plugin'), { recursive: true });
      await fs.writeFile(path.join(outDir, 'target', 'plugin', 'version.txt'), 'old');
      const realOpen = fs.open.bind(fs);
      let injected = false;
      const open = vi.spyOn(fs, 'open').mockImplementation(async (file, flags, mode) => {
        const handle = await realOpen(file, flags, mode);
        const candidate = String(file);
        if (!injected && candidate.startsWith(`${lock}.`) && candidate.endsWith('.writing')
          && !candidate.startsWith(`${lock}.guard.`)) {
          injected = true;
          vi.spyOn(handle, operation).mockRejectedValueOnce(new Error(`lock ${operation} failed`));
        }
        return handle;
      });
      try {
        await expect(commitPackageUnits(outDir, [], current.assets, { projectRoot: current.root }))
          .rejects.toThrow(`lock ${operation} failed`);
      } finally {
        open.mockRestore();
      }

      expect(injected).toBe(true);
      expect(await fs.readFile(path.join(outDir, 'target', 'plugin', 'version.txt'), 'utf8')).toBe('old');
      expect(await helpers(current.root)).toEqual([]);
    },
  );

  it('retries a transient final lock close failure without leaking its handle or draft', async () => {
    const current = await fixture();
    const outDir = path.join(current.root, 'dist');
    const lock = path.join(current.root, '.dist.acplugin.lock');
    const realOpen = fs.open.bind(fs);
    let injected = false;
    const open = vi.spyOn(fs, 'open').mockImplementation(async (file, flags, mode) => {
      const handle = await realOpen(file, flags, mode);
      const candidate = String(file);
      if (!injected && candidate.startsWith(`${lock}.`) && candidate.endsWith('.writing')
        && !candidate.startsWith(`${lock}.guard.`)) {
        injected = true;
        vi.spyOn(handle, 'close').mockRejectedValueOnce(new Error('lock close failed'));
      }
      return handle;
    });
    try {
      await commitPackageUnits(outDir, [], current.assets, { projectRoot: current.root });
    } finally {
      open.mockRestore();
    }

    expect(injected).toBe(true);
    expect(await helpers(current.root)).toEqual([]);
  });

  it('cleans a final lock draft when atomic publication fails', async () => {
    const current = await fixture();
    const outDir = path.join(current.root, 'dist');
    const lock = path.join(current.root, '.dist.acplugin.lock');
    const realLink = fs.link.bind(fs);
    let injected = false;
    const link = vi.spyOn(fs, 'link').mockImplementation(async (existingPath, newPath) => {
      if (!injected && String(newPath) === lock) {
        injected = true;
        throw new Error('lock publication failed');
      }
      await realLink(existingPath, newPath);
    });
    try {
      await expect(commitPackageUnits(outDir, [], current.assets, { projectRoot: current.root }))
        .rejects.toThrow('lock publication failed');
    } finally {
      link.mockRestore();
    }

    expect(injected).toBe(true);
    expect(await helpers(current.root)).toEqual([]);
  });

  it.each(['draft', 'record'] as const)(
    'retries a transient final lock %s removal failure',
    async (target) => {
      const current = await fixture();
      const outDir = path.join(current.root, 'dist');
      const lock = path.join(current.root, '.dist.acplugin.lock');
      const realRm = fs.rm.bind(fs);
      let injected = false;
      const rm = vi.spyOn(fs, 'rm').mockImplementation(async (file, options) => {
        const candidate = String(file);
        const finalDraft = candidate.startsWith(`${lock}.`) && candidate.endsWith('.writing')
          && !candidate.startsWith(`${lock}.guard.`);
        if (!injected && (target === 'record' ? candidate === lock : finalDraft)) {
          injected = true;
          throw new Error(`lock ${target} remove failed`);
        }
        await realRm(file, options);
      });
      try {
        await commitPackageUnits(outDir, [], current.assets, { projectRoot: current.root });
      } finally {
        rm.mockRestore();
      }

      expect(injected).toBe(true);
      expect(await helpers(current.root)).toEqual([]);
    },
  );

  it('replaces the full configured output set atomically', async () => {
    const current = await fixture();
    const outDir = path.join(current.root, 'dist');
    await fs.mkdir(path.join(outDir, 'stale', 'plugin'), { recursive: true });
    await fs.writeFile(path.join(outDir, 'stale', 'plugin', 'version.txt'), 'stale');

    await commitPackageUnits(outDir, [await unit(current.assets, 'target', 'new')], current.assets, {
      projectRoot: current.root,
      scope: { type: 'full' },
    });

    expect(await fs.readFile(path.join(outDir, 'target', 'plugin', 'version.txt'), 'utf8')).toBe('new');
    await expect(fs.access(path.join(outDir, 'stale'))).rejects.toThrow();
    if (process.platform !== 'win32') {
      for (const directory of [outDir, path.join(outDir, 'target'), path.join(outDir, 'target', 'plugin')])
        expect((await fs.stat(directory)).mode & 0o777).toBe(0o755);
      expect((await fs.stat(path.join(outDir, 'target', 'plugin', 'version.txt'))).mode & 0o777).toBe(0o644);
    }
  });

  it('replaces an explicit subset while preserving validated unselected Platform bytes and mode', async () => {
    const current = await fixture();
    const outDir = path.join(current.root, 'dist');
    const preserved = path.join(outDir, 'other', 'plugin', 'bin', 'main.mjs');
    await fs.mkdir(path.dirname(preserved), { recursive: true });
    await fs.writeFile(preserved, 'old-other', { mode: 0o755 });
    await fs.mkdir(path.join(outDir, 'target', 'plugin'), { recursive: true });
    await fs.writeFile(path.join(outDir, 'target', 'plugin', 'version.txt'), 'old-target');
    /** 旧输出的私有目录 mode 不得原样污染新的 subset stage。 */
    if (process.platform !== 'win32') {
      for (const directory of [outDir, path.join(outDir, 'other'), path.join(outDir, 'other', 'plugin'), path.dirname(preserved), path.join(outDir, 'target'), path.join(outDir, 'target', 'plugin')])
        await fs.chmod(directory, 0o700);
    }

    await commitPackageUnits(outDir, [await unit(current.assets, 'target', 'new-target')], current.assets, {
      projectRoot: current.root,
      scope: { type: 'subset', platforms: ['target'] },
    });

    expect(await fs.readFile(path.join(outDir, 'target', 'plugin', 'version.txt'), 'utf8')).toBe('new-target');
    expect(await fs.readFile(preserved, 'utf8')).toBe('old-other');
    expect((await fs.stat(preserved)).mode & 0o777).toBe(0o755);
    if (process.platform !== 'win32') {
      for (const directory of [
        outDir,
        path.join(outDir, 'other'),
        path.join(outDir, 'other', 'plugin'),
        path.dirname(preserved),
        path.join(outDir, 'target'),
        path.join(outDir, 'target', 'plugin'),
      ]) expect((await fs.stat(directory)).mode & 0o777).toBe(0o755);
      expect((await fs.stat(path.join(outDir, 'target', 'plugin', 'version.txt'))).mode & 0o777).toBe(0o644);
    }
  });

  it('rejects a stage directory mode mutation before swap', async () => {
    if (process.platform === 'win32')
      return;
    const current = await fixture();
    const outDir = path.join(current.root, 'dist');
    await fs.mkdir(path.join(outDir, 'target', 'plugin'), { recursive: true });
    await fs.writeFile(path.join(outDir, 'target', 'plugin', 'version.txt'), 'old');

    await expect(commitPackageUnits(outDir, [await unit(current.assets, 'target', 'new')], current.assets, {
      projectRoot: current.root,
      async onPhase(phase) {
        if (phase !== 'stage-materialized')
          return;
        /** fault injection 只定位当前事务唯一 stage，不依赖随机 suffix。 */
        const stage = (await fs.readdir(current.root)).find(name => name.startsWith('.dist.acplugin-stage-'))!;
        await fs.chmod(path.join(current.root, stage, 'target'), 0o700);
      },
    })).rejects.toThrow('mode 0755');

    expect(await fs.readFile(path.join(outDir, 'target', 'plugin', 'version.txt'), 'utf8')).toBe('old');
    expect(await helpers(current.root)).toEqual([]);
  });

  it('rejects unsafe subset trees and Platform set mismatches before swap', async () => {
    const current = await fixture();
    const outDir = path.join(current.root, 'dist');
    await fs.mkdir(path.join(outDir, 'other', 'plugin'), { recursive: true });
    await fs.symlink(current.root, path.join(outDir, 'other', 'plugin', 'escape'));
    const packageUnit = await unit(current.assets, 'target', 'new');

    await expect(commitPackageUnits(outDir, [packageUnit], current.assets, {
      projectRoot: current.root, scope: { type: 'subset', platforms: ['target'] },
    })).rejects.toThrow('symbolic link');
    await expect(commitPackageUnits(outDir, [packageUnit], current.assets, {
      projectRoot: current.root, scope: { type: 'subset', platforms: ['other'] },
    })).rejects.toThrow('exactly match');
  });

  it('rejects source TOCTOU and leaves old output intact', async () => {
    const current = await fixture();
    const outDir = path.join(current.root, 'dist');
    await fs.mkdir(path.join(outDir, 'target', 'plugin'), { recursive: true });
    await fs.writeFile(path.join(outDir, 'target', 'plugin', 'version.txt'), 'old');
    const sourceRoot = path.join(current.root, 'public');
    await fs.mkdir(sourceRoot);
    await fs.writeFile(path.join(sourceRoot, 'data.txt'), 'original');
    /** 本测试使用独立 Registry 公开 Source API 签发 TOCTOU ref。 */
    const scope = new BuildSessionScope();
    const sources = new SourceRegistry(scope, current.root);
    const work = new WorkDirectoryRegistry(scope, path.join(current.root, '.work-source'));
    const assets = new AssetRegistry(scope, sources, work);
    const rootRef = await sources.issueRoot('framework:public', sourceRoot);
    const source = await sources.service('framework:public').file(rootRef, 'data.txt');
    const asset = await assets.service('framework:public').fromSource(source);
    assets.grant('framework:public', 'platform:target', asset);
    const packageUnit: PackageUnitSnapshot = Object.freeze({
      platform: 'target', id: 'plugin', type: 'plugin', role: 'primary',
      assets: Object.freeze([{ path: 'data.txt', owner: 'framework:public', asset }]),
      compatibility: Object.freeze([]), metadata: Object.freeze([]),
    });
    await fs.writeFile(path.join(sourceRoot, 'data.txt'), 'changed');

    await expect(commitPackageUnits(outDir, [packageUnit], assets, { projectRoot: current.root })).rejects.toThrow('changed after');
    expect(await fs.readFile(path.join(outDir, 'target', 'plugin', 'version.txt'), 'utf8')).toBe('old');
  });

  it('rejects project root and outside targets before creating transaction state', async () => {
    const current = await fixture();
    const outside = await fixture();

    await expect(commitPackageUnits(current.root, [], current.assets, { projectRoot: current.root })).rejects.toThrow('strictly inside');
    await expect(commitPackageUnits(path.join(outside.root, 'dist'), [], current.assets, { projectRoot: current.root })).rejects.toThrow('strictly inside');
    /** 现有 outDir 符号链接也不能被当成受管目录替换。 */
    const linkedOut = path.join(current.root, 'linked-dist');
    await fs.symlink(outside.root, linkedOut);
    await expect(commitPackageUnits(linkedOut, [], current.assets, { projectRoot: current.root })).rejects.toThrow('symbolic links');
    expect(await helpers(current.root)).toEqual([]);
  });

  it('rejects a concurrent writer while the first transaction holds the lock', async () => {
    const current = await fixture();
    const outDir = path.join(current.root, 'dist');
    let notifyLocked!: () => void;
    let releaseLock!: () => void;
    /** locked 与 gate 精确控制两个 transaction 的竞争窗口。 */
    const locked = new Promise<void>((resolve) => {
      notifyLocked = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const first = commitPackageUnits(outDir, [], current.assets, {
      projectRoot: current.root,
      async onPhase(phase) {
        if (phase === 'lock-acquired') {
          notifyLocked();
          await gate;
        }
      },
    });
    await locked;

    await expect(commitPackageUnits(outDir, [], current.assets, { projectRoot: current.root })).rejects.toThrow('locked');
    releaseLock();
    await first;
    expect(await helpers(current.root)).toEqual([]);
  });

  it('serializes stale-lock recovery before another writer can replace the observed record', async () => {
    /** dead lock 让第一个事务进入 quarantine 临界区。 */
    const current = await fixture();
    const outDir = path.join(current.root, 'dist');
    const lock = path.join(current.root, '.dist.acplugin.lock');
    await fs.writeFile(lock, `${JSON.stringify({
      schemaVersion: 3,
      pid: 99_999_999,
      token: '00000000-0000-4000-8000-000000000003',
    })}\n`);
    /** entered 与 gate 把首次 quarantine rename 固定在可竞争窗口。 */
    let notifyEntered!: () => void;
    let continueRecovery!: () => void;
    const entered = new Promise<void>((resolve) => {
      notifyEntered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      continueRecovery = resolve;
    });
    /** 真实 rename 仅在 stale lock 路径上注入暂停。 */
    const realRename = fs.rename.bind(fs);
    const rename = vi.spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
      if (String(source) === lock && String(destination).endsWith('.stale')) {
        notifyEntered();
        await gate;
      }
      return realRename(source, destination);
    });
    try {
      /** 第一个 writer 持有 metadata guard 并暂停在 stale quarantine。 */
      const first = commitPackageUnits(outDir, [], current.assets, { projectRoot: current.root });
      await entered;
      /** 第二个 writer 不能移除/替换 final lock，只能在 guard 外失败关闭。 */
      let secondError: unknown;
      try {
        await commitPackageUnits(outDir, [], current.assets, { projectRoot: current.root });
      } catch (error) {
        secondError = error;
      }
      expect(secondError).toBeInstanceOf(Error);
      expect((secondError as Error).message).toContain('locked');
      continueRecovery();
      await first;
    } finally {
      continueRecovery();
      rename.mockRestore();
    }
    expect(await helpers(current.root)).toEqual([]);
  });

  it('recovers backup/record/stale-stage state before starting a new transaction', async () => {
    const current = await fixture();
    const outDir = path.join(current.root, 'dist');
    const backup = path.join(current.root, '.dist.acplugin-backup');
    const staleStage = path.join(current.root, '.dist.acplugin-stage-crashed');
    const transaction = path.join(current.root, '.dist.acplugin-transaction.json');
    await fs.mkdir(path.join(backup, 'old', 'plugin'), { recursive: true });
    await fs.writeFile(path.join(backup, 'old', 'plugin', 'version.txt'), 'old');
    await fs.mkdir(staleStage);
    await fs.writeFile(path.join(staleStage, 'partial.txt'), 'partial');
    await transactionMarker(current.root, 'transaction', true);

    await expect(commitPackageUnits(outDir, [], current.assets, {
      projectRoot: current.root,
      onPhase(phase) {
        if (phase === 'recovery-complete')
          throw new Error('stop after recovery');
      },
    })).rejects.toThrow('stop after recovery');

    expect(await fs.readFile(path.join(outDir, 'old', 'plugin', 'version.txt'), 'utf8')).toBe('old');
    await expect(fs.access(staleStage)).rejects.toThrow();
    await expect(fs.access(transaction)).rejects.toThrow();
  });

  it('rolls back an exposed output after a process crash before cleanup committed', async () => {
    const current = await fixture();
    const outDir = path.join(current.root, 'dist');
    const backup = path.join(current.root, '.dist.acplugin-backup');
    await fs.mkdir(path.join(outDir, 'target', 'plugin'), { recursive: true });
    await fs.writeFile(path.join(outDir, 'target', 'plugin', 'version.txt'), 'uncommitted-new');
    await fs.mkdir(path.join(backup, 'target', 'plugin'), { recursive: true });
    await fs.writeFile(path.join(backup, 'target', 'plugin', 'version.txt'), 'old');
    await transactionMarker(current.root, 'transaction', true);

    await expect(commitPackageUnits(outDir, [], current.assets, {
      projectRoot: current.root,
      onPhase(phase) {
        if (phase === 'recovery-complete')
          throw new Error('stop after rollback recovery');
      },
    })).rejects.toThrow('stop after rollback recovery');

    expect(await fs.readFile(path.join(outDir, 'target', 'plugin', 'version.txt'), 'utf8')).toBe('old');
    expect(await helpers(current.root)).toEqual([]);
  });

  it('removes a first-build output exposed before cleanup committed', async () => {
    const current = await fixture();
    const outDir = path.join(current.root, 'dist');
    await fs.mkdir(path.join(outDir, 'target', 'plugin'), { recursive: true });
    await fs.writeFile(path.join(outDir, 'target', 'plugin', 'version.txt'), 'uncommitted-first');
    await transactionMarker(current.root, 'transaction', false);

    await expect(commitPackageUnits(outDir, [], current.assets, {
      projectRoot: current.root,
      onPhase(phase) {
        if (phase === 'recovery-complete')
          throw new Error('stop after first-build recovery');
      },
    })).rejects.toThrow('stop after first-build recovery');

    await expect(fs.access(outDir)).rejects.toThrow();
    expect(await helpers(current.root)).toEqual([]);
  });

  it('keeps a cleanup-committed output and discards its old backup', async () => {
    const current = await fixture();
    const outDir = path.join(current.root, 'dist');
    const backup = path.join(current.root, '.dist.acplugin-backup');
    await fs.mkdir(path.join(outDir, 'target', 'plugin'), { recursive: true });
    await fs.writeFile(path.join(outDir, 'target', 'plugin', 'version.txt'), 'committed-new');
    await fs.mkdir(path.join(backup, 'target', 'plugin'), { recursive: true });
    await fs.writeFile(path.join(backup, 'target', 'plugin', 'version.txt'), 'old');
    await transactionMarker(current.root, 'transaction', true);
    await transactionMarker(current.root, 'committed', true);

    await expect(commitPackageUnits(outDir, [], current.assets, {
      projectRoot: current.root,
      onPhase(phase) {
        if (phase === 'recovery-complete')
          throw new Error('stop after committed recovery');
      },
    })).rejects.toThrow('stop after committed recovery');

    expect(await fs.readFile(path.join(outDir, 'target', 'plugin', 'version.txt'), 'utf8')).toBe('committed-new');
    expect(await helpers(current.root)).toEqual([]);
  });

  it('ignores an unpublished transaction marker draft after a process crash', async () => {
    const current = await fixture();
    const outDir = path.join(current.root, 'dist');
    await fs.mkdir(path.join(outDir, 'target', 'plugin'), { recursive: true });
    await fs.writeFile(path.join(outDir, 'target', 'plugin', 'version.txt'), 'old');
    /** 截断草稿模拟进程在首次 marker 原子发布前退出。 */
    await fs.writeFile(path.join(current.root, '.dist.acplugin-transaction.json.writing'), '{"schemaVersion":');

    await expect(commitPackageUnits(outDir, [], current.assets, {
      projectRoot: current.root,
      onPhase(phase) {
        if (phase === 'recovery-complete')
          throw new Error('stop after transaction draft recovery');
      },
    })).rejects.toThrow('stop after transaction draft recovery');

    expect(await fs.readFile(path.join(outDir, 'target', 'plugin', 'version.txt'), 'utf8')).toBe('old');
    expect(await helpers(current.root)).toEqual([]);
  });

  it('rolls back when a process crashes before publishing the committed marker', async () => {
    const current = await fixture();
    const outDir = path.join(current.root, 'dist');
    const backup = path.join(current.root, '.dist.acplugin-backup');
    await fs.mkdir(path.join(outDir, 'target', 'plugin'), { recursive: true });
    await fs.writeFile(path.join(outDir, 'target', 'plugin', 'version.txt'), 'uncommitted-new');
    await fs.mkdir(path.join(backup, 'target', 'plugin'), { recursive: true });
    await fs.writeFile(path.join(backup, 'target', 'plugin', 'version.txt'), 'old');
    await transactionMarker(current.root, 'transaction', true);
    /** 截断草稿不是权威 committed marker，恢复必须选择 rollback。 */
    await fs.writeFile(path.join(current.root, '.dist.acplugin-committed.json.writing'), '{"schemaVersion":');

    await expect(commitPackageUnits(outDir, [], current.assets, {
      projectRoot: current.root,
      onPhase(phase) {
        if (phase === 'recovery-complete')
          throw new Error('stop after committed draft recovery');
      },
    })).rejects.toThrow('stop after committed draft recovery');

    expect(await fs.readFile(path.join(outDir, 'target', 'plugin', 'version.txt'), 'utf8')).toBe('old');
    expect(await helpers(current.root)).toEqual([]);
  });

  it('removes a dead-process lock and commits successfully', async () => {
    const current = await fixture();
    const outDir = path.join(current.root, 'dist');
    const lock = path.join(current.root, '.dist.acplugin.lock');
    await fs.writeFile(lock, `${JSON.stringify({
      schemaVersion: 3,
      pid: 99_999_999,
      token: '00000000-0000-4000-8000-000000000001',
    })}\n`);

    await commitPackageUnits(outDir, [], current.assets, { projectRoot: current.root });

    expect(await fs.readdir(outDir)).toEqual([]);
    await expect(fs.access(lock)).rejects.toThrow();
  });

  it.each(['', '{"schemaVersion":', '{"schemaVersion":2,"pid":1}\n'])(
    'recovers a malformed atomic lock record %j',
    async (contents) => {
      const current = await fixture();
      const outDir = path.join(current.root, 'dist');
      const lock = path.join(current.root, '.dist.acplugin.lock');
      await fs.writeFile(lock, contents);

      await commitPackageUnits(outDir, [], current.assets, { projectRoot: current.root });

      expect(await fs.readdir(outDir)).toEqual([]);
      expect(await helpers(current.root)).toEqual([]);
    },
  );

  it('preserves a malformed legacy lock that becomes a live record during the bounded check', async () => {
    /** 空文件模拟旧 create→write writer 尚未完成的中间状态。 */
    const current = await fixture();
    const outDir = path.join(current.root, 'dist');
    const lock = path.join(current.root, '.dist.acplugin.lock');
    await fs.writeFile(lock, '');
    /** stability window 内把同一路径补全为当前可见父进程持有的活锁。 */
    const liveRecord = `${JSON.stringify({
      schemaVersion: 3,
      pid: process.ppid,
      token: '00000000-0000-4000-8000-000000000004',
    })}\n`;
    const writer = new Promise<void>((resolve, reject) => {
      setTimeout(() => {
        fs.writeFile(lock, liveRecord).then(() => resolve(), reject);
      }, 5);
    });

    await expect(commitPackageUnits(outDir, [], current.assets, { projectRoot: current.root })).rejects.toThrow('locked');
    await writer;
    expect(await fs.readFile(lock, 'utf8')).toBe(liveRecord);
    /** 测试清理只移除模拟的外部 live lock。 */
    await fs.rm(lock);
    expect(await helpers(current.root)).toEqual([]);
  });

  it('rejects a same-byte lock replacement by comparing stable metadata', async () => {
    /** 两个空文件字节相同，只有 inode/metadata 能证明路径已被替换。 */
    const current = await fixture();
    const outDir = path.join(current.root, 'dist');
    const lock = path.join(current.root, '.dist.acplugin.lock');
    const displaced = `${lock}.external`;
    await fs.writeFile(lock, '');
    /** quarantine rename 前用同字节新 inode 替换 lock，模拟不参与 guard 的外部 writer。 */
    const realRename = fs.rename.bind(fs);
    let injected = false;
    const rename = vi.spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
      if (!injected && String(source) === lock && String(destination).endsWith('.stale')) {
        injected = true;
        await realRename(lock, displaced);
        await fs.writeFile(lock, '');
      }
      await realRename(source, destination);
    });

    try {
      await expect(commitPackageUnits(outDir, [], current.assets, { projectRoot: current.root })).rejects.toThrow('locked');
    } finally {
      rename.mockRestore();
    }
    expect(injected).toBe(true);
    expect(await fs.readFile(lock, 'utf8')).toBe('');
    expect(await fs.readFile(displaced, 'utf8')).toBe('');
    /** 两个模拟外部路径都不属于当前事务，测试结束前显式清理。 */
    await fs.rm(lock);
    await fs.rm(displaced);
    expect(await helpers(current.root)).toEqual([]);
  });

  it('recovers a stale token left by the current process', async () => {
    const current = await fixture();
    const outDir = path.join(current.root, 'dist');
    const lock = path.join(current.root, '.dist.acplugin.lock');
    await fs.writeFile(lock, `${JSON.stringify({
      schemaVersion: 3,
      pid: process.pid,
      token: '00000000-0000-4000-8000-000000000002',
    })}\n`);

    await commitPackageUnits(outDir, [], current.assets, { projectRoot: current.root });

    expect(await helpers(current.root)).toEqual([]);
  });

  it('rolls back the complete old set when afterSwap cleanup fails', async () => {
    const current = await fixture();
    const outDir = path.join(current.root, 'dist');
    await fs.mkdir(path.join(outDir, 'target', 'plugin'), { recursive: true });
    await fs.writeFile(path.join(outDir, 'target', 'plugin', 'version.txt'), 'old');

    await expect(commitPackageUnits(outDir, [await unit(current.assets, 'target', 'new')], current.assets, {
      projectRoot: current.root,
      afterSwap() {
        throw new Error('close failed');
      },
    })).rejects.toThrow('close failed');

    expect(await fs.readFile(path.join(outDir, 'target', 'plugin', 'version.txt'), 'utf8')).toBe('old');
    expect(await helpers(current.root)).toEqual([]);
  });
});
