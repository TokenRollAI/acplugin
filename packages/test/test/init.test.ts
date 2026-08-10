import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as acplugin from '@tokenroll/acplugin';
import { initializeProject } from '@tokenroll/acplugin';

/** 当前测试创建并在 afterEach 中统一删除的临时目录。 */
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe('init', () => {
  it('creates the minimal strict dual-Platform project without fake Extension source', async () => {
    /** 最小工程脚手架测试使用的父目录。 */
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-init-test-'));
    roots.push(cwd);
    /** 非交互初始化返回的脚手架摘要。 */
    const result = await initializeProject({ cwd, directory: 'demo-plugin', yes: true });

    expect(result.directory).toBe('demo-plugin');
    expect(result.platforms).toEqual(['claude-code', 'codex']);
    expect(result.extensions).toEqual([]);
    /** 默认配置通过两个独立 Platform package 的显式默认导入构建。 */
    const config = await fs.readFile(path.join(cwd, 'demo-plugin/acplugin.config.ts'), 'utf8');
    expect(config).toContain(`import claudeCode from '@tokenroll/acplugin-platform-claude-code';`);
    expect(config).toContain(`import codex from '@tokenroll/acplugin-platform-codex';`);
    expect(config).toContain('platforms: [claudeCode(), codex()]');
    expect(await fs.readFile(path.join(cwd, 'demo-plugin/src/skills/demo-plugin/SKILL.md'), 'utf8')).toContain('description:');
    expect(JSON.parse(await fs.readFile(path.join(cwd, 'demo-plugin/package.json'), 'utf8'))).toMatchObject({
      engines: { node: '^20.19.0 || ^22.13.0 || >=23.5.0' },
      devDependencies: {
        '@tokenroll/acplugin-platform-claude-code': '^0.0.1-beta',
        '@tokenroll/acplugin-platform-codex': '^0.0.1-beta',
        'typescript': '^7.0.2',
      },
    });
  });

  it('adds selected Extensions without generating fake handlers or servers', async () => {
    /** 可选 Extension 脚手架测试使用的父目录。 */
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-init-test-'));
    roots.push(cwd);
    await initializeProject({ cwd, directory: 'extension-plugin', yes: true, hooks: true, mcp: true });
    /** 已生成工程的绝对路径。 */
    const project = path.join(cwd, 'extension-plugin');

    expect(await fs.readFile(path.join(project, 'acplugin.config.ts'), 'utf8')).toContain('extensions: [hooks(), mcp()]');
    expect(await fs.readdir(path.join(project, 'src/hooks'))).toEqual([]);
    expect(await fs.readdir(path.join(project, 'src/mcp'))).toEqual([]);
  });

  it('writes any explicit subset of the six official Platform factories', async () => {
    /** 六 Platform 脚手架测试使用的父目录。 */
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-init-test-'));
    roots.push(cwd);
    /** 显式选择所有内置 Platform 的初始化结果。 */
    const result = await initializeProject({
      cwd,
      directory: 'all-platforms',
      yes: true,
      platforms: ['claude-code', 'codex', 'cursor', 'antigravity', 'opencode', 'pi'],
    });
    /** 需要能被 TypeScript 配置加载器执行的配置源码。 */
    const config = await fs.readFile(path.join(cwd, 'all-platforms/acplugin.config.ts'), 'utf8');

    expect(result.platforms).toEqual(['claude-code', 'codex', 'cursor', 'antigravity', 'opencode', 'pi']);
    expect(config).toContain('claudeCode(), codex(), cursor(), antigravity(), openCode(), pi()');
    expect(config).toContain(`import pi from '@tokenroll/acplugin-platform-pi';`);
  });

  it('refuses a non-empty destination', async () => {
    /** 非空目标拒绝测试使用的父目录。 */
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-init-test-'));
    roots.push(cwd);
    await fs.mkdir(path.join(cwd, 'existing'));
    await fs.writeFile(path.join(cwd, 'existing/user.txt'), 'keep');

    await expect(initializeProject({ cwd, directory: 'existing', yes: true })).rejects.toThrow('not empty');
    expect(await fs.readFile(path.join(cwd, 'existing/user.txt'), 'utf8')).toBe('keep');
  });

  it('keeps the specialized init error outside the public facade', () => {
    expect('InitError' in acplugin).toBe(false);
  });
});
