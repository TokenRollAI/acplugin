import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

/** 原生严格拒绝子进程直接加载的 Core 构建入口。 */
const coreEntry = fileURLToPath(new URL('../../core/dist/index.mjs', import.meta.url));

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

  it('observes immediate Artifact rejection before an async Adapter failure in strict Node mode', async () => {
    /** 子进程使用的空工程，确保生命周期可进入 Adapter 阶段。 */
    const root = await temporaryProject();
    /** 真实构建 Core 中创建立即碰撞 Promise、随后等待 timer 并抛错的 ESM 程序。 */
    const source = `
import {
  bytesArtifact,
  defineExtension,
  definePlatform,
  executeLifecycle,
  resolveConfig,
} from ${JSON.stringify(coreEntry)};

const platform = definePlatform({
  id: 'strict-rejection',
  apiVersion: '1',
  deliveryType: 'plugin',
  prepare: () => ({
    documents: [{
      id: 'manifest',
      path: 'manifest.json',
      format: 'json',
      owner: 'platform:strict-rejection',
      value: {},
      extensionPoints: [],
    }],
    artifacts: [],
  }),
  generateBundle: context => ({
    id: 'plugin', role: 'primary', type: 'plugin', artifacts: context.artifacts,
  }),
  validateBundle: () => undefined,
});
const extension = defineExtension({
  name: 'strict-rejection-extension',
  apiVersion: '1',
  discover: () => ({ enabled: true }),
  adapters: [{
    extensionApiVersion: '1',
    platform: platform.id,
    platformApiVersion: '1',
    async apply(context) {
      context.emitArtifact(bytesArtifact('manifest.json', 'collision'));
      await new Promise(resolve => setTimeout(resolve, 20));
      throw new Error('later Adapter failure');
    },
  }],
});
const resolved = resolveConfig({
  name: 'strict-rejection-fixture',
  version: '1.0.0',
  description: 'Strict rejection fixture.',
  public: false,
  platforms: [platform],
  extensions: [extension],
}, ${JSON.stringify(path.join(root, 'acplugin.config.ts'))}, 'validate', 'production');
if (!resolved.config)
  throw new Error('Fixture config did not resolve.');
const result = await executeLifecycle({
  config: resolved.config,
  loadTypeScriptModule: async () => undefined,
  environment: {},
});
process.stdout.write(JSON.stringify(result));
`;
    /** strict 模式会把任何短暂无 observer 的拒绝直接升级为进程失败。 */
    const execution = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      /** 使用原生 ESM 与严格拒绝策略执行真实 Core 构建产物。 */
      const child = spawn(process.execPath, ['--unhandled-rejections=strict', '--input-type=module', '--eval', source], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      /** 子进程返回的唯一 JSON 构建结果。 */
      let stdout = '';
      /** 严格模式下不得出现未处理拒绝堆栈。 */
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });
      child.on('error', reject);
      child.on('close', code => resolve({ code, stdout, stderr }));
    });

    expect(execution.code).toBe(0);
    expect(execution.stderr).toBe('');
    expect(JSON.parse(execution.stdout)).toEqual(expect.objectContaining({
      success: false,
      committed: false,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'PLATFORM_GENERATION_FAILED', platform: 'strict-rejection' }),
      ]),
    }));
  });
});
