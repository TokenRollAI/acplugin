import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { codex, cursor, ProjectConfigError, runProject, type PlatformId } from '@tokenroll/acplugin';

/** 当前测试创建并在 afterEach 中统一删除的临时工程根目录。 */
const roots: string[] = [];

/**
 * 创建包含最小 Skill 和可选自定义配置的测试工程。
 *
 * @param config 可选的完整配置源码。
 * @returns 自动登记清理的工程绝对路径。
 */
async function project(config = ''): Promise<string> {
  /** 当前集成测试独占并自动登记清理的工程根。 */
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
  it('validates without committing and builds both default Platforms atomically', async () => {
    /** 默认双 Platform 构建使用的最小工程。 */
    const root = await project();
    /** 不提交任何输出的 validate 结果。 */
    const validate = await runProject({ cwd: root, command: 'validate', mode: 'production', commit: false });

    expect(validate.success).toBe(true);
    expect(validate.committed).toBe(false);
    await expect(fs.access(path.join(root, 'dist'))).rejects.toThrow();

    /** 原子提交 Claude Code 与 Codex 输出的 build 结果。 */
    const build = await runProject({ cwd: root, command: 'build', mode: 'production', commit: true });
    expect(build.success).toBe(true);
    expect(build.committed).toBe(true);
    expect(JSON.parse(await fs.readFile(path.join(root, 'dist/claude-code/plugin/.claude-plugin/plugin.json'), 'utf8'))).toMatchObject({ name: 'hello-plugin' });
    expect(JSON.parse(await fs.readFile(path.join(root, 'dist/codex/plugin/.codex-plugin/plugin.json'), 'utf8'))).toMatchObject({ skills: './skills/' });

    /** build 命令显式关闭 commit 时仍完整物化验证，但不创建新 outDir。 */
    await fs.rm(path.join(root, 'dist'), { recursive: true, force: true });
    /** 关闭提交后的完整 build 报告。 */
    const dryBuild = await runProject({ cwd: root, command: 'build', mode: 'production', commit: false });
    expect(dryBuild).toMatchObject({ success: true, committed: false, command: 'build' });
    await expect(fs.access(path.join(root, 'dist'))).rejects.toThrow();
  });

  it('preserves the last complete dual-Platform output when either Platform fails', async () => {
    /** 先生成一份可用于失败回滚对比的完整默认输出。 */
    const root = await project();
    /** 产生回滚基线的首次双 Platform 构建。 */
    const first = await runProject({ cwd: root, command: 'build', mode: 'production' });
    expect(first).toMatchObject({ success: true, committed: true });
    /** Claude Code 原生但 Codex 会降级的 Agent，使默认严格构建整体失败。 */
    await fs.mkdir(path.join(root, 'src/agents'), { recursive: true });
    await fs.writeFile(path.join(root, 'src/agents/reviewer.md'), '---\ndescription: Review changes.\n---\nReview changes carefully.\n');
    /** 失败前 Codex Plugin Manifest 的稳定内容。 */
    const manifest = path.join(root, 'dist/codex/plugin/.codex-plugin/plugin.json');
    /** 用于确认失败事务未覆盖旧产物的基线文本。 */
    const previous = await fs.readFile(manifest, 'utf8');

    /** 新增不兼容 Agent 后的预期失败构建。 */
    const failed = await runProject({ cwd: root, command: 'build', mode: 'production' });

    expect(failed).toMatchObject({ success: false, committed: false });
    expect(failed.diagnostics).toContainEqual(expect.objectContaining({ code: 'COMPATIBILITY_STRICT', platform: codex().id }));
    expect(await fs.readFile(manifest, 'utf8')).toBe(previous);
  });

  it('fails strict Codex compatibility for Agents and succeeds when relaxed', async () => {
    /** 包含 Codex 降级 Agent 的测试工程。 */
    const root = await project();
    await fs.mkdir(path.join(root, 'src/agents'), { recursive: true });
    await fs.writeFile(path.join(root, 'src/agents/reviewer.md'), '---\ndescription: Review changes.\n---\nReview changes carefully.\n');

    /** 严格模式下预期失败的 Codex 验证结果。 */
    const strict = await runProject({ cwd: root, command: 'validate', mode: 'production', platforms: [codex().id], strict: true });
    expect(strict.success).toBe(false);
    expect(strict.diagnostics).toContainEqual(expect.objectContaining({ code: 'COMPATIBILITY_STRICT' }));

    /** 宽松模式下保留降级结论但成功的 Codex 验证结果。 */
    const relaxed = await runProject({ cwd: root, command: 'validate', mode: 'production', platforms: [codex().id], strict: false });
    expect(relaxed.success).toBe(true);
    expect(relaxed.compatibility).toContainEqual(expect.objectContaining({ subject: 'agent:reviewer', level: 'degraded' }));
  });

  it('rejects empty, duplicate, and unconfigured Platform selections before execution', async () => {
    /** Platform 子集边界测试使用的最小工程。 */
    const root = await project();
    /** 三种非法选择对应的稳定诊断码。 */
    const cases: readonly { platforms: readonly PlatformId[]; code: string }[] = [
      { platforms: [] as const, code: 'CLI_PLATFORM_SELECTION_EMPTY' },
      { platforms: [codex().id, codex().id], code: 'CLI_PLATFORM_SELECTION_DUPLICATE' },
      { platforms: [cursor().id], code: 'CLI_PLATFORM_NOT_CONFIGURED' },
    ];

    /** item 表示当前待验证的非法 Platform 子集。 */
    for (const item of cases) {
      await expect(runProject({
        cwd: root,
        command: 'validate',
        mode: 'production',
        platforms: item.platforms,
      })).rejects.toSatisfy((error: unknown) => error instanceof ProjectConfigError
        && error.diagnostics.some(diagnostic => diagnostic.code === item.code));
    }
  });
});
