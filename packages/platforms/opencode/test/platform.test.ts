import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { executeLifecycle, resolveConfig, type ResolvedConfig } from '@acplugin/core';
import { openCode } from '../src/index.js';

/** 测试结束后统一删除的临时工程根目录。 */
const temporaryRoots: string[] = [];

/** OpenCode 配置 Golden 的固定目录。 */
const goldenRoot = path.join(import.meta.dirname, 'golden');

/** 创建覆盖 OpenCode 三类原生 workspace 资源的规范工程。 */
async function createProject(): Promise<string> {
  /** 当前用例独占的工程根目录。 */
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-opencode-platform-'));
  temporaryRoots.push(root);
  await fs.mkdir(path.join(root, 'src/commands'), { recursive: true });
  await fs.mkdir(path.join(root, 'src/skills/review'), { recursive: true });
  await fs.mkdir(path.join(root, 'src/agents'), { recursive: true });
  await fs.writeFile(path.join(root, 'src/commands/release.md'), '---\ndescription: Prepare a release.\n---\nPrepare release {{arguments}}.\n');
  await fs.writeFile(path.join(root, 'src/skills/review/SKILL.md'), '---\ndescription: Review a change.\n---\nReview the change.\n');
  await fs.writeFile(path.join(root, 'src/agents/reviewer.md'), '---\ndescription: Review code.\nmodel: inherit\ncapabilities:\n  - filesystem:read\n  - search\n---\nReview code.\n');
  return root;
}

/** 解析仅包含 OpenCode Platform 的严格测试配置。 */
function resolvedConfig(root: string): ResolvedConfig {
  /** 启用官方配置 Schema 的 workspace 解析结果。 */
  const result = resolveConfig({
    name: 'release-tools',
    version: '1.2.3',
    description: 'Release workflow tools.',
    platforms: [openCode({ workspace: { schema: true } })],
  }, path.join(root, 'acplugin.config.ts'), 'build', 'production', { defaultPlatforms: [openCode()] });
  expect(result.diagnostics).toEqual([]);
  return result.config!;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe('OpenCode Platform', () => {
  it('loads the generated config and discovers workspace Commands, Skills, and Agents', async () => {
    /** 覆盖全部静态 workspace 资源的规范工程。 */
    const root = await createProject();
    /** 经过配置加载边界和 Platform Validator 的构建结果。 */
    const result = await executeLifecycle({
      config: resolvedConfig(root),
      /** 纯 Markdown Platform Fixture 不加载 TypeScript descriptor。 */
      loadTypeScriptModule: async () => undefined,
      environment: {},
    });
    /** OpenCode workspace 的最终输出根。 */
    const output = path.join(root, 'dist/opencode/workspace');
    /** OpenCode 会在 workspace 启动时读取的配置对象。 */
    const config = JSON.parse(await fs.readFile(path.join(output, 'opencode.json'), 'utf8')) as Record<string, unknown>;
    /** 按 OpenCode 官方发现目录模拟加载到的资源路径。 */
    const discovered = (await fs.readdir(path.join(output, '.opencode'), { recursive: true }))
      .map(entry => String(entry).split(path.sep).join('/'))
      .filter(entry => entry.endsWith('.md'))
      .sort((a, b) => a.localeCompare(b, 'en'));

    expect(result.success).toBe(true);
    expect(config).toEqual({ $schema: 'https://opencode.ai/config.json' });
    expect(await fs.readFile(path.join(output, 'opencode.json'))).toEqual(await fs.readFile(path.join(goldenRoot, 'opencode.json')));
    expect(discovered).toEqual([
      'agents/reviewer.md',
      'commands/release.md',
      'skills/review/SKILL.md',
    ]);
    await expect(fs.access(path.join(output, 'package.json'))).rejects.toThrow();
  });

  it('does not materialize an empty workspace config', async () => {
    /** 空工程仍需建立 src 根以满足 Scanner 约定。 */
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-opencode-platform-'));
    temporaryRoots.push(root);
    await fs.mkdir(path.join(root, 'src'));
    /** 默认选项下不创建 opencode.json 的构建结果。 */
    const result = resolveConfig({
      name: 'empty-workspace', version: '1.0.0', description: 'Empty workspace.', platforms: [openCode()],
    }, path.join(root, 'acplugin.config.ts'), 'build', 'production', { defaultPlatforms: [openCode()] });
    /** 空配置生命周期执行结果。 */
    const build = await executeLifecycle({
      config: result.config!,
      /** 空 Workspace Fixture 不加载 TypeScript descriptor。 */
      loadTypeScriptModule: async () => undefined,
      environment: {},
    });

    expect(build.success, JSON.stringify(build.diagnostics)).toBe(true);
    await expect(fs.access(path.join(root, 'dist/opencode/workspace/opencode.json'))).rejects.toThrow();
  });
});
