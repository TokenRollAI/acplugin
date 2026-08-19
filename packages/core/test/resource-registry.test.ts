import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defineExtension, definePlatform } from '../src/kernel-contracts.js';
import { resolveKernelConfig, type ResolvedKernelConfig } from '../src/kernel/config-resolver.js';
import { BuildSessionScope } from '../src/kernel/build-session-scope.js';
import { DiagnosticRegistry } from '../src/kernel/diagnostic-registry.js';
import { SourceRegistry } from '../src/kernel/source-registry.js';
import { WatchRegistry } from '../src/kernel/watch-registry.js';
import { ResourceRegistry } from '../src/resources/resource-registry.js';

/** Resource Registry 测试临时根。 */
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

/** @returns 声明 roots 的最小 Extension。 */
function extension(id: string, resourceRoots: readonly string[]) {
  return defineExtension({
    id, apiVersion: '1', resourceRoots,
    createSession: () => ({
      discover: () => ({}),
      validate: () => ({ state: {}, subjects: [] }),
      build: () => ({ state: {} }),
      contributors: [],
    }),
  });
}

/**
 * 创建可 claim 的临时工程和 Registry。
 *
 * @param input runtime 与 extensions 配置。
 * @returns 当前测试 BuildSession fixture。
 */
async function fixture(input: { readonly runtime?: false; readonly extensions?: readonly ReturnType<typeof extension>[] } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-resource-registry-'));
  roots.push(root);
  await fs.writeFile(path.join(root, 'acplugin.config.ts'), 'export default {};\n');
  /** 配置先走最终 Kernel resolver。 */
  const resolved = resolveKernelConfig({
    name: 'resource-fixture', version: '1.0.0', description: 'Resource fixture.', platforms: [platform()],
    ...(input.runtime === undefined ? {} : { runtime: input.runtime }),
    ...(input.extensions === undefined ? {} : { extensions: input.extensions }),
  }, { projectRoot: root, configFile: path.join(root, 'acplugin.config.ts'), command: 'build', mode: 'production' });
  expect(resolved.diagnostics).toEqual([]);
  const scope = new BuildSessionScope();
  const sources = new SourceRegistry(scope, root);
  const watch = new WatchRegistry(scope, root);
  const diagnostics = new DiagnosticRegistry();
  const registry = new ResourceRegistry({ config: resolved.config as ResolvedKernelConfig, sources, watch, diagnostics });
  return { root, sources, watch, diagnostics, registry };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe('ResourceRegistry', () => {
  it('claims canonical, Runtime and configured Extension roots generically', async () => {
    const current = await fixture({ extensions: [extension('hooks', ['hooks']), extension('mcp', ['mcp'])] });
    await fs.mkdir(path.join(current.root, 'src', 'commands'), { recursive: true });
    await fs.mkdir(path.join(current.root, 'src', 'runtime'), { recursive: true });
    await fs.mkdir(path.join(current.root, 'src', 'hooks'), { recursive: true });
    await fs.mkdir(path.join(current.root, 'src', 'mcp'), { recursive: true });
    await fs.writeFile(path.join(current.root, 'src', 'hooks', 'hook.ts'), 'export {};\n');
    await fs.writeFile(path.join(current.root, 'src', 'mcp', 'mcp.ts'), 'export {};\n');

    const claims = await current.registry.claim();
    expect(current.diagnostics.diagnostics).toEqual([]);
    expect(claims.canonical.commands?.path).toBe('src/commands');
    expect(claims.runtime?.path).toBe('src/runtime');
    expect(claims.extensions.hooks?.hooks?.path).toBe('src/hooks');
    expect(claims.extensions.mcp?.mcp?.path).toBe('src/mcp');
    expect(Object.isFrozen(claims.extensions)).toBe(true);
    expect(current.watch.snapshot().identities).toContain('src');
  });

  it('rejects unknown non-empty roots and direct files while ignoring unknown empty directories', async () => {
    const current = await fixture();
    await fs.mkdir(path.join(current.root, 'src', 'empty'), { recursive: true });
    await fs.mkdir(path.join(current.root, 'src', 'unknown'), { recursive: true });
    await fs.writeFile(path.join(current.root, 'src', 'unknown', 'value.ts'), 'export {};\n');
    await fs.writeFile(path.join(current.root, 'src', 'loose.ts'), 'export {};\n');

    await current.registry.claim();
    const unknown = current.diagnostics.diagnostics.filter(item => item.code === 'RESOURCE_ROOT_UNKNOWN');
    expect(unknown.map(item => item.location?.path)).toEqual(['src/loose.ts', 'src/unknown']);
  });

  it('uses the same unknown-root gate for disabled Runtime and unconfigured horizontal resources', async () => {
    const current = await fixture({ runtime: false });
    for (const directory of ['runtime', 'hooks', 'mcp']) {
      await fs.mkdir(path.join(current.root, 'src', directory), { recursive: true });
      await fs.writeFile(path.join(current.root, 'src', directory, 'entry.ts'), 'export {};\n');
    }

    await current.registry.claim();
    expect(current.diagnostics.diagnostics.filter(item => item.code === 'RESOURCE_ROOT_UNKNOWN').map(item => item.location?.path)).toEqual([
      'src/hooks', 'src/mcp', 'src/runtime',
    ]);
  });

  it('rejects duplicate Extension claims and unsafe author roots without product-name branches', async () => {
    const current = await fixture({ extensions: [extension('first', ['shared']), extension('second', ['shared'])] });
    await fs.mkdir(path.join(current.root, 'src'), { recursive: true });
    await fs.mkdir(path.join(current.root, 'outside'), { recursive: true });
    await fs.symlink(path.join(current.root, 'outside'), path.join(current.root, 'src', 'shared'), 'dir');

    await current.registry.claim();
    expect(current.diagnostics.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'RESOURCE_ROOT_CONFLICT' }),
      expect.objectContaining({ code: 'SOURCE_ROOT_CONTENT_INVALID' }),
    ]));
  });
});
