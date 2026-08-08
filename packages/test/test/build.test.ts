import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectConfigError, runProject, serializeBuildResult, type PlatformId } from '@tokenroll/acplugin';
import claudeCode from '@tokenroll/acplugin-platform-claude-code';
import codex from '@tokenroll/acplugin-platform-codex';
import cursor from '@tokenroll/acplugin-platform-cursor';

/** 临时配置与当前 Vitest 源码图共享官方 Platform 工厂的隔离全局键。 */
const BUILD_TEST_PLATFORMS = Symbol.for('tokenroll.acplugin.build-test-platforms');

Reflect.set(globalThis, BUILD_TEST_PLATFORMS, Object.freeze({ claudeCode, codex }));

/** 当前测试创建并在 afterEach 中统一删除的临时工程根目录。 */
const roots: string[] = [];

/** 完整受管输出树中的一个稳定文件快照。 */
interface OutputFileSnapshot {
  /** 使用 POSIX 分隔符的 dist 相对路径。 */
  readonly path: string;
  /** 只保留 Artifact 契约关心的权限位。 */
  readonly mode: number;
  /** 未文本化的真实文件字节。 */
  readonly bytes: Buffer;
}

/**
 * 递归读取完整 dist 文件树，供跨绝对根执行字节级比较。
 *
 * @param directory 当前遍历目录。
 * @param outputRoot 受管输出根。
 * @returns 按 code-unit 路径排序的普通文件快照。
 */
async function outputTree(directory: string, outputRoot: string = directory): Promise<OutputFileSnapshot[]> {
  /** 当前目录按 code-unit 排序后的文件系统项。 */
  const entries = (await fs.readdir(directory, { withFileTypes: true }))
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  /** 当前子树累计的普通文件快照。 */
  const files: OutputFileSnapshot[] = [];
  for (const entry of entries) {
    /** 当前目录项的绝对路径。 */
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await outputTree(target, outputRoot));
    } else if (entry.isFile()) {
      /** 当前输出文件的权限与真实字节。 */
      const stat = await fs.stat(target);
      files.push({
        path: path.relative(outputRoot, target).split(path.sep).join('/'),
        mode: stat.mode & 0o777,
        bytes: await fs.readFile(target),
      });
    }
  }
  return files;
}

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
  await fs.writeFile(path.join(root, 'acplugin.config.ts'), config || `const platforms = globalThis[Symbol.for('tokenroll.acplugin.build-test-platforms')];
export default {
    name: 'hello-plugin',
    version: '1.0.0',
    description: 'Hello plugin.',
    platforms: [platforms.claudeCode(), platforms.codex()],
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

  it('keeps the complete dist tree, Artifact hashes, and report bytes stable across roots and unrelated environment values', async () => {
    /** 相同字节工程使用的两个不同绝对根。 */
    const firstRoot = await project();
    /** 与第一个工程字节相同但绝对位置不同的第二个根。 */
    const secondRoot = await project();
    /** 测试结束后需要恢复的原始环境值。 */
    const previousEnvironment = process.env.ACPLUGIN_UNRELATED_FIXTURE;
    try {
      process.env.ACPLUGIN_UNRELATED_FIXTURE = 'first-machine-value';
      /** 第一个根和环境输入下的内置构建报告。 */
      const first = await runProject({ cwd: firstRoot, command: 'build', mode: 'production' });
      process.env.ACPLUGIN_UNRELATED_FIXTURE = 'second-machine-value';
      /** 第二个根和无关环境输入下的内置构建报告。 */
      const second = await runProject({ cwd: secondRoot, command: 'build', mode: 'production' });

      expect(second.deliveryUnits).toEqual(first.deliveryUnits);
      expect(serializeBuildResult(second)).toBe(serializeBuildResult(first));
      expect(await outputTree(path.join(secondRoot, 'dist'))).toEqual(await outputTree(path.join(firstRoot, 'dist')));
    } finally {
      if (previousEnvironment === undefined)
        delete process.env.ACPLUGIN_UNRELATED_FIXTURE;
      else
        process.env.ACPLUGIN_UNRELATED_FIXTURE = previousEnvironment;
    }
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
