import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { definePlatform } from '@acplugin/core/integration';
import { createProject, ProjectConfigError, runProject } from '../src/author/project.js';

/** 临时工程由 afterEach 统一删除。 */
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

/** 配置 Module Host externalize 的真实测试 Platform 模块。 */
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-project-api-'));
  roots.push(root);
  await fs.mkdir(path.join(root, 'src', 'commands'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'commands', 'review.md'), [
    '---', 'description: Review changes.', '---', 'Review changes.', '',
  ].join('\n'));
  /** 共享品牌化 Platform 通过测试进程全局传入配置 Module graph。 */
  const key = Symbol.for('tokenroll.acplugin.project-api-test-platform');
  Reflect.set(globalThis, key, definePlatform({
    id: 'project-api',
    apiVersion: '1',
    deliveryType: 'plugin',
    createSession: () => ({
      createPackage: ({ project }) => ({
        documents: [], assets: [],
        compatibility: project.commands.map(command => ({
          subject: `command:${command.id}`, capability: 'component', level: 'native', reason: 'Native command.',
        })),
        metadata: ['name', 'version', 'description'].map(field => ({
          field, disposition: 'emitted', output: `manifest/${field}`, reason: 'Emitted metadata.',
        })),
      }),
      finalizePackage: () => ({ id: 'plugin', type: 'plugin' }),
      validatePackage: () => undefined,
    }),
  }));
  /** Platform identity 由 config 的本地 TypeScript closure 读取。 */
  await fs.writeFile(path.join(root, 'platform.ts'), `
export const platform = globalThis[Symbol.for('tokenroll.acplugin.project-api-test-platform')];
`);
  await fs.writeFile(path.join(root, 'value.ts'), `export const version = '1.0.0';\n`);
  await fs.writeFile(path.join(root, 'acplugin.config.ts'), `
import { platform } from './platform.ts';
import { version } from './value.ts';
export default ({ command }) => ({
  name: 'project-api', version, description: command, platforms: [platform], public: false,
});
`);
  return root;
}

describe('Project API', () => {
  it('uses the same one-shot implementation for Project.run and runProject and fresh-loads config', async () => {
    const root = await fixture();
    const project = createProject({ cwd: root });
    const first = await project.run({ command: 'validate' });
    const convenience = await runProject({ cwd: root, command: 'validate' });
    expect(first).toEqual(convenience);
    expect(first.success).toBe(true);
    expect(first.committed).toBe(false);
    expect(first.command).toBe('validate');

    await fs.writeFile(path.join(root, 'value.ts'), `export const version = '2.0.0';\n`);
    const changed = await project.run({ command: 'validate' });
    expect(changed.framework).toEqual(first.framework);
    expect(changed.success).toBe(true);
  });

  it('keeps config location/evaluation/schema failures outside BuildReport', async () => {
    const root = await fixture();
    await fs.rm(path.join(root, 'acplugin.config.ts'));
    await expect(runProject({ cwd: root, command: 'validate' })).rejects.toSatisfy((error: unknown) =>
      error instanceof ProjectConfigError && error.diagnostics.some(item => item.code === 'CONFIG_LOAD_FAILED'));
    await expect(runProject({ cwd: root, configFile: '../escape.ts', command: 'validate' })).rejects.toBeInstanceOf(ProjectConfigError);

    await fs.writeFile(path.join(root, 'acplugin.config.ts'), 'throw new Error("secret=/private/path");\n');
    await expect(runProject({ cwd: root, command: 'validate' })).rejects.toSatisfy((error: unknown) =>
      error instanceof ProjectConfigError
      && error.diagnostics.some(item => item.code === 'CONFIG_EVALUATION_FAILED')
      && !error.diagnostics.some(item => item.message.includes('/private/path')));
  });

  it('rejects duplicate/unknown Platform subsets before Integration setup', async () => {
    const root = await fixture();
    const duplicate = await runProject({ cwd: root, command: 'validate', platforms: ['project-api', 'project-api'] });
    const unknown = await runProject({ cwd: root, command: 'validate', platforms: ['missing'] });
    expect(duplicate.success).toBe(false);
    expect(unknown.success).toBe(false);
    expect(duplicate.diagnostics).toContainEqual(expect.objectContaining({ code: 'PLATFORM_SELECTION_INVALID' }));
    expect(unknown.diagnostics).toContainEqual(expect.objectContaining({ code: 'PLATFORM_SELECTION_INVALID' }));
  });

  it('forces validate and inspect to be read-only while honoring build commit=false', async () => {
    const root = await fixture();
    const output = path.join(root, 'dist');

    const validated = await runProject({ cwd: root, command: 'validate', commit: true });
    const inspected = await runProject({ cwd: root, command: 'inspect', commit: true });
    const dryBuild = await runProject({ cwd: root, command: 'build', commit: false });
    expect(validated).toMatchObject({ command: 'validate', success: true, committed: false });
    expect(inspected).toMatchObject({ command: 'inspect', success: true, committed: false });
    expect(dryBuild).toMatchObject({ command: 'build', success: true, committed: false });
    await expect(fs.access(output)).rejects.toThrow();

    const committed = await runProject({ cwd: root, command: 'build' });
    expect(committed).toMatchObject({ command: 'build', success: true, committed: true });
    await fs.access(path.join(output, 'project-api', 'plugin'));
  });
});
