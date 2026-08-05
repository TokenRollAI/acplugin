import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ArtifactGraph,
  buildProject,
  bytesArtifact,
  commitManagedOutput,
  DiagnosticCollector,
  type AcpluginModule,
  type Compiler,
  type ManagedOutputPhase,
  resolveConfig,
  scanProject,
} from '../src/index.js';

const temporaryDirectories: string[] = [];

async function temporaryProject(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-core-test-'));
  temporaryDirectories.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

describe('config', () => {
  it('normalizes the default targets and directories', async () => {
    const root = await temporaryProject();
    const result = resolveConfig({
      name: 'test-plugin',
      version: '1.0.0',
      description: 'Test plugin.',
    }, path.join(root, 'acplugin.config.ts'), 'build', 'production');

    expect(result.diagnostics).toEqual([]);
    expect(result.config?.targets).toEqual([
      { id: 'claude-code', strict: true },
      { id: 'codex', strict: true },
    ]);
    expect(result.config?.srcDir).toBe(path.join(root, 'src'));
    expect(result.config?.outDir).toBe(path.join(root, 'dist'));
    expect(result.config?.displayName).toBe('Test Plugin');
  });

  it('never relaxes structural config failures', async () => {
    const root = await temporaryProject();
    const result = resolveConfig({
      name: 'Invalid Name',
      version: 'nope',
      description: '',
      build: { strict: false, outDir: '.' },
    }, path.join(root, 'acplugin.config.ts'), 'build', 'production');

    expect(result.config).toBeUndefined();
    expect(result.diagnostics.every(diagnostic => diagnostic.severity === 'error')).toBe(true);
  });

  it('rejects unknown and incorrectly typed nested config fields', async () => {
    const root = await temporaryProject();
    const result = resolveConfig({
      name: 'test-plugin',
      version: '1.0.0',
      description: 'Test plugin.',
      build: { strict: 'yes', clean: true },
      public: { copy: [{ from: 'assets', to: 'assets', transform: 'text' }] },
      targets: [{ id: 'codex', strict: 'yes', compiler: 'custom' }],
      extensions: { native: {} },
    } as never, path.join(root, 'acplugin.config.ts'), 'build', 'production');

    expect(result.config).toBeUndefined();
    expect(result.diagnostics.map(diagnostic => diagnostic.code)).toEqual(expect.arrayContaining([
      'CONFIG_FIELD_UNKNOWN',
      'CONFIG_STRICT_INVALID',
      'CONFIG_TARGET_STRICT_INVALID',
    ]));
  });

  it('rejects canonical semantics and executable values inside target extensions', async () => {
    const root = await temporaryProject();
    const result = resolveConfig({
      name: 'test-plugin', version: '1.0.0', description: 'Test plugin.',
      extensions: { codex: { body: 'duplicate prompt', vendor: { loader: () => 'unsafe' } } },
    } as never, path.join(root, 'acplugin.config.ts'), 'build', 'production');

    expect(result.config).toBeUndefined();
    expect(result.diagnostics.filter(diagnostic => diagnostic.code === 'CONFIG_EXTENSION_SEMANTICS')).toHaveLength(2);
  });
});

describe('canonical scanner', () => {
  it('discovers components, dependencies, auxiliary files, and Public', async () => {
    const root = await temporaryProject();
    await fs.mkdir(path.join(root, 'src/skills/review/references'), { recursive: true });
    await fs.mkdir(path.join(root, 'src/commands'), { recursive: true });
    await fs.mkdir(path.join(root, 'src/agents'), { recursive: true });
    await fs.mkdir(path.join(root, 'public'), { recursive: true });
    await fs.writeFile(path.join(root, 'src/skills/review/SKILL.md'), '---\ndescription: Review changes.\nrequires:\n  agents: [reviewer]\n---\nReview the change.\n');
    await fs.writeFile(path.join(root, 'src/skills/review/references/checks.md'), 'checks');
    await fs.writeFile(path.join(root, 'src/commands/check.md'), '---\ndescription: Check a change.\nrequires:\n  skills: [review]\n---\nCheck {{arguments}}.\n');
    await fs.writeFile(path.join(root, 'src/agents/reviewer.md'), '---\ndescription: Focused reviewer.\nmodel: capable\ncapabilities: [filesystem:read, search]\n---\nReview carefully.\n');
    await fs.writeFile(path.join(root, 'public/icon.bin'), new Uint8Array([1, 2, 3]));
    const resolved = resolveConfig({ name: 'test-plugin', version: '1.0.0', description: 'Test.' }, path.join(root, 'acplugin.config.ts'), 'build', 'production');
    const diagnostics = new DiagnosticCollector();
    const { project } = await scanProject(resolved.config!, diagnostics);

    expect(diagnostics.diagnostics).toEqual([]);
    expect(project.commands.map(component => component.id)).toEqual(['check']);
    expect(project.skills[0]?.auxiliaryFiles[0]?.path).toBe('references/checks.md');
    expect(project.agents[0]?.model).toBe('capable');
    expect(project.publicFiles[0]?.targetPath).toBe('icon.bin');
  });

  it('reports a complete dependency cycle', async () => {
    const root = await temporaryProject();
    await fs.mkdir(path.join(root, 'src/skills/a'), { recursive: true });
    await fs.mkdir(path.join(root, 'src/skills/b'), { recursive: true });
    await fs.writeFile(path.join(root, 'src/skills/a/SKILL.md'), '---\ndescription: A.\nrequires:\n  skills: [b]\n---\nA body.\n');
    await fs.writeFile(path.join(root, 'src/skills/b/SKILL.md'), '---\ndescription: B.\nrequires:\n  skills: [a]\n---\nB body.\n');
    const resolved = resolveConfig({ name: 'test-plugin', version: '1.0.0', description: 'Test.' }, path.join(root, 'acplugin.config.ts'), 'build', 'production');
    const diagnostics = new DiagnosticCollector();
    await scanProject(resolved.config!, diagnostics);

    expect(diagnostics.diagnostics).toContainEqual(expect.objectContaining({
      code: 'COMPONENT_DEPENDENCY_CYCLE',
      message: expect.stringContaining('skill:a -> skill:b -> skill:a'),
    }));
  });
});

describe('Artifact graph', () => {
  it('hashes content and rejects case-insensitive collisions', async () => {
    const root = await temporaryProject();
    const graph = new ArtifactGraph([root]);
    const first = await graph.add('test', {
      path: 'Skills/Test.md',
      source: { type: 'bytes', value: new TextEncoder().encode('content') },
    });

    expect(first.sha256).toHaveLength(64);
    await expect(graph.add('other', {
      path: 'skills/test.md',
      source: { type: 'bytes', value: new Uint8Array() },
    })).rejects.toThrow('collision');
  });
});

describe('managed output transaction', () => {
  it('preserves the previous complete output at every injected failure phase', async () => {
    const phases: ManagedOutputPhase[] = [
      'lock-acquired',
      'recovery-complete',
      'stage-materialized',
      'stage-validated',
      'transaction-written',
      'backup-created',
      'output-swapped',
    ];

    for (const phase of phases) {
      const root = await temporaryProject();
      const outDir = path.join(root, 'dist');
      await fs.mkdir(path.join(outDir, 'codex'), { recursive: true });
      await fs.writeFile(path.join(outDir, 'codex/version.txt'), 'old');
      const graph = new ArtifactGraph([root]);
      await graph.add('test', {
        path: 'version.txt',
        source: { type: 'bytes', value: new TextEncoder().encode('new') },
      });

      await expect(commitManagedOutput(outDir, new Map([['codex', graph.artifacts]]), {
        onPhase(current) {
          if (current === phase)
            throw new Error(`fail at ${phase}`);
        },
      })).rejects.toThrow(`fail at ${phase}`);

      expect(await fs.readFile(path.join(outDir, 'codex/version.txt'), 'utf8')).toBe('old');
      expect((await fs.readdir(root)).filter(name => name.startsWith('.dist.acplugin-'))).toEqual([]);
    }
  });

  it('replaces the whole managed target set on success', async () => {
    const root = await temporaryProject();
    const outDir = path.join(root, 'dist');
    await fs.mkdir(path.join(outDir, 'stale-target'), { recursive: true });
    await fs.writeFile(path.join(outDir, 'stale-target/file.txt'), 'stale');
    const graph = new ArtifactGraph([root]);
    await graph.add('test', {
      path: 'version.txt',
      source: { type: 'bytes', value: new TextEncoder().encode('new') },
    });

    await commitManagedOutput(outDir, new Map([['codex', graph.artifacts]]));

    expect(await fs.readFile(path.join(outDir, 'codex/version.txt'), 'utf8')).toBe('new');
    await expect(fs.access(path.join(outDir, 'stale-target'))).rejects.toThrow();
  });

  it('rejects a file source changed after hashing and preserves the old output', async () => {
    const root = await temporaryProject();
    const outDir = path.join(root, 'dist');
    const source = path.join(root, 'source.txt');
    await fs.mkdir(path.join(outDir, 'codex'), { recursive: true });
    await fs.writeFile(path.join(outDir, 'codex/version.txt'), 'old');
    await fs.writeFile(source, 'original');
    const graph = new ArtifactGraph([root]);
    await graph.add('test', { path: 'source.txt', source: { type: 'file', path: source } });
    await fs.writeFile(source, 'changed-after-hash');

    await expect(commitManagedOutput(outDir, new Map([['codex', graph.artifacts]]))).rejects.toThrow('integrity mismatch');
    expect(await fs.readFile(path.join(outDir, 'codex/version.txt'), 'utf8')).toBe('old');
  });
});

describe('Module lifecycle', () => {
  it('uses dependency order and always cleans up in reverse order', async () => {
    const root = await temporaryProject();
    const events: string[] = [];
    const first: AcpluginModule<string, string> = {
      name: 'first',
      configResolved() { events.push('first:config'); },
      discover() {
        events.push('first:discover');
        return 'first-state';
      },
      validate() { events.push('first:validate'); },
      build() {
        events.push('first:build');
        return 'first-built';
      },
      generate() { events.push('first:generate'); },
      buildEnd(context) {
        events.push(context.error ? 'first:end:error' : 'first:end');
      },
    };
    const second: AcpluginModule<string, string> = {
      name: 'second',
      dependsOn: ['first'],
      configResolved() { events.push('second:config'); },
      discover(context) {
        events.push(`second:discover:${String(context.dependencyState.get('first'))}`);
        return 'second-state';
      },
      validate() { events.push('second:validate'); },
      build(context) {
        events.push(`second:build:${String(context.dependencyState.get('first'))}`);
        return 'second-built';
      },
      generate(context) {
        events.push(`second:generate:${String(context.dependencyBuiltState.get('first'))}`);
      },
      buildEnd() {
        events.push('second:end');
        throw new Error('cleanup failed');
      },
    };
    const compiler: Compiler = {
      id: 'codex',
      compile() {
        events.push('compiler');
        return { artifacts: [bytesArtifact('manifest.json', '{}\n')], compatibility: [] };
      },
    };
    const resolved = resolveConfig({
      name: 'lifecycle-plugin',
      version: '1.0.0',
      description: 'Lifecycle fixture.',
      targets: ['codex'],
      modules: [second, first],
    }, path.join(root, 'acplugin.config.ts'), 'inspect', 'production');

    const result = await buildProject({
      config: resolved.config!,
      compilers: new Map([['codex', compiler]]),
      loadTypeScriptModule: async () => undefined,
      commit: false,
    });

    expect(events).toEqual([
      'first:config', 'second:config',
      'first:discover', 'second:discover:first-state',
      'first:validate', 'second:validate',
      'first:build', 'second:build:first-state',
      'first:generate', 'second:generate:first-built',
      'compiler',
      'second:end', 'first:end:error',
    ]);
    expect(result.report.success).toBe(false);
    expect(result.report.diagnostics).toContainEqual(expect.objectContaining({
      code: 'MODULE_BUILD_END_FAILED',
      module: 'second',
    }));
  });

  it('does not commit when buildEnd fails and redacts untrusted Module errors', async () => {
    const root = await temporaryProject();
    const outDir = path.join(root, 'dist');
    await fs.mkdir(path.join(outDir, 'codex'), { recursive: true });
    await fs.writeFile(path.join(outDir, 'codex/version.txt'), 'old');
    const module: AcpluginModule = {
      name: 'unsafe-module',
      discover() {
        return undefined;
      },
      buildEnd() {
        throw new Error(`Bearer top-secret ${path.join(root, 'private.txt')}`);
      },
    };
    const compiler: Compiler = {
      id: 'codex',
      compile() {
        return { artifacts: [bytesArtifact('manifest.json', '{}\n')], compatibility: [] };
      },
    };
    const resolved = resolveConfig({
      name: 'cleanup-plugin', version: '1.0.0', description: 'Cleanup fixture.',
      targets: ['codex'], modules: [module],
    }, path.join(root, 'acplugin.config.ts'), 'build', 'production');

    const result = await buildProject({
      config: resolved.config!,
      compilers: new Map([['codex', compiler]]),
      loadTypeScriptModule: async () => undefined,
      commit: true,
    });

    expect(result.report).toMatchObject({ success: false, committed: false });
    expect(JSON.stringify(result.report)).not.toContain('top-secret');
    expect(JSON.stringify(result.report)).not.toContain(root);
    expect(await fs.readFile(path.join(outDir, 'codex/version.txt'), 'utf8')).toBe('old');
  });
});
