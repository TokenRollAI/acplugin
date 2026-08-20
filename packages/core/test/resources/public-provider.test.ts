import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { definePlatform } from '../../src/api/definitions.js';
import { resolveKernelConfig } from '../../src/config/resolver.js';
import { AssetRegistry } from '../../src/services/assets.js';
import { BuildSessionScope } from '../../src/lifecycle/session-scope.js';
import { DiagnosticRegistry } from '../../src/services/diagnostics.js';
import { SourceRegistry } from '../../src/services/sources.js';
import { WatchRegistry } from '../../src/services/watch.js';
import { WorkDirectoryRegistry } from '../../src/services/work-directories.js';
import { discoverPublicResources } from '../../src/resources/public.js';

/** Public Provider 测试根。 */
const roots: string[] = [];

/** @returns 最小 Platform。 */
function platform() {
  return definePlatform({
    id: 'target', apiVersion: '1', deliveryType: 'plugin',
    createSession: () => ({
      createPackage: () => ({ documents: [], assets: [], compatibility: [], metadata: [] }),
      finalizePackage: () => ({ id: 'plugin', type: 'plugin' }),
      validatePackage: () => undefined,
    }),
  });
}

/**
 * 创建 Public Provider fixture。
 *
 * @param publicValue 作者 public 配置。
 * @returns 当前 BuildSession 和发现函数。
 */
async function fixture(publicValue: unknown = undefined) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-public-provider-'));
  roots.push(root);
  await fs.writeFile(path.join(root, 'acplugin.config.ts'), 'export default {};\n');
  const resolved = resolveKernelConfig({
    name: 'public-fixture', version: '1.0.0', description: 'Public fixture.', platforms: [platform()],
    ...(publicValue === undefined ? {} : { public: publicValue }),
  }, { projectRoot: root, configFile: path.join(root, 'acplugin.config.ts'), command: 'build', mode: 'production' });
  const scope = new BuildSessionScope();
  const sources = new SourceRegistry(scope, root);
  const work = new WorkDirectoryRegistry(scope, path.join(root, '.work'));
  const assets = new AssetRegistry(scope, sources, work);
  const watch = new WatchRegistry(scope, root);
  const diagnostics = new DiagnosticRegistry();
  const discover = () => discoverPublicResources({ config: resolved.config!, sources, assets, watch, diagnostics });
  return { root, configDiagnostics: resolved.diagnostics, assets, watch, diagnostics, discover };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe('Public Provider', () => {
  it('copies the default full tree as SourceAssets with stable package-relative paths', async () => {
    const current = await fixture();
    await fs.mkdir(path.join(current.root, 'public', 'bin'), { recursive: true });
    await fs.writeFile(path.join(current.root, 'public', 'bin', 'tool'), Uint8Array.of(0x00, 0xff));
    await fs.chmod(path.join(current.root, 'public', 'bin', 'tool'), 0o755);

    const resources = await current.discover();
    expect(current.configDiagnostics).toEqual([]);
    expect(current.diagnostics.diagnostics).toEqual([]);
    expect(resources.map(file => file.path)).toEqual(['bin/tool']);
    expect(current.assets.describe('framework:public', resources[0]!.asset)).toMatchObject({
      mode: 0o755,
      origin: { type: 'source', resource: 'framework:public', path: 'public/bin/tool' },
    });
    expect(current.watch.snapshot().identities).toContain('public');
  });

  it('supports multiple project-root exact sources without scanning protected siblings', async () => {
    const current = await fixture({
      dir: '.',
      copy: [
        { from: 'schemas', to: 'schemas' },
        { from: 'rulepacks', to: 'runtime/rulepacks' },
      ],
    });
    await fs.mkdir(path.join(current.root, 'schemas'), { recursive: true });
    await fs.mkdir(path.join(current.root, 'rulepacks'), { recursive: true });
    await fs.mkdir(path.join(current.root, 'node_modules'), { recursive: true });
    await fs.writeFile(path.join(current.root, 'schemas', 'schema.json'), '{}\n');
    await fs.writeFile(path.join(current.root, 'rulepacks', 'default.json'), '{}\n');
    /** project root 中其他目录 symlink 不应污染精确 copy 来源。 */
    await fs.symlink(path.join(current.root, 'schemas'), path.join(current.root, 'node_modules', 'linked'), 'dir');

    const resources = await current.discover();
    expect(current.configDiagnostics).toEqual([]);
    expect(current.diagnostics.diagnostics).toEqual([]);
    expect(resources.map(file => file.path)).toEqual(['runtime/rulepacks/default.json', 'schemas/schema.json']);
  });

  it('rejects target collisions, missing sources and source symlinks deterministically', async () => {
    const current = await fixture({
      copy: [
        { from: 'a/file.txt', to: 'Shared/file.txt' },
        { from: 'b/file.txt', to: 'shared/file.txt' },
        { from: 'missing.txt', to: 'missing.txt' },
        { from: 'linked.txt', to: 'linked.txt' },
      ],
    });
    await fs.mkdir(path.join(current.root, 'public', 'a'), { recursive: true });
    await fs.mkdir(path.join(current.root, 'public', 'b'), { recursive: true });
    await fs.writeFile(path.join(current.root, 'public', 'a', 'file.txt'), 'a');
    await fs.writeFile(path.join(current.root, 'public', 'b', 'file.txt'), 'b');
    await fs.symlink(path.join(current.root, 'public', 'a', 'file.txt'), path.join(current.root, 'public', 'linked.txt'));

    const resources = await current.discover();
    expect(resources.map(file => file.path)).toEqual(['Shared/file.txt']);
    expect(current.diagnostics.diagnostics.map(item => item.code)).toEqual(expect.arrayContaining([
      'PUBLIC_TARGET_COLLISION', 'PUBLIC_SOURCE_MISSING', 'PUBLIC_SOURCE_INVALID',
    ]));
  });

  it('defensively rejects unsafe targets after config resolution', async () => {
    const current = await fixture({ copy: [{ from: 'file.txt', to: 'safe/file.txt' }] });
    await fs.mkdir(path.join(current.root, 'public'), { recursive: true });
    await fs.writeFile(path.join(current.root, 'public', 'file.txt'), 'public');
    const resolved = resolveKernelConfig({
      name: 'public-fixture', version: '1.0.0', description: 'Public fixture.', platforms: [platform()],
      public: { copy: [{ from: 'file.txt', to: 'safe/file.txt' }] },
    }, {
      projectRoot: current.root,
      configFile: path.join(current.root, 'acplugin.config.ts'),
      command: 'build',
      mode: 'production',
    }).config!;
    const unsafe = {
      ...resolved,
      public: { ...resolved.public, copy: [{ ...resolved.public.copy![0]!, to: '../escape.txt' }] },
    };
    const scope = new BuildSessionScope();
    const sources = new SourceRegistry(scope, current.root);
    const work = new WorkDirectoryRegistry(scope, path.join(current.root, '.unsafe-work'));
    const assets = new AssetRegistry(scope, sources, work);
    const watch = new WatchRegistry(scope, current.root);
    const diagnostics = new DiagnosticRegistry();

    expect(await discoverPublicResources({ config: unsafe, sources, assets, watch, diagnostics })).toEqual([]);
    expect(diagnostics.diagnostics).toContainEqual(expect.objectContaining({ code: 'PUBLIC_TARGET_INVALID' }));
  });

  it('is silent for disabled or absent default Public roots', async () => {
    const absent = await fixture();
    expect(await absent.discover()).toEqual([]);
    expect(absent.diagnostics.diagnostics).toEqual([]);
    const disabled = await fixture(false);
    expect(await disabled.discover()).toEqual([]);
    expect(disabled.diagnostics.diagnostics).toEqual([]);
  });
});
