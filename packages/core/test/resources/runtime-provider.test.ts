import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BuildSessionScope } from '../../src/services/session-scope.js';
import { DiagnosticRegistry } from '../../src/services/diagnostics.js';
import { SourceRegistry } from '../../src/services/sources.js';
import { discoverNodeRuntime } from '../../src/resources/runtime/provider.js';

/** Runtime Provider 测试根。 */
const roots: string[] = [];

/**
 * 创建 Runtime root 和 Source Registry。
 *
 * @returns 当前测试 fixture。
 */
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-runtime-provider-'));
  roots.push(root);
  const runtime = path.join(root, 'src', 'runtime');
  await fs.mkdir(runtime, { recursive: true });
  const scope = new BuildSessionScope();
  const sources = new SourceRegistry(scope, root);
  const diagnostics = new DiagnosticRegistry();
  return { root, runtime, sources, diagnostics };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe('Runtime Provider', () => {
  it('auto-discovers only direct executable TS/JS sources and keeps nested modules as dependencies', async () => {
    const current = await fixture();
    await fs.mkdir(path.join(current.runtime, 'internal'), { recursive: true });
    await fs.writeFile(path.join(current.runtime, 'cli.ts'), 'export {};\n');
    await fs.writeFile(path.join(current.runtime, 'worker.mts'), 'export {};\n');
    await fs.writeFile(path.join(current.runtime, 'types.d.ts'), 'export interface Type {}\n');
    await fs.writeFile(path.join(current.runtime, 'internal', 'helper.ts'), 'export {};\n');
    const runtimeRoot = await current.sources.issueRoot('framework:node-runtime', current.runtime);
    const resource = await discoverNodeRuntime({
      root: runtimeRoot,
      config: { enabled: true, directory: current.runtime, target: 'node20' },
      sources: current.sources,
      diagnostics: current.diagnostics,
    });

    expect(current.diagnostics.diagnostics).toEqual([]);
    expect(resource?.entries.map(entry => [entry.id, entry.kind, entry.source.path])).toEqual([
      ['cli', 'executable', 'src/runtime/cli.ts'],
      ['worker', 'executable', 'src/runtime/worker.mts'],
    ]);
    expect(JSON.stringify(resource)).not.toContain(current.root);
    expect(Object.isFrozen(resource?.entries)).toBe(true);
  });

  it('uses explicit entries as a complete replacement and preserves compile options', async () => {
    const current = await fixture();
    await fs.mkdir(path.join(current.runtime, 'bin'), { recursive: true });
    await fs.writeFile(path.join(current.runtime, 'ignored.ts'), 'export {};\n');
    await fs.writeFile(path.join(current.runtime, 'bin', 'cli.ts'), 'export {};\n');
    const runtimeRoot = await current.sources.issueRoot('framework:node-runtime', current.runtime);
    const resource = await discoverNodeRuntime({
      root: runtimeRoot,
      config: {
        enabled: true,
        directory: current.runtime,
        target: 'node20',
        entries: { tool: { entry: 'bin/cli.ts', kind: 'module' } },
        compile: { treeshake: false },
      },
      sources: current.sources,
      diagnostics: current.diagnostics,
    });

    expect(current.diagnostics.diagnostics).toEqual([]);
    expect(resource).toMatchObject({ target: 'node20', compile: { treeshake: false } });
    expect(resource?.entries.map(entry => [entry.id, entry.kind, entry.source.path])).toEqual([
      ['tool', 'module', 'src/runtime/bin/cli.ts'],
    ]);
  });

  it('reports unsupported, duplicate and missing entries without fake Runtime output', async () => {
    const current = await fixture();
    await fs.writeFile(path.join(current.runtime, 'cli.ts'), 'export {};\n');
    await fs.writeFile(path.join(current.runtime, 'cli.js'), 'export {};\n');
    await fs.writeFile(path.join(current.runtime, 'README.md'), 'not runtime\n');
    const runtimeRoot = await current.sources.issueRoot('framework:node-runtime', current.runtime);
    const automatic = await discoverNodeRuntime({
      root: runtimeRoot,
      config: { enabled: true, directory: current.runtime, target: 'node20' },
      sources: current.sources,
      diagnostics: current.diagnostics,
    });
    expect(automatic?.entries).toHaveLength(1);
    expect(current.diagnostics.diagnostics.map(item => item.code)).toEqual(expect.arrayContaining([
      'RUNTIME_ENTRY_CONFLICT', 'RUNTIME_SOURCE_UNSUPPORTED',
    ]));

    const explicitDiagnostics = new DiagnosticRegistry();
    const explicit = await discoverNodeRuntime({
      root: runtimeRoot,
      config: {
        enabled: true,
        directory: current.runtime,
        target: 'node20',
        entries: {
          missing: { entry: 'missing.ts', kind: 'executable' },
          declarations: { entry: 'types.d.ts', kind: 'module' },
        },
      },
      sources: current.sources,
      diagnostics: explicitDiagnostics,
    });
    expect(explicit).toBeUndefined();
    expect(explicitDiagnostics.diagnostics.map(item => item.code)).toEqual(['RUNTIME_ENTRY_MISSING', 'RUNTIME_SOURCE_UNSUPPORTED']);
  });

  it('defensively rejects invalid IDs, escaped paths and symlink sources', async () => {
    const current = await fixture();
    await fs.writeFile(path.join(current.runtime, 'valid.ts'), 'export {};\n');
    await fs.writeFile(path.join(current.root, 'outside.ts'), 'export {};\n');
    await fs.symlink(path.join(current.root, 'outside.ts'), path.join(current.runtime, 'linked.ts'));
    const runtimeRoot = await current.sources.issueRoot('framework:node-runtime', current.runtime);
    const resource = await discoverNodeRuntime({
      root: runtimeRoot,
      config: {
        enabled: true,
        directory: current.runtime,
        target: 'node20',
        entries: {
          Valid: { entry: 'valid.ts', kind: 'module' },
          cafe\u0301: { entry: 'valid.ts', kind: 'module' },
          escaped: { entry: '../outside.ts', kind: 'module' },
          linked: { entry: 'linked.ts', kind: 'module' },
        },
      },
      sources: current.sources,
      diagnostics: current.diagnostics,
    });

    expect(resource).toBeUndefined();
    expect(current.diagnostics.diagnostics.map(item => item.code)).toEqual([
      'RUNTIME_ENTRY_MISSING',
      'RUNTIME_ENTRY_MISSING',
      'RUNTIME_ENTRY_ID_INVALID',
      'RUNTIME_ENTRY_ID_INVALID',
    ]);
    expect(JSON.stringify(current.diagnostics.diagnostics)).not.toContain(current.root);
  });

  it('is silent for absent, empty and explicitly unselected Runtime roots', async () => {
    const current = await fixture();
    expect(await discoverNodeRuntime({
      config: { enabled: true, directory: current.runtime, target: 'node20' },
      sources: current.sources,
      diagnostics: current.diagnostics,
    })).toBeUndefined();
    const runtimeRoot = await current.sources.issueRoot('framework:node-runtime', current.runtime);
    expect(await discoverNodeRuntime({
      root: runtimeRoot,
      config: { enabled: true, directory: current.runtime, target: 'node20', entries: {} },
      sources: current.sources,
      diagnostics: current.diagnostics,
    })).toBeUndefined();
    expect(current.diagnostics.diagnostics).toEqual([]);
  });
});
