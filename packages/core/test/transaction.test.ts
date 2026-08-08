import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  bytesArtifact,
  commitDeliveryUnits,
  definePlatform,
  DeliveryUnitRegistry,
  withMaterializedDeliveryUnitCandidate,
  type ArtifactInput,
  type DeliveryUnit,
  type ManagedOutputPhase,
  type PlatformId,
} from '../src/index.js';

/** 新事务测试创建并统一删除的临时工程。 */
const temporaryDirectories: string[] = [];

/** @returns 已登记清理的临时工程根。 */
async function temporaryRoot(): Promise<string> {
  /** 当前测试独占的临时目录。 */
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-transaction-test-'));
  temporaryDirectories.push(root);
  return root;
}

/**
 * 创建测试使用的品牌化 Platform ID。
 *
 * @param id 开放 Platform ID。
 * @returns Core 工厂生成的 PlatformId。
 */
function platformId(id: string): PlatformId {
  return definePlatform({
    id,
    apiVersion: '1',
    deliveryType: 'plugin',
    /** 事务测试直接构建 DeliveryUnit。 */
    prepare: () => ({ documents: [], artifacts: [] }),
    /** 事务测试不执行 Platform generateBundle。 */
    generateBundle: () => ({ id: 'plugin', role: 'primary', type: 'plugin', artifacts: [] }),
    /** 候选测试通过独立回调模拟 Validator。 */
    validateBundle: () => undefined,
  }).id;
}

/** Codex 测试单元使用的稳定 ID。 */
const CODEX = platformId('codex');

/**
 * 创建包含指定 Artifact 的不可变主 DeliveryUnit。
 *
 * @param roots 文件型 Artifact 可以读取的来源根。
 * @param artifacts 主单元产物输入。
 * @returns 已完成 owner、hash 和路径校验的单元。
 */
async function pluginUnit(roots: readonly string[], artifacts: readonly ArtifactInput[]): Promise<DeliveryUnit> {
  /** 测试单元内 Platform owner 独占的目录来源授权。 */
  const policies = new Map([['platform:codex', { roots }]]);
  /** 当前 helper 独占的全局单元 Registry。 */
  const registry = new DeliveryUnitRegistry(policies);
  return registry.add(CODEX, { id: 'plugin', role: 'primary', type: 'plugin', artifacts });
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

describe('DeliveryUnit transaction', () => {
  it('preserves the previous complete output at every injected failure phase', async () => {
    /** 逐一注入故障并验证完整 DeliveryUnit 集合回滚的事务阶段。 */
    const phases: ManagedOutputPhase[] = [
      'lock-acquired',
      'recovery-complete',
      'stage-materialized',
      'stage-validated',
      'transaction-written',
      'backup-created',
      'output-swapped',
    ];

    for (const phase of phases) {
      /** 当前故障阶段独占的事务工程根。 */
      const root = await temporaryRoot();
      /** 预先包含完整旧输出的目标目录。 */
      const outDir = path.join(root, 'dist');
      await fs.mkdir(path.join(outDir, 'codex', 'plugin'), { recursive: true });
      await fs.writeFile(path.join(outDir, 'codex', 'plugin', 'version.txt'), 'old');
      /** 当前事务尝试提交的新主 DeliveryUnit。 */
      const unit = await pluginUnit([root], [bytesArtifact('version.txt', 'new')]);

      await expect(commitDeliveryUnits(outDir, [unit], {
        projectRoot: root,
        /** 在指定事务阶段注入失败以验证旧输出恢复。 */
        onPhase(current) {
          if (current === phase)
            throw new Error(`fail at ${phase}`);
        },
      })).rejects.toThrow(`fail at ${phase}`);

      expect(await fs.readFile(path.join(outDir, 'codex', 'plugin', 'version.txt'), 'utf8')).toBe('old');
      expect((await fs.readdir(root)).filter(name => name.startsWith('.dist.acplugin-'))).toEqual([]);
    }
  });

  it('materializes an isolated candidate and rejects Validator mutation', async () => {
    /** 候选目录和 Platform 临时目录所在的测试根。 */
    const root = await temporaryRoot();
    /** 包含一个稳定字节 Artifact 的主单元。 */
    const unit = await pluginUnit([root], [bytesArtifact('manifest.json', '{"ok":true}')]);
    /** Validator 观察到的候选根，用于确认 finally 清理。 */
    let candidateRoot = '';

    await expect(withMaterializedDeliveryUnitCandidate(unit, async (candidate) => {
      candidateRoot = candidate.root;
      expect(await fs.readFile(path.join(candidate.root, 'manifest.json'), 'utf8')).toBe('{"ok":true}');
      await fs.writeFile(path.join(candidate.root, 'manifest.json'), 'mutated');
    }, root)).rejects.toThrow('integrity mismatch');
    await expect(fs.access(candidateRoot)).rejects.toThrow();
  });

  it('commits the two-level Platform/unit layout and replaces the full managed set', async () => {
    /** 已含旧 Platform 目录的工程根。 */
    const root = await temporaryRoot();
    /** 本次事务整体替换的托管输出目录。 */
    const outDir = path.join(root, 'dist');
    await fs.mkdir(path.join(outDir, 'claude-code', 'plugin'), { recursive: true });
    await fs.writeFile(path.join(outDir, 'claude-code', 'plugin', 'old.txt'), 'old');
    /** 本次只选择 Codex 的完整新单元集合。 */
    const unit = await pluginUnit([root], [bytesArtifact('manifest.json', 'new')]);

    await commitDeliveryUnits(outDir, [unit], { projectRoot: root });

    expect(await fs.readFile(path.join(outDir, 'codex', 'plugin', 'manifest.json'), 'utf8')).toBe('new');
    await expect(fs.access(path.join(outDir, 'claude-code'))).rejects.toThrow();
  });

  it('preserves the complete old output when a file source changes after hashing', async () => {
    /** 包含旧输出和可变文件来源的工程根。 */
    const root = await temporaryRoot();
    /** 完整性失败后必须保留旧版本的输出目录。 */
    const outDir = path.join(root, 'dist');
    /** hash 完成后会被修改的文件型 Artifact 来源。 */
    const source = path.join(root, 'source.txt');
    await fs.mkdir(path.join(outDir, 'codex', 'plugin'), { recursive: true });
    await fs.writeFile(path.join(outDir, 'codex', 'plugin', 'version.txt'), 'old');
    await fs.writeFile(source, 'original');
    /** 在来源变更前完成 hash 的单元。 */
    const unit = await pluginUnit([root], [{ path: 'source.txt', source: { type: 'file', path: source } }]);
    await fs.writeFile(source, 'changed-after-hash');

    await expect(commitDeliveryUnits(outDir, [unit], { projectRoot: root })).rejects.toThrow('integrity mismatch');
    expect(await fs.readFile(path.join(outDir, 'codex', 'plugin', 'version.txt'), 'utf8')).toBe('old');
  });

  it('rejects the project root and paths outside it before creating transaction state', async () => {
    /** 安全边界验证使用的空工程。 */
    const root = await temporaryRoot();
    /** 工程根之外且不得成为输出目标的目录。 */
    const outside = await temporaryRoot();

    await expect(commitDeliveryUnits(root, [], { projectRoot: root })).rejects.toThrow('strictly inside');
    await expect(commitDeliveryUnits(path.join(outside, 'dist'), [], { projectRoot: root })).rejects.toThrow('strictly inside');
    expect((await fs.readdir(root)).filter(name => name.includes('acplugin-'))).toEqual([]);
  });
});
