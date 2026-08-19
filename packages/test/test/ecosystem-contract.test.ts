import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  defineExtension,
  definePlatform,
  type SourceFileRef,
} from '@tokenroll/acplugin/sdk';
import claudeCode from '@tokenroll/acplugin-platform-claude-code';
import codex from '@tokenroll/acplugin-platform-codex';
import {
  resolveKernelConfig,
  runKernelBuildSession,
} from '@acplugin/core';

/** 生态契约测试创建并统一清理的临时工程。 */
const temporaryRoots: string[] = [];

/** 创建包含最小配置占位符且登记清理的工程。 */
async function temporaryProject(): Promise<string> {
  /** 当前测试独占的工程根。 */
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-ecosystem-contract-'));
  temporaryRoots.push(root);
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'acplugin.config.ts'), 'export default {}\n');
  return root;
}

/** 第三方 Fixture 对必填 metadata 的完整处置。 */
function metadata() {
  return ['name', 'version', 'description'].map(field => ({
    field,
    disposition: 'emitted' as const,
    output: `plugin.json/${field}`,
    reason: 'The ecosystem fixture emits this canonical field.',
  }));
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe('Kernel v2 ecosystem contract', () => {
  it('executes SDK-created Platform, Extension, and Contributor through the fixed Package lifecycle', async () => {
    /** Extension 独占来源根中的 add-only 资源。 */
    const root = await temporaryProject();
    await fs.mkdir(path.join(root, 'src/community'), { recursive: true });
    await fs.writeFile(path.join(root, 'src/community/state.txt'), 'enabled\n');
    /** 第三方 Platform 只使用公开 SDK 的 Session/Document/Asset 契约。 */
    const platform = definePlatform({
      id: 'ecosystem-fixture',
      apiVersion: '1',
      deliveryType: 'plugin',
      options: { channel: 'stable' },
      /** 每轮创建只捕获 Core 防御性复制后的选项。 */
      createSession({ options }) {
        expect(options).toEqual({ channel: 'stable' });
        return {
          /** Platform 只创建自己的 base Document。 */
          createPackage: ({ project }) => ({
            documents: [{
              id: 'plugin-manifest',
              path: 'plugin.json',
              format: 'json',
              value: {
                name: project.metadata.name,
                version: project.metadata.version,
                description: project.metadata.description,
                extensions: {},
              },
              extensionPoints: [['extensions', 'community']],
            }],
            assets: [],
            compatibility: [],
            metadata: metadata(),
          }),
          /** Core 自动继承 base 与 Contributor 内容。 */
          finalizePackage: () => ({ id: 'plugin', type: 'plugin' }),
          /** 临时候选必须已经包含 codec 输出和 Extension Asset。 */
          async validatePackage({ candidate }) {
            /** manifest 是 Core Document codec 物化后的最终候选。 */
            const manifest = JSON.parse(await fs.readFile(path.join(candidate.root, 'plugin.json'), 'utf8'));
            expect(manifest.extensions).toEqual({ community: { enabled: true } });
            await expect(fs.readFile(path.join(candidate.root, 'community/state.txt'), 'utf8')).resolves.toBe('enabled\n');
          },
        };
      },
    });
    /** 第三方 Extension 的状态只沿 discover→validate→build 传递。 */
    const extension = defineExtension<Record<string, never>, { readonly file: SourceFileRef }, { readonly file: SourceFileRef }, { readonly asset: import('@tokenroll/acplugin/sdk').SourceAssetRef }>({
      id: 'community-extension',
      apiVersion: '1',
      options: {},
      resourceRoots: ['community'],
      /** 每轮返回独立且无跨 Extension 读取的 Session。 */
      createSession: () => ({
        /** discover 只能从 Extension 独占 Resource root 签发 SourceRef。 */
        async discover({ roots, sources }) {
          /** 缺失 root 时按未发现处理，不生成兼容性噪声。 */
          const sourceRoot = roots.community;
          return sourceRoot === undefined ? undefined : { file: await sources.file(sourceRoot, 'state.txt') };
        },
        /** validate 声明 Contributor 后续必须覆盖的 capability tuple。 */
        validate: (_context, discovered) => ({
          state: discovered,
          subjects: [{ subject: 'community:state', capabilities: ['delivery'] }],
        }),
        /** build 只通过 owner-scoped Asset Service 转换 SourceRef。 */
        build: async ({ assets }, validated) => ({
          state: { asset: await assets.fromSource(validated.file) },
        }),
        contributors: [{
          platform: 'ecosystem-fixture',
          platformApiVersion: '1',
          /** Contributor 只填声明点并追加自己拥有的 Asset。 */
          contribute: (_context, built) => ({
            documentFields: [{
              document: 'plugin-manifest',
              path: ['extensions', 'community'],
              value: { enabled: true },
            }],
            assets: [{ path: 'community/state.txt', asset: built.asset }],
            compatibility: [{
              subject: 'community:state',
              capability: 'delivery',
              level: 'native',
              reason: 'The extension contributes through a declared Package extension point.',
            }],
          }),
        }],
      }),
    });
    /** 私有测试直接调用 Kernel，生产配置仍只通过公开品牌对象。 */
    const resolved = resolveKernelConfig({
      name: 'ecosystem-test',
      version: '1.0.0',
      description: 'Ecosystem contract.',
      public: false,
      platforms: [platform],
      extensions: [extension],
    }, {
      projectRoot: root,
      configFile: path.join(root, 'acplugin.config.ts'),
      command: 'inspect',
      mode: 'production',
    });
    /** BuildSession 是测试中唯一实际执行的构建路径。 */
    const result = await runKernelBuildSession({
      config: resolved.config!,
      frameworkVersion: 'test',
      commit: false,
    });

    expect(resolved.diagnostics).toEqual([]);
    expect(result.report.success, JSON.stringify(result.report.diagnostics, null, 2)).toBe(true);
    expect(result.report.packages).toContainEqual(expect.objectContaining({
      platform: 'ecosystem-fixture',
      id: 'plugin',
      validated: true,
      assets: expect.arrayContaining([
        expect.objectContaining({ path: 'plugin.json', owner: 'platform:ecosystem-fixture' }),
        expect.objectContaining({ path: 'community/state.txt', owner: 'extension:community-extension' }),
      ]),
    }));
    expect(result.report.compatibility).toContainEqual(expect.objectContaining({
      platform: 'ecosystem-fixture',
      subject: 'community:state',
      capability: 'delivery',
      level: 'native',
    }));
  });

  it('delivers one Core-built Node Runtime byte stream to Claude Code and Codex', async () => {
    /** 工程包含一个原生 Skill 和一个自动发现的 Runtime 入口。 */
    const root = await temporaryProject();
    await fs.mkdir(path.join(root, 'src/skills/host'), { recursive: true });
    await fs.mkdir(path.join(root, 'src/runtime'), { recursive: true });
    await fs.writeFile(path.join(root, 'src/skills/host/SKILL.md'), '---\ndescription: Host the runtime.\n---\nUse the runtime.\n');
    await fs.writeFile(path.join(root, 'src/runtime/cli.ts'), 'process.stdout.write("runtime-ready\\n");\n');
    /** 两个官方 Platform 都只声明能力，不各自编译 Runtime。 */
    const resolved = resolveKernelConfig({
      name: 'runtime-ecosystem',
      version: '1.0.0',
      description: 'Cross-platform runtime contract.',
      public: false,
      platforms: [claudeCode(), codex()],
    }, {
      projectRoot: root,
      configFile: path.join(root, 'acplugin.config.ts'),
      command: 'build',
      mode: 'production',
    });
    /** commit 验证最终两个 Platform 目录中的真实字节。 */
    const result = await runKernelBuildSession({
      config: resolved.config!,
      frameworkVersion: 'test',
      commit: true,
    });
    /** 两个 Package 报告中的 Runtime 必须继承同一个 Core provenance/hash/mode。 */
    const runtimes = result.report.packages
      .filter(unit => unit.role === 'primary')
      .map(unit => unit.assets.find(asset => asset.path === 'runtime/cli/main.mjs')!);

    expect(resolved.diagnostics).toEqual([]);
    expect(result.report.success, JSON.stringify(result.report.diagnostics, null, 2)).toBe(true);
    expect(runtimes).toHaveLength(2);
    expect(runtimes[0]).toMatchObject({
      owner: 'framework:node-runtime',
      mode: 0o755,
      origin: { type: 'compile', profile: 'portable-node' },
    });
    expect(runtimes[1]).toEqual(runtimes[0]);
    await expect(fs.readFile(path.join(root, 'dist/claude-code/plugin/runtime/cli/main.mjs'))).resolves.toEqual(
      await fs.readFile(path.join(root, 'dist/codex/plugin/runtime/cli/main.mjs')),
    );
  });
});
