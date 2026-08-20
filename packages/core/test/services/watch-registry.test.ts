import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BuildSessionScope } from '../../src/lifecycle/session-scope.js';
import { WatchRegistry } from '../../src/services/watch.js';

/** Watch Registry 测试创建的临时根。 */
const roots: string[] = [];

/**
 * 创建工程内文件和工程外 package 文件。
 *
 * @returns 当前测试独占的 watch fixture。
 */
async function fixture() {
  /** 当前测试独占工程根。 */
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-watch-registry-'));
  roots.push(root);
  /** 工程内两个可替换 observation。 */
  const alpha = path.join(root, 'src', 'alpha.ts');
  /** 第二个工程内 observation。 */
  const beta = path.join(root, 'src', 'beta.ts');
  await fs.mkdir(path.dirname(alpha), { recursive: true });
  await fs.writeFile(alpha, 'export const alpha = 1;\n');
  await fs.writeFile(beta, 'export const beta = 2;\n');
  /** 工程真实根外的模拟 package store。 */
  const packageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-watch-package-'));
  roots.push(packageRoot);
  /** 外部 package entry 必须带安全逻辑 identity。 */
  const packageEntry = path.join(packageRoot, 'index.js');
  await fs.writeFile(packageEntry, 'export {};\n');
  /** 当前 BuildSession scope。 */
  const scope = new BuildSessionScope();
  return { root, alpha, beta, packageRoot, packageEntry, scope, watch: new WatchRegistry(scope, root) };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe('WatchRegistry', () => {
  it('atomically replaces and removes owner operations with immutable snapshots', async () => {
    /** 当前测试独占 Registry。 */
    const current = await fixture();
    await current.watch.replace('extension:fixture', 'module/config', [
      { path: current.alpha, type: 'file' },
      { path: current.packageEntry, type: 'file', identity: 'package:fixture@1.0.0/index.js' },
    ]);
    /** 首次完整 operation 快照。 */
    const initial = current.watch.snapshot();

    expect(initial.identities).toEqual(['package:fixture@1.0.0/index.js', 'src/alpha.ts']);
    expect(Object.isFrozen(initial)).toBe(true);
    expect(Object.isFrozen(initial.paths)).toBe(true);
    expect(Object.isFrozen(initial.identities)).toBe(true);
    expect(initial.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: await fs.realpath(current.packageEntry), identity: 'package:fixture@1.0.0/index.js', type: 'file' }),
    ]));
    expect(Object.isFrozen(initial.observations)).toBe(true);

    /** replace 必须移除旧 observation，而不是增量残留。 */
    await current.watch.replace('extension:fixture', 'module/config', [{ path: current.beta, type: 'file' }]);
    expect(current.watch.snapshot().identities).toEqual(['src/beta.ts']);
    current.watch.remove('extension:fixture', 'module/config');
    expect(current.watch.snapshot()).toEqual({ paths: [], identities: [], observations: [] });
  });

  it('allows package-manager directory symlinks but rejects unsafe observations', async () => {
    /** 当前测试独占 Registry。 */
    const current = await fixture();
    /** node_modules 目录链接模拟 pnpm package link。 */
    const linkedPackage = path.join(current.root, 'node_modules', 'fixture');
    await fs.mkdir(path.dirname(linkedPackage), { recursive: true });
    await fs.symlink(current.packageRoot, linkedPackage, 'dir');
    await expect(current.watch.replace('framework:compiler', 'compiler/job', [{
      path: path.join(linkedPackage, 'index.js'),
      type: 'file',
      identity: 'package:fixture@1.0.0/index.js',
    }])).resolves.toBeUndefined();

    /** 最终文件 symlink 不属于 dependency-manager 目录链接例外。 */
    const linkedFile = path.join(current.root, 'linked.ts');
    await fs.symlink(current.alpha, linkedFile);
    await expect(current.watch.replace('framework:compiler', 'compiler/link', [{ path: linkedFile, type: 'file' }])).rejects.toThrow('regular file');
    await expect(current.watch.replace('framework:compiler', 'compiler/missing', [{ path: path.join(current.root, 'missing.ts'), type: 'file' }])).rejects.toThrow('regular file');
    await expect(current.watch.replace('framework:compiler', 'compiler/external', [{ path: current.packageEntry, type: 'file' }])).rejects.toThrow('package identity');
    /** Resource Registry 可观察空目录，供后续新增文件触发 Dev rebuild。 */
    await expect(current.watch.replace('framework:resource', 'resource/src', [{ path: path.join(current.root, 'src'), type: 'directory' }])).resolves.toBeUndefined();
    expect(current.watch.snapshot().identities).toContain('src');
    await expect(current.watch.replace('framework:resource', 'resource/wrong-type', [{ path: current.alpha, type: 'directory' }])).rejects.toThrow('regular directory');
  });

  it('rejects ambiguous identities and expired BuildSessions', async () => {
    /** 当前测试独占 Registry。 */
    const current = await fixture();
    /** 第二个外部文件用于 identity 一对多测试。 */
    const other = path.join(current.packageRoot, 'other.js');
    await fs.writeFile(other, 'export {};\n');

    await expect(current.watch.replace('extension:fixture', 'module/duplicate', [
      { path: current.packageEntry, type: 'file', identity: 'package:fixture@1.0.0/index.js' },
      { path: other, type: 'file', identity: 'package:fixture@1.0.0/index.js' },
    ])).rejects.toThrow('multiple files');
    await expect(current.watch.replace('extension:fixture', 'module/case', [
      { path: current.packageEntry, type: 'file', identity: 'package:fixture@1.0.0/Foo.js' },
      { path: other, type: 'file', identity: 'package:fixture@1.0.0/foo.js' },
    ])).rejects.toThrow('normalization collision');

    current.scope.close();
    expect(() => current.watch.snapshot()).toThrow('no longer active');
    await expect(current.watch.replace('extension:fixture', 'module/expired', [{ path: current.alpha, type: 'file' }])).rejects.toThrow('no longer active');
  });
});
