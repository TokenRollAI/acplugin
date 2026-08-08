import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { BuildResult, RunProjectOptions } from '@tokenroll/acplugin';

/** 当前测试文件所在仓库的绝对根目录。 */
const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url));

/** 配置文件直接导入的主包真实构建产物。 */
const acpluginEntry = path.join(repositoryRoot, 'packages/acplugin/dist/index.mjs');

/** 临时包代理加载的 Hooks Extension 真实构建产物。 */
const hooksEntry = path.join(repositoryRoot, 'packages/extensions/hooks/dist/index.mjs');

/** 临时包代理加载的 MCP Extension 真实构建产物。 */
const mcpEntry = path.join(repositoryRoot, 'packages/extensions/mcp/dist/index.mjs');

/** 当前测试创建并在 afterEach 中统一删除的临时工程。 */
const temporaryRoots: string[] = [];

/**
 * 在原生 Node ESM 子进程中运行真实主包，确保配置和 Pipeline 共用品牌实例。
 *
 * @param options 可 JSON 序列化的项目运行选项。
 * @returns 公开 API 产生的结构化 BuildResult。
 */
async function runProject(options: RunProjectOptions): Promise<BuildResult> {
  /** 子进程直接导入真实主包构建产物并序列化结果的 ESM 源码。 */
  const source = `
import { runProject } from ${JSON.stringify(acpluginEntry)};
try {
  const result = await runProject(${JSON.stringify(options)});
  process.stdout.write(JSON.stringify({ ok: true, result }));
} catch (error) {
  process.stdout.write(JSON.stringify({
    ok: false,
    name: error instanceof Error ? error.name : 'Error',
    message: error instanceof Error ? error.message : 'Project execution failed.',
  }));
}
`;
  /** 原生 ESM 子进程的退出状态和输出。 */
  const execution = await new Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }>((resolve, reject) => {
    /** 不经过 Vitest 转换器的真实 Node 进程。 */
    const child = spawn(process.execPath, ['--input-type=module', '--eval', source], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    /** 子进程累计的 JSON 标准输出。 */
    let stdout = '';
    /** 子进程累计的框架错误输出。 */
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
  if (execution.code !== 0)
    throw new Error(`Project subprocess failed: ${execution.stderr}`);
  /** 子进程返回的成功结果或安全错误摘要。 */
  const payload = JSON.parse(execution.stdout) as {
    readonly ok: boolean;
    readonly result?: BuildResult;
    readonly name?: string;
    readonly message?: string;
  };
  if (!payload.ok || payload.result === undefined)
    throw new Error(`${payload.name ?? 'Error'}: ${payload.message ?? 'Project execution failed.'}`);
  return payload.result;
}

/**
 * 在临时工程中创建一个指向 workspace 构建产物的 ESM 包代理。
 *
 * @param root 临时工程根目录。
 * @param packageName 待创建的包名。
 * @param entry workspace 内真实 ESM 入口。
 */
async function writePackageProxy(root: string, packageName: string, entry: string): Promise<void> {
  /** scope/name 转换后的临时 node_modules 包目录。 */
  const packageRoot = path.join(root, 'node_modules', ...packageName.split('/'));
  await fs.mkdir(packageRoot, { recursive: true });
  await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
    name: packageName,
    version: '1.0.0',
    type: 'module',
    exports: './index.mjs',
  }));
  await fs.writeFile(
    path.join(packageRoot, 'index.mjs'),
    `export * from ${JSON.stringify(entry)}; export { default } from ${JSON.stringify(entry)};\n`,
  );
}

/**
 * 创建覆盖四个平台、两个 Extension 和所有 Component 的真实工程。
 *
 * @returns 已登记自动清理的工程根目录。
 */
async function createCompleteProject(): Promise<string> {
  /** 当前用例独占的临时工程。 */
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-secondary-platforms-'));
  temporaryRoots.push(root);
  await writePackageProxy(root, '@tokenroll/acplugin-extension-hooks', hooksEntry);
  await writePackageProxy(root, '@tokenroll/acplugin-extension-mcp', mcpEntry);
  await fs.mkdir(path.join(root, 'src/commands'), { recursive: true });
  await fs.mkdir(path.join(root, 'src/skills/review/references'), { recursive: true });
  await fs.mkdir(path.join(root, 'src/agents'), { recursive: true });
  await fs.mkdir(path.join(root, 'src/hooks/session-start'), { recursive: true });
  await fs.mkdir(path.join(root, 'src/hooks/permission'), { recursive: true });
  await fs.mkdir(path.join(root, 'src/mcp/docs'), { recursive: true });
  await fs.mkdir(path.join(root, 'src/mcp/local-tools'), { recursive: true });
  await fs.mkdir(path.join(root, 'public/assets'), { recursive: true });
  await fs.writeFile(path.join(root, 'src/commands/release.md'), `---
description: Prepare a release.
argumentHint: <version>
---
Prepare release {{arguments}}.
`);
  await fs.writeFile(path.join(root, 'src/skills/review/SKILL.md'), `---
description: Review the current change.
invocation:
  user: false
  model: true
---
Review the implementation.
`);
  await fs.writeFile(path.join(root, 'src/skills/review/references/checklist.md'), 'Review checklist.\n');
  await fs.writeFile(path.join(root, 'src/agents/reviewer.md'), `---
description: Review code changes.
model: capable
capabilities:
  - filesystem:read
  - filesystem:write
  - search
  - shell
---
Review code and report findings.
`);
  await fs.writeFile(path.join(root, 'src/hooks/session-start/hook.ts'), `
import { defineHook } from '@tokenroll/acplugin-extension-hooks';
export default defineHook({ event: 'SessionStart', run() { return { additionalContext: 'Ready.' }; } });
`);
  await fs.writeFile(path.join(root, 'src/hooks/permission/hook.ts'), `
import { defineHook } from '@tokenroll/acplugin-extension-hooks';
export default defineHook({ event: 'PermissionRequest', run() { return { decision: 'defer' }; } });
`);
  await fs.writeFile(path.join(root, 'src/mcp/docs/mcp.ts'), `
import { defineMcpServer } from '@tokenroll/acplugin-extension-mcp';
export default defineMcpServer({ transport: 'http', url: 'https://mcp.example.com/mcp' });
`);
  await fs.writeFile(path.join(root, 'src/mcp/local-tools/mcp.ts'), `
import { defineMcpServer } from '@tokenroll/acplugin-extension-mcp';
export default defineMcpServer({ transport: 'stdio' });
`);
  await fs.writeFile(path.join(root, 'src/mcp/local-tools/server.ts'), `
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  const lines = buffer.split('\\n');
  buffer = lines.pop() ?? '';
  for (const line of lines.filter(Boolean)) {
    const message = JSON.parse(line);
    if (message.method === 'initialize') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'secondary-fixture', version: '1.0.0' },
      } }) + '\\n');
    } else if (message.method === 'tools/list') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [] } }) + '\\n');
    }
  }
});
`);
  await fs.writeFile(path.join(root, 'public/assets/readme.txt'), 'Public asset.\n');
  await fs.writeFile(path.join(root, 'acplugin.config.ts'), `
import { antigravity, cursor, openCode, pi } from ${JSON.stringify(acpluginEntry)};
import hooks from '@tokenroll/acplugin-extension-hooks';
import mcp from '@tokenroll/acplugin-extension-mcp';
export default {
  name: 'portable-tools',
  version: '1.2.3',
  description: 'Portable tools.',
  displayName: 'Portable Tools',
  author: { name: 'TokenRoll', email: 'maintainers@example.com', url: 'https://example.com/team' },
  homepage: 'https://example.com/portable-tools',
  repository: 'https://github.com/TokenRollAI/portable-tools',
  license: 'MIT',
  keywords: ['portable'],
  platforms: [cursor({ strict: false }), antigravity({ strict: false }), openCode({ strict: false }), pi({ strict: false })],
  extensions: [hooks(), mcp()],
  build: { strict: false },
};
`);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe('secondary official Platforms', () => {
  it('builds four native delivery-unit shapes with field-level compatibility', async () => {
    /** 覆盖全部次级 Platform 和 Extension Adapter 的规范工程。 */
    const root = await createCompleteProject();
    /** 宽松模式允许矩阵明确声明的有限支持进入交付。 */
    const result = await runProject({ cwd: root, command: 'build', mode: 'production' });

    expect(result.success).toBe(true);
    expect(result.deliveryUnits.map(unit => `${unit.platform}/${unit.id}:${unit.type}`).sort()).toEqual([
      'antigravity/plugin:plugin',
      'cursor/plugin:plugin',
      'opencode/workspace:workspace',
      'pi/package:package',
    ]);
    /** Cursor 使用官方 Plugin Manifest、原生 Component 和 remote-only MCP。 */
    const cursorManifest = JSON.parse(await fs.readFile(
      path.join(root, 'dist/cursor/plugin/.cursor-plugin/plugin.json'),
      'utf8',
    )) as Record<string, unknown>;
    expect(cursorManifest).toMatchObject({
      name: 'portable-tools',
      commands: './commands/*.md',
      skills: './skills/*/SKILL.md',
      agents: './agents/*.md',
      hooks: './hooks/hooks.json',
      mcpServers: './mcp.json',
    });
    await expect(fs.access(path.join(root, 'dist/cursor/plugin/mcp/local-tools/server.mjs'))).rejects.toThrow();

    /** Antigravity 保持最小 Manifest，并将 Command/Agent 收敛到 Skills。 */
    expect(JSON.parse(await fs.readFile(path.join(root, 'dist/antigravity/plugin/plugin.json'), 'utf8')))
      .toEqual({ name: 'portable-tools' });
    expect(await fs.readFile(
      path.join(root, 'dist/antigravity/plugin/skills/command-release/SKILL.md'),
      'utf8',
    )).toContain('the arguments supplied with this explicit invocation');
    expect(await fs.readFile(
      path.join(root, 'dist/antigravity/plugin/skills/agent-reviewer/SKILL.md'),
      'utf8',
    )).toContain('role guidance');

    /** OpenCode 输出 workspace 资源、runtime Hook Plugin 与 local/remote MCP 配置。 */
    const openCodeConfig = JSON.parse(await fs.readFile(path.join(root, 'dist/opencode/workspace/opencode.json'), 'utf8'));
    expect(openCodeConfig).toHaveProperty('mcp.docs.type', 'remote');
    expect(openCodeConfig).toHaveProperty('mcp.local-tools.type', 'local');
    expect(await fs.readFile(
      path.join(root, 'dist/opencode/workspace/.opencode/plugins/acplugin-hooks.mjs'),
      'utf8',
    )).toContain('\'tool.execute.before\'');

    /** Pi 输出真正的 npm package，Hooks 进入 Extension，MCP 不产生伪配置。 */
    const piPackage = JSON.parse(await fs.readFile(path.join(root, 'dist/pi/package/package.json'), 'utf8'));
    expect(piPackage).toMatchObject({
      name: 'portable-tools',
      version: '1.2.3',
      pi: {
        skills: ['./skills'],
        prompts: ['./prompts'],
        extensions: ['./extensions/acplugin-hooks.mjs'],
      },
    });
    expect(piPackage).not.toHaveProperty('private');
    /** 四个平台针对三类 Component 实际提交的完整能力结论。 */
    const componentCompatibility = (platform: string): string[] => result.compatibility
      .filter(entry => entry.platform === platform && /^(?:command|skill|agent):/u.test(entry.subject))
      .map(entry => `${entry.subject}/${entry.capability}/${entry.level}`)
      .sort();
    expect(componentCompatibility('cursor')).toEqual([
      'agent:reviewer/agent.capabilities/degraded',
      'agent:reviewer/agent.model/degraded',
      'agent:reviewer/component/native',
      'command:release/argumentHint/degraded',
      'command:release/component/native',
      'skill:review/component/native',
      'skill:review/invocation.user/degraded',
    ].sort());
    expect(componentCompatibility('antigravity')).toEqual([
      'agent:reviewer/agent.capabilities/degraded',
      'agent:reviewer/agent.model/degraded',
      'agent:reviewer/component/degraded',
      'command:release/argumentHint/degraded',
      'command:release/component/transform',
      'skill:review/component/native',
      'skill:review/invocation/degraded',
    ].sort());
    expect(componentCompatibility('opencode')).toEqual([
      'agent:reviewer/agent.capabilities/transform',
      'agent:reviewer/agent.model/degraded',
      'agent:reviewer/component/native',
      'command:release/argumentHint/degraded',
      'command:release/component/native',
      'skill:review/component/native',
      'skill:review/invocation/degraded',
    ].sort());
    expect(componentCompatibility('pi')).toEqual([
      'agent:reviewer/agent.capabilities/degraded',
      'agent:reviewer/agent.model/degraded',
      'agent:reviewer/component/degraded',
      'command:release/argumentHint/native',
      'command:release/component/transform',
      'skill:review/component/native',
      'skill:review/invocation/degraded',
    ].sort());
    expect(result.compatibility).toEqual(expect.arrayContaining([
      expect.objectContaining({ platform: 'cursor', subject: 'mcp:local-tools', level: 'unsupported' }),
      expect.objectContaining({ platform: 'antigravity', subject: 'command:release', level: 'transform' }),
      expect.objectContaining({ platform: 'opencode', subject: 'agent:reviewer', capability: 'agent.capabilities', level: 'transform' }),
      expect.objectContaining({ platform: 'pi', subject: 'mcp:docs', level: 'unsupported' }),
    ]));
  });

  it('keeps strict Pi usable for Skills and Commands but rejects Agent fallback', async () => {
    /** 完整工程用于先确认 Agent fallback 的 strict 失败。 */
    const root = await createCompleteProject();
    /** Pi strictness 只对实际能力损失生效。 */
    const strictWithAgent = await runProject({
      cwd: root,
      command: 'validate',
      mode: 'production',
      platforms: ['pi'] as never,
      strict: true,
    });
    expect(strictWithAgent.success).toBe(false);
    expect(strictWithAgent.diagnostics).toContainEqual(expect.objectContaining({
      code: 'COMPATIBILITY_STRICT',
      platform: 'pi',
    }));

    /** 移除 Agent 和 MCP 后只剩 Pi 原生/transform 能力。 */
    await fs.rm(path.join(root, 'src/agents'), { recursive: true, force: true });
    await fs.rm(path.join(root, 'src/mcp'), { recursive: true, force: true });
    await fs.rm(path.join(root, 'src/hooks/permission'), { recursive: true, force: true });
    await fs.writeFile(path.join(root, 'src/skills/review/SKILL.md'), `---
description: Review the current change.
---
Review the implementation.
`);
    /** strict Skills/Commands/SessionStart 构建结果。 */
    const supported = await runProject({
      cwd: root,
      command: 'validate',
      mode: 'production',
      platforms: ['pi'] as never,
      strict: true,
    });
    expect(supported.success).toBe(true);
  });
});
