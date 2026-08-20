import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PackageContribution, PlatformPackageInput } from '../../src/contracts/index.js';
import { AssetRegistry } from '../../src/services/assets.js';
import { BuildSessionScope } from '../../src/lifecycle/session-scope.js';
import { SourceRegistry } from '../../src/services/sources.js';
import { WorkDirectoryRegistry } from '../../src/services/work-directories.js';
import {
  createBasePackage,
  finalizePrimaryPackage,
  mergePackageContributions,
} from '../../src/package/registry.js';

/** Package Registry 测试临时根。 */
const roots: string[] = [];

/** @returns 当前 Session Asset Registry 与 owner services。 */
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-package-registry-'));
  roots.push(root);
  const scope = new BuildSessionScope();
  const sources = new SourceRegistry(scope, root);
  const work = new WorkDirectoryRegistry(scope, path.join(root, '.work'));
  const assets = new AssetRegistry(scope, sources, work);
  return { root, assets };
}

/** @returns 另一 BuildSession，用于证明 ref identity 不跨 Session。 */
async function otherAssets(root: string): Promise<AssetRegistry> {
  const scope = new BuildSessionScope();
  const sources = new SourceRegistry(scope, root);
  const work = new WorkDirectoryRegistry(scope, path.join(root, '.work-other'));
  return new AssetRegistry(scope, sources, work);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

/** @returns 带两个 extension point 的 Platform base Package。 */
async function baseInput(assets: AssetRegistry): Promise<PlatformPackageInput> {
  const readme = await assets.service('platform:target').fromBytes({
    bytes: 'readme\n',
    origin: { operation: 'platform-readme' },
  });
  return {
    documents: [{
      id: 'manifest',
      path: 'plugin.json',
      format: 'json',
      value: { extensions: {} },
      extensionPoints: [['extensions', 'hooks'], ['extensions', 'mcp']],
    }],
    assets: [{ path: 'README.md', asset: readme }],
    compatibility: [{ subject: 'skill:review', capability: 'component', level: 'native', reason: 'Native.' }],
    metadata: [
      { field: 'name', disposition: 'emitted', output: 'manifest.name', reason: 'Emitted.' },
      { field: 'version', disposition: 'emitted', output: 'manifest.version', reason: 'Emitted.' },
      { field: 'description', disposition: 'emitted', output: 'manifest.description', reason: 'Emitted.' },
    ],
  };
}

describe('Package Registry', () => {
  it('creates immutable base snapshots and rejects occupied or colliding Documents', async () => {
    const current = await fixture();
    const input = await baseInput(current.assets);
    const base = createBasePackage('target', input, current.assets);

    expect(base.documents[0]).toMatchObject({ id: 'manifest', path: 'plugin.json', emission: 'required' });
    expect(Object.isFrozen(base)).toBe(true);
    expect(Object.isFrozen(base.documents[0]?.value)).toBe(true);
    expect(() => createBasePackage('target', {
      ...input,
      documents: [{ ...input.documents[0]!, value: { extensions: { hooks: true } }, extensionPoints: [['extensions', 'hooks']] }],
    }, current.assets)).toThrow('empty field');
    expect(() => createBasePackage('target', {
      ...input,
      documents: [...input.documents, { ...input.documents[0]!, id: 'other', path: 'PLUGIN.json', extensionPoints: [] }],
    }, current.assets)).toThrow('collides');
    /** null-prototype JSON records are valid data containers at the package boundary. */
    const nullPrototype = Object.assign(Object.create(null) as Record<string, unknown>, {
      extensions: Object.create(null) as Record<string, unknown>,
    });
    expect(createBasePackage('target', {
      ...input,
      documents: [{ ...input.documents[0]!, value: nullPrototype as never }],
    }, current.assets).documents[0]?.value).toEqual({ extensions: {} });
  });

  it('merges contributions independently of configuration/completion order', async () => {
    const current = await fixture();
    const base = createBasePackage('target', await baseInput(current.assets), current.assets);
    const hooksAsset = await current.assets.service('extension:hooks').fromBytes({
      bytes: 'hooks', origin: { operation: 'hooks-runtime', subjects: ['hook:pre-tool'] },
    });
    const mcpAsset = await current.assets.service('extension:mcp').fromBytes({
      bytes: 'mcp', origin: { operation: 'mcp-runtime', subjects: ['mcp:tools'] },
    });
    const contributions = [
      {
        owner: 'extension:mcp',
        subjects: [{ subject: 'mcp:tools', capabilities: ['runtime'] }],
        contribution: {
          documentFields: [{ document: 'manifest', path: ['extensions', 'mcp'], value: { enabled: true } }],
          assets: [{ path: 'runtime/mcp.mjs', asset: mcpAsset }],
          compatibility: [{ subject: 'mcp:tools', capability: 'runtime', level: 'native', reason: 'Native.' }],
        },
      },
      {
        owner: 'extension:hooks',
        subjects: [{ subject: 'hook:pre-tool', capabilities: ['runtime'] }],
        contribution: {
          documentFields: [{ document: 'manifest', path: ['extensions', 'hooks'], value: { enabled: true } }],
          assets: [{ path: 'runtime/hooks.mjs', asset: hooksAsset }],
          compatibility: [{ subject: 'hook:pre-tool', capability: 'runtime', level: 'native', reason: 'Native.' }],
        },
      },
    ] as const;

    const first = mergePackageContributions('target', base, contributions, current.assets);
    const second = mergePackageContributions('target', base, [...contributions].reverse(), current.assets);
    expect(first.documents[0]?.value).toEqual(second.documents[0]?.value);
    expect(first.assets.map(asset => [asset.path, asset.owner])).toEqual(second.assets.map(asset => [asset.path, asset.owner]));
    expect(first.assets.map(asset => asset.path)).toEqual(['README.md', 'runtime/hooks.mjs', 'runtime/mcp.mjs']);
  });

  it('keeps async contributor completion order outside centralized merge semantics', async () => {
    const current = await fixture();
    const base = createBasePackage('target', await baseInput(current.assets), current.assets);
    /** 每个异步 producer 只返回 owner-bound Contribution，不观察其他 producer。 */
    const produce = async (owner: 'extension:hooks' | 'extension:mcp', delay: number) => {
      await new Promise<void>(resolve => setTimeout(resolve, delay));
      const id = owner.slice('extension:'.length);
      const asset = await current.assets.service(owner).fromBytes({ bytes: id, origin: { operation: `${id}-runtime` } });
      return {
        owner,
        contribution: {
          documentFields: [{ document: 'manifest', path: ['extensions', id], value: { enabled: true } }],
          assets: [{ path: `runtime/${id}.mjs`, asset }],
          compatibility: [],
        },
      } as const;
    };
    const hooksFirst = await Promise.all([produce('extension:hooks', 0), produce('extension:mcp', 10)]);
    const mcpFirst = await Promise.all([produce('extension:mcp', 0), produce('extension:hooks', 10)]);

    const first = mergePackageContributions('target', base, hooksFirst, current.assets);
    const second = mergePackageContributions('target', base, mcpFirst, current.assets);
    expect(first.documents).toEqual(second.documents);
    expect(first.assets.map(asset => [asset.path, asset.owner])).toEqual(second.assets.map(asset => [asset.path, asset.owner]));
  });

  it('rejects undeclared/duplicate fields, path collisions, forged refs and missing subject coverage', async () => {
    const current = await fixture();
    const base = createBasePackage('target', await baseInput(current.assets), current.assets);
    const hooksAsset = await current.assets.service('extension:hooks').fromBytes({ bytes: 'hooks', origin: { operation: 'hooks-runtime' } });
    const contribution = (value: Partial<PackageContribution>): PackageContribution => ({ compatibility: [], ...value });

    expect(() => mergePackageContributions('target', base, [{
      owner: 'extension:hooks', contribution: contribution({ documentFields: [{ document: 'manifest', path: ['extensions', 'unknown'], value: true }] }),
    }], current.assets)).toThrow('undeclared');
    expect(() => mergePackageContributions('target', base, [
      { owner: 'extension:a', contribution: contribution({ documentFields: [{ document: 'manifest', path: ['extensions', 'hooks'], value: true }] }) },
      { owner: 'extension:b', contribution: contribution({ documentFields: [{ document: 'manifest', path: ['extensions', 'hooks'], value: false }] }) },
    ], current.assets)).toThrow('claimed by both');
    expect(() => mergePackageContributions('target', base, [{
      owner: 'extension:hooks', contribution: contribution({ assets: [{ path: 'readme.md', asset: hooksAsset }] }),
    }], current.assets)).toThrow('collides');
    expect(() => mergePackageContributions('target', base, [{
      owner: 'extension:other', contribution: contribution({ assets: [{ path: 'runtime/hooks.mjs', asset: hooksAsset }] }),
    }], current.assets)).toThrow('not authorized');
    expect(() => mergePackageContributions('target', base, [{
      owner: 'extension:hooks', subjects: [{ subject: 'hook:pre-tool', capabilities: ['runtime'] }], contribution: contribution({}),
    }], current.assets)).toThrow('does not cover');
    /** forged ref 与另一 BuildSession 的真实 ref 都不能进入当前 Package。 */
    expect(() => mergePackageContributions('target', base, [{
      owner: 'extension:hooks', contribution: contribution({ assets: [{ path: 'runtime/forged.mjs', asset: Object.freeze({ ...hooksAsset }) }] }),
    }], current.assets)).toThrow('not authorized');
    const other = await otherAssets(current.root);
    const crossSession = await other.service('extension:hooks').fromBytes({ bytes: 'other', origin: { operation: 'other-runtime' } });
    expect(() => mergePackageContributions('target', base, [{
      owner: 'extension:hooks', contribution: contribution({ assets: [{ path: 'runtime/other.mjs', asset: crossSession }] }),
    }], current.assets)).toThrow('BuildSession');
  });

  it('rejects behavior-bearing package, contribution and compatibility objects', async () => {
    const current = await fixture();
    const input = await baseInput(current.assets);
    class PackageInput {}
    const accessor = Object.defineProperty({}, 'documents', { get: () => [], enumerable: true });
    expect(() => createBasePackage('target', new PackageInput() as never, current.assets)).toThrow('plain object');
    expect(() => createBasePackage('target', accessor as never, current.assets)).toThrow('data property');
    expect(() => createBasePackage('target', { ...input, [Symbol('hidden')]: true } as never, current.assets)).toThrow('Symbol');
    expect(() => createBasePackage('target', {
      ...input,
      compatibility: [Object.defineProperty({}, 'subject', { get: () => 'skill:review', enumerable: true }) as never],
    }, current.assets)).toThrow('data property');

    const base = createBasePackage('target', input, current.assets);
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => mergePackageContributions('target', base, [{
      owner: 'extension:hooks',
      contribution: {
        documentFields: [{ document: 'manifest', path: ['extensions', 'hooks'], value: cycle as never }],
        compatibility: [],
      },
    }], current.assets)).toThrow('cycles');
  });

  it('finalizes a primary Unit by automatically inheriting assets and Core-encoded Documents', async () => {
    const current = await fixture();
    const base = createBasePackage('target', await baseInput(current.assets), current.assets);
    const finalAsset = await current.assets.service('platform:target').fromBytes({ bytes: 'final', origin: { operation: 'final-manifest' } });
    const primary = await finalizePrimaryPackage('target', 'plugin', base, {
      id: 'plugin', type: 'plugin', assets: [{ path: 'final.txt', asset: finalAsset }],
    }, current.assets);

    expect(primary.assets.map(asset => asset.path)).toEqual(['README.md', 'final.txt', 'plugin.json']);
    const documentAsset = primary.assets.find(asset => asset.path === 'plugin.json')!;
    expect(new TextDecoder().decode(await current.assets.service('platform:target').read(documentAsset.asset))).toContain('"extensions"');
    await expect(finalizePrimaryPackage('target', 'plugin', base, {
      id: 'plugin', type: 'workspace',
    }, current.assets)).rejects.toThrow('delivery type');
    /** finalize 不能借助既有 grant 把其他 owner ref 伪装成新增 Platform Asset。 */
    const foreign = await current.assets.service('extension:foreign').fromBytes({ bytes: 'foreign', origin: { operation: 'foreign' } });
    current.assets.grant('extension:foreign', 'platform:target', foreign);
    await expect(finalizePrimaryPackage('target', 'plugin', base, {
      id: 'plugin', type: 'plugin', assets: [{ path: 'foreign.txt', asset: foreign }],
    }, current.assets)).rejects.toThrow('current Platform');
  });
});
