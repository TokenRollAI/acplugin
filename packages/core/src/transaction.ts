import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hashFile } from './artifacts.js';
import type { Artifact, TargetId } from './types.js';

export type ManagedOutputPhase
  = | 'lock-acquired'
    | 'recovery-complete'
    | 'stage-materialized'
    | 'stage-validated'
    | 'transaction-written'
    | 'backup-created'
    | 'output-swapped';

export interface CommitManagedOutputOptions {
  onPhase?(phase: ManagedOutputPhase): void | Promise<void>;
  afterSwap?(): void | Promise<void>;
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function materializeFile(root: string, artifact: Artifact): Promise<void> {
  const destination = path.join(root, ...artifact.path.split('/'));
  await fs.mkdir(path.dirname(destination), { recursive: true });
  if (artifact.source.type === 'bytes')
    await fs.writeFile(destination, artifact.source.value, { mode: artifact.mode });
  else
    await fs.copyFile(artifact.source.path, destination);
  await fs.chmod(destination, artifact.mode);
}

export async function materializeTargets(
  root: string,
  targets: ReadonlyMap<TargetId, readonly Artifact[]>,
): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  for (const target of [...targets.keys()].sort()) {
    const targetRoot = path.join(root, target);
    await fs.mkdir(targetRoot, { recursive: true });
    for (const artifact of targets.get(target) ?? [])
      await materializeFile(targetRoot, artifact);
  }
}

async function validateMaterializedTargets(
  root: string,
  targets: ReadonlyMap<TargetId, readonly Artifact[]>,
): Promise<void> {
  for (const target of [...targets.keys()].sort()) {
    const targetRoot = path.join(root, target);
    for (const artifact of targets.get(target) ?? []) {
      const destination = path.join(targetRoot, ...artifact.path.split('/'));
      const stat = await fs.lstat(destination);
      if (stat.isSymbolicLink() || !stat.isFile())
        throw new Error(`Materialized Artifact is not a regular file: ${target}/${artifact.path}`);
      const actual = await hashFile(destination);
      if (actual.size !== artifact.size || actual.sha256 !== artifact.sha256)
        throw new Error(`Materialized Artifact integrity mismatch: ${target}/${artifact.path}`);
      if ((stat.mode & 0o777) !== artifact.mode)
        throw new Error(`Materialized Artifact mode mismatch: ${target}/${artifact.path}`);
    }
  }
}

export async function validateMaterialization(
  targets: ReadonlyMap<TargetId, readonly Artifact[]>,
): Promise<void> {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-validate-'));
  try {
    await materializeTargets(temporary, targets);
    await validateMaterializedTargets(temporary, targets);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

export async function commitManagedOutput(
  outDir: string,
  targets: ReadonlyMap<TargetId, readonly Artifact[]>,
  options: CommitManagedOutputOptions = {},
): Promise<void> {
  const resolved = path.resolve(outDir);
  const parent = path.dirname(resolved);
  const base = path.basename(resolved);
  if (resolved === path.parse(resolved).root || base === '' || base === '.' || base === '..')
    throw new Error(`Unsafe managed output path: ${outDir}`);

  await fs.mkdir(parent, { recursive: true });
  const lockPath = path.join(parent, `.${base}.acplugin.lock`);
  const transactionPath = path.join(parent, `.${base}.acplugin-transaction.json`);
  const backupPath = path.join(parent, `.${base}.acplugin-backup`);
  let stage: string | undefined;
  let backupCreated = false;
  let outputSwapped = false;

  const acquireLock = async (): Promise<import('node:fs/promises').FileHandle> => {
    try {
      const handle = await fs.open(lockPath, 'wx');
      await handle.writeFile(`${JSON.stringify({ schemaVersion: 1, pid: process.pid })}\n`);
      return handle;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
        throw error;
      try {
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
        const handle = await fs.open(lockPath, 'wx');
        await handle.writeFile(`${JSON.stringify({ schemaVersion: 1, pid: process.pid })}\n`);
        return handle;
      } catch (lockError) {
        throw new Error(`Managed output is locked: ${outDir}. ${String(lockError)}`, { cause: lockError });
      }
    }
  };
  const lock = await acquireLock();

  try {
    await options.onPhase?.('lock-acquired');
    if (await exists(backupPath)) {
      if (!await exists(resolved))
        await fs.rename(backupPath, resolved);
      else
        await fs.rm(backupPath, { recursive: true, force: true });
    }
    if (await exists(transactionPath))
      await fs.rm(transactionPath, { force: true });
    await options.onPhase?.('recovery-complete');

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
        // The complete output is committed. The next invocation can remove a
        // retained transaction record without treating cleanup as build failure.
      }
    } catch (error) {
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
        // The committed output is complete. A retained backup is recovered on
        // the next invocation rather than turning a successful swap into failure.
      }
    }
  } catch (error) {
    if (!(error instanceof AggregateError)) {
      try {
        await fs.rm(transactionPath, { force: true });
      } catch {
        // A transaction record is safe to retain: the next invocation recovers it.
      }
    }
    throw error;
  } finally {
    if (stage) {
      try {
        await fs.rm(stage, { recursive: true, force: true });
      } catch {
        // Staging cleanup is recoverable and cannot replace the primary result.
      }
    }
    try {
      await lock.close();
    } catch {
      // The process owns this handle; a close failure is not a build outcome.
    }
    try {
      await fs.rm(lockPath, { force: true });
    } catch {
      // A retained lock record is reconciled by a later invocation.
    }
  }
}
