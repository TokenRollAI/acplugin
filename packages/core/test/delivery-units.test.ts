import { describe, expect, it } from 'vitest';
import {
  ArtifactRegistry,
  bytesArtifact,
  definePlatform,
  DeliveryUnitRegistry,
  type PlatformId,
} from '../src/index.js';

/**
 * 创建 DeliveryUnit 测试所需的品牌化 Platform ID。
 *
 * @param id 开放 Platform ID。
 * @returns Core 工厂创建的 PlatformId。
 */
function platformId(id: string): PlatformId {
  return definePlatform({
    id,
    apiVersion: '1',
    deliveryType: 'plugin',
    /** 单元 Registry 测试不准备真实 Draft。 */
    prepare: () => ({ documents: [], artifacts: [] }),
    /** 单元 Registry 测试直接调用 Registry.add。 */
    generateBundle: () => ({ id: 'plugin', role: 'primary', type: 'plugin', artifacts: [] }),
    /** 单元 Registry 测试不物化候选目录。 */
    validateBundle: () => undefined,
  }).id;
}

/** 两个独立 Platform 用于验证 tuple 唯一性范围。 */
const CODEX = platformId('codex');
/** 第二个平台允许复用相同单元 ID。 */
const CLAUDE = platformId('claude-code');

describe('DeliveryUnit Registry', () => {
  it('creates stable units with Platform-owned Artifact metadata', async () => {
    /** 当前构建全局共享的单元 Registry。 */
    const registry = new DeliveryUnitRegistry(new Map());
    /** Codex 主 Plugin 单元。 */
    const unit = await registry.add(CODEX, {
      id: 'plugin',
      role: 'primary',
      type: 'plugin',
      artifacts: [bytesArtifact('manifest.json', '{}')],
    });
    /** Claude Code 可以使用相同 unit-id，因为 Platform ID 不同。 */
    await registry.add(CLAUDE, {
      id: 'plugin',
      role: 'primary',
      type: 'plugin',
      artifacts: [bytesArtifact('plugin.json', '{}')],
    });

    expect(unit.artifacts[0]).toEqual(expect.objectContaining({ owner: 'platform:codex', size: 2, mode: 0o644 }));
    expect(registry.snapshot().map(item => `${item.platform}/${item.id}`)).toEqual([
      'claude-code/plugin',
      'codex/plugin',
    ]);
    expect(Object.isFrozen(registry.snapshot())).toBe(true);
    expect(Object.isFrozen(unit)).toBe(true);
  });

  it('rejects duplicate tuple keys before processing another unit', async () => {
    /** 已含 Codex plugin 单元的 Registry。 */
    const registry = new DeliveryUnitRegistry(new Map());
    await registry.add(CODEX, { id: 'plugin', role: 'primary', type: 'plugin', artifacts: [] });

    await expect(registry.add(CODEX, {
      id: 'plugin',
      role: 'primary',
      type: 'plugin',
      artifacts: [bytesArtifact('../would-not-be-read', 'bad')],
    })).rejects.toThrow('Duplicate DeliveryUnit');
    expect(registry.snapshot()).toHaveLength(1);
  });

  it('rejects unit-internal path conflicts before registering the unit', async () => {
    /** 空 Registry 不应保留构建失败的部分单元。 */
    const registry = new DeliveryUnitRegistry(new Map());
    await expect(registry.add(CODEX, {
      id: 'plugin',
      role: 'primary',
      type: 'plugin',
      artifacts: [
        bytesArtifact('Skills/Review.md', 'first'),
        bytesArtifact('skills/review.md', 'second'),
      ],
    })).rejects.toThrow('collision');
    expect(registry.snapshot()).toEqual([]);
  });

  it('enforces primary and Marketplace distribution role contracts', async () => {
    /** 角色与类型组合验证使用的独立 Registry。 */
    const registry = new DeliveryUnitRegistry(new Map());
    await expect(registry.add(CODEX, {
      id: 'marketplace', role: 'primary', type: 'marketplace', artifacts: [],
    })).rejects.toThrow('primary');
    await expect(registry.add(CODEX, {
      id: 'archive', role: 'distribution', type: 'plugin', artifacts: [],
    })).rejects.toThrow('distribution');
    /** 唯一支持的 1.0 Distribution 组合。 */
    const marketplace = await registry.add(CODEX, {
      id: 'marketplace', role: 'distribution', type: 'marketplace', artifacts: [],
    });
    expect(marketplace.role).toBe('distribution');
  });

  it('preserves primary Artifact ownership and metadata when a Distribution reuses it', async () => {
    /** 主单元与 Distribution 共用的 Registry。 */
    const registry = new DeliveryUnitRegistry(new Map());
    /** 带显式可执行权限的 Platform 主单元。 */
    const primary = await registry.add(CODEX, {
      id: 'plugin',
      role: 'primary',
      type: 'plugin',
      artifacts: [{ ...bytesArtifact('bin/runner', 'run'), mode: 0o755 }],
    });
    /** 使用主单元 Artifact 作为继承边界的 Marketplace Distribution。 */
    const distribution = await registry.add(CODEX, {
      id: 'marketplace',
      role: 'distribution',
      type: 'marketplace',
      artifacts: primary.artifacts,
    }, primary.artifacts);

    expect(distribution.artifacts[0]).toEqual(expect.objectContaining({
      owner: primary.artifacts[0]!.owner,
      mode: primary.artifacts[0]!.mode,
      size: primary.artifacts[0]!.size,
      sha256: primary.artifacts[0]!.sha256,
    }));
  });

  it('preserves an inherited Extension owner after relocation without trusting spoofed metadata', async () => {
    /** 模拟 Draft 阶段按 owner 隔离并冻结的 Artifact Registry。 */
    const draftArtifacts = new ArtifactRegistry(new Map());
    /** Extension 生成且需要由 Platform 原样编排进 Distribution 的可执行文件。 */
    const inherited = await draftArtifacts.add(
      'extension:bundle-assets',
      { ...bytesArtifact('assets/runner', 'run'), mode: 0o755 },
    );
    /** Marketplace Distribution 使用的独立 DeliveryUnit Registry。 */
    const registry = new DeliveryUnitRegistry(new Map());
    /** 使用同一冻结 source、但移动到 Distribution 子目录的可信 Artifact 输入。 */
    const relocated = {
      path: 'plugins/plugin-alpha/assets/runner',
      source: inherited.source,
      mode: inherited.mode,
    };
    /**
     * 即使输入伪造了 owner、hash 与 size，只要 source 不是 Core 冻结的继承对象，
     * DeliveryUnit 就必须重新计算元数据并把产物归属当前 Platform。
     */
    const spoofed = {
      ...inherited,
      path: 'plugins/plugin-alpha/assets/spoofed-runner',
      source: bytesArtifact('unused', 'changed').source,
    };
    /** 只有显式传入 inheritedArtifacts 且 source 身份相同的重定位内容才能继承 owner。 */
    const distribution = await registry.add(CODEX, {
      id: 'marketplace',
      role: 'distribution',
      type: 'marketplace',
      artifacts: [relocated, spoofed],
    }, [inherited]);

    expect(distribution.artifacts[0]).toEqual(expect.objectContaining({
      path: 'plugins/plugin-alpha/assets/runner',
      owner: 'extension:bundle-assets',
      mode: inherited.mode,
      size: inherited.size,
      sha256: inherited.sha256,
    }));
    expect(distribution.artifacts[1]).toEqual(expect.objectContaining({
      path: 'plugins/plugin-alpha/assets/spoofed-runner',
      owner: 'platform:codex',
      size: 7,
    }));
    expect(distribution.artifacts[1]!.sha256).not.toBe(inherited.sha256);
  });
});
