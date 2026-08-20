import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { BuildReport } from '@tokenroll/acplugin';
import codex, { PLATFORM_ID } from '@tokenroll/acplugin-platform-codex';

/** 跨包契约测试读取源码边界时使用的仓库根目录。 */
const repositoryRoot = fileURLToPath(new URL('../../../..', import.meta.url));

/** 配置和生命周期共用品牌实例的主包真实构建入口。 */
const acpluginEntry = path.join(repositoryRoot, 'packages/acplugin/dist/index.mjs');

/** 临时工程通过正常 package specifier 加载的 Codex Platform 包名。 */
const codexPackageName = '@tokenroll/acplugin-platform-codex';

/** 当前测试创建并在 afterEach 中删除的临时工程。 */
const temporaryRoots: string[] = [];

/**
 * 在原生 Node ESM 子进程中运行已构建主包。
 *
 * @param root 包含真实配置文件的临时项目根。
 * @returns 公开 runProject 产生的结构化结果。
 */
async function runBuiltProject(root: string): Promise<BuildReport> {
  /** 子进程加载公开入口并返回稳定 JSON 的 ESM 源码。 */
  const source = `
import { runProject } from ${JSON.stringify(acpluginEntry)};
try {
  const result = await runProject(${JSON.stringify({ cwd: root, command: 'build', mode: 'production' })});
  process.stdout.write(JSON.stringify({ ok: true, result }));
} catch (error) {
  process.stdout.write(JSON.stringify({
    ok: false,
    message: error instanceof Error ? error.message : 'Project execution failed.',
  }));
}
`;
  /** 不经过 Vitest alias 的原生 ESM 执行结果。 */
  const execution = await new Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }>((resolve, reject) => {
    /** 与真实 CLI 相同模块边界的 Node 子进程。 */
    const child = spawn(process.execPath, ['--input-type=module', '--eval', source], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    /** 子进程累计的 JSON 标准输出。 */
    let stdout = '';
    /** 子进程累计的错误输出。 */
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
  /** 子进程返回的成功结果或安全错误摘要。 */
  const payload = JSON.parse(execution.stdout) as { readonly ok: boolean; readonly result?: BuildReport; readonly message?: string };
  if (!payload.ok || payload.result === undefined)
    throw new Error(payload.message ?? 'Project execution failed.');
  return payload.result;
}

/**
 * 用 package-manager 风格目录链接给临时工程安装真实构建后的 Codex 包。
 *
 * @param root 临时消费工程根。
 */
async function installBuiltCodex(root: string): Promise<void> {
  /** scope 目录必须先存在，最终 package link 才与 pnpm 布局语义一致。 */
  const scope = path.join(root, 'node_modules/@tokenroll');
  await fs.mkdir(scope, { recursive: true });
  await fs.symlink(
    path.join(repositoryRoot, 'packages/platforms/codex'),
    path.join(scope, 'acplugin-platform-codex'),
    'dir',
  );
}

/**
 * 递归读取 Codex Platform 的全部 TypeScript 源码。
 *
 * @param directory 当前需要遍历的源码目录。
 * @returns 按文件名稳定排序并拼接后的源码文本。
 */
async function platformSources(directory: string): Promise<string> {
  /** 当前目录按名称排序后的文件系统项。 */
  const entries = (await fs.readdir(directory, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name, 'en'));
  /** 当前目录与全部子目录累计的 TypeScript 源码。 */
  const sources: string[] = [];
  for (const entry of entries) {
    /** 当前目录项的绝对路径。 */
    const target = path.join(directory, entry.name);
    if (entry.isDirectory())
      sources.push(await platformSources(target));
    else if (entry.isFile() && entry.name.endsWith('.ts'))
      sources.push(await fs.readFile(target, 'utf8'));
  }
  return sources.join('\n');
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe('Codex public Platform integration', () => {
  it('exports an independent Platform factory with typed interface and Marketplace policy', () => {
    /** 通过独立公开 package 创建的 Codex Platform。 */
    const platform = codex({
      strict: false,
      interface: {
        category: 'Developer Tools',
        capabilities: ['Review changes'],
        defaultPrompt: 'Review this change.',
      },
      marketplace: {
        displayName: 'TokenRoll Plugins',
        policy: { installation: 'INSTALLED_BY_DEFAULT' },
      },
    });

    expect(platform.id).toBe(PLATFORM_ID);
    expect(platform.strict).toBe(false);
    expect(platform.deliveryType).toBe('plugin');
    expect(platform.options).toEqual({
      interface: {
        category: 'Developer Tools',
        capabilities: ['Review changes'],
        defaultPrompt: 'Review this change.',
      },
      marketplace: {
        displayName: 'TokenRoll Plugins',
        policy: { installation: 'INSTALLED_BY_DEFAULT' },
      },
    });
    expect(Object.isFrozen(platform.options)).toBe(true);
    expect(Object.isFrozen(platform.options!.interface)).toBe(true);
    expect(Object.isFrozen(platform.options!.marketplace)).toBe(true);
  });

  it('loads plugin-prefixed Command Skill IDs through the built public packages', async () => {
    /** 使用真实配置加载路径验证独立 Platform package 与主包 bundle 的品牌一致性。 */
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-codex-generated-id-'));
    temporaryRoots.push(root);
    await installBuiltCodex(root);
    await fs.mkdir(path.join(root, 'src/commands'), { recursive: true });
    await fs.writeFile(path.join(root, 'src/commands/bootstrap.md'), `---
description: Bootstrap the repository.
---
Bootstrap the repository.
`);
    await fs.writeFile(path.join(root, 'acplugin.config.ts'), `
import codex from ${JSON.stringify(codexPackageName)};
export default {
  name: 'repository-ops',
  version: '1.0.0',
  description: 'Repository operations.',
  platforms: [codex()],
};
`);
    /** 子进程加载真实 dist 入口并完成事务提交。 */
    const result = await runBuiltProject(root);
    /** 最终 Skill ID 不依赖生成后重命名或报告修补。 */
    const generatedId = 'repository-ops-bootstrap';

    expect(result.success, JSON.stringify(result.diagnostics)).toBe(true);
    expect(result.packages.find(unit => unit.id === 'plugin')?.assets)
      .toContainEqual(expect.objectContaining({ path: `skills/${generatedId}/SKILL.md` }));
    expect(result.compatibility).toContainEqual(expect.objectContaining({
      subject: 'command:bootstrap',
      transformation: `explicit-skill:${generatedId}`,
    }));
    expect(await fs.readFile(path.join(root, `dist/codex/plugin/skills/${generatedId}/SKILL.md`), 'utf8'))
      .toContain(`name: ${generatedId}`);
  });

  it('keeps Hooks and MCP implementation packages outside the Platform dependency boundary', async () => {
    /** Codex 公开 Platform 的完整源码文本。 */
    const source = await platformSources(path.join(repositoryRoot, 'packages/platforms/codex/src'));

    expect(source).not.toContain('@tokenroll/acplugin-extension-hooks');
    expect(source).not.toContain('@tokenroll/acplugin-extension-mcp');
    expect(source).not.toContain('@tokenroll/acplugin-module-hooks');
    expect(source).not.toContain('@tokenroll/acplugin-module-mcp');
  });

  it('reports an independent arguments transformation only when the Command uses the placeholder', async () => {
    /** 覆盖有参数和无参数 Command 的真实 Scanner/Lifecycle 工程。 */
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-codex-arguments-'));
    temporaryRoots.push(root);
    await installBuiltCodex(root);
    await fs.mkdir(path.join(root, 'src/commands'), { recursive: true });
    await fs.writeFile(path.join(root, 'src/commands/deploy.md'), `---
description: Deploy an environment.
---
Deploy {{arguments}}.
`);
    await fs.writeFile(path.join(root, 'src/commands/status.md'), `---
description: Show deployment status.
---
Show deployment status.
`);
    await fs.writeFile(path.join(root, 'acplugin.config.ts'), `
import codex from ${JSON.stringify(codexPackageName)};
export default {
  name: 'codex-arguments',
  version: '1.0.0',
  description: 'Verify Codex argument compatibility.',
  platforms: [codex({ strict: false })],
};
`);
    /** 执行真实配置加载、扫描、转换、候选校验和事务后的结果。 */
    const result = await runBuiltProject(root);

    expect(result.success, JSON.stringify(result.diagnostics)).toBe(true);
    expect(result.compatibility).toContainEqual(expect.objectContaining({
      platform: 'codex',
      subject: 'command:deploy',
      capability: 'arguments',
      level: 'transform',
    }));
    expect(result.compatibility).not.toContainEqual(expect.objectContaining({
      platform: 'codex',
      subject: 'command:status',
      capability: 'arguments',
    }));
    expect(await fs.readFile(path.join(root, 'dist/codex/plugin/skills/codex-arguments-deploy/SKILL.md'), 'utf8'))
      .toContain('the arguments supplied with this explicit invocation');
  });
});
