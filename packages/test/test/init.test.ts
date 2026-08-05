import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initializeProject } from '@tokenroll/acplugin';

/** 当前测试创建并在 afterEach 中统一删除的临时目录。 */
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe('init', () => {
  it('creates the minimal strict dual-target project without fake Module source', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-init-test-'));
    roots.push(cwd);
    const result = await initializeProject({ cwd, directory: 'demo-plugin', yes: true });

    expect(result.directory).toBe('demo-plugin');
    expect(result.modules).toEqual([]);
    expect(await fs.readFile(path.join(cwd, 'demo-plugin/src/skills/demo-plugin/SKILL.md'), 'utf8')).toContain('description:');
    expect(JSON.parse(await fs.readFile(path.join(cwd, 'demo-plugin/package.json'), 'utf8'))).toMatchObject({
      devDependencies: { typescript: '^7.0.2' },
    });
  });

  it('adds selected Modules without generating fake handlers or servers', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-init-test-'));
    roots.push(cwd);
    await initializeProject({ cwd, directory: 'module-plugin', yes: true, hooks: true, mcp: true });
    const project = path.join(cwd, 'module-plugin');

    expect(await fs.readFile(path.join(project, 'acplugin.config.ts'), 'utf8')).toContain('modules: [hooks(), mcp()]');
    await expect(fs.access(path.join(project, 'src/hooks'))).rejects.toThrow();
    await expect(fs.access(path.join(project, 'src/mcp'))).rejects.toThrow();
  });

  it('refuses a non-empty destination', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-init-test-'));
    roots.push(cwd);
    await fs.mkdir(path.join(cwd, 'existing'));
    await fs.writeFile(path.join(cwd, 'existing/user.txt'), 'keep');

    await expect(initializeProject({ cwd, directory: 'existing', yes: true })).rejects.toThrow('not empty');
    expect(await fs.readFile(path.join(cwd, 'existing/user.txt'), 'utf8')).toBe('keep');
  });
});
