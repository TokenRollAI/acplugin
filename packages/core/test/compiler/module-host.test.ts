import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { BuildSessionScope } from '../../src/services/session-scope.js';
import { ModuleHost } from '../../src/compiler/module-host.js';
import { SourceRegistry } from '../../src/services/sources.js';
import { WatchRegistry } from '../../src/services/watch.js';
import { WorkDirectoryRegistry } from '../../src/services/work-directories.js';

/** Module Host 测试创建的临时工程根。 */
const roots: string[] = [];

/**
 * 写入一个 ESM/CJS package dependency。
 *
 * @param root 工程根。
 * @param name package 名称。
 * @param format package 模块格式。
 * @param symlink 是否模拟 pnpm store 目录链接。
 * @returns package 真实物理 entry。
 */
async function dependency(root: string, name: string, format: 'esm' | 'cjs', symlink = false): Promise<string> {
  /** symlink package 使用工程内 store，但正常 node_modules 路径是目录链接。 */
  const packageRoot = symlink ? path.join(root, '.store', name) : path.join(root, 'node_modules', name);
  await fs.mkdir(packageRoot, { recursive: true });
  /** 当前格式对应的 package entry 文件名。 */
  const entryName = format === 'esm' ? 'index.js' : 'index.cjs';
  await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
    name,
    version: '1.2.3',
    ...(format === 'esm' ? { type: 'module' } : {}),
    exports: `./${entryName}`,
  }));
  await fs.writeFile(path.join(packageRoot, entryName), format === 'esm'
    ? 'export default Object.freeze({ format: "esm" });\n'
    : 'module.exports = Object.freeze({ format: "cjs" });\n');
  if (symlink) {
    /** node_modules package link 保留正常包管理器解析语义。 */
    const modules = path.join(root, 'node_modules');
    await fs.mkdir(modules, { recursive: true });
    await fs.symlink(packageRoot, path.join(modules, name), 'dir');
  }
  return fs.realpath(path.join(packageRoot, entryName));
}

/**
 * 创建一轮全新的 owner-scoped Module Host Session。
 *
 * @param root 工程根。
 * @param sourceRoot 作者模块 root。
 * @param entryRelative 入口相对路径。
 * @param sessionId 独占 work 根后缀。
 * @returns 当前 BuildSession 的 module service 和 watch。
 */
async function session(root: string, sourceRoot: string, entryRelative: string, sessionId: string) {
  /** 每次调用使用新的 capability scope，防止 ESM cache 混入授权语义。 */
  const scope = new BuildSessionScope();
  /** 当前 Session Source Registry。 */
  const sources = new SourceRegistry(scope, root);
  /** 当前 Session owner。 */
  const owner = 'framework:config';
  /** config 来源根 ref。 */
  const sourceDirectory = await sources.issueRoot(owner, sourceRoot);
  /** config 精确入口 ref。 */
  const entry = await sources.service(owner).file(sourceDirectory, entryRelative);
  /** 当前 Session 独占 workDir。 */
  const workDirectories = new WorkDirectoryRegistry(scope, path.join(root, '.work', sessionId));
  /** 当前 Session 唯一 Watch Registry。 */
  const watch = new WatchRegistry(scope, root);
  /** 当前 Session 唯一 Module Host。 */
  const host = new ModuleHost({ projectRoot: root, sources, workDirectories, watch });
  return { scope, watch, entry, service: host.service(owner) };
}

/**
 * 创建包含 local graph、imports map 和 ESM/CJS package 的工程。
 *
 * @param symlink ESM dependency 是否使用 package-manager link。
 * @returns 可用于多 Session 的工程 fixture。
 */
async function fixture(symlink = false) {
  /** 当前测试独占工程根。 */
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-module-host-'));
  roots.push(root);
  /** Module Host 被授权的作者模块根。 */
  const sourceRoot = path.join(root, 'src', 'config');
  await fs.mkdir(sourceRoot, { recursive: true });
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
    name: 'module-host-project',
    version: '1.0.0',
    type: 'module',
    imports: { '#local': './src/config/imported.ts' },
  }));
  await fs.writeFile(path.join(sourceRoot, 'helper.ts'), 'export const local: string = "local";\n');
  await fs.writeFile(path.join(sourceRoot, 'imported.ts'), 'export const imported: string = "imports-map";\n');
  /** ESM package 可选使用 pnpm 风格链接。 */
  const esmEntry = await dependency(root, 'esm-fixture', 'esm', symlink);
  /** CJS package 验证 Node external interop identity。 */
  const cjsEntry = await dependency(root, 'cjs-fixture', 'cjs');
  await fs.writeFile(path.join(sourceRoot, 'config.ts'), [
    'import esm from "esm-fixture";',
    'import cjs from "cjs-fixture";',
    'import { local } from "./helper.ts";',
    'import { imported } from "#local";',
    'export default { esm, cjs, local, imported };',
  ].join('\n'));
  return { root, sourceRoot, esmEntry, cjsEntry };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe('ModuleHost', () => {
  it('bundles local TypeScript and preserves ESM/CJS package instance identity', async () => {
    /** package manager link 同时覆盖外部真实路径和 watch identity。 */
    const current = await fixture(true);
    /** 当前全新 Module Session。 */
    const currentSession = await session(current.root, current.sourceRoot, 'config.ts', 'first');
    const result = await currentSession.service.loadDefault<{
      readonly esm: object;
      readonly cjs: object;
      readonly local: string;
      readonly imported: string;
    }>({ id: 'project-config', entry: currentSession.entry });
    /** 直接 Node import 必须观察同一 externalized ESM instance。 */
    const directEsm = await import(pathToFileURL(current.esmEntry).href) as { readonly default: object };
    /** require 与 Module Host 的 CJS default 必须观察同一 Node cache identity。 */
    const directCjs = createRequire(import.meta.url)(current.cjsEntry) as object;

    expect(result.local).toBe('local');
    expect(result.imported).toBe('imports-map');
    expect(result.esm).toBe(directEsm.default);
    expect(result.cjs).toBe(directCjs);
    expect(currentSession.watch.snapshot().identities).toEqual(expect.arrayContaining([
      'package.json',
      'src/config/config.ts',
      'src/config/helper.ts',
      'src/config/imported.ts',
      'package:esm-fixture@1.2.3/index.js',
      'package:esm-fixture@1.2.3/package.json',
      'package:cjs-fixture@1.2.3/index.cjs',
      'package:cjs-fixture@1.2.3/package.json',
    ]));
  });

  it('freshly evaluates each BuildSession and rejects a missing default export', async () => {
    /** 当前测试独占工程。 */
    const current = await fixture();
    await fs.writeFile(path.join(current.sourceRoot, 'fresh.ts'), 'export default { value: 1 };\n');
    /** 第一轮独立 Session 读取旧值。 */
    const first = await session(current.root, current.sourceRoot, 'fresh.ts', 'fresh-one');
    await expect(first.service.loadDefault<{ readonly value: number }>({ id: 'fresh-config', entry: first.entry })).resolves.toEqual({ value: 1 });
    first.scope.close();
    await fs.writeFile(path.join(current.sourceRoot, 'fresh.ts'), 'export default { value: 2 };\n');
    /** 新 SourceRef + work URL 必须绕开上一轮 ESM cache。 */
    const second = await session(current.root, current.sourceRoot, 'fresh.ts', 'fresh-two');
    await expect(second.service.loadDefault<{ readonly value: number }>({ id: 'fresh-config', entry: second.entry })).resolves.toEqual({ value: 2 });

    await fs.writeFile(path.join(current.sourceRoot, 'missing-default.ts'), 'export const value = 1;\n');
    /** 缺少 default export 是稳定的 Module contract failure。 */
    const missing = await session(current.root, current.sourceRoot, 'missing-default.ts', 'missing');
    await expect(missing.service.loadDefault({ id: 'missing-default', entry: missing.entry })).rejects.toThrow('default export');
  });

  it('rejects local source escape, non-literal dynamic import and duplicate operations', async () => {
    /** 当前测试独占工程。 */
    const current = await fixture();
    await fs.writeFile(path.join(current.root, 'outside.ts'), 'export default "outside";\n');
    await fs.writeFile(path.join(current.sourceRoot, 'escape.ts'), 'export { default } from "../../outside.ts";\n');
    await fs.writeFile(path.join(current.sourceRoot, 'dynamic.ts'), 'const target = "./helper.ts"; export default import(target);\n');

    /** local graph 不得越过当前 Source root。 */
    const escaped = await session(current.root, current.sourceRoot, 'escape.ts', 'escape');
    await expect(escaped.service.loadDefault({ id: 'escape-config', entry: escaped.entry })).rejects.toThrow('escaped');
    /** 无法静态登记的动态 import 不得留到 runtime。 */
    const dynamic = await session(current.root, current.sourceRoot, 'dynamic.ts', 'dynamic');
    await expect(dynamic.service.loadDefault({ id: 'dynamic-config', entry: dynamic.entry })).rejects.toThrow('non-literal dynamic import');

    /** owner 内 operation ID 只能消费一次，避免覆盖 work output/watch identity。 */
    const duplicate = await session(current.root, current.sourceRoot, 'config.ts', 'duplicate');
    await duplicate.service.loadDefault({ id: 'same-operation', entry: duplicate.entry });
    await expect(duplicate.service.loadDefault({ id: 'same-operation', entry: duplicate.entry })).rejects.toThrow('already used');
  });
});
