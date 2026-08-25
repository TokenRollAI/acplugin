import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { BuildReport, RunProjectOptions } from '@tokenroll/acplugin';

/** 当前测试文件所在仓库的绝对根目录。 */
const repositoryRoot = fileURLToPath(new URL('../../../..', import.meta.url));

/** 配置加载使用主包及每个官方 Platform 的真实构建产物。 */
const entries = Object.freeze({
  'framework': path.join(repositoryRoot, 'packages/acplugin/dist/index.mjs'),
  'claude-code': path.join(repositoryRoot, 'packages/platforms/claude-code/dist/index.mjs'),
  'cursor': path.join(repositoryRoot, 'packages/platforms/cursor/dist/index.mjs'),
  'opencode': path.join(repositoryRoot, 'packages/platforms/opencode/dist/index.mjs'),
  'codex': path.join(repositoryRoot, 'packages/platforms/codex/dist/index.mjs'),
  'antigravity': path.join(repositoryRoot, 'packages/platforms/antigravity/dist/index.mjs'),
  'pi': path.join(repositoryRoot, 'packages/platforms/pi/dist/index.mjs'),
});

/** 当前用例创建并在 afterEach 中统一清理的临时工程。 */
const temporaryRoots: string[] = [];

/** 在原生 Node ESM 子进程中运行真实主包，避免 Vitest alias 掩盖 package 边界。 */
async function runBuiltProject(options: RunProjectOptions): Promise<BuildReport> {
  const source = `
import { runProject } from ${JSON.stringify(entries.framework)};
try {
  process.stdout.write(JSON.stringify({ ok: true, result: await runProject(${JSON.stringify(options)}) }));
} catch (error) {
  process.stdout.write(JSON.stringify({
    ok: false,
    name: error instanceof Error ? error.name : 'Error',
    message: error instanceof Error ? error.message : 'Project execution failed.',
    cause: error instanceof Error && error.cause instanceof Error ? error.cause.message : undefined,
    diagnostics: error && typeof error === 'object' ? Reflect.get(error, 'diagnostics') : undefined,
  }));
}
`;
  const execution = await new Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', source], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => stdout += chunk);
    child.stderr.on('data', (chunk: string) => stderr += chunk);
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
  });
  if (execution.code !== 0)
    throw new Error(`Project subprocess failed: ${execution.stderr}`);
  const payload = JSON.parse(execution.stdout) as {
    readonly ok: boolean;
    readonly result?: BuildReport;
    readonly name?: string;
    readonly message?: string;
    readonly cause?: string;
    readonly diagnostics?: unknown;
  };
  if (!payload.ok || payload.result === undefined)
    throw new Error(`${payload.name ?? 'Error'}: ${payload.message ?? 'Project execution failed.'} ${payload.cause ?? ''} ${JSON.stringify(payload.diagnostics ?? [])}`);
  return payload.result;
}

interface BuiltDevEvent {
  readonly type: 'initial' | 'complete';
  readonly success: boolean;
  readonly committed?: boolean;
}

/** 启动真实构建产物的 DevSession，并按行读取稳定的轮次摘要。 */
function startBuiltDevProject(cwd: string, platform: string): {
  readonly child: ReturnType<typeof spawn>;
  readonly next: () => Promise<BuiltDevEvent>;
} {
  const source = `
import { createProject } from ${JSON.stringify(entries.framework)};
const session = await createProject({ cwd: ${JSON.stringify(cwd)} }).dev({ mode: 'development', platforms: [${JSON.stringify(platform)}] });
process.stdout.write(JSON.stringify({ type: 'initial', success: session.current.success }) + '\\n');
session.subscribe(event => {
  if (event.type === 'build-complete')
    process.stdout.write(JSON.stringify({ type: 'complete', success: event.report.success, committed: event.report.committed }) + '\\n');
});
process.stdin.resume();
process.stdin.on('end', async () => {
  await session.close();
});
`;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', source], {
    cwd,
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buffer = '';
  const queue: BuiltDevEvent[] = [];
  const waiters: ((event: BuiltDevEvent) => void)[] = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0)
        break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.length === 0)
        continue;
      const event = JSON.parse(line) as BuiltDevEvent;
      const waiter = waiters.shift();
      if (waiter === undefined)
        queue.push(event);
      else
        waiter(event);
    }
  });
  return {
    child,
    next: () => {
      const queued = queue.shift();
      if (queued !== undefined)
        return Promise.resolve(queued);
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          const index = waiters.indexOf(resolve);
          if (index >= 0)
            waiters.splice(index, 1);
          reject(new Error('Timed out waiting for built DevSession event.'));
        }, 15_000);
        waiters.push((event) => {
          clearTimeout(timeout);
          resolve(event);
        });
      });
    },
  };
}

/** 在临时工程写入模拟正常包管理器安装的 ESM package 代理。 */
async function writePackageProxy(root: string, packageName: string, entry: string): Promise<void> {
  const packageRoot = path.join(root, 'node_modules', ...packageName.split('/'));
  await fs.mkdir(packageRoot, { recursive: true });
  await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
    name: packageName,
    version: '1.0.0',
    type: 'module',
    exports: packageName === '@tokenroll/acplugin'
      ? { '.': './index.mjs', './sdk': './sdk.mjs' }
      : './index.mjs',
  }));
  const sourceRoot = path.dirname(entry);
  for (const file of (await fs.readdir(sourceRoot)).filter(file => file.endsWith('.mjs')))
    await fs.copyFile(path.join(sourceRoot, file), path.join(packageRoot, file));
  await fs.copyFile(entry, path.join(packageRoot, 'index.mjs'));
}

/** Codex 的生产 bundle 仍通过正常 runtime dependencies 解析其官方 wire codec。 */
async function linkCodexRuntimeDependencies(root: string): Promise<void> {
  for (const dependency of ['image-size', 'saxes', 'yaml']) {
    const source = await fs.realpath(path.join(repositoryRoot, 'packages/platforms/codex/node_modules', dependency));
    await fs.symlink(source, path.join(root, 'node_modules', dependency), 'dir');
  }
}

/** 主包 bundle external 的正常 runtime dependencies 必须同样出现在代理 consumer 中。 */
async function linkFrameworkRuntimeDependencies(root: string): Promise<void> {
  for (const dependency of ['@inquirer/prompts', 'commander', 'gray-matter', 'rolldown', 'semver', 'spdx-expression-parse']) {
    const source = await fs.realpath(path.join(repositoryRoot, 'packages/acplugin/node_modules', dependency));
    await fs.mkdir(path.dirname(path.join(root, 'node_modules', dependency)), { recursive: true });
    await fs.symlink(source, path.join(root, 'node_modules', dependency), 'dir');
  }
}

/** 建立一个只含私有 Platform Component contribution 的领域中立消费工程。 */
async function createProject(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-native-component-contribution-'));
  temporaryRoots.push(root);
  await writePackageProxy(root, '@tokenroll/acplugin', entries.framework);
  await linkFrameworkRuntimeDependencies(root);
  await writePackageProxy(root, '@tokenroll/acplugin-platform-claude-code', entries['claude-code']);
  await writePackageProxy(root, '@tokenroll/acplugin-platform-cursor', entries.cursor);
  await writePackageProxy(root, '@tokenroll/acplugin-platform-opencode', entries.opencode);
  await writePackageProxy(root, '@tokenroll/acplugin-platform-codex', entries.codex);
  await writePackageProxy(root, '@tokenroll/acplugin-platform-antigravity', entries.antigravity);
  await writePackageProxy(root, '@tokenroll/acplugin-platform-pi', entries.pi);
  await linkCodexRuntimeDependencies(root);
  await fs.mkdir(path.join(root, 'src/skills/base'), { recursive: true });
  await fs.writeFile(path.join(root, 'src/skills/base/SKILL.md'), '---\ndescription: Base fixture Skill.\n---\nBase.\n');
  await fs.writeFile(path.join(root, 'acplugin.config.ts'), `
import { defineConfig } from '@tokenroll/acplugin';
import { defineExtension } from '@tokenroll/acplugin/sdk';
import claudeCode from '@tokenroll/acplugin-platform-claude-code';
import cursor from '@tokenroll/acplugin-platform-cursor';
import openCode from '@tokenroll/acplugin-platform-opencode';
import codex from '@tokenroll/acplugin-platform-codex';
import antigravity from '@tokenroll/acplugin-platform-antigravity';
import pi from '@tokenroll/acplugin-platform-pi';

const subject = 'fixture:private-agent';
const compatibility = () => [{
  subject,
  capability: 'delivery',
  level: 'native' as const,
  reason: 'The fixture uses a Platform-native private component.',
}] as const;
const extension = defineExtension({
  id: 'private-agent-fixture',
  apiVersion: '1',
  resourceRoots: [],
  createSession: () => ({
    discover: () => ({}),
    validate: (_context, state) => ({ state, subjects: [{ subject, capabilities: ['delivery'] }] }),
    build: (_context, state) => ({ state }),
    contributors: [
      {
        platform: 'claude-code',
        platformApiVersion: '1',
        contribute: () => ({ components: [{ subject, value: {
          kind: 'native-agent', id: 'observer', description: 'Observe the workspace.', body: 'Observe.', model: 'capable', tools: ['Read'],
        } }], compatibility: compatibility() }),
      },
      {
        platform: 'cursor',
        platformApiVersion: '1',
        contribute: () => ({ components: [{ subject, value: {
          kind: 'native-agent', id: 'observer', description: 'Observe the workspace.', body: 'Observe.', readonly: true,
        } }], compatibility: compatibility() }),
      },
      {
        platform: 'opencode',
        platformApiVersion: '1',
        contribute: () => ({ components: [{ subject, value: {
          kind: 'native-agent', id: 'observer', description: 'Observe the workspace.', body: 'Observe.',
          tools: { read: true, glob: true }, permission: { edit: 'deny', bash: 'deny' },
        } }], compatibility: compatibility() }),
      },
      ...['codex', 'antigravity', 'pi'].map(platform => ({
        platform,
        platformApiVersion: '1' as const,
        contribute: () => ({ components: [{ subject, value: {
          kind: 'native-agent', id: 'observer', description: 'Observe the workspace.', body: 'Observe.',
        } }], compatibility: compatibility() }),
      })),
    ],
  }),
});

export default defineConfig({
  name: 'native-component-fixture',
  version: '1.0.0',
  description: 'Private Platform component fixture.',
  platforms: [claudeCode(), cursor(), openCode(), codex(), antigravity(), pi()],
  extensions: [extension],
});
`);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe('Platform Component contributions through built public packages', () => {
  it.each([
    ['claude-code', 'plugin', 'agents/observer.md'],
    ['cursor', 'plugin', 'agents/observer.md'],
    ['opencode', 'workspace', '.opencode/agents/observer.md'],
  ] as const)('delivers a Platform-owned private Agent natively for %s', async (platform, packageId, assetPath) => {
    const root = await createProject();
    const validated = await runBuiltProject({ cwd: root, command: 'validate', mode: 'production', platforms: [platform] });
    const first = await runBuiltProject({ cwd: root, command: 'build', mode: 'production', platforms: [platform] });
    const second = await runBuiltProject({ cwd: root, command: 'build', mode: 'production', platforms: [platform] });
    const unit = first.packages.find(candidate => candidate.id === packageId)!;
    const asset = unit.assets.find(candidate => candidate.path === assetPath)!;

    expect(validated).toMatchObject({ success: true, committed: false });
    expect(first.success, JSON.stringify(first.diagnostics, null, 2)).toBe(true);
    expect(first.schemaVersion).toBe(3);
    expect(first.compatibility).toContainEqual(expect.objectContaining({
      platform, subject: 'fixture:private-agent', capability: 'delivery', level: 'native',
    }));
    expect(asset).toMatchObject({
      owner: `platform:${platform}`,
      origin: { contributors: [{ owner: 'extension:private-agent-fixture', subject: 'fixture:private-agent' }] },
    });
    expect(second.packages).toEqual(first.packages);
    await expect(fs.readFile(path.join(root, 'dist', platform, packageId, ...assetPath.split('/')), 'utf8')).resolves.toContain('Observe.');
  });

  it('supports inspect without committing output and preserves the last output after a failed build', async () => {
    const root = await createProject();
    const first = await runBuiltProject({ cwd: root, command: 'build', mode: 'production', platforms: ['claude-code'] });
    const generated = path.join(root, 'dist', 'claude-code', 'plugin', 'skills/base/SKILL.md');
    const contributed = path.join(root, 'dist', 'claude-code', 'plugin', 'agents/observer.md');
    const initial = await fs.readFile(generated);
    const initialContribution = await fs.readFile(contributed);

    const inspected = await runBuiltProject({ cwd: root, command: 'inspect', mode: 'production', platforms: ['claude-code'] });
    expect(first.success).toBe(true);
    expect(inspected.success).toBe(true);
    expect(inspected.committed).toBe(false);
    expect(await fs.readFile(generated)).toEqual(initial);
    expect(await fs.readFile(contributed)).toEqual(initialContribution);

    await fs.writeFile(path.join(root, 'src/skills/base/SKILL.md'), 'invalid without frontmatter\n');
    const failed = await runBuiltProject({ cwd: root, command: 'build', mode: 'production', platforms: ['claude-code'] });
    expect(failed.success).toBe(false);
    expect(await fs.readFile(generated)).toEqual(initial);
    expect(await fs.readFile(contributed)).toEqual(initialContribution);

    await fs.writeFile(path.join(root, 'src/skills/base/SKILL.md'), '---\ndescription: Base fixture Skill.\n---\nRecovered.\n');
    const recovered = await runBuiltProject({ cwd: root, command: 'build', mode: 'production', platforms: ['claude-code'] });
    expect(recovered.success).toBe(true);
    await expect(fs.readFile(generated, 'utf8')).resolves.toContain('Recovered.');
  });

  it('rebuilds Platform Component delivery through the public DevSession contract', async () => {
    const root = await createProject();
    const running = startBuiltDevProject(root, 'claude-code');
    const initial = await running.next();
    expect(initial).toEqual({ type: 'initial', success: true });

    const source = path.join(root, 'src/skills/base/SKILL.md');
    await fs.writeFile(source, '---\ndescription: Base fixture Skill.\n---\nDev rebuild.\n');
    const complete = await running.next();
    expect(complete).toEqual({ type: 'complete', success: true, committed: true });
    await expect(fs.readFile(path.join(root, 'dist/claude-code/plugin/skills/base/SKILL.md'), 'utf8')).resolves.toContain('Dev rebuild.');
    await expect(fs.readFile(path.join(root, 'dist/claude-code/plugin/agents/observer.md'), 'utf8')).resolves.toContain('Observe.');

    running.child.stdin?.end();
    await new Promise<void>((resolve, reject) => {
      running.child.once('error', reject);
      running.child.once('close', () => resolve());
    });
  }, 20_000);

  it.each(['codex', 'antigravity', 'pi'] as const)('rejects a non-empty private Component contribution for unsupported %s', async (platform) => {
    const root = await createProject();
    const report = await runBuiltProject({ cwd: root, command: 'build', mode: 'production', platforms: [platform] });

    expect(report.success).toBe(false);
    expect(report.committed).toBe(false);
    expect(report.packages).toEqual([]);
    expect(report.diagnostics).toContainEqual(expect.objectContaining({
      code: `${platform.toUpperCase()}_COMPONENT_CONTRIBUTION_UNSUPPORTED`, phase: 'finalize', platform,
    }));
    await expect(fs.access(path.join(root, 'dist', platform))).rejects.toThrow();
  });
});
