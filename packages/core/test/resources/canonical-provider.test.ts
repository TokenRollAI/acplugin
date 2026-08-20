import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AssetRegistry } from '../../src/services/assets.js';
import { BuildSessionScope } from '../../src/services/session-scope.js';
import { DiagnosticRegistry } from '../../src/services/diagnostics.js';
import { SourceRegistry } from '../../src/services/sources.js';
import { WatchRegistry } from '../../src/services/watch.js';
import { WorkDirectoryRegistry } from '../../src/services/work-directories.js';
import { discoverCanonicalProject } from '../../src/resources/canonical/provider.js';
import { ResourceRegistry } from '../../src/resources/registry.js';
import { resolveKernelConfig } from '../../src/config/resolver.js';
import { definePlatform } from '../../src/api/definitions.js';

/** Canonical Provider 测试临时根。 */
const roots: string[] = [];

/** @returns 最小 Platform definition。 */
function platform(id: string) {
  return definePlatform({
    id, apiVersion: '1', deliveryType: 'plugin',
    createSession: () => ({
      createPackage: () => ({ documents: [], assets: [], compatibility: [], metadata: [] }),
      finalizePackage: () => ({ id: 'plugin', type: 'plugin' }),
      validatePackage: () => undefined,
    }),
  });
}

/**
 * 创建 Canonical Provider BuildSession fixture。
 *
 * @returns 工程根、registries 与发现函数。
 */
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-canonical-provider-'));
  roots.push(root);
  await fs.writeFile(path.join(root, 'acplugin.config.ts'), 'export default {};\n');
  const configured = resolveKernelConfig({
    name: 'canonical-fixture', version: '1.0.0', description: 'Canonical fixture.', platforms: [platform('codex')],
  }, { projectRoot: root, configFile: path.join(root, 'acplugin.config.ts'), command: 'build', mode: 'production' }).config!;
  const scope = new BuildSessionScope();
  const sources = new SourceRegistry(scope, root);
  const work = new WorkDirectoryRegistry(scope, path.join(root, '.work'));
  const assets = new AssetRegistry(scope, sources, work);
  const watch = new WatchRegistry(scope, root);
  const diagnostics = new DiagnosticRegistry();
  const discover = async () => {
    const claims = await new ResourceRegistry({ config: configured, sources, watch, diagnostics }).claim();
    return discoverCanonicalProject({
      metadata: configured.metadata,
      platformIds: configured.platforms.map(item => item.definition.id),
      claims,
      sources,
      assets,
      diagnostics,
    });
  };
  return { root, assets, diagnostics, discover };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe('Canonical Provider', () => {
  it('builds an immutable Component graph with safe locations and auxiliary AssetRefs', async () => {
    const current = await fixture();
    await fs.mkdir(path.join(current.root, 'src', 'commands'), { recursive: true });
    await fs.mkdir(path.join(current.root, 'src', 'skills', 'review', 'references'), { recursive: true });
    await fs.mkdir(path.join(current.root, 'src', 'agents'), { recursive: true });
    await fs.writeFile(path.join(current.root, 'src', 'commands', 'check.md'), `---
description: Check a release.
argumentHint: <ref>
requires:
  skills: [review]
platforms:
  codex:
    model: fast
---
Check {{arguments}}.
`);
    await fs.writeFile(path.join(current.root, 'src', 'skills', 'review', 'SKILL.md'), `---
description: Review a release.
requires:
  agents: [reviewer]
---
Review evidence.
`);
    await fs.writeFile(path.join(current.root, 'src', 'skills', 'review', 'references', 'data.bin'), Uint8Array.of(0xff, 0x00));
    await fs.writeFile(path.join(current.root, 'src', 'agents', 'reviewer.md'), `---
description: Review correctness.
model: capable
capabilities: [filesystem:read, search]
---
Return findings.
`);

    const project = await current.discover();
    expect(current.diagnostics.diagnostics).toEqual([]);
    expect(project.commands[0]).toMatchObject({
      id: 'check',
      location: { path: 'src/commands/check.md', bodyLine: 10 },
      requires: { skills: ['review'], agents: [] },
      platforms: { codex: { model: 'fast' } },
    });
    expect(project.skills[0]?.auxiliaryFiles[0]?.path).toBe('references/data.bin');
    expect(current.assets.describe('framework:canonical', project.skills[0]!.auxiliaryFiles[0]!.asset).origin).toEqual({
      type: 'source', resource: 'framework:canonical', path: 'src/skills/review/references/data.bin',
    });
    expect(project.agents[0]).toMatchObject({ id: 'reviewer', model: 'capable', capabilities: ['filesystem:read', 'search'] });
    expect(JSON.stringify(project)).not.toContain(current.root);
    expect(Object.isFrozen(project)).toBe(true);
    expect(Object.isFrozen(project.skills[0]?.auxiliaryFiles)).toBe(true);
  });

  it('reports malformed authoring, platform JSON and invocation rules without creating unsafe data', async () => {
    const current = await fixture();
    await fs.mkdir(path.join(current.root, 'src', 'commands', 'nested'), { recursive: true });
    await fs.mkdir(path.join(current.root, 'src', 'skills', 'disabled'), { recursive: true });
    await fs.mkdir(path.join(current.root, 'src', 'agents'), { recursive: true });
    await fs.writeFile(path.join(current.root, 'src', 'commands', 'broken.md'), '---\ndescription: [\n---\nBroken.\n');
    await fs.writeFile(path.join(current.root, 'src', 'commands', 'placeholder.md'), '---\ndescription: Placeholder.\nplatforms:\n  ghost: {}\n---\nUse {{ args }}.\n');
    await fs.writeFile(path.join(current.root, 'src', 'skills', 'disabled', 'SKILL.md'), '---\ndescription: Disabled.\ninvocation:\n  user: false\n  model: false\n---\nDisabled.\n');
    await fs.writeFile(path.join(current.root, 'src', 'agents', 'unsafe.md'), '---\ndescription: Unsafe.\ncapabilities: [raw-tool]\n---\nUnsafe.\n');

    await current.discover();
    expect(current.diagnostics.diagnostics.map(item => item.code)).toEqual(expect.arrayContaining([
      'COMMAND_ENTRY_INVALID', 'FRONTMATTER_INVALID', 'COMMAND_PLACEHOLDER_INVALID',
      'COMPONENT_PLATFORM_NOT_CONFIGURED', 'SKILL_INVOCATION_EMPTY', 'AGENT_CAPABILITY_INVALID',
    ]));
  });

  it('rejects invalid UTF-8 Markdown and blank dependency values', async () => {
    const current = await fixture();
    await fs.mkdir(path.join(current.root, 'src', 'commands'), { recursive: true });
    await fs.writeFile(path.join(current.root, 'src', 'commands', 'binary.md'), Uint8Array.of(0xff, 0xfe));
    await fs.writeFile(path.join(current.root, 'src', 'commands', 'blank.md'), `---
description: Blank dependency.
requires:
  skills: ['   ']
---
Check dependencies.
`);

    await current.discover();
    expect(current.diagnostics.diagnostics.map(item => item.code)).toEqual(expect.arrayContaining([
      'MARKDOWN_UTF8_INVALID', 'FRONTMATTER_STRING_ARRAY',
    ]));
  });

  it('rejects missing, self, duplicate and cyclic Component dependencies', async () => {
    const current = await fixture();
    await fs.mkdir(path.join(current.root, 'src', 'commands'), { recursive: true });
    await fs.mkdir(path.join(current.root, 'src', 'skills', 'alpha'), { recursive: true });
    await fs.mkdir(path.join(current.root, 'src', 'skills', 'beta'), { recursive: true });
    await fs.writeFile(path.join(current.root, 'src', 'commands', 'run.md'), '---\ndescription: Run.\nrequires:\n  skills: [missing, missing]\n---\nRun.\n');
    await fs.writeFile(path.join(current.root, 'src', 'skills', 'alpha', 'SKILL.md'), '---\ndescription: Alpha.\nrequires:\n  skills: [alpha, beta]\n---\nAlpha.\n');
    await fs.writeFile(path.join(current.root, 'src', 'skills', 'beta', 'SKILL.md'), '---\ndescription: Beta.\nrequires:\n  skills: [alpha]\n---\nBeta.\n');

    await current.discover();
    expect(current.diagnostics.diagnostics.map(item => item.code)).toEqual(expect.arrayContaining([
      'FRONTMATTER_ARRAY_DUPLICATE', 'COMPONENT_DEPENDENCY_MISSING',
      'COMPONENT_DEPENDENCY_SELF', 'COMPONENT_DEPENDENCY_CYCLE',
    ]));
  });
});
