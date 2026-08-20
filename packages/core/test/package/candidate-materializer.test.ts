import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PackageUnitSnapshot } from '../../src/contracts/index.js';
import { AssetRegistry } from '../../src/services/assets.js';
import { BuildSessionScope } from '../../src/services/session-scope.js';
import { SourceRegistry } from '../../src/services/sources.js';
import { WorkDirectoryRegistry } from '../../src/services/work-directories.js';
import { materializePackageCandidate, withPackageCandidate } from '../../src/package/candidate-materializer.js';

/** Candidate 测试使用并统一清理的临时根。 */
const roots: string[] = [];

/** @returns 当前测试独占的 Registry 与临时根。 */
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-candidate-v2-'));
  roots.push(root);
  const scope = new BuildSessionScope();
  const sources = new SourceRegistry(scope, root);
  const work = new WorkDirectoryRegistry(scope, path.join(root, '.work'));
  const assets = new AssetRegistry(scope, sources, work);
  return { root, scope, sources, work, assets };
}

/** @returns 带一个 executable Asset 的最小主 Package Unit。 */
async function unit(assets: AssetRegistry): Promise<PackageUnitSnapshot> {
  /** Platform owner 签发的 candidate 内容。 */
  const asset = await assets.service('platform:target').fromBytes({
    bytes: 'export default true;\n', mode: 0o755, origin: { operation: 'runtime-main' },
  });
  return Object.freeze({
    platform: 'target', id: 'plugin', type: 'plugin', role: 'primary',
    assets: Object.freeze([{ path: 'runtime/main.mjs', owner: 'platform:target', asset }]),
    compatibility: Object.freeze([]), metadata: Object.freeze([]),
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe('Package candidate materializer', () => {
  it('materializes a complete candidate and always cleans its temporary root', async () => {
    const current = await fixture();
    const packageUnit = await unit(current.assets);
    let candidateRoot = '';

    await withPackageCandidate(packageUnit, current.assets, async (candidate) => {
      candidateRoot = candidate.root;
      expect(await fs.readFile(path.join(candidate.root, 'runtime', 'main.mjs'), 'utf8')).toBe('export default true;\n');
      expect((await fs.stat(path.join(candidate.root, 'runtime', 'main.mjs'))).mode & 0o777).toBe(0o755);
      if (process.platform !== 'win32') {
        expect((await fs.stat(candidate.root)).mode & 0o777).toBe(0o700);
        expect((await fs.stat(path.join(candidate.root, 'runtime'))).mode & 0o777).toBe(0o700);
      }
    }, current.root);

    await expect(fs.access(candidateRoot)).rejects.toThrow();
  });

  it('detects validator byte, mode, extra-file, symlink and empty-directory mutations', async () => {
    const mutations = [
      async (root: string) => fs.writeFile(path.join(root, 'runtime', 'main.mjs'), 'mutated'),
      async (root: string) => fs.chmod(path.join(root, 'runtime', 'main.mjs'), 0o644),
      async (root: string) => fs.writeFile(path.join(root, 'extra.txt'), 'extra'),
      async (root: string) => fs.symlink(path.join(root, 'runtime', 'main.mjs'), path.join(root, 'link.mjs')),
      async (root: string) => fs.mkdir(path.join(root, 'empty')),
    ];
    for (const mutate of mutations) {
      const current = await fixture();
      const packageUnit = await unit(current.assets);
      await expect(withPackageCandidate(packageUnit, current.assets, async (candidate) => {
        await mutate(candidate.root);
      }, current.root)).rejects.toThrow(/(?:integrity|mode|closure|symbolic link)/u);
    }
  });

  it('rejects forged, cross-owner and colliding Package Asset snapshots', async () => {
    const current = await fixture();
    const original = await unit(current.assets);
    const mapping = original.assets[0]!;
    /** 等形复制不能替代 AssetRegistry 中的原始 ref identity。 */
    const forged = Object.freeze({ ...mapping.asset });
    await expect(materializePackageCandidate(Object.freeze({
      ...original, assets: Object.freeze([{ ...mapping, asset: forged }]),
    }), current.assets, current.root)).rejects.toThrow('not authorized');
    /** mapping owner 必须与真实 issuer 一致。 */
    await expect(materializePackageCandidate(Object.freeze({
      ...original, assets: Object.freeze([{ ...mapping, owner: 'extension:forged' }]),
    }), current.assets, current.root)).rejects.toThrow('owner mismatch');
    /** 文件路径不能同时作为另一个文件的祖先目录。 */
    await expect(materializePackageCandidate(Object.freeze({
      ...original,
      assets: Object.freeze([
        mapping,
        { ...mapping, path: 'runtime' },
      ]),
    }), current.assets, current.root)).rejects.toThrow('collides');
  });

  it('rejects SourceAsset mutation immediately before candidate materialization', async () => {
    const current = await fixture();
    const sourceRoot = path.join(current.root, 'public');
    await fs.mkdir(sourceRoot);
    await fs.writeFile(path.join(sourceRoot, 'data.txt'), 'original');
    const directory = await current.sources.issueRoot('framework:public', sourceRoot);
    const source = await current.sources.service('framework:public').file(directory, 'data.txt');
    const asset = await current.assets.service('framework:public').fromSource(source);
    current.assets.grant('framework:public', 'platform:target', asset);
    const packageUnit: PackageUnitSnapshot = Object.freeze({
      platform: 'target', id: 'plugin', type: 'plugin', role: 'primary',
      assets: Object.freeze([{ path: 'data.txt', owner: 'framework:public', asset }]),
      compatibility: Object.freeze([]), metadata: Object.freeze([]),
    });
    await fs.writeFile(path.join(sourceRoot, 'data.txt'), 'changed');

    await expect(materializePackageCandidate(packageUnit, current.assets, current.root)).rejects.toThrow('changed after');
  });

  it('makes candidate cleanup idempotent', async () => {
    const current = await fixture();
    const handle = await materializePackageCandidate(await unit(current.assets), current.assets, current.root);
    await handle.cleanup();
    await expect(handle.cleanup()).resolves.toBeUndefined();
  });
});
