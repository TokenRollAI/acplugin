import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/** 主包工作区根目录。 */
const packageRoot = fileURLToPath(new URL('../../../acplugin', import.meta.url));

/** 公开 Component payload 类型所在的三个官方 Platform package。 */
const componentPlatformRoots = Object.freeze({
  'claude-code': fileURLToPath(new URL('../../../platforms/claude-code', import.meta.url)),
  'cursor': fileURLToPath(new URL('../../../platforms/cursor', import.meta.url)),
  'opencode': fileURLToPath(new URL('../../../platforms/opencode', import.meta.url)),
});

/** packed consumer 测试创建的临时目录。 */
const temporaryRoots: string[] = [];

/** 执行 clean consumer 子进程并完整捕获文本输出。 */
async function execute(command: string, args: readonly string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  /** 动态加载避免测试模块初始化时产生子进程副作用。 */
  const { execFile } = await import('node:child_process');
  return new Promise((resolve, reject) => {
    execFile(command, [...args], { cwd, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error)
        reject(new Error(`${command} ${args.join(' ')} failed: ${stderr || stdout}`, { cause: error }));
      else
        resolve({ stdout, stderr });
    });
  });
}

/** 从 pnpm pack stdout 解析当前 package 的 tarball 绝对路径。 */
function packedPath(stdout: string, cwd: string): string {
  /** pnpm 最后一行是新生成 tarball 的路径。 */
  const output = stdout.trim().split('\n').at(-1)!;
  return path.isAbsolute(output) ? output : path.resolve(cwd, output);
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe('published sdk package boundary', () => {
  it('publishes root and sdk as distinct ESM entries sharing one runtime brand', async () => {
    /** 从真实构建产物加载的 root 作者入口。 */
    const root = await import(pathToFileURL(path.join(packageRoot, 'dist/index.mjs')).href);
    /** 从真实构建产物加载的 Integration SDK 入口。 */
    const sdk = await import(pathToFileURL(path.join(packageRoot, 'dist/sdk.mjs')).href);
    /** SDK 工厂创建并由同一 SDK validator 识别的 Platform。 */
    const platform = sdk.definePlatform({
      id: 'packed-platform',
      apiVersion: '1',
      deliveryType: 'plugin',
      /** packed fixture 使用最小 Session。 */
      createSession: () => ({
        /** packed fixture 创建空 base Package。 */
        createPackage: () => ({ documents: [], assets: [], compatibility: [], metadata: [] }),
        /** packed fixture 创建主 Plugin Package。 */
        finalizePackage: () => ({ id: 'plugin', type: 'plugin' }),
        /** packed fixture 不增加 candidate 约束。 */
        validatePackage: () => undefined,
      }),
    });

    expect(root.definePlatform).toBeUndefined();
    expect(root.defineExtension).toBeUndefined();
    expect(root.defineConfig({ name: 'packed', version: '1.0.0', description: 'Packed.', platforms: [platform] }).platforms[0]).toBe(platform);
    expect(sdk.isAcpluginPlatform(platform)).toBe(true);
    expect(sdk.LIFECYCLE_API_VERSION).toBe('1');
  });

  it('packs an installable tarball containing both declared export entries', async () => {
    /** pnpm pack 输出所在的隔离目录。 */
    const destination = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-sdk-pack-'));
    temporaryRoots.push(destination);
    /** 使用 pnpm pack 真实执行 files/export 打包规则。 */
    const { execFile } = await import('node:child_process');
    /** Promise 化子进程避免 shell 插值。 */
    const pack = await new Promise<{ stdout: string }>((resolve, reject) => {
      execFile('pnpm', ['pack', '--pack-destination', destination], { cwd: packageRoot }, (error, stdout) => {
        if (error)
          reject(error);
        else
          resolve({ stdout });
      });
    });
    /** pnpm 最后一行输出生成的 tarball 路径。 */
    const tarball = pack.stdout.trim().split('\n').at(-1)!;
    /** tarball 内容通过系统 tar 只读枚举。 */
    const { stdout: listing } = await new Promise<{ stdout: string }>((resolve, reject) => {
      execFile('tar', ['-tf', tarball], (error, stdout) => {
        if (error)
          reject(error);
        else
          resolve({ stdout });
      });
    });

    expect(listing).toContain('package/dist/index.mjs');
    expect(listing).toContain('package/dist/index.d.mts');
    expect(listing).toContain('package/dist/sdk.mjs');
    expect(listing).toContain('package/dist/sdk.d.mts');
  });

  it('accepts a clean packed SDK-only package exporting both a Platform and Extension', async () => {
    /** 所有 package、tarball 与消费工程都位于 workspace 外的同一临时根。 */
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-external-sdk-'));
    temporaryRoots.push(root);
    /** 主包 tarball 只能来自真实 publish files/exports。 */
    const tarballs = path.join(root, 'tarballs');
    await fs.mkdir(tarballs, { recursive: true });
    /** 当前真实主包 tarball 路径。 */
    const mainTarball = packedPath(
      (await execute('pnpm', ['pack', '--pack-destination', tarballs], packageRoot)).stdout,
      packageRoot,
    );
    /** 当前主包版本决定第三方 Integration 的正常 peer range。 */
    const mainManifest = JSON.parse(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8')) as { version: string };

    /** 独立第三方 package 的实现和声明都只从公开 SDK subpath 导入。 */
    const integration = path.join(root, 'external-integration');
    await fs.mkdir(integration, { recursive: true });
    await fs.writeFile(path.join(integration, 'package.json'), JSON.stringify({
      name: 'external-acplugin-integration-fixture',
      version: '1.0.0',
      type: 'module',
      exports: { '.': { types: './index.d.mts', import: './index.mjs' } },
      files: ['index.mjs', 'index.d.mts'],
      peerDependencies: { '@tokenroll/acplugin': `^${mainManifest.version}` },
    }, null, 2));
    await fs.writeFile(path.join(integration, 'index.d.mts'), `
import type { AcpluginExtension, AcpluginPlatform } from '@tokenroll/acplugin/sdk';
export declare const externalPlatform: AcpluginPlatform;
export declare const externalExtension: AcpluginExtension;
`);
    await fs.writeFile(path.join(integration, 'index.mjs'), `
import { defineExtension, definePlatform } from '@tokenroll/acplugin/sdk';

const metadata = () => ['name', 'version', 'description'].map(field => ({
  field,
  disposition: 'emitted',
  output: \`plugin.json/\${field}\`,
  reason: 'The external fixture emits this canonical field.',
}));

export const externalPlatform = definePlatform({
  id: 'external-fixture',
  apiVersion: '1',
  deliveryType: 'plugin',
  createSession: () => ({
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
        extensionPoints: [['extensions', 'external']],
      }],
      assets: [],
      compatibility: [],
      metadata: metadata(),
    }),
    finalizePackage: () => ({ id: 'plugin', type: 'plugin' }),
    validatePackage: () => undefined,
  }),
});

export const externalExtension = defineExtension({
  id: 'external-fixture',
  apiVersion: '1',
  resourceRoots: ['external'],
  createSession: () => ({
    async discover({ roots, sources }) {
      const root = roots.external;
      return root === undefined ? undefined : { file: await sources.file(root, 'state.txt') };
    },
    validate: (_context, discovered) => ({
      state: discovered,
      subjects: [{ subject: 'external:state', capabilities: ['delivery'] }],
    }),
    async build({ assets }, validated) {
      return { state: { asset: await assets.fromSource(validated.file) } };
    },
    contributors: [{
      platform: 'external-fixture',
      platformApiVersion: '1',
      contribute: (_context, built) => ({
        documentFields: [{
          document: 'plugin-manifest',
          path: ['extensions', 'external'],
          value: { enabled: true },
        }],
        assets: [{ path: 'external/state.txt', asset: built.asset }],
        compatibility: [{
          subject: 'external:state',
          capability: 'delivery',
          level: 'native',
          reason: 'The external fixture contributes through the public SDK.',
        }],
      }),
    }],
  }),
});
`);
    /** 第三方 tarball 不得声明私有 Core 或另一个 Integration runtime dependency。 */
    const integrationTarball = packedPath(
      (await execute('pnpm', ['pack', '--pack-destination', tarballs], integration)).stdout,
      integration,
    );
    /** 从第三方 tarball 原始清单读取公开依赖边界。 */
    const packedManifest = JSON.parse((await execute('tar', ['-xOf', integrationTarball, 'package/package.json'], root)).stdout) as {
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    expect(packedManifest.dependencies).toBeUndefined();
    expect(packedManifest.peerDependencies).toEqual({ '@tokenroll/acplugin': `^${mainManifest.version}` });
    expect(JSON.stringify(packedManifest)).not.toContain('@acplugin/');

    /** clean consumer 只安装两个 tarball，不依赖 workspace alias 或私有 Core。 */
    const consumer = path.join(root, 'consumer');
    await fs.mkdir(path.join(consumer, 'src/external'), { recursive: true });
    await fs.writeFile(path.join(consumer, 'package.json'), JSON.stringify({
      name: 'external-acplugin-consumer',
      version: '1.0.0',
      private: true,
      type: 'module',
      dependencies: {
        '@tokenroll/acplugin': `file:${mainTarball}`,
        'external-acplugin-integration-fixture': `file:${integrationTarball}`,
      },
      devDependencies: { '@typescript/native': 'npm:typescript@^7.0.2' },
    }, null, 2));
    await fs.writeFile(path.join(consumer, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        lib: ['ESNext', 'DOM'],
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        noEmit: true,
        skipLibCheck: false,
      },
      include: ['acplugin.config.ts'],
    }, null, 2));
    await fs.writeFile(path.join(consumer, 'src/external/state.txt'), 'external-ready\n');
    await fs.writeFile(path.join(consumer, 'acplugin.config.ts'), `
import { defineConfig } from '@tokenroll/acplugin';
import { externalExtension, externalPlatform } from 'external-acplugin-integration-fixture';

export default defineConfig({
  name: 'external-consumer',
  version: '1.0.0',
  description: 'Clean external SDK consumer.',
  public: false,
  platforms: [externalPlatform],
  extensions: [externalExtension],
});
`);
    await execute('pnpm', ['install', '--ignore-workspace', '--ignore-scripts'], consumer);
    await execute('pnpm', ['exec', 'tsc', '-p', 'tsconfig.json'], consumer);

    /** SDK identity helpers必须识别第三方 package 导出的两个 factory result。 */
    const identity = await execute(process.execPath, ['--input-type=module', '--eval', `
import { isAcpluginExtension, isAcpluginPlatform } from '@tokenroll/acplugin/sdk';
import { externalExtension, externalPlatform } from 'external-acplugin-integration-fixture';
process.stdout.write(JSON.stringify({
  platform: isAcpluginPlatform(externalPlatform),
  extension: isAcpluginExtension(externalExtension),
}));
`], consumer);
    expect(JSON.parse(identity.stdout)).toEqual({ platform: true, extension: true });

    /** validate 和 build 必须通过同一安装后的 CLI/Kernel 生命周期。 */
    const validate = JSON.parse((await execute('pnpm', ['exec', 'acplugin', 'validate', '--json'], consumer)).stdout);
    /** build 报告用于验证真实事务和最终 Package。 */
    const build = JSON.parse((await execute('pnpm', ['exec', 'acplugin', 'build', '--json'], consumer)).stdout);
    expect(validate).toMatchObject({ success: true, committed: false });
    expect(build).toMatchObject({ success: true, committed: true });
    expect(build.compatibility).toContainEqual(expect.objectContaining({
      platform: 'external-fixture',
      subject: 'external:state',
      capability: 'delivery',
      level: 'native',
    }));
    expect(build.packages).toContainEqual(expect.objectContaining({
      platform: 'external-fixture',
      id: 'plugin',
      validated: true,
      assets: expect.arrayContaining([
        expect.objectContaining({ path: 'plugin.json', owner: 'platform:external-fixture' }),
        expect.objectContaining({ path: 'external/state.txt', owner: 'extension:external-fixture' }),
      ]),
    }));
    await expect(fs.readFile(path.join(consumer, 'dist/external-fixture/plugin/external/state.txt'), 'utf8')).resolves.toBe('external-ready\n');
    /** 最终 Manifest 必须包含 Core 合并后的 add-only Document 字段。 */
    const manifest = JSON.parse(await fs.readFile(path.join(consumer, 'dist/external-fixture/plugin/plugin.json'), 'utf8'));
    expect(manifest.extensions).toEqual({ external: { enabled: true } });
  }, 120_000);

  it('typechecks and builds official Platform Component payloads from clean tarballs', async () => {
    /** 主包、Platform tarball 和 consumer 全部位于 workspace 外。 */
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-platform-components-pack-'));
    temporaryRoots.push(root);
    const tarballs = path.join(root, 'tarballs');
    await fs.mkdir(tarballs);

    /** 所有安装输入都经过各公开 package 的真实 pnpm pack 边界。 */
    const mainTarball = packedPath(
      (await execute('pnpm', ['pack', '--pack-destination', tarballs], packageRoot)).stdout,
      packageRoot,
    );
    const platformTarballs = Object.fromEntries(await Promise.all(
      Object.entries(componentPlatformRoots).map(async ([id, packageDirectory]) => [
        id,
        packedPath(
          (await execute('pnpm', ['pack', '--pack-destination', tarballs], packageDirectory)).stdout,
          packageDirectory,
        ),
      ]),
    ));

    /** clean consumer 不可见 workspace alias、私有 Core 或源码声明。 */
    const consumer = path.join(root, 'consumer');
    await fs.mkdir(consumer);
    await fs.writeFile(path.join(consumer, 'package.json'), JSON.stringify({
      name: 'official-platform-component-consumer',
      version: '1.0.0',
      private: true,
      type: 'module',
      dependencies: {
        '@tokenroll/acplugin': `file:${mainTarball}`,
        '@tokenroll/acplugin-platform-claude-code': `file:${platformTarballs['claude-code']}`,
        '@tokenroll/acplugin-platform-cursor': `file:${platformTarballs.cursor}`,
        '@tokenroll/acplugin-platform-opencode': `file:${platformTarballs.opencode}`,
      },
      devDependencies: { '@typescript/native': 'npm:typescript@^7.0.2' },
    }, null, 2));
    await fs.writeFile(path.join(consumer, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        lib: ['ESNext', 'DOM'],
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        noEmit: true,
        skipLibCheck: false,
      },
      include: ['acplugin.config.ts'],
    }, null, 2));
    await fs.writeFile(path.join(consumer, 'acplugin.config.ts'), `
import { defineConfig } from '@tokenroll/acplugin';
import { defineExtension, type PlatformContributor } from '@tokenroll/acplugin/sdk';
import claudeCode, { type ClaudePackageComponent } from '@tokenroll/acplugin-platform-claude-code';
import cursor, { type CursorPackageComponent } from '@tokenroll/acplugin-platform-cursor';
import openCode, { type OpenCodePackageComponent } from '@tokenroll/acplugin-platform-opencode';

type BuiltState = Record<string, never>;
const subject = 'fixture:packed-agent';
const compatibility = [{
  subject,
  capability: 'delivery',
  level: 'native',
  reason: 'The packed fixture is delivered as a native Platform Component.',
}] as const;

const claudeContributor: PlatformContributor<BuiltState, ClaudePackageComponent> = {
  platform: 'claude-code',
  platformApiVersion: '1',
  contribute: () => ({
    components: [{ subject, value: {
      kind: 'native-agent', id: 'packed-agent', description: 'Packed Agent.', body: 'Run packed checks.',
      model: 'capable', tools: ['Read'],
    } }],
    compatibility,
  }),
};

const cursorContributor: PlatformContributor<BuiltState, CursorPackageComponent> = {
  platform: 'cursor',
  platformApiVersion: '1',
  contribute: () => ({
    components: [{ subject, value: {
      kind: 'native-agent', id: 'packed-agent', description: 'Packed Agent.', body: 'Run packed checks.',
      readonly: true,
    } }],
    compatibility,
  }),
};

const openCodeContributor: PlatformContributor<BuiltState, OpenCodePackageComponent> = {
  platform: 'opencode',
  platformApiVersion: '1',
  contribute: () => ({
    components: [{ subject, value: {
      kind: 'native-agent', id: 'packed-agent', description: 'Packed Agent.', body: 'Run packed checks.',
      tools: { read: true }, permission: { edit: 'deny' },
    } }],
    compatibility,
  }),
};

const extension = defineExtension({
  id: 'packed-component-fixture',
  apiVersion: '1',
  resourceRoots: [],
  createSession: () => ({
    discover: () => ({}),
    validate: (_context, state) => ({ state, subjects: [{ subject, capabilities: ['delivery'] }] }),
    build: (_context, state) => ({ state }),
    contributors: [claudeContributor, cursorContributor, openCodeContributor],
  }),
});

export default defineConfig({
  name: 'packed-component-consumer',
  version: '1.0.0',
  description: 'Clean packed Platform Component consumer.',
  public: false,
  platforms: [claudeCode(), cursor(), openCode()],
  extensions: [extension],
});
`);

    await execute('pnpm', ['install', '--ignore-workspace', '--ignore-scripts'], consumer);
    await execute('pnpm', ['exec', 'tsc', '-p', 'tsconfig.json'], consumer);
    const build = JSON.parse((await execute('pnpm', ['exec', 'acplugin', 'build', '--json'], consumer)).stdout);

    expect(build).toMatchObject({ success: true, committed: true, schemaVersion: 3 });
    expect(build.packages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        platform: 'claude-code',
        assets: expect.arrayContaining([expect.objectContaining({ path: 'agents/packed-agent.md' })]),
      }),
      expect.objectContaining({
        platform: 'cursor',
        assets: expect.arrayContaining([expect.objectContaining({ path: 'agents/packed-agent.md' })]),
      }),
      expect.objectContaining({
        platform: 'opencode',
        assets: expect.arrayContaining([expect.objectContaining({ path: '.opencode/agents/packed-agent.md' })]),
      }),
    ]));
  }, 120_000);
});
