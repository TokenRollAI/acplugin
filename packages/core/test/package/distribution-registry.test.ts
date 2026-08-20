import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AssetRef, PackageUnitSnapshot } from '../../src/contracts/index.js';
import { AssetRegistry } from '../../src/services/assets.js';
import { BuildSessionScope } from '../../src/services/session-scope.js';
import { SourceRegistry } from '../../src/services/sources.js';
import { WorkDirectoryRegistry } from '../../src/services/work-directories.js';
import { collectDistributionPackages, createDistributionPackage } from '../../src/package/distributions.js';

/** Distribution 测试统一清理的临时根。 */
const roots: string[] = [];

/** @returns Asset Registry 与带继承 Asset 的 primary Unit。 */
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-distribution-v2-'));
  roots.push(root);
  const scope = new BuildSessionScope();
  const sources = new SourceRegistry(scope, root);
  const work = new WorkDirectoryRegistry(scope, path.join(root, '.work'));
  const assets = new AssetRegistry(scope, sources, work);
  const inherited = await assets.service('platform:target').fromBytes({
    bytes: 'plugin', mode: 0o755, origin: { operation: 'plugin-main' },
  });
  const primary: PackageUnitSnapshot = Object.freeze({
    platform: 'target', id: 'plugin', type: 'plugin', role: 'primary',
    assets: Object.freeze([{ path: 'main.mjs', owner: 'platform:target', asset: inherited }]),
    compatibility: Object.freeze([]), metadata: Object.freeze([]),
  });
  return { root, assets, primary, inherited };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe('Distribution Package Registry', () => {
  it('inherits primary refs, accepts callback-issued refs and preserves metadata', async () => {
    const current = await fixture();
    const scope = current.assets.issuanceScope('platform:target');
    const manifest = await scope.service.fromBytes({ bytes: '{}\n', origin: { operation: 'marketplace-manifest' } });
    scope.close();
    const distribution = createDistributionPackage({
      platform: 'target', primary: current.primary, assets: current.assets, issued: scope.includes,
      input: {
        id: 'marketplace', type: 'marketplace',
        assets: [
          { path: 'plugin/runtime.mjs', asset: current.inherited },
          { path: 'marketplace.json', asset: manifest },
        ],
      },
    });

    expect(distribution).toMatchObject({ platform: 'target', id: 'marketplace', role: 'distribution', type: 'marketplace' });
    expect(distribution.assets.map(asset => [asset.path, asset.owner])).toEqual([
      ['marketplace.json', 'platform:target'],
      ['plugin/runtime.mjs', 'platform:target'],
    ]);
    await expect(scope.service.fromBytes({ bytes: 'late', origin: { operation: 'late' } })).rejects.toThrow('no longer active');
  });

  it('rejects foreign granted refs, forged refs, duplicate roots and invalid identities', async () => {
    const current = await fixture();
    const foreign = await current.assets.service('extension:foreign').fromBytes({ bytes: 'foreign', origin: { operation: 'foreign' } });
    current.assets.grant('extension:foreign', 'platform:target', foreign);
    const scope = current.assets.issuanceScope('platform:target');
    scope.close();
    const create = (asset: AssetRef, id = 'marketplace') => createDistributionPackage({
      platform: 'target', primary: current.primary, assets: current.assets, issued: scope.includes,
      input: { id, type: 'marketplace', assets: [{ path: 'foreign.txt', asset }] },
    });

    expect(() => create(foreign)).toThrow('inherited from primary or issued');
    expect(() => create(Object.freeze({ ...current.inherited }) as AssetRef)).toThrow('inherited from primary or issued');
    expect(() => create(current.inherited, 'plugin')).toThrow('differ from the primary');
    expect(() => createDistributionPackage({
      platform: 'target', primary: current.primary, assets: current.assets, issued: scope.includes,
      input: {
        id: 'marketplace', type: 'marketplace',
        assets: [
          { path: 'tree', asset: current.inherited },
          { path: 'tree/main.mjs', asset: current.inherited },
        ],
      },
    })).toThrow('collides');
  });

  it('owns the callback Asset scope, closes leaked services and rejects duplicate outputs', async () => {
    const current = await fixture();
    let leaked: Parameters<Parameters<typeof collectDistributionPackages>[0]['create']>[0] | undefined;
    const distributions = await collectDistributionPackages({
      platform: 'target', primary: current.primary, assets: current.assets,
      async create(assets) {
        leaked = assets;
        const manifest = await assets.fromBytes({ bytes: '{}\n', origin: { operation: 'marketplace-manifest' } });
        return [{ id: 'marketplace', type: 'marketplace', assets: [{ path: 'marketplace.json', asset: manifest }] }];
      },
    });

    expect(distributions.map(unit => unit.id)).toEqual(['marketplace']);
    await expect(leaked!.fromBytes({ bytes: 'late', origin: { operation: 'late' } })).rejects.toThrow('no longer active');
    await expect(collectDistributionPackages({
      platform: 'target', primary: current.primary, assets: current.assets,
      create: () => [
        { id: 'marketplace', type: 'marketplace', assets: [] },
        { id: 'marketplace', type: 'marketplace', assets: [] },
      ],
    })).rejects.toThrow('unique');
  });

  it('closes the callback Asset scope when Platform creation throws', async () => {
    const current = await fixture();
    let leaked: Parameters<Parameters<typeof collectDistributionPackages>[0]['create']>[0] | undefined;
    await expect(collectDistributionPackages({
      platform: 'target', primary: current.primary, assets: current.assets,
      create(assets) {
        leaked = assets;
        throw new Error('Platform failed');
      },
    })).rejects.toThrow('Platform failed');
    await expect(leaked!.fromBytes({ bytes: 'late', origin: { operation: 'late' } })).rejects.toThrow('no longer active');
  });
});
