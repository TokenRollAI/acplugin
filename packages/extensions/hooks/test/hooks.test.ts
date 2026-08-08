import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BuildResult, RunProjectOptions } from '@tokenroll/acplugin';
import hooks, { HOOK_EVENTS } from '../src/index.js';

/** 当前测试文件所在仓库的绝对根目录。 */
const repositoryRoot = path.resolve(import.meta.dirname, '../../../..');

/** 测试描述文件通过临时包入口加载的 Hooks Extension 构建产物。 */
const extensionEntry = path.join(repositoryRoot, 'packages/extensions/hooks/dist/index.mjs');

/** 需要自定义 Platform 时由配置文件直接加载的主包构建产物。 */
const acpluginEntry = path.join(repositoryRoot, 'packages/acplugin/dist/index.mjs');

/** 当前测试创建并在 afterEach 中统一删除的临时工程。 */
const temporaryRoots: string[] = [];

/** 单个测试 Hook 的目录 ID 和 defineHook 参数源码。 */
interface HookFixture {
  /** `src/hooks/<id>` 使用的规范目录 ID。 */
  readonly id: string;
  /** defineHook 之前写入描述文件的可选额外 import。 */
  readonly imports?: string;
  /** 传入 defineHook 的 TypeScript 对象表达式。 */
  readonly definition: string;
}

/** 创建临时规范工程时使用的可选配置。 */
interface ProjectFixtureOptions {
  /** 当前工程需要写入的 Hook 作者资源。 */
  readonly hooks?: readonly HookFixture[];
  /** 添加到配置文件 import 区域的源码。 */
  readonly configImports?: string;
  /** 添加到顶层配置对象的字段源码。 */
  readonly configFields?: string;
  /** 是否提供一个带 LICENSE 的本地第三方依赖。 */
  readonly dependency?: boolean;
  /** 直接传入 `hooks(...)` 的可选 TypeScript 参数表达式。 */
  readonly hooksOptions?: string;
}

/** 子进程 Handler 的稳定退出状态和有限输出。 */
interface HandlerResult {
  /** Node 子进程退出码。 */
  readonly code: number | null;
  /** Handler 写入标准输出的完整文本。 */
  readonly stdout: string;
  /** Handler 写入标准错误的安全文本。 */
  readonly stderr: string;
}

/**
 * 在原生 Node ESM 子进程中运行公开 API，确保私有品牌只加载一个主包实例。
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
    diagnostics: error && typeof error === 'object' && 'diagnostics' in error ? error.diagnostics : [],
  }));
}
`;
  /** Node 子进程的退出状态与文本输出。 */
  const execution = await new Promise<HandlerResult>((resolve, reject) => {
    /** 不经过 Vitest 转换器的原生 ESM 子进程。 */
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
  /** 子进程返回的成功结果或安全异常摘要。 */
  const payload = JSON.parse(execution.stdout) as {
    readonly ok: boolean;
    readonly result?: BuildResult;
    readonly name?: string;
    readonly message?: string;
    readonly diagnostics?: unknown;
  };
  if (!payload.ok || payload.result === undefined)
    throw new Error(`${payload.name ?? 'Error'}: ${payload.message ?? 'Project execution failed.'}`);
  return payload.result;
}

/**
 * 在临时工程中创建可由 Jiti 和 Rolldown 共同解析的 Extension 包入口。
 *
 * @param root 临时工程根目录。
 */
async function writeExtensionProxy(root: string): Promise<void> {
  /** 临时 node_modules 中的 Hooks Extension 包目录。 */
  const packageRoot = path.join(root, 'node_modules/@tokenroll/acplugin-extension-hooks');
  await fs.mkdir(packageRoot, { recursive: true });
  await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
    name: '@tokenroll/acplugin-extension-hooks',
    version: '1.0.0',
    type: 'module',
    exports: './index.mjs',
  }));
  await fs.writeFile(
    path.join(packageRoot, 'index.mjs'),
    `export * from ${JSON.stringify(extensionEntry)}; export { default } from ${JSON.stringify(extensionEntry)};\n`,
  );
}

/**
 * 写入一个实际参与 Bundle 和第三方许可收集的本地 npm 依赖。
 *
 * @param root 临时工程根目录。
 */
async function writeLicensedDependency(root: string): Promise<void> {
  /** 临时 node_modules 中的第三方测试包目录。 */
  const packageRoot = path.join(root, 'node_modules/fixture-dependency');
  await fs.mkdir(packageRoot, { recursive: true });
  await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
    name: 'fixture-dependency',
    version: '2.3.4',
    type: 'module',
    exports: './index.js',
    license: 'MIT',
  }));
  await fs.writeFile(path.join(packageRoot, 'index.js'), 'export function dependencyMessage() { return "licensed dependency"; }\n');
  await fs.writeFile(path.join(packageRoot, 'LICENSE'), 'Fixture dependency license.\n');
}

/**
 * 创建带最小 Skill、配置和可选 Hooks 的真实临时工程。
 *
 * @param options Hook、Platform 字段和第三方依赖选项。
 * @returns 已登记清理的工程绝对路径。
 */
async function createProject(options: ProjectFixtureOptions = {}): Promise<string> {
  /** 当前测试独占的临时工程根目录。 */
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-hooks-test-'));
  temporaryRoots.push(root);
  await writeExtensionProxy(root);
  if (options.dependency === true)
    await writeLicensedDependency(root);
  await fs.mkdir(path.join(root, 'src/skills/hello'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'src/skills/hello/SKILL.md'),
    '---\ndescription: Say hello.\n---\nSay hello to the user.\n',
  );
  for (const hook of options.hooks ?? []) {
    /** 当前 Hook 的规范一级目录。 */
    const directory = path.join(root, 'src/hooks', hook.id);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(
      path.join(directory, 'hook.ts'),
      `import { defineHook } from '@tokenroll/acplugin-extension-hooks';\n${hook.imports ?? ''}\nexport default defineHook(${hook.definition});\n`,
    );
  }
  await fs.writeFile(path.join(root, 'acplugin.config.ts'), `
import hooks from '@tokenroll/acplugin-extension-hooks';
${options.configImports ?? ''}
export default {
  name: 'hooks-fixture',
  version: '1.0.0',
  description: 'Hooks integration fixture.',
  extensions: [hooks(${options.hooksOptions ?? ''})],
  ${options.configFields ?? 'build: { strict: false },'}
};
`);
  return root;
}

/**
 * 执行最终 Bundle Handler，并完整收集测试所需的 stdout 和 stderr。
 *
 * @param handler Handler Bundle 绝对路径。
 * @param platform Adapter 固定传入的 Platform ID。
 * @param input 写入 stdin 的原始字符串。
 * @param environment 可选的 Plugin Root 和 Plugin Data 环境变量。
 * @returns 子进程退出结果。
 */
async function runHandler(
  handler: string,
  platform: string,
  input: string,
  environment: Readonly<Record<string, string>> = {},
): Promise<HandlerResult> {
  return new Promise((resolve, reject) => {
    /** 使用当前 Node 执行实际安装产物的子进程。 */
    const child = spawn(process.execPath, [handler, platform], {
      env: { ...process.env, ...environment },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    /** 子进程累计的标准输出文本。 */
    let stdout = '';
    /** 子进程累计的标准错误文本。 */
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
    child.stdin.end(input);
  });
}

/**
 * 创建覆盖 11 个规范事件、输入规范化和安全输出边界的 Hook fixtures。
 *
 * @returns 按事件声明顺序排列的作者资源。
 */
function canonicalHooks(): readonly HookFixture[] {
  return HOOK_EVENTS.map((event): HookFixture => {
    if (event === 'PreToolUse') {
      return {
        id: 'pre-tool-use',
        imports: `import { dependencyMessage } from 'fixture-dependency';`,
        definition: `{
          event: 'PreToolUse',
          matcher: 'Bash',
          timeout: 5,
          platforms: { codex: { additionalContextLimit: 1200 } },
          run(input, context) {
            const toolInput = input.toolInput as { nestedValue: string };
            dependencyMessage();
            if (toolInput.nestedValue === 'invalid-json')
              return { decision: 'allow', updatedInput: { nested: { secret: BigInt(1) } } };
            if (toolInput.nestedValue === 'context')
              return { decision: 'deny', reason: [context.platform, context.pluginRoot, context.pluginData].join(':') };
            return { decision: 'deny', reason: context.platform + ':' + input.toolName + ':' + toolInput.nestedValue };
          },
        }`,
      };
    }
    if (event === 'SessionEnd') {
      return {
        id: 'session-end',
        imports: `import { readFile } from 'node:fs';`,
        definition: `{
          event: 'SessionEnd',
          run(input) {
            if (input.reason === 'oversized') return { systemMessage: 'x'.repeat(1024 * 1024) };
            if (input.reason.startsWith('log:')) process.stdout.write(input.reason.slice(4));
            if (input.reason.startsWith('throw:')) throw new Error(input.reason.slice(6));
            if (input.reason === 'delayed-log') setTimeout(() => process.stdout.write('DELAYED_SECRET'), 0);
            if (input.reason === 'delayed-throw') setTimeout(() => { throw new Error('DELAYED_SECRET'); }, 0);
            if (input.reason === 'delayed-rejection') setTimeout(() => Promise.reject(new Error('DELAYED_SECRET')), 0);
            if (input.reason === 'multiple-async-failures') {
              setTimeout(() => { throw new Error('FIRST_SECRET'); }, 0);
              setTimeout(() => { throw new Error('SECOND_SECRET'); }, 5);
            }
            if (input.reason === 'late-before-exit')
              process.once('beforeExit', () => { throw new Error('BEFORE_EXIT_SECRET'); });
            if (input.reason === 'late-before-exit-io')
              process.once('beforeExit', () => {
                readFile(new URL(import.meta.url), () => { throw new Error('BEFORE_EXIT_IO_SECRET'); });
              });
          },
        }`,
      };
    }
    if (event === 'Stop') {
      return {
        id: 'stop',
        definition: `{ event: 'Stop', matcher: 'quality-gate', run() { return { decision: 'finish' }; } }`,
      };
    }
    if (event === 'PreCompact' || event === 'PostCompact') {
      /** 两个压缩事件共同验证通用 continue/stop wire 语义。 */
      const id = event === 'PreCompact' ? 'pre-compact' : 'post-compact';
      return {
        id,
        definition: `{ event: ${JSON.stringify(event)}, run() { return { decision: 'stop', reason: 'Compact later.' }; } }`,
      };
    }
    /** 其他规范事件只需证明发现、Bundle、Adapter 和兼容性闭环。 */
    const id = event.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
    return { id, definition: `{ event: ${JSON.stringify(event)}, run() {} }` };
  });
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe('Hooks Extension', () => {
  it('filters discovered resources with include and rejects invalid factory options', async () => {
    /** 只选择 keep、忽略 skip 的真实作者工程。 */
    const root = await createProject({
      hooks: [
        { id: 'keep', definition: `{ event: 'SessionStart', run() {} }` },
        { id: 'skip', definition: `{ event: 'Stop', run() {} }` },
      ],
      hooksOptions: `{ include: ['keep'] }`,
    });
    /** include 筛选后的双 Platform 构建结果。 */
    const result = await runProject({ cwd: root, command: 'build', mode: 'production' });

    expect(result.success).toBe(true);
    expect((await fs.readdir(path.join(root, 'dist/claude-code/plugin/hooks'))).sort()).toEqual(['hooks.json', 'keep']);
    await expect(fs.access(path.join(root, 'dist/codex/plugin/hooks/skip/handler.mjs'))).rejects.toThrow();
    expect(() => hooks({ include: ['valid', 'valid'] })).toThrow('duplicate ID');
    expect(() => hooks({ include: ['Not-Kebab'] })).toThrow('lowercase kebab-case');
    expect(() => hooks({ unknown: true } as never)).toThrow('Unknown Hooks option');
  });

  it('reports missing includes and platform-specific SessionEnd timeout limits', async () => {
    /** 同时覆盖缺失 include 和 Codex 三秒上限的工程。 */
    const missingRoot = await createProject({
      hooks: [{ id: 'session-end', definition: `{ event: 'SessionEnd', timeout: 4, platforms: { 'claude-code': { timeout: 60 } }, run() {} }` }],
      hooksOptions: `{ include: ['session-end', 'missing'] }`,
    });
    /** discover 与 validate 阶段应分别提交目标明确的诊断。 */
    const missing = await runProject({ cwd: missingRoot, command: 'validate', mode: 'production' });
    expect(missing.success).toBe(false);
    expect(missing.diagnostics).toContainEqual(expect.objectContaining({ code: 'HOOK_INCLUDE_MISSING' }));
    expect(missing.diagnostics).toContainEqual(expect.objectContaining({ code: 'HOOK_TIMEOUT_PLATFORM_LIMIT' }));

    /** Codex 使用三秒，而 Claude Code 单独超过六十秒上限的工程。 */
    const claudeRoot = await createProject({
      hooks: [{ id: 'session-end', definition: `{ event: 'SessionEnd', timeout: 3, platforms: { 'claude-code': { timeout: 61 } }, run() {} }` }],
    });
    /** Claude Code 上限必须独立于 Codex 默认值验证。 */
    const claude = await runProject({ cwd: claudeRoot, command: 'validate', mode: 'production' });
    expect(claude.success).toBe(false);
    expect(claude.diagnostics).toContainEqual(expect.objectContaining({ code: 'HOOK_TIMEOUT_PLATFORM_LIMIT' }));
  });

  it('builds all canonical events once and adapts them to Claude Code and Codex', async () => {
    /** 覆盖完整事件矩阵和本地第三方依赖的真实工程。 */
    const root = await createProject({ hooks: canonicalHooks(), dependency: true });
    /** 完整提交双 Platform 产物的构建结果。 */
    const result = await runProject({ cwd: root, command: 'build', mode: 'production' });

    expect(result.success).toBe(true);
    /** event 表示当前规范事件，用于验证两个 Adapter 都报告原生触发能力。 */
    for (const event of HOOK_EVENTS) {
      expect(result.compatibility).toContainEqual(expect.objectContaining({
        platform: 'claude-code',
        capability: `event.${event}`,
        level: 'native',
      }));
      expect(result.compatibility).toContainEqual(expect.objectContaining({
        platform: 'codex',
        capability: `event.${event}`,
        level: 'native',
      }));
    }
    expect(result.compatibility).toContainEqual(expect.objectContaining({
      platform: 'codex',
      subject: 'hook:stop',
      capability: 'matcher',
      level: 'degraded',
    }));

    /** Claude Code 最终 Plugin Manifest。 */
    const claudeManifest = JSON.parse(await fs.readFile(
      path.join(root, 'dist/claude-code/plugin/.claude-plugin/plugin.json'),
      'utf8',
    )) as Record<string, unknown>;
    /** Codex 最终 Plugin Manifest。 */
    const codexManifest = JSON.parse(await fs.readFile(
      path.join(root, 'dist/codex/plugin/.codex-plugin/plugin.json'),
      'utf8',
    )) as Record<string, unknown>;
    expect(claudeManifest.hooks).toBe('./hooks/hooks.json');
    expect(codexManifest.hooks).toBe('./hooks/hooks.json');

    /** Claude Code Adapter 生成的 Hook 配置。 */
    const claudeHooks = JSON.parse(await fs.readFile(
      path.join(root, 'dist/claude-code/plugin/hooks/hooks.json'),
      'utf8',
    )) as { hooks: Record<string, { hooks: Record<string, unknown>[] }[]> };
    /** Codex Adapter 生成的 Hook 配置。 */
    const codexHooks = JSON.parse(await fs.readFile(
      path.join(root, 'dist/codex/plugin/hooks/hooks.json'),
      'utf8',
    )) as { hooks: Record<string, { hooks: Record<string, unknown>[] }[]> };
    expect(Object.keys(claudeHooks.hooks).sort()).toEqual([...HOOK_EVENTS].sort());
    expect(Object.keys(codexHooks.hooks).sort()).toEqual([...HOOK_EVENTS].sort());
    expect(claudeHooks.hooks.PreToolUse![0]!.hooks[0]).toMatchObject({
      type: 'command',
      command: 'node',
      args: ['${CLAUDE_PLUGIN_ROOT}/hooks/pre-tool-use/handler.mjs', 'claude-code'],
      timeout: 5,
    });
    expect(codexHooks.hooks.PreToolUse![0]!.hooks[0]).toMatchObject({
      type: 'command',
      command: 'node "${PLUGIN_ROOT}/hooks/pre-tool-use/handler.mjs" codex',
      timeout: 5,
      additionalContextLimit: 1200,
    });
    expect(codexHooks.hooks.PreToolUse![0]!.hooks[0]).not.toHaveProperty('args');

    /** 两个平台复用同一平台中立 Handler 的 Claude Code 文件。 */
    const claudeHandler = path.join(root, 'dist/claude-code/plugin/hooks/pre-tool-use/handler.mjs');
    /** 两个平台复用同一平台中立 Handler 的 Codex 文件。 */
    const codexHandler = path.join(root, 'dist/codex/plugin/hooks/pre-tool-use/handler.mjs');
    expect(await fs.readFile(claudeHandler)).toEqual(await fs.readFile(codexHandler));
    /** Claude Code Adapter 独立贡献的原生协议 profile。 */
    const claudeWire = await fs.readFile(path.join(root, 'dist/claude-code/plugin/hooks/pre-tool-use/wire.mjs'), 'utf8');
    /** Codex Adapter 独立贡献的原生协议 profile。 */
    const codexWire = await fs.readFile(path.join(root, 'dist/codex/plugin/hooks/pre-tool-use/wire.mjs'), 'utf8');
    expect(claudeWire).toContain('export const platform = "claude-code"');
    expect(codexWire).toContain('export const platform = "codex"');
    expect(claudeWire).not.toBe(codexWire);
    expect(await fs.readFile(
      path.join(root, 'dist/claude-code/plugin/hooks/pre-tool-use/THIRD_PARTY_LICENSES.txt'),
      'utf8',
    )).toContain('fixture-dependency@2.3.4');
  });

  it('normalizes input, maps results, bounds I/O, and never exposes handler failures', async () => {
    /** 复用完整事件 fixture 取得真实构建后的 Handler。 */
    const root = await createProject({ hooks: canonicalHooks(), dependency: true });
    /** 生成两个默认 Platform Handler 的构建结果。 */
    const build = await runProject({ cwd: root, command: 'build', mode: 'production' });
    expect(build.success).toBe(true);
    /** 用于验证 camelCase 和 PreToolUse deny 映射的 Handler。 */
    const preToolHandler = path.join(root, 'dist/claude-code/plugin/hooks/pre-tool-use/handler.mjs');
    /** 平台发送给 Handler 的规范 snake_case 输入。 */
    const preToolInput = JSON.stringify({
      session_id: 'session-1',
      transcript_path: null,
      cwd: root,
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { nested_value: 'normalized' },
      tool_use_id: 'tool-1',
    });
    /** Claude Code 参数下的真实 Runner 输出。 */
    const claude = await runHandler(preToolHandler, 'claude-code', preToolInput, {
      CLAUDE_PLUGIN_ROOT: '/plugin-root',
      CLAUDE_PLUGIN_DATA: '/plugin-data',
    });
    expect(claude.code).toBe(0);
    expect(JSON.parse(claude.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'claude-code:Bash:normalized',
      },
    });
    expect(claude.stderr).toBe('');

    /** 两个 wire profile 必须各自解析平台原生的 Plugin 根和数据目录。 */
    const contextInput = JSON.stringify({
      session_id: 'session-1',
      cwd: root,
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { nested_value: 'context' },
      tool_use_id: 'tool-2',
    });
    /** Claude Code wire 的运行时上下文结果。 */
    const claudeContext = await runHandler(preToolHandler, 'claude-code', contextInput, {
      CLAUDE_PLUGIN_ROOT: '/claude-root',
      CLAUDE_PLUGIN_DATA: '/claude-data',
    });
    /** Codex wire 的运行时上下文结果。 */
    const codexContext = await runHandler(
      path.join(root, 'dist/codex/plugin/hooks/pre-tool-use/handler.mjs'),
      'codex',
      contextInput,
      { PLUGIN_ROOT: '/codex-root', PLUGIN_DATA: '/codex-data' },
    );
    expect(JSON.parse(claudeContext.stdout).hookSpecificOutput.permissionDecisionReason)
      .toBe('claude-code:/claude-root:/claude-data');
    expect(JSON.parse(codexContext.stdout).hookSpecificOutput.permissionDecisionReason)
      .toBe('codex:/codex-root:/codex-data');

    /** SessionEnd Handler 用于触发三种安全失败边界。 */
    const sessionEndHandler = path.join(root, 'dist/claude-code/plugin/hooks/session-end/handler.mjs');
    /** Codex 目录中与 Codex wire profile 相邻的 SessionEnd Handler。 */
    const codexSessionEndHandler = path.join(root, 'dist/codex/plugin/hooks/session-end/handler.mjs');
    /** 生成 SessionEnd 输入的局部辅助函数。 */
    const sessionEndInput = (reason: string): string => JSON.stringify({
      session_id: 'session-1',
      transcript_path: null,
      cwd: root,
      hook_event_name: 'SessionEnd',
      reason,
    });
    /** 超出一 MiB 的规范结果必须被 Runner 阻止。 */
    const oversized = await runHandler(sessionEndHandler, 'claude-code', sessionEndInput('oversized'));
    expect(oversized).toEqual({
      code: 1,
      stdout: '',
      stderr: 'acplugin hook error: OUTPUT_TOO_LARGE\n',
    });
    /** 用户实现直接写 stdout 时不得绕过规范结果协议或泄露内容。 */
    const logged = await runHandler(sessionEndHandler, 'claude-code', sessionEndInput('log:TOP_SECRET'));
    expect(logged).toEqual({
      code: 1,
      stdout: '',
      stderr: 'acplugin hook error: HANDLER_OUTPUT_FORBIDDEN\n',
    });
    expect(logged.stderr).not.toContain('TOP_SECRET');
    /** 用户异常消息只能收敛为稳定安全代码。 */
    const thrown = await runHandler(codexSessionEndHandler, 'codex', sessionEndInput('throw:TOP_SECRET'));
    expect(thrown).toEqual({
      code: 1,
      stdout: '',
      stderr: 'acplugin hook error: HANDLER_FAILED\n',
    });
    /** 超过输入上限时在 JSON 解析前返回固定错误。 */
    const tooLarge = await runHandler(codexSessionEndHandler, 'codex', `{"value":"${'x'.repeat(1024 * 1024)}"}`);
    expect(tooLarge).toEqual({
      code: 1,
      stdout: '',
      stderr: 'acplugin hook error: INPUT_TOO_LARGE\n',
    });
    /** Codex 目录中与 Codex wire profile 相邻的 PreToolUse Handler。 */
    const codexPreToolHandler = path.join(root, 'dist/codex/plugin/hooks/pre-tool-use/handler.mjs');
    /** 同一对象中的 snake_case/camelCase 字段碰撞不得静默覆盖。 */
    const collision = await runHandler(codexPreToolHandler, 'codex', JSON.stringify({
      session_id: 'session-1',
      cwd: root,
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { nested_value: 'first', nestedValue: 'second' },
      tool_use_id: 'tool-1',
    }));
    expect(collision).toEqual({
      code: 1,
      stdout: '',
      stderr: 'acplugin hook error: INPUT_KEY_COLLISION\n',
    });
    /** 构造超过递归规范化上限、但仍远小于字节上限的输入字段。 */
    let nestedInput: unknown = 'leaf';
    /** depth 表示当前追加的对象嵌套层数。 */
    for (let depth = 0; depth < 130; depth += 1)
      nestedInput = { value: nestedInput };
    /** 过深输入必须使用稳定错误码终止，不能触发运行时栈错误。 */
    const tooDeep = await runHandler(codexPreToolHandler, 'codex', JSON.stringify({
      session_id: 'session-1',
      cwd: root,
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: nestedInput,
      tool_use_id: 'tool-1',
    }));
    expect(tooDeep).toEqual({
      code: 1,
      stdout: '',
      stderr: 'acplugin hook error: INPUT_TOO_DEEP\n',
    });

    /** updatedInput 的嵌套 BigInt 不是 JSON 值，必须在 wire 序列化前拒绝。 */
    const invalidUpdatedInput = await runHandler(codexPreToolHandler, 'codex', JSON.stringify({
      session_id: 'session-1',
      cwd: root,
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { nested_value: 'invalid-json' },
      tool_use_id: 'tool-1',
    }));
    expect(invalidUpdatedInput).toEqual({
      code: 1,
      stdout: '',
      stderr: 'acplugin hook error: RESULT_UPDATED_INPUT_INVALID\n',
    });

    /** 未等待任务中的输出仍在进程退出前被拦截，且不会泄露原文。 */
    const delayedLog = await runHandler(sessionEndHandler, 'claude-code', sessionEndInput('delayed-log'));
    expect(delayedLog).toEqual({
      code: 1,
      stdout: '',
      stderr: 'acplugin hook error: HANDLER_OUTPUT_FORBIDDEN\n',
    });
    expect(delayedLog.stderr).not.toContain('DELAYED_SECRET');
    /** 未等待 timer 抛错和拒绝统一收敛为异步失败码。 */
    for (const reason of ['delayed-throw', 'delayed-rejection']) {
      /** 当前异步失败形式的隔离执行结果。 */
      const delayedFailure = await runHandler(sessionEndHandler, 'claude-code', sessionEndInput(reason));
      expect(delayedFailure).toEqual({
        code: 1,
        stdout: '',
        stderr: 'acplugin hook error: HANDLER_ASYNC_FAILED\n',
      });
      expect(delayedFailure.stderr).not.toContain('DELAYED_SECRET');
    }
    /** 多个未等待异常以及 beforeExit 启动的同步或 I/O 异常都必须保持在安全监听边界内。 */
    for (const reason of ['multiple-async-failures', 'late-before-exit', 'late-before-exit-io']) {
      /** 当前复杂异步失败形式的隔离执行结果。 */
      const complexFailure = await runHandler(sessionEndHandler, 'claude-code', sessionEndInput(reason));
      expect(complexFailure).toEqual({
        code: 1,
        stdout: '',
        stderr: 'acplugin hook error: HANDLER_ASYNC_FAILED\n',
      });
      expect(complexFailure.stderr).not.toMatch(/FIRST_SECRET|SECOND_SECRET|BEFORE_EXIT_(?:IO_)?SECRET/u);
    }

    /** 两个压缩事件都必须通过各自 Platform 的完整 Handler/wire 组合。 */
    for (const [event, id] of [['PreCompact', 'pre-compact'], ['PostCompact', 'post-compact']] as const) {
      /** 当前压缩事件的原生输入。 */
      const compactInput = JSON.stringify({
        session_id: 'session-1',
        transcript_path: null,
        cwd: root,
        hook_event_name: event,
        trigger: 'manual',
      });
      /** Claude Code 目录中的完整运行结果。 */
      const claudeCompact = await runHandler(
        path.join(root, `dist/claude-code/plugin/hooks/${id}/handler.mjs`),
        'claude-code',
        compactInput,
      );
      /** Codex 目录中的完整运行结果。 */
      const codexCompact = await runHandler(
        path.join(root, `dist/codex/plugin/hooks/${id}/handler.mjs`),
        'codex',
        compactInput,
      );
      expect(JSON.parse(claudeCompact.stdout)).toEqual(event === 'PreCompact'
        ? { decision: 'block', reason: 'Compact later.' }
        : { continue: false, stopReason: 'Compact later.' });
      expect(JSON.parse(codexCompact.stdout)).toEqual({ continue: false, stopReason: 'Compact later.' });
    }
  });

  it('rejects raw platform handler declarations and invalid adapter fields before bundling', async () => {
    /** 同时尝试六类禁止入口和一个未知平台字段的恶意作者工程。 */
    const root = await createProject({
      hooks: [{
        id: 'unsafe',
        definition: `{
          event: 'PreToolUse',
          type: 'http',
          command: 'rm -rf /',
          executable: '/usr/bin/node',
          url: 'https://example.com/hook',
          prompt: 'approve',
          agent: 'reviewer',
          server: 'mcp-server',
          tool: 'check',
          platforms: { codex: { command: 'node unsafe.js' } },
          run() {},
        }`,
      }],
    });
    /** validate 在 Extension build 前收集的结构化失败结果。 */
    const result = await runProject({ cwd: root, command: 'validate', mode: 'production' });

    expect(result.success).toBe(false);
    expect(result.deliveryUnits).toEqual([]);
    expect(result.diagnostics.filter(diagnostic => diagnostic.code === 'HOOK_FIELD_UNKNOWN')).toHaveLength(8);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: 'HOOK_PLATFORM_FIELD_UNKNOWN',
    }));
  });

  it('routes platform-only events exclusively to their declared configured Adapter', async () => {
    /** Claude Code Setup 平台事件仍同时配置默认双 Platform 的工程。 */
    const root = await createProject({
      hooks: [{
        id: 'setup',
        definition: `{ event: { platform: 'claude-code', name: 'Setup' }, matcher: 'init', run() {} }`,
      }],
    });
    /** 平台事件成功构建后的兼容性和 Artifact 结果。 */
    const result = await runProject({ cwd: root, command: 'build', mode: 'production' });

    expect(result.success).toBe(true);
    expect(result.compatibility).toContainEqual(expect.objectContaining({
      platform: 'claude-code',
      subject: 'hook:setup',
      capability: 'event.Setup',
      level: 'native',
    }));
    expect(result.compatibility).not.toContainEqual(expect.objectContaining({
      platform: 'codex',
      subject: 'hook:setup',
    }));
    await expect(fs.access(path.join(root, 'dist/codex/plugin/hooks/hooks.json'))).rejects.toThrow();
    /** Codex Manifest 不应因其他平台事件获得空 hooks 字段。 */
    const codexManifest = JSON.parse(await fs.readFile(
      path.join(root, 'dist/codex/plugin/.codex-plugin/plugin.json'),
      'utf8',
    )) as Record<string, unknown>;
    expect(codexManifest).not.toHaveProperty('hooks');
  });

  it('keeps an empty Extension artifact-free and uses the Cursor Adapter when selected', async () => {
    /** 没有 `src/hooks` 的空 Extension 工程。 */
    const emptyRoot = await createProject();
    /** 空 Extension 的成功构建结果。 */
    const empty = await runProject({ cwd: emptyRoot, command: 'build', mode: 'production' });
    expect(empty.success).toBe(true);
    expect(empty.deliveryUnits
      .flatMap(unit => unit.artifacts)
      .some(artifact => artifact.path.startsWith('hooks/'))).toBe(false);

    /** 只配置 Cursor、且拥有实际 Hook 资源的工程。 */
    const cursorRoot = await createProject({
      hooks: [{ id: 'stop', definition: `{ event: 'Stop', run() {} }` }],
      configImports: `import { cursor } from ${JSON.stringify(acpluginEntry)};`,
      configFields: 'platforms: [cursor({ strict: false })], build: { strict: false },',
    });
    /** relaxed 模式使用 Cursor 事件映射并保留 transform 结论。 */
    const cursorResult = await runProject({ cwd: cursorRoot, command: 'validate', mode: 'production' });
    expect(cursorResult.success).toBe(true);
    expect(cursorResult.compatibility).toContainEqual(expect.objectContaining({
      platform: 'cursor',
      subject: 'hook:stop',
      level: 'transform',
    }));
  });

  it('applies strictness only when an actual Codex matcher loses semantics', async () => {
    /** Stop 使用有语义 matcher 的严格构建工程。 */
    const root = await createProject({
      hooks: [{ id: 'stop', definition: `{ event: 'Stop', matcher: 'quality-gate', run() {} }` }],
      configFields: 'build: { strict: true },',
    });
    /** strict 模式因当前 Hook 的 Codex matcher 损失而失败。 */
    const strict = await runProject({ cwd: root, command: 'validate', mode: 'production' });
    expect(strict.success).toBe(false);
    expect(strict.diagnostics).toContainEqual(expect.objectContaining({
      code: 'COMPATIBILITY_STRICT',
      platform: 'codex',
    }));
    /** 运行时覆盖 relaxed 后保留 degraded 结论并成功。 */
    const relaxed = await runProject({
      cwd: root,
      command: 'validate',
      mode: 'production',
      strict: false,
    });
    expect(relaxed.success).toBe(true);
    expect(relaxed.compatibility).toContainEqual(expect.objectContaining({
      platform: 'codex',
      subject: 'hook:stop',
      capability: 'matcher',
      level: 'degraded',
    }));
  });

  it('reports Claude Code events that silently ignore meaningful matchers', async () => {
    /** 只配置 Claude Code，避免其他 Platform 的兼容性结论干扰断言。 */
    const root = await createProject({
      hooks: [{ id: 'stop', definition: `{ event: 'Stop', matcher: 'quality-gate', run() {} }` }],
      configImports: `import { claudeCode } from ${JSON.stringify(acpluginEntry)};`,
      configFields: 'platforms: [claudeCode()], build: { strict: true },',
    });
    /** meaningful matcher 被宿主静默忽略，因此严格模式必须失败。 */
    const strict = await runProject({ cwd: root, command: 'validate', mode: 'production' });
    expect(strict.success).toBe(false);
    expect(strict.diagnostics).toContainEqual(expect.objectContaining({
      code: 'COMPATIBILITY_STRICT',
      platform: 'claude-code',
    }));
    /** relaxed 模式保留精确 degraded 报告，并允许用户显式接受损失。 */
    const relaxed = await runProject({
      cwd: root,
      command: 'validate',
      mode: 'production',
      strict: false,
    });
    expect(relaxed.success).toBe(true);
    expect(relaxed.compatibility).toContainEqual(expect.objectContaining({
      platform: 'claude-code',
      subject: 'hook:stop',
      capability: 'matcher',
      level: 'degraded',
    }));
  });

  it('rejects unconfigured and unknown platform-only events with targeted diagnostics', async () => {
    /** 只配置 Codex 却声明 Claude Code Setup 的工程。 */
    const unconfiguredRoot = await createProject({
      hooks: [{
        id: 'setup',
        definition: `{ event: { platform: 'claude-code', name: 'Setup' }, run() {} }`,
      }],
      configImports: `import { codex } from ${JSON.stringify(acpluginEntry)};`,
      configFields: 'platforms: [codex({ strict: false })], build: { strict: false },',
    });
    /** Platform 缺失应在 Bundle 前失败。 */
    const unconfigured = await runProject({ cwd: unconfiguredRoot, command: 'validate', mode: 'production' });
    expect(unconfigured.diagnostics).toContainEqual(expect.objectContaining({ code: 'HOOK_PLATFORM_NOT_CONFIGURED' }));

    /** 默认包含 Claude Code、但事件名不属于其官方 Schema 的工程。 */
    const unknownRoot = await createProject({
      hooks: [{
        id: 'unknown-event',
        definition: `{ event: { platform: 'claude-code', name: 'ImaginaryEvent' }, run() {} }`,
      }],
    });
    /** Adapter 未知事件应给出独立诊断码。 */
    const unknown = await runProject({ cwd: unknownRoot, command: 'validate', mode: 'production' });
    expect(unknown.diagnostics).toContainEqual(expect.objectContaining({ code: 'HOOK_PLATFORM_EVENT_UNSUPPORTED' }));
  });
});
