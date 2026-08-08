import { describe, expect, it } from 'vitest';
import {
  bytesArtifact,
  definePlatform,
  DocumentRegistry,
  PlatformDraftRegistry,
  type DraftDocument,
  type PlatformId,
} from '../src/index.js';

/**
 * 创建测试可用的品牌化 Platform ID。
 *
 * @param id 开放 Platform ID。
 * @returns 只能由 Core 工厂生成的 PlatformId。
 */
function platformId(id: string): PlatformId {
  return definePlatform({
    id,
    apiVersion: '1',
    deliveryType: 'plugin',
    /** Document 测试不执行 Platform prepare。 */
    prepare: () => ({ documents: [], artifacts: [] }),
    /** Document 测试不生成 DeliveryUnit。 */
    generateBundle: () => ({ id: 'plugin', role: 'primary', type: 'plugin', artifacts: [] }),
    /** Document 测试不物化候选目录。 */
    validateBundle: () => undefined,
  }).id;
}

/** Document Registry 测试统一使用的 Platform ID。 */
const TEST_PLATFORM = platformId('test-platform');

/** @returns 带两个精确空扩展点的 Manifest Document。 */
function manifestDocument(): DraftDocument {
  return {
    id: 'manifest',
    path: 'plugin.json',
    format: 'json',
    owner: 'platform:test-platform',
    value: { config: {} },
    extensionPoints: [['config', 'hooks'], ['config', 'mcp']],
  };
}

describe('Document Registry', () => {
  it('applies exact add-only patches and exposes immutable owner-merged snapshots', () => {
    /** 接管 Platform 初始 Manifest 的 Registry。 */
    const registry = new DocumentRegistry(TEST_PLATFORM, [manifestDocument()]);
    registry.patchDocument('extension:hooks', {
      document: 'manifest',
      path: ['config', 'hooks'],
      value: { events: ['before-tool'] },
    });
    /** 完成 Extension 合并后的逻辑 Document 快照。 */
    const snapshot = registry.snapshot();

    expect(registry.getDocument('manifest')).toEqual({ config: { hooks: { events: ['before-tool'] } } });
    expect(snapshot).toEqual([expect.objectContaining({
      id: 'manifest',
      owner: 'platform:test-platform',
      value: { config: { hooks: { events: ['before-tool'] } } },
    })]);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot[0]!.value)).toBe(true);
    expect(Object.isFrozen((snapshot[0]!.value as { config: object }).config)).toBe(true);
  });

  it('rejects undeclared points, replacement, duplicate owners, and pre-filled extension points', () => {
    /** 仍具有两个空位的初始 Registry。 */
    const registry = new DocumentRegistry(TEST_PLATFORM, [manifestDocument()]);
    registry.patchDocument('extension:hooks', {
      document: 'manifest',
      path: ['config', 'hooks'],
      value: { enabled: true },
    });

    expect(() => registry.patchDocument('extension:other', {
      document: 'manifest', path: ['config', 'hooks'], value: { enabled: false },
    })).toThrow('already owned');
    /** 失败 patch 不得改写首个 owner 已提交的不可变字段。 */
    expect(registry.getDocument('manifest')).toEqual({ config: { hooks: { enabled: true } } });
    expect(() => registry.patchDocument('extension:other', {
      document: 'manifest', path: ['config', 'unknown'], value: true,
    })).toThrow('does not declare');
    /** Platform 预填值与 Extension add-only 所有权冲突。 */
    const occupied: DraftDocument = {
      ...manifestDocument(),
      value: { config: { hooks: {} } },
      extensionPoints: [['config', 'hooks']],
    };
    expect(() => new DocumentRegistry(TEST_PLATFORM, [occupied])).toThrow('empty field');
  });

  it('rejects duplicate logical IDs and physical path collisions', () => {
    /** 与 Manifest 只在逻辑 ID 不同的重复文档。 */
    const duplicateId = { ...manifestDocument(), path: 'other.json' };
    expect(() => new DocumentRegistry(TEST_PLATFORM, [manifestDocument(), duplicateId])).toThrow('Duplicate Document id');
    /** 与 Manifest 只在大小写上不同的物理路径。 */
    const pathCollision: DraftDocument = {
      ...manifestDocument(), id: 'secondary', path: 'PLUGIN.json', extensionPoints: [],
    };
    expect(() => new DocumentRegistry(TEST_PLATFORM, [manifestDocument(), pathCollision])).toThrow('collision');
  });

  it('shares path ownership between Documents and Adapter Artifacts', async () => {
    /** Document 已占用 plugin.json 的完整 Platform Draft。 */
    const registry = await PlatformDraftRegistry.create(TEST_PLATFORM, {
      documents: [manifestDocument()],
      artifacts: [bytesArtifact('README.md', 'readme')],
    }, new Map());

    await expect(registry.emitArtifact('extension:hooks', bytesArtifact('PLUGIN.json', 'conflict'))).rejects.toThrow('collision');
    /** 不冲突的 Extension Artifact 带有自己的 owner。 */
    const artifact = await registry.emitArtifact('extension:hooks', bytesArtifact('hooks/run.mjs', 'run'));
    expect(artifact.owner).toBe('extension:hooks');
    expect(registry.artifacts.map(item => item.path)).toEqual(['README.md', 'hooks/run.mjs']);
  });

  it('preserves the explicit empty-document emission policy in frozen snapshots', () => {
    /** 可由 Platform 在空对象状态省略的配置 Document。 */
    const optional: DraftDocument = {
      id: 'optional-config',
      path: 'optional.json',
      format: 'json',
      owner: 'platform:test-platform',
      value: {},
      emission: 'omit-if-empty',
      extensionPoints: [['mcp']],
    };
    /** 接管可选文档后的 Registry。 */
    const registry = new DocumentRegistry(TEST_PLATFORM, [optional]);

    expect(registry.snapshot()).toEqual([expect.objectContaining({ emission: 'omit-if-empty', value: {} })]);
  });
});
