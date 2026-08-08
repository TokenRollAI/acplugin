import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  bytesArtifact,
  defineExtension,
  definePlatform,
  stableJson,
} from '@tokenroll/acplugin';
import {
  executeLifecycle,
  type ResolvedConfig,
} from '@acplugin/core';

/** 生态契约测试创建并统一清理的临时工程。 */
const temporaryRoots: string[] = [];

/**
 * 创建不包含内置 Platform 假设的空作者工程。
 *
 * @returns 已登记清理的工程绝对路径。
 */
async function temporaryProject(): Promise<string> {
  /** 当前测试独占的工程根。 */
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-ecosystem-contract-'));
  temporaryRoots.push(root);
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe('third-party ecosystem contract', () => {
  it('executes public factory-created Platform, Extension, and Adapter objects through Core', async () => {
    /** 用公开主包工厂创建且不依赖任何内置实现的虚拟 Platform。 */
    const platform = definePlatform({
      id: 'ecosystem-fixture',
      apiVersion: '1',
      deliveryType: 'plugin',
      options: { manifest: { channel: 'stable' } },
      /** prepare 创建可供 Adapter 增量扩展的 Manifest Draft。 */
      prepare(context) {
        expect(context.options).toEqual({ manifest: { channel: 'stable' } });
        context.reportMetadata({
          field: 'name',
          disposition: 'emitted',
          output: 'plugin.json.name',
          reason: 'The virtual manifest preserves the canonical name.',
        });
        return {
          documents: [{
            id: 'plugin-manifest',
            path: 'plugin.json',
            format: 'json',
            owner: 'platform:ecosystem-fixture',
            value: { name: context.project.metadata.name, extensions: {} },
            extensionPoints: [['extensions', 'bridge']],
          }],
          artifacts: [],
        };
      },
      /** generateBundle 将合并后的 Document 与 Artifact 序列化为主单元。 */
      generateBundle(context) {
        /** Adapter patch 完成后的 Manifest 文档。 */
        const manifest = context.documents.find(document => document.id === 'plugin-manifest')!;
        return {
          id: 'plugin',
          role: 'primary',
          type: 'plugin',
          artifacts: [
            ...context.artifacts,
            bytesArtifact('plugin.json', stableJson(manifest.value)),
          ],
        };
      },
      /** validateBundle 接受当前虚拟 Platform 的已物化候选。 */
      validateBundle: () => undefined,
    });
    /** 用公开主包工厂创建并桥接虚拟 Platform 的第三方 Extension。 */
    const extension = defineExtension({
      name: 'ecosystem-bridge',
      apiVersion: '1',
      /** discover 返回 Extension 在 Fixture 中发现的最小状态。 */
      discover: () => ({ enabled: true }),
      /** build 把已发现状态作为跨 Platform 的 Built State。 */
      build: (_context, discovered) => discovered,
      adapters: [{
        extensionApiVersion: '1',
        platform: platform.id,
        platformApiVersion: '1',
        /** apply 只通过 add-only Context 修改当前 Platform Draft。 */
        apply(context, built) {
          context.patchDocument({
            document: 'plugin-manifest',
            path: ['extensions', 'bridge'],
            value: built,
          });
          context.emitArtifact(bytesArtifact('bridge/state.txt', 'enabled'));
        },
      }],
    });
    /** 手工组装仅供私有 Core 集成测试使用的已解析配置边界。 */
    const root = await temporaryProject();
    /** 直接执行 Core 所需的完整 ResolvedConfig Fixture。 */
    const config = {
      root,
      configPath: path.join(root, 'acplugin.config.ts'),
      command: 'validate',
      mode: 'production',
      metadata: { name: 'ecosystem-test', version: '1.0.0', description: 'Ecosystem contract.' },
      srcDir: path.join(root, 'src'),
      public: { enabled: false, dir: path.join(root, 'public') },
      platforms: [{ platform, strict: true }],
      extensions: [extension],
      outDir: path.join(root, 'dist'),
      strict: true,
    } as unknown as ResolvedConfig;

    /** 第三方 Platform、Extension 与 Adapter 共同运行的生命周期结果。 */
    const result = await executeLifecycle({
      config,
      /** loadTypeScriptModule 在当前 Fixture 中不需要加载任何作者模块。 */
      loadTypeScriptModule: async () => undefined,
      environment: {},
    });

    expect(result.success).toBe(true);
    expect(result.deliveryUnits).toEqual([
      expect.objectContaining({
        platform: 'ecosystem-fixture',
        id: 'plugin',
        artifacts: expect.arrayContaining([
          expect.objectContaining({ path: 'plugin.json', owner: 'platform:ecosystem-fixture' }),
          expect.objectContaining({ path: 'bridge/state.txt', owner: 'extension:ecosystem-bridge' }),
        ]),
      }),
    ]);
    expect(result.metadata).toEqual([
      expect.objectContaining({ platform: 'ecosystem-fixture', field: 'name', disposition: 'emitted' }),
    ]);
  });
});
