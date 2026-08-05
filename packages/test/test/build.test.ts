import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runProject } from '@tokenroll/acplugin';

/** 当前测试创建并在 afterEach 中统一删除的临时工程根目录。 */
const roots: string[] = [];

/**
 * 创建包含最小 Skill 和可选自定义配置的测试工程。
 *
 * @param config 可选的完整配置源码。
 * @returns 自动登记清理的工程绝对路径。
 */
async function project(config = ''): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-build-test-'));
  roots.push(root);
  await fs.mkdir(path.join(root, 'src/skills/hello'), { recursive: true });
  await fs.writeFile(path.join(root, 'src/skills/hello/SKILL.md'), '---\ndescription: Say hello.\n---\nSay hello to the user.\n');
  await fs.writeFile(path.join(root, 'acplugin.config.ts'), config || `export default {
    name: 'hello-plugin',
    version: '1.0.0',
    description: 'Hello plugin.',
  }`);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe('unified pipeline', () => {
  it('validates without committing and builds both default targets atomically', async () => {
    const root = await project();
    const validate = await runProject({ cwd: root, command: 'validate', mode: 'production', commit: false });

    expect(validate.report.success).toBe(true);
    expect(validate.report.committed).toBe(false);
    await expect(fs.access(path.join(root, 'dist'))).rejects.toThrow();

    const build = await runProject({ cwd: root, command: 'build', mode: 'production', commit: true });
    expect(build.report.success).toBe(true);
    expect(build.report.committed).toBe(true);
    expect(JSON.parse(await fs.readFile(path.join(root, 'dist/claude-code/.claude-plugin/plugin.json'), 'utf8'))).toMatchObject({ name: 'hello-plugin' });
    expect(JSON.parse(await fs.readFile(path.join(root, 'dist/codex/.codex-plugin/plugin.json'), 'utf8'))).toMatchObject({ skills: './skills/' });
  });

  it('fails strict Codex compatibility for Agents and succeeds when relaxed', async () => {
    const root = await project();
    await fs.mkdir(path.join(root, 'src/agents'), { recursive: true });
    await fs.writeFile(path.join(root, 'src/agents/reviewer.md'), '---\ndescription: Review changes.\n---\nReview changes carefully.\n');

    const strict = await runProject({ cwd: root, command: 'validate', mode: 'production', targets: ['codex'], strict: true });
    expect(strict.report.success).toBe(false);
    expect(strict.report.diagnostics).toContainEqual(expect.objectContaining({ code: 'COMPATIBILITY_STRICT' }));

    const relaxed = await runProject({ cwd: root, command: 'validate', mode: 'production', targets: ['codex'], strict: false });
    expect(relaxed.report.success).toBe(true);
    expect(relaxed.report.compatibility).toContainEqual(expect.objectContaining({ subject: 'agent:reviewer', level: 'degraded' }));
  });
});
