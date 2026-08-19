import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { BuildReport, RunProjectOptions } from '@tokenroll/acplugin';

/** 当前测试文件所在仓库的绝对根目录。 */
const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url));

/** 配置文件直接导入的主包真实构建产物。 */
const acpluginEntry = path.join(repositoryRoot, 'packages/acplugin/dist/index.mjs');

/** 六个官方 Platform 的真实独立构建入口。 */
const platformEntries = {
  'antigravity': path.join(repositoryRoot, 'packages/platforms/antigravity/dist/index.mjs'),
  'claude-code': path.join(repositoryRoot, 'packages/platforms/claude-code/dist/index.mjs'),
  'codex': path.join(repositoryRoot, 'packages/platforms/codex/dist/index.mjs'),
  'cursor': path.join(repositoryRoot, 'packages/platforms/cursor/dist/index.mjs'),
  'opencode': path.join(repositoryRoot, 'packages/platforms/opencode/dist/index.mjs'),
  'pi': path.join(repositoryRoot, 'packages/platforms/pi/dist/index.mjs'),
} as const;

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
 * @returns 公开 API 产生的结构化 BuildReport。
 */
async function runProject(options: RunProjectOptions): Promise<BuildReport> {
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
    cause: error instanceof Error && error.cause instanceof Error ? error.cause.message : undefined,
    diagnostics: error && typeof error === 'object' ? Reflect.get(error, 'diagnostics') : undefined,
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
    readonly result?: BuildReport;
    readonly name?: string;
    readonly message?: string;
    readonly diagnostics?: readonly { readonly code?: string; readonly message?: string }[];
    readonly cause?: string;
  };
  if (!payload.ok || payload.result === undefined)
    throw new Error(`${payload.name ?? 'Error'}: ${payload.message ?? 'Project execution failed.'} ${payload.cause ?? ''} ${JSON.stringify(payload.diagnostics ?? [])}`);
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
    exports: packageName === '@tokenroll/acplugin'
      ? { '.': './index.mjs', './sdk': './sdk.mjs' }
      : './index.mjs',
  }));
  /** 复制真实入口及其同目录 chunks，保持包代理的相对模块图完整。 */
  const sourceRoot = path.dirname(entry);
  /** 入口目录内的全部 ESM 构建文件。 */
  const files = await fs.readdir(sourceRoot);
  for (const file of files.filter(file => file.endsWith('.mjs'))) {
    await fs.copyFile(path.join(sourceRoot, file), path.join(packageRoot, file));
  }
  await fs.copyFile(entry, path.join(packageRoot, 'index.mjs'));
}

/** 将公开 Platform 的真实 runtime dependency 暴露给临时 packed-consumer 代理。 */
async function linkCodexRuntimeDependencies(root: string): Promise<void> {
  /** dependency 是 Codex tarball 正常安装时由包管理器提供的运行时包。 */
  for (const dependency of ['image-size', 'saxes', 'yaml']) {
    /** source 解析 pnpm workspace symlink 后的真实 package 根。 */
    const source = await fs.realpath(path.join(repositoryRoot, 'packages/platforms/codex/node_modules', dependency));
    /** destination 模拟消费者 node_modules 的正常依赖布局。 */
    const destination = path.join(root, 'node_modules', dependency);
    await fs.symlink(source, destination, 'dir');
  }
}

/** 读取一个托管输出目录的完整相对路径与字节快照。 */
async function snapshotDirectory(root: string): Promise<Readonly<Record<string, string>>> {
  /** files 使用 base64 保留 mode 之外的精确文件字节。 */
  const files: Record<string, string> = {};
  /** visit 递归枚举受事务管理的普通目录。 */
  async function visit(directory: string): Promise<void> {
    /** entries 采用稳定 code-unit 顺序，避免文件系统枚举差异。 */
    const entries = (await fs.readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      /** absolute 是当前候选内已知子路径。 */
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory())
        await visit(absolute);
      else if (entry.isFile())
        files[path.relative(root, absolute).split(path.sep).join('/')] = (await fs.readFile(absolute)).toString('base64');
    }
  }
  await visit(root);
  return Object.freeze(files);
}

/**
 * 创建覆盖四个平台、两个 Extension 和所有 Component 的真实工程。
 *
 * @returns 已登记自动清理的工程根目录。
 */
async function createCompleteProject(options: { readonly strictCursor?: boolean; readonly strictPi?: boolean } = {}): Promise<string> {
  /** 当前用例独占的临时工程。 */
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-secondary-platforms-'));
  temporaryRoots.push(root);
  await writePackageProxy(root, '@tokenroll/acplugin', acpluginEntry);
  await writePackageProxy(root, '@tokenroll/acplugin-platform-antigravity', platformEntries.antigravity);
  await writePackageProxy(root, '@tokenroll/acplugin-platform-claude-code', platformEntries['claude-code']);
  await writePackageProxy(root, '@tokenroll/acplugin-platform-codex', platformEntries.codex);
  await linkCodexRuntimeDependencies(root);
  await writePackageProxy(root, '@tokenroll/acplugin-platform-cursor', platformEntries.cursor);
  await writePackageProxy(root, '@tokenroll/acplugin-platform-opencode', platformEntries.opencode);
  await writePackageProxy(root, '@tokenroll/acplugin-platform-pi', platformEntries.pi);
  await writePackageProxy(root, '@tokenroll/acplugin-extension-hooks', hooksEntry);
  await writePackageProxy(root, '@tokenroll/acplugin-extension-mcp', mcpEntry);
  await fs.mkdir(path.join(root, 'src/commands'), { recursive: true });
  await fs.mkdir(path.join(root, 'src/skills/review/references'), { recursive: true });
  await fs.mkdir(path.join(root, 'src/agents'), { recursive: true });
  await fs.mkdir(path.join(root, 'src/hooks/session-start'), { recursive: true });
  await fs.mkdir(path.join(root, 'src/hooks/permission'), { recursive: true });
  await fs.mkdir(path.join(root, 'src/mcp/docs'), { recursive: true });
  await fs.mkdir(path.join(root, 'src/mcp/oauth-docs'), { recursive: true });
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
import type { Hook } from '@tokenroll/acplugin-extension-hooks';
export default { event: 'SessionStart', run() { return { additionalContext: 'Ready.' }; } } satisfies Hook<'SessionStart'>;
`);
  await fs.writeFile(path.join(root, 'src/hooks/permission/hook.ts'), `
import type { Hook } from '@tokenroll/acplugin-extension-hooks';
export default { event: 'PermissionRequest', run() { return { decision: 'defer' }; } } satisfies Hook<'PermissionRequest'>;
`);
  await fs.writeFile(path.join(root, 'src/mcp/docs/mcp.ts'), `
import type { McpServer } from '@tokenroll/acplugin-extension-mcp';
export default {
  transport: 'http',
  url: 'https://mcp.example.com/mcp',
  auth: { type: 'bearer', env: 'DOCS_TOKEN' },
} satisfies McpServer;
`);
  await fs.writeFile(path.join(root, 'src/mcp/oauth-docs/mcp.ts'), `
import type { McpServer } from '@tokenroll/acplugin-extension-mcp';
export default {
  transport: 'http',
  url: 'https://oauth-mcp.example.com/mcp',
  auth: { type: 'oauth', scopes: ['docs:read', 'docs:write'] },
  headers: { 'X-Zeta': { value: 'z' }, 'X-Alpha': { value: 'a' } },
} satisfies McpServer;
`);
  await fs.writeFile(path.join(root, 'src/mcp/local-tools/mcp.ts'), `
import type { McpServer } from '@tokenroll/acplugin-extension-mcp';
export default { transport: 'stdio' } satisfies McpServer;
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
import antigravity from '@tokenroll/acplugin-platform-antigravity';
import claudeCode from '@tokenroll/acplugin-platform-claude-code';
import codex from '@tokenroll/acplugin-platform-codex';
import cursor from '@tokenroll/acplugin-platform-cursor';
import openCode from '@tokenroll/acplugin-platform-opencode';
import pi from '@tokenroll/acplugin-platform-pi';
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
  platforms: [claudeCode({ strict: false }), codex({ strict: false }), cursor({ strict: ${options.strictCursor === true ? 'true' : 'false'} }), antigravity({ strict: false }), openCode({ strict: false }), pi({ strict: ${options.strictPi === true ? 'true' : 'false'} })],
  extensions: [hooks(), mcp()],
  build: { strict: false },
};
`);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe('official Platform integration', () => {
  it('builds six final candidates with field-level compatibility and deterministic MCP bytes', async () => {
    /** 覆盖全部官方 Platform 和 Extension Contributor 的规范工程。 */
    const root = await createCompleteProject();
    /** 宽松模式允许矩阵明确声明的有限支持进入交付。 */
    const result = await runProject({ cwd: root, command: 'build', mode: 'production' });

    expect(result.success, JSON.stringify(result.diagnostics)).toBe(true);
    expect(result.packages.map(unit => `${unit.platform}/${unit.id}:${unit.type}`).sort()).toEqual([
      'antigravity/plugin:plugin',
      'claude-code/plugin:plugin',
      'codex/plugin:plugin',
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
    expect(openCodeConfig).toHaveProperty('mcp.docs.headers.Authorization', 'Bearer {env:DOCS_TOKEN}');
    expect(openCodeConfig).toHaveProperty('mcp.local-tools.type', 'local');
    expect(openCodeConfig).toHaveProperty('mcp.oauth-docs.oauth.scope', 'docs:read docs:write');
    await expect(fs.access(path.join(root, 'dist/opencode/workspace/.opencode/mcp.json'))).rejects.toThrow();
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
    /** Claude Code 与 Codex 分别使用各自官方 OAuth scope wire。 */
    const claudeMcp = JSON.parse(await fs.readFile(path.join(root, 'dist/claude-code/plugin/.mcp.json'), 'utf8'));
    /** Codex MCP 配置保留 scope 数组。 */
    const codexMcp = JSON.parse(await fs.readFile(path.join(root, 'dist/codex/plugin/.mcp.json'), 'utf8'));
    expect(claudeMcp).toHaveProperty('mcpServers.oauth-docs.oauth.scopes', 'docs:read docs:write');
    expect(codexMcp).toHaveProperty('oauth-docs.scopes', ['docs:read', 'docs:write']);
    /** Cursor 与 Antigravity 使用各自可在运行时求值的 Bearer Header wire。 */
    const cursorMcp = JSON.parse(await fs.readFile(path.join(root, 'dist/cursor/plugin/mcp.json'), 'utf8'));
    /** Antigravity MCP 配置保持独立根文件。 */
    const antigravityMcp = JSON.parse(await fs.readFile(path.join(root, 'dist/antigravity/plugin/mcp_config.json'), 'utf8'));
    expect(cursorMcp).toHaveProperty('mcpServers.docs.headers.Authorization', 'Bearer ${env:DOCS_TOKEN}');
    expect(antigravityMcp).toHaveProperty('mcpServers.docs.headers.Authorization', 'Bearer ${DOCS_TOKEN}');
    /** 四个平台针对三类 Component 实际提交的完整能力结论。 */
    const componentCompatibility = (platform: string): string[] => result.compatibility
      .filter(entry => entry.platform === platform && /^(?:command|skill|agent):/u.test(entry.subject))
      .map(entry => `${entry.subject}/${entry.capability}/${entry.level}`)
      .sort();
    expect(componentCompatibility('cursor')).toEqual([
      'agent:reviewer/agent.capabilities/degraded',
      'agent:reviewer/agent.model/degraded',
      'agent:reviewer/component/native',
      'command:release/argument-hint/degraded',
      'command:release/component/native',
      'skill:review/component/native',
      'skill:review/invocation.user/degraded',
    ].sort());
    expect(componentCompatibility('antigravity')).toEqual([
      'agent:reviewer/agent.capabilities/degraded',
      'agent:reviewer/agent.model/degraded',
      'agent:reviewer/component/degraded',
      'command:release/argument-hint/degraded',
      'command:release/arguments/transform',
      'command:release/component/transform',
      'skill:review/component/native',
      'skill:review/invocation/degraded',
    ].sort());
    expect(componentCompatibility('opencode')).toEqual([
      'agent:reviewer/agent.capabilities/transform',
      'agent:reviewer/agent.model/degraded',
      'agent:reviewer/component/native',
      'command:release/argument-hint/degraded',
      'command:release/component/native',
      'skill:review/component/native',
      'skill:review/invocation/degraded',
    ].sort());
    expect(componentCompatibility('pi')).toEqual([
      'agent:reviewer/agent.capabilities/degraded',
      'agent:reviewer/agent.model/degraded',
      'agent:reviewer/component/degraded',
      'command:release/argument-hint/native',
      'command:release/arguments/native',
      'command:release/component/transform',
      'skill:review/component/native',
      'skill:review/invocation/degraded',
    ].sort());
    expect(result.compatibility).toEqual(expect.arrayContaining([
      expect.objectContaining({ platform: 'cursor', subject: 'mcp:local-tools', level: 'unsupported' }),
      expect.objectContaining({ platform: 'antigravity', subject: 'command:release', level: 'transform' }),
      expect.objectContaining({ platform: 'opencode', subject: 'agent:reviewer', capability: 'agent.capabilities', level: 'transform' }),
      expect.objectContaining({ platform: 'pi', subject: 'mcp:docs', level: 'unsupported' }),
      expect.objectContaining({ platform: 'claude-code', subject: 'mcp:oauth-docs', capability: 'auth.oauth', level: 'native' }),
      expect.objectContaining({ platform: 'codex', subject: 'mcp:oauth-docs', capability: 'auth.oauth', level: 'native' }),
      expect.objectContaining({ platform: 'cursor', subject: 'mcp:oauth-docs', capability: 'auth.oauth', level: 'degraded' }),
      expect.objectContaining({ platform: 'antigravity', subject: 'mcp:oauth-docs', capability: 'auth.oauth', level: 'degraded' }),
      expect.objectContaining({ platform: 'opencode', subject: 'mcp:oauth-docs', capability: 'auth.oauth', level: 'native' }),
      expect.objectContaining({ platform: 'cursor', subject: 'mcp:docs', capability: 'auth.bearer', level: 'native' }),
      expect.objectContaining({ platform: 'antigravity', subject: 'mcp:docs', capability: 'auth.bearer', level: 'native' }),
      expect.objectContaining({ platform: 'opencode', subject: 'mcp:docs', capability: 'auth.bearer', level: 'native' }),
    ]));
    /** 第二轮相同输入必须产生完全相同的六平台候选字节。 */
    const firstSnapshot = await snapshotDirectory(path.join(root, 'dist'));
    /** repeated 是同一工程的第二次完整事务构建。 */
    const repeated = await runProject({ cwd: root, command: 'build', mode: 'production' });
    expect(repeated.success, JSON.stringify(repeated.diagnostics)).toBe(true);
    expect(await snapshotDirectory(path.join(root, 'dist'))).toEqual(firstSnapshot);
  });

  it('rejects scoped OAuth loss in strict mode without a capability waiver', async () => {
    /** strict Cursor 工程稍后裁剪为一个原生 Skill 和一个 scoped OAuth Server。 */
    const root = await createCompleteProject({ strictCursor: true });
    await fs.rm(path.join(root, 'src/commands'), { recursive: true, force: true });
    await fs.rm(path.join(root, 'src/agents'), { recursive: true, force: true });
    await fs.rm(path.join(root, 'src/hooks'), { recursive: true, force: true });
    await fs.rm(path.join(root, 'src/mcp/docs'), { recursive: true, force: true });
    await fs.rm(path.join(root, 'src/mcp/local-tools'), { recursive: true, force: true });
    await fs.writeFile(path.join(root, 'src/skills/review/SKILL.md'), `---
description: Review the current change.
---
Review the implementation.
`);
    /** scoped OAuth 是这个候选中唯一的 degraded capability。 */
    const result = await runProject({
      cwd: root,
      command: 'validate',
      mode: 'production',
      platforms: ['cursor'],
    });
    expect(result.success).toBe(false);
    expect(result.compatibility).toContainEqual(expect.objectContaining({
      platform: 'cursor', subject: 'mcp:oauth-docs', capability: 'auth.oauth', level: 'degraded',
    }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: 'COMPATIBILITY_STRICT_FAILURE', platform: 'cursor',
    }));
  });

  it('keeps strict Pi usable for Skills and Commands but rejects Agent fallback', async () => {
    /** 完整工程用于先确认 Agent fallback 的 strict 失败。 */
    const root = await createCompleteProject({ strictPi: true });
    /** Pi strictness 只对实际能力损失生效。 */
    const strictWithAgent = await runProject({
      cwd: root,
      command: 'validate',
      mode: 'production',
      platforms: ['pi'],
    });
    expect(strictWithAgent.success).toBe(false);
    expect(strictWithAgent.diagnostics).toContainEqual(expect.objectContaining({
      code: 'COMPATIBILITY_STRICT_FAILURE',
      platform: 'pi',
    }));

    /** 移除 Agent 后保留 MCP，证明 strict 会拒绝 unsupported MCP transport。 */
    await fs.rm(path.join(root, 'src/agents'), { recursive: true, force: true });
    await fs.rm(path.join(root, 'src/hooks/permission'), { recursive: true, force: true });
    await fs.writeFile(path.join(root, 'src/skills/review/SKILL.md'), `---
description: Review the current change.
---
Review the implementation.
`);
    /** strict MCP 失败必须指向 Pi 且报告真实 MCP compatibility。 */
    const strictWithMcp = await runProject({
      cwd: root,
      command: 'validate',
      mode: 'production',
      platforms: ['pi'],
    });
    expect(strictWithMcp.success).toBe(false);
    expect(strictWithMcp.compatibility).toContainEqual(expect.objectContaining({
      platform: 'pi', subject: 'mcp:docs', capability: 'transport.http', level: 'unsupported',
    }));
    /** 移除 MCP 后只剩 Pi 原生/transform 能力。 */
    await fs.rm(path.join(root, 'src/mcp'), { recursive: true, force: true });
    /** strict Skills/Commands/SessionStart 构建结果。 */
    const supported = await runProject({
      cwd: root,
      command: 'validate',
      mode: 'production',
      platforms: ['pi'],
    });
    expect(supported.success).toBe(true);
  });
});
