import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CompileJob, SourceFileRef } from '../src/kernel-types.js';
import { CompilerHost } from '../src/compiler/compiler-host.js';
import { packageScope } from '../src/compiler/managed-boundary.js';
import { AssetRegistry } from '../src/kernel/asset-registry.js';
import { BuildSessionScope } from '../src/kernel/build-session-scope.js';
import { SourceRegistry } from '../src/kernel/source-registry.js';
import { WatchRegistry } from '../src/kernel/watch-registry.js';
import { WorkDirectoryRegistry } from '../src/kernel/work-directories.js';

/** portable Compiler 测试创建的临时工程根。 */
const roots: string[] = [];

/**
 * 写入一个真实可由 Rolldown bare-import 解析的第三方包。
 *
 * @param root fixture 工程根。
 * @param options 可选缺失/非法法律材料状态。
 * @returns package 真正物理根。
 */
async function writeDependency(
  root: string,
  options: { readonly license?: string | false; readonly legal?: boolean; readonly symlink?: boolean } = {},
): Promise<string> {
  /** symlink 模式模拟 pnpm node_modules 链接到包管理器 store。 */
  const packageRoot = options.symlink === true
    ? path.join(root, '.store', 'portable-fixture-dependency')
    : path.join(root, 'node_modules', 'portable-fixture-dependency');
  await fs.mkdir(packageRoot, { recursive: true });
  await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
    name: 'portable-fixture-dependency',
    version: '3.2.1',
    type: 'module',
    exports: './index.js',
    ...(options.license === false ? {} : { license: options.license ?? 'MIT' }),
  }));
  await fs.writeFile(path.join(packageRoot, 'index.js'), [
    '/*! @license MIT */',
    'export const dependencyMessage = "dependency-ready";',
  ].join('\n'));
  if (options.legal !== false) {
    await fs.writeFile(path.join(packageRoot, 'LICENSE'), 'Portable fixture dependency license.\n');
    await fs.writeFile(path.join(packageRoot, 'NOTICE.md'), 'Portable fixture notice.\n');
  }
  if (options.symlink === true) {
    const modules = path.join(root, 'node_modules');
    await fs.mkdir(modules, { recursive: true });
    await fs.symlink(packageRoot, path.join(modules, 'portable-fixture-dependency'), 'dir');
  }
  return packageRoot;
}

/**
 * 创建 owner-scoped portable Compiler fixture。
 *
 * @param dependency 是否写入依赖及其法律材料。
 * @returns SourceRef、CompilerService、AssetRegistry 与 watch 记录。
 */
async function fixture(dependency: Parameters<typeof writeDependency>[1] | false = {}) {
  /** 当前测试独占工程根。 */
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-compiler-portable-'));
  roots.push(root);
  /** portable 作者源码树。 */
  const sourceRoot = path.join(root, 'src', 'runtime');
  await fs.mkdir(sourceRoot, { recursive: true });
  await fs.writeFile(path.join(sourceRoot, 'helper.ts'), 'export const local: string = "local";\n');
  await fs.writeFile(path.join(sourceRoot, 'main.ts'), [
    'import { readFile } from "fs/promises";',
    'import { dependencyMessage } from "portable-fixture-dependency";',
    'import { local } from "./helper.ts";',
    'export const value: string = `${dependencyMessage}:${local}:${typeof readFile}`;',
  ].join('\n'));
  await fs.writeFile(path.join(sourceRoot, 'plain.mts'), 'export const plain: string = "plain";\n');
  /** 可选正常或故障依赖。 */
  const packageRoot = dependency === false ? undefined : await writeDependency(root, dependency);
  /** 当前 BuildSession capability registries。 */
  const owner = 'framework:portable';
  const scope = new BuildSessionScope();
  const sources = new SourceRegistry(scope, root);
  const work = new WorkDirectoryRegistry(scope, path.join(root, '.work'));
  const assets = new AssetRegistry(scope, sources, work);
  /** 当前 Session 唯一 Watch Registry。 */
  const watch = new WatchRegistry(scope, root);
  const sourceDirectory = await sources.issueRoot(owner, sourceRoot);
  const sourceService = sources.service(owner);
  const main = await sourceService.file(sourceDirectory, 'main.ts');
  const plain = await sourceService.file(sourceDirectory, 'plain.mts');
  const host = new CompilerHost({
    projectRoot: root,
    sources,
    workDirectories: work,
    assets,
    watch,
  });
  return {
    root,
    sourceRoot,
    packageRoot,
    sourceDirectory,
    sourceService,
    main,
    plain,
    assets,
    owner,
    watch,
    service: await host.service(owner),
  };
}

/**
 * 创建固定 portable-node Job。
 *
 * @param entries 当前 owner 的命名 SourceRef。
 * @param overrides 需要覆盖的 Job 字段。
 * @returns 可交给 CompilerService 的请求。
 */
function portableJob(
  entries: Readonly<Record<string, SourceFileRef>>,
  overrides: Record<string, unknown> = {},
): CompileJob<'portable-node'> {
  return {
    id: 'portable-job',
    profile: 'portable-node',
    entries: Object.fromEntries(Object.entries(entries).map(([id, source]) => [id, {
      type: 'source' as const,
      source,
      mode: id === 'main' ? 0o755 : 0o644,
    }])),
    ...overrides,
  } as CompileJob<'portable-node'>;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe('portable-node Compiler Profile', () => {
  it('resolves package identity above type-only nested manifests', async () => {
    /** 许多 ESM 包在 dist/esm 下放置只含 type 的 package.json。 */
    const current = await fixture();
    /** 模拟真实 SDK 的嵌套 module-format boundary。 */
    const nested = path.join(current.packageRoot!, 'dist/esm');
    await fs.mkdir(nested, { recursive: true });
    await fs.writeFile(path.join(nested, 'package.json'), JSON.stringify({ type: 'module' }));
    await fs.writeFile(path.join(nested, 'index.js'), 'export const value = true;\n');

    await expect(packageScope(path.join(nested, 'index.js'))).resolves.toMatchObject({
      name: 'portable-fixture-dependency',
      version: '3.2.1',
      root: await fs.realpath(current.packageRoot!),
    });
  });

  it('builds each TS entry as an independent Node 20 ESM bundle with strict licenses', async () => {
    /** 当前包含第三方依赖的完整 fixture。 */
    const current = await fixture();
    const result = await current.service.compile(portableJob({ main: current.main, plain: current.plain }));

    expect(result.profile).toBe('portable-node');
    expect(result.outputs.map(output => [output.outputId, output.type, output.fileName])).toEqual([
      ['main', 'chunk', 'main.mjs'],
      ['main', 'licenses', 'THIRD_PARTY_LICENSES.txt'],
      ['plain', 'chunk', 'main.mjs'],
    ]);
    /** npm dependency 已内联，只保留规范化 node: builtin。 */
    const main = result.outputs.find(output => output.outputId === 'main' && output.type === 'chunk')!;
    const mainCode = new TextDecoder().decode(await current.assets.service(current.owner).read(main.asset));
    expect(mainCode).toContain('dependency-ready');
    expect(mainCode).toContain('from"node:fs/promises"');
    expect(mainCode).not.toContain('portable-fixture-dependency"');
    expect(mainCode).not.toContain(current.root);
    /** 第三方 license 只与实际包含依赖的 entry 相邻。 */
    const license = result.outputs.find(output => output.type === 'licenses')!;
    const licenseText = new TextDecoder().decode(await current.assets.service(current.owner).read(license.asset));
    expect(licenseText).toContain('Package: portable-fixture-dependency@3.2.1');
    expect(licenseText).toContain('License: MIT');
    expect(licenseText).toContain('--- LICENSE ---');
    expect(licenseText).toContain('--- NOTICE.md ---');
    expect(licenseText).not.toContain(current.root);
    /** source/package/manifest/legal inputs 全部进入唯一 watch 出口。 */
    expect(current.watch.snapshot().paths).toEqual(expect.arrayContaining([
      await fs.realpath(path.join(current.sourceRoot, 'main.ts')),
      await fs.realpath(path.join(current.sourceRoot, 'helper.ts')),
      await fs.realpath(path.join(current.packageRoot!, 'index.js')),
      await fs.realpath(path.join(current.packageRoot!, 'package.json')),
      await fs.realpath(path.join(current.packageRoot!, 'LICENSE')),
      await fs.realpath(path.join(current.packageRoot!, 'NOTICE.md')),
    ]));
    expect(result.modules.some(module => module.id === 'package:portable-fixture-dependency@3.2.1/index.js')).toBe(true);
  });

  it('produces identical bytes across physical roots and allows package-manager symlinks', async () => {
    /** 两个不同临时绝对根，其中一个依赖经 pnpm 风格 symlink 解析。 */
    const direct = await fixture();
    const symlinked = await fixture({ symlink: true });
    const first = await direct.service.compile(portableJob({ main: direct.main }));
    const second = await symlinked.service.compile(portableJob({ main: symlinked.main }));
    const firstBytes = await direct.assets.service(direct.owner).read(first.outputs.find(output => output.type === 'chunk')!.asset);
    const secondBytes = await symlinked.assets.service(symlinked.owner).read(second.outputs.find(output => output.type === 'chunk')!.asset);
    expect(firstBytes).toEqual(secondBytes);
    const firstLicense = await direct.assets.service(direct.owner).read(first.outputs.find(output => output.type === 'licenses')!.asset);
    const secondLicense = await symlinked.assets.service(symlinked.owner).read(second.outputs.find(output => output.type === 'licenses')!.asset);
    expect(firstLicense).toEqual(secondLicense);
  });

  it('accepts only the frozen portable JSON option subset', async () => {
    /** 不使用第三方依赖的入口可单独验证 option mapping。 */
    const current = await fixture(false);
    await expect(current.service.compile(portableJob({ plain: current.plain }, {
      options: {
        resolve: { extensions: ['.mts', '.ts', '.js'] },
        transform: { define: { PORTABLE_FLAG: '"ready"' }, dropLabels: ['DEBUG'] },
        treeshake: true,
      },
    }))).resolves.toMatchObject({ profile: 'portable-node' });

    await expect(current.service.compile(portableJob({ plain: current.plain }, {
      id: 'unknown-option',
      options: { plugins: [] },
    }))).rejects.toThrow('plugins is unknown');
    await expect(current.service.compile(portableJob({ plain: current.plain }, {
      id: 'unsafe-transform',
      options: { transform: { inject: { process: './shim.js' } } },
    }))).rejects.toThrow('inject is unknown');
    await expect(current.service.compile(portableJob({ plain: current.plain }, {
      id: 'unsafe-minify',
      options: { minify: false },
    }))).rejects.toThrow('minify is unknown');
  });

  it('rejects unresolved, non-literal, native and implicit runtime imports', async () => {
    /** 每个故障用独立 fixture，避免 SourceRef 发放后的文件修改触发更早指纹诊断。 */
    const check = async (code: string, expected: string): Promise<void> => {
      const current = await fixture(false);
      await fs.writeFile(path.join(current.sourceRoot, 'invalid.ts'), code);
      const invalid = await current.sourceService.file(current.sourceDirectory, 'invalid.ts');
      await expect(current.service.compile(portableJob({ invalid }))).rejects.toThrow(expected);
    };
    await check('import "missing-package"; export const value = true;', 'residual non-node import');
    await check('const target = "./helper.ts"; export const value = import(target);', 'non-literal dynamic import');
    await check('const target = "./helper.ts"; export const value = require(target);', 'non-literal require');
    await check('export { default } from "./native.node";', 'native addon');
    await check('export const file = new URL("./data.json", import.meta.url);', 'implicit runtime file');
  });

  it('fails strict license collection for missing or invalid evidence', async () => {
    /** package manifest 没有 SPDX field。 */
    const missingSpdx = await fixture({ license: false });
    await expect(missingSpdx.service.compile(portableJob({ main: missingSpdx.main }))).rejects.toThrow('SPDX');
    /** 非法 SPDX expression 不能冒充元数据。 */
    const invalidSpdx = await fixture({ license: 'Definitely Not SPDX' });
    await expect(invalidSpdx.service.compile(portableJob({ main: invalidSpdx.main }))).rejects.toThrow('invalid license SPDX');
    /** 只有 SPDX 字段、没有实际法律正文仍然失败。 */
    const missingLegal = await fixture({ legal: false });
    await expect(missingLegal.service.compile(portableJob({ main: missingLegal.main }))).rejects.toThrow('license or notice evidence');
  });
});
