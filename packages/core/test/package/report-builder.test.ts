import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PackageUnitSnapshot } from '../../src/contracts/index.js';
import { AssetRegistry } from '../../src/services/assets.js';
import { BuildSessionScope } from '../../src/lifecycle/session-scope.js';
import { SourceRegistry } from '../../src/services/sources.js';
import { WorkDirectoryRegistry } from '../../src/services/work-directories.js';
import { createBuildReport, serializeBuildReport } from '../../src/package/report-builder.js';

/** BuildReport 测试临时根。 */
const roots: string[] = [];

/** @returns 带一个 structured-origin Asset 的 Package fixture。 */
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-report-v2-'));
  roots.push(root);
  const scope = new BuildSessionScope();
  const sources = new SourceRegistry(scope, root);
  const work = new WorkDirectoryRegistry(scope, path.join(root, '.work'));
  const assets = new AssetRegistry(scope, sources, work);
  const asset = await assets.service('platform:target').fromBytes({
    bytes: 'content\n',
    mode: 0o755,
    origin: { operation: 'generated-command', subjects: ['command:check'] },
  });
  const unit: PackageUnitSnapshot = Object.freeze({
    platform: 'target', id: 'plugin', type: 'plugin', role: 'primary',
    assets: Object.freeze([{ path: 'bin/main.mjs', owner: 'platform:target', asset }]),
    compatibility: Object.freeze([]), metadata: Object.freeze([]),
  });
  return { root, assets, unit };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe('BuildReport schema v2', () => {
  it('sorts deterministically and includes structured Asset provenance without bytes', async () => {
    const current = await fixture();
    const input = {
      frameworkVersion: '1.0.0-beta.1', compilerVersion: '1.2.2', success: true,
      command: 'inspect' as const, mode: 'production' as const, committed: false,
      components: [
        { kind: 'skill' as const, id: 'z', location: { path: 'src/skills/z/SKILL.md' } },
        { kind: 'command' as const, id: 'a', location: { path: 'src/commands/a.md' } },
      ],
      runtimes: [], extensions: [],
      platforms: [{ id: 'target', selected: true, success: true, packageIds: ['plugin'] }],
      packages: [current.unit], validatedPackages: ['target/plugin'],
      compatibility: [], metadata: [], diagnostics: [], assets: current.assets,
    };
    const first = serializeBuildReport(createBuildReport(input));
    const second = serializeBuildReport(createBuildReport({ ...input, components: [...input.components].reverse() }));

    expect(first).toBe(second);
    expect(first.endsWith('\n')).toBe(true);
    expect(JSON.parse(first)).toMatchObject({
      schemaVersion: 2,
      packages: [{ validated: true, assets: [{
        path: 'bin/main.mjs', owner: 'platform:target', mode: 0o755,
        origin: { type: 'generated', owner: 'platform:target', operation: 'generated-command', subjects: ['command:check'] },
      }] }],
    });
    expect(first).not.toContain('content');
    expect(first).not.toContain(current.root);
    expect(first).not.toContain('timestamp');
  });

  it('rejects forged report data instead of serializing behavior or bytes', async () => {
    const current = await fixture();
    const report = createBuildReport({
      frameworkVersion: '1.0.0-beta.1', compilerVersion: '1.2.2', success: true,
      command: 'inspect', mode: 'production', committed: false, components: [], runtimes: [], extensions: [], platforms: [],
      packages: [current.unit], compatibility: [], metadata: [], diagnostics: [], assets: current.assets,
    });
    expect(() => serializeBuildReport({ ...report, unsafe: () => 'secret' } as never)).toThrow('JSON values');
  });

  it('deep-copies and freezes nested report input before callers can mutate it', async () => {
    const current = await fixture();
    const component = { kind: 'command' as const, id: 'check', location: { path: 'src/commands/check.md' } };
    const diagnostic = {
      phase: 'package' as const, code: 'PACKAGE_NOTE', severity: 'warning' as const,
      message: 'Stable.', related: [{ path: 'src/commands/check.md', line: 1 }],
    };
    const report = createBuildReport({
      frameworkVersion: '1.0.0-beta.1', compilerVersion: '1.2.2', success: true,
      command: 'inspect', mode: 'production', committed: false,
      components: [component], runtimes: [], extensions: [], platforms: [], packages: [current.unit],
      compatibility: [], metadata: [], diagnostics: [diagnostic], assets: current.assets,
    });
    component.location.path = 'mutated';
    diagnostic.related[0]!.path = 'mutated';

    expect(report.components[0]?.location.path).toBe('src/commands/check.md');
    expect(report.diagnostics[0]?.related?.[0]?.path).toBe('src/commands/check.md');
    expect(Object.isFrozen(report.components[0]?.location)).toBe(true);
    expect(Object.isFrozen(report.diagnostics[0]?.related)).toBe(true);
  });
});
