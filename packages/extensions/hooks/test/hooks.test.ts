import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BuildReport, RunProjectOptions } from '@tokenroll/acplugin';
import hooks, { HOOK_EVENTS } from '../src/index.js';

/** 当前测试文件所在仓库的绝对根目录。 */
const repositoryRoot = path.resolve(import.meta.dirname, '../../../..');

/** 测试描述文件通过临时包入口加载的 Hooks Extension 构建产物。 */
const extensionEntry = path.join(repositoryRoot, 'packages/extensions/hooks/dist/index.mjs');

/** 需要自定义 Platform 时由配置文件直接加载的主包构建产物。 */
const acpluginEntry = path.join(repositoryRoot, 'packages/acplugin/dist/index.mjs');

/** 配置覆盖使用的三个独立 Platform 真实构建入口。 */
const claudeCodeEntry = path.join(repositoryRoot, 'packages/platforms/claude-code/dist/index.mjs');
/** Hook 测试自定义配置使用的 Codex Platform 构建入口。 */
const codexEntry = path.join(repositoryRoot, 'packages/platforms/codex/dist/index.mjs');
/** Hook 测试自定义配置使用的 Cursor Platform 构建入口。 */
const cursorEntry = path.join(repositoryRoot, 'packages/platforms/cursor/dist/index.mjs');

/** 当前测试创建并在 afterEach 中统一删除的临时工程。 */
const temporaryRoots: string[] = [];

/** 单个测试 Hook 的目录 ID 和 plain descriptor 源码。 */
interface HookFixture {
  /** `src/hooks/<id>` 使用的规范目录 ID。 */
  readonly id: string;
  /** descriptor 之前写入的可选额外 import。 */
  readonly imports?: string;
  /** 默认导出的 TypeScript 对象表达式。 */
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
 * 在原生 Node ESM 子进程中运行公开 API，确保共享 registry brand 只绑定一个主包实例。
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
    readonly result?: BuildReport;
    readonly name?: string;
    readonly message?: string;
    readonly diagnostics?: unknown;
  };
  if (!payload.ok || payload.result === undefined)
    throw new Error(`${payload.name ?? 'Error'}: ${payload.message ?? 'Project execution failed.'} ${JSON.stringify(payload.diagnostics ?? [])} STDERR=${execution.stderr}`);
  return payload.result;
}

/**
 * 在临时工程中创建可由统一 Module Service 和 Rolldown 共同解析的 Extension 包入口。
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
  /** Hooks 构建产物按包名导入公开 SDK，这里提供与打包安装相同的代理入口。 */
  const acpluginRoot = path.join(root, 'node_modules/@tokenroll/acplugin');
  await fs.mkdir(acpluginRoot, { recursive: true });
  await fs.writeFile(path.join(acpluginRoot, 'package.json'), JSON.stringify({
    name: '@tokenroll/acplugin',
    version: '1.0.0',
    type: 'module',
    exports: { '.': './index.mjs', './sdk': './sdk.mjs' },
  }));
  await fs.writeFile(path.join(acpluginRoot, 'index.mjs'), `export * from ${JSON.stringify(acpluginEntry)};\n`);
  await fs.writeFile(path.join(acpluginRoot, 'sdk.mjs'), `export * from ${JSON.stringify(path.join(repositoryRoot, 'packages/acplugin/dist/sdk.mjs'))};\n`);
  /** Platform package proxies keep config imports inside the fixture's package graph. */
  for (const [name, entry] of [
    ['@tokenroll/acplugin-platform-claude-code', claudeCodeEntry],
    ['@tokenroll/acplugin-platform-codex', codexEntry],
    ['@tokenroll/acplugin-platform-cursor', cursorEntry],
  ] as const) {
    /** 当前代理包的物理根目录。 */
    const platformRoot = path.join(root, 'node_modules', name);
    await fs.mkdir(platformRoot, { recursive: true });
    await fs.writeFile(path.join(platformRoot, 'package.json'), JSON.stringify({
      name,
      version: '1.0.0',
      type: 'module',
      exports: './index.mjs',
    }));
    await fs.writeFile(path.join(platformRoot, 'index.mjs'), `export * from ${JSON.stringify(entry)}; export { default } from ${JSON.stringify(entry)};\n`);
  }
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
      `import type { Hook } from '@tokenroll/acplugin-extension-hooks';\n${hook.imports ?? ''}\nexport default ${hook.definition} satisfies Hook;\n`,
    );
  }
  await fs.writeFile(path.join(root, 'acplugin.config.ts'), `
import hooks from '@tokenroll/acplugin-extension-hooks';
${options.configImports ?? `import claudeCode from '@tokenroll/acplugin-platform-claude-code';
import codex from '@tokenroll/acplugin-platform-codex';`}
export default {
  name: 'hooks-fixture',
  version: '1.0.0',
  description: 'Hooks integration fixture.',
  extensions: [hooks(${options.hooksOptions ?? ''})],
  ${options.configFields ?? 'platforms: [claudeCode(), codex()], build: { strict: false },'}
};
`);
  return root;
}

/**
 * 执行最终 Bundle Handler，并完整收集测试所需的 stdout 和 stderr。
 *
 * @param handler Handler Bundle 绝对路径。
 * @param platform Contributor 固定传入的 Platform ID。
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
    /** 其他规范事件只需证明发现、Bundle、Contributor 和兼容性闭环。 */
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

  it('rejects non-enumerable descriptor accessors without evaluating them', async () => {
    /** 不可枚举 getter 也属于可执行描述行为，不能靠 Object.keys 隐藏。 */
    const root = await createProject({
      hooks: [{
        id: 'accessor',
        definition: `(() => {
          const value = { event: 'SessionStart', run() {} };
          Object.defineProperty(value, 'hidden', { get() { throw new Error('MUST_NOT_RUN'); } });
          return value;
        })() as never`,
      }],
    });
    /** discover 只报告脱敏加载失败，不执行或泄漏 getter 内容。 */
    const result = await runProject({ cwd: root, command: 'validate', mode: 'production' });

    expect(result.success).toBe(false);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'HOOK_LOAD_FAILED' }));
    expect(JSON.stringify(result.diagnostics)).not.toContain('MUST_NOT_RUN');
  });

  it('rejects non-enumerable unknown descriptor fields', async () => {
    /** data property 即使不可枚举也必须保留到领域 Schema 检查。 */
    const root = await createProject({
      hooks: [{
        id: 'hidden-field',
        definition: `(() => {
          const value = { event: 'SessionStart', run() {} };
          Object.defineProperty(value, 'hidden', { value: true });
          return value;
        })() as never`,
      }],
    });
    /** 隐藏字段不能因 Module Service 快照规则而消失。 */
    const result = await runProject({ cwd: root, command: 'validate', mode: 'production' });

    expect(result.success).toBe(false);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'HOOK_FIELD_UNKNOWN' }));
  });

  it('distinguishes omitted descriptor fields from nested undefined values', async () => {
    /** 顶层可选字段缺失是合法 omission。 */
    const omittedRoot = await createProject({
      hooks: [{
        id: 'omitted',
        definition: `{ event: 'SessionStart', run() {} }`,
      }],
    });
    /** omission 能完整进入 validate/build，而不是被误判成非法 JSON。 */
    const omitted = await runProject({ cwd: omittedRoot, command: 'validate', mode: 'production' });
    expect(omitted.success).toBe(true);
    expect(omitted.extensions).toContainEqual(expect.objectContaining({
      id: 'hooks',
      discovered: true,
      subjects: expect.arrayContaining([
        expect.objectContaining({ subject: 'hook:omitted' }),
      ]),
    }));

    /** 已出现的嵌套字段显式 undefined 不是 JSON 数据。 */
    const invalidRoot = await createProject({
      hooks: [{
        id: 'nested-undefined',
        definition: `{ event: 'SessionStart', platforms: { codex: { timeout: undefined } }, run() {} } as never`,
      }],
    });
    /** discover 必须只拒绝包含显式 nested undefined 的 descriptor。 */
    const invalid = await runProject({ cwd: invalidRoot, command: 'validate', mode: 'production' });

    expect(invalid.success).toBe(false);
    expect(invalid.diagnostics.filter(diagnostic => diagnostic.code === 'HOOK_LOAD_FAILED')).toHaveLength(1);
  });

  it('rejects array accessors, custom fields, Symbols and __proto__ fields without executing accessors', async () => {
    /** 四个资源分别覆盖 nested array getter、自定义索引、数组 Symbol 与特殊对象字段名。 */
    const root = await createProject({
      hooks: [{
        id: 'nested-accessor',
        definition: `(() => {
          const platforms = [];
          Object.defineProperty(platforms, '0', { get() { process.stdout.write('GETTER_EXECUTED'); return 'codex'; } });
          Object.defineProperty(platforms, 'length', { value: 1 });
          return { event: 'SessionStart', platforms, run() {} };
        })() as never`,
      }, {
        id: 'array-field',
        definition: `(() => {
          const platforms = ['codex'];
          Object.defineProperty(platforms, '01', { value: 'claude-code' });
          return { event: 'SessionStart', platforms, run() {} };
        })() as never`,
      }, {
        id: 'array-symbol',
        definition: `(() => {
          const platforms = ['codex'];
          Object.defineProperty(platforms, Symbol.for('hidden'), { value: true });
          return { event: 'SessionStart', platforms, run() {} };
        })() as never`,
      }, {
        id: 'proto-field',
        definition: `(() => {
          const value = { event: 'SessionStart', run() {} };
          Object.defineProperty(value, '__proto__', { value: true });
          return value;
        })() as never`,
      }],
    });
    /** getter 资源加载失败，特殊字段资源进入领域未知字段诊断。 */
    const result = await runProject({ cwd: root, command: 'validate', mode: 'production' });

    expect(result.success).toBe(false);
    expect(result.diagnostics.filter(diagnostic => diagnostic.code === 'HOOK_LOAD_FAILED')).toHaveLength(3);
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
    expect(missing.diagnostics).not.toContainEqual(expect.objectContaining({ code: 'HOOK_TIMEOUT_PLATFORM_LIMIT' }));

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
    /** event 表示当前规范事件，用于验证两个 Contributor 都报告原生触发能力。 */
    for (const event of HOOK_EVENTS) {
      expect(result.compatibility).toContainEqual(expect.objectContaining({
        platform: 'claude-code',
        capability: `event.${event.replace(/([a-z0-9])([A-Z])/gu, '$1-$2').toLowerCase()}`,
        level: 'native',
      }));
      expect(result.compatibility).toContainEqual(expect.objectContaining({
        platform: 'codex',
        capability: `event.${event.replace(/([a-z0-9])([A-Z])/gu, '$1-$2').toLowerCase()}`,
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

    /** Claude Code Contributor 生成的 Hook 配置。 */
    const claudeHooks = JSON.parse(await fs.readFile(
      path.join(root, 'dist/claude-code/plugin/hooks/hooks.json'),
      'utf8',
    )) as { hooks: Record<string, { hooks: Record<string, unknown>[] }[]> };
    /** Codex Contributor 生成的 Hook 配置。 */
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
    await expect(fs.access(path.join(root, 'dist/claude-code/plugin/hooks/pre-tool-use/wire.mjs'))).rejects.toThrow();
    expect((await fs.readFile(claudeHandler, 'utf8'))).not.toContain('./wire.mjs');
    expect(await fs.readFile(
      path.join(root, 'dist/claude-code/plugin/hooks/pre-tool-use/THIRD_PARTY_LICENSES.txt'),
      'utf8',
    )).toContain('fixture-dependency@2.3.4');
  });

  it('keeps Handler bytes and report hashes stable across isolated work directories', async () => {
    /** 单个 Hook 足以暴露随机 Extension workDir 曾进入 Rolldown region 注释的问题。 */
    const root = await createProject({
      hooks: [{ id: 'session-start', definition: `{ event: 'SessionStart', run() {} }` }],
    });
    /** 第一次完整构建的稳定报告。 */
    const first = await runProject({ cwd: root, command: 'build', mode: 'production' });
    /** 第一次事务提交后的 Handler 原始字节。 */
    const firstHandler = await fs.readFile(path.join(root, 'dist/claude-code/plugin/hooks/session-start/handler.mjs'));
    /** 相同输入下由新 workDir 完成的第二次构建报告。 */
    const second = await runProject({ cwd: root, command: 'build', mode: 'production' });
    /** 第二次事务提交后的 Handler 原始字节。 */
    const secondHandler = await fs.readFile(path.join(root, 'dist/claude-code/plugin/hooks/session-start/handler.mjs'));

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(secondHandler).toEqual(firstHandler);
    expect(secondHandler.toString('utf8')).not.toMatch(/^\/\/#(?:end)?region/mu);
    expect(secondHandler.toString('utf8')).not.toContain(root);
    expect(secondHandler.toString('utf8')).not.toContain('src/hooks/session-start/hook.ts');
    expect(second.packages).toEqual(first.packages);
    /** 删除 Canonical 源码后，自包含安装产物仍必须可独立执行。 */
    await fs.rm(path.join(root, 'src/hooks'), { recursive: true });
    /** 删除源码后执行已安装 Handler 的进程结果。 */
    const execution = await runHandler(
      path.join(root, 'dist/claude-code/plugin/hooks/session-start/handler.mjs'),
      'claude-code',
      JSON.stringify({ session_id: 'session-1', cwd: root, hook_event_name: 'SessionStart', source: 'startup' }),
      { CLAUDE_PLUGIN_ROOT: '/plugin-root', CLAUDE_PLUGIN_DATA: '/plugin-data' },
    );
    expect(execution).toEqual({ code: 0, stdout: '', stderr: '' });
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

  it('rejects raw platform handler declarations and invalid contributor fields before bundling', async () => {
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
    expect(result.packages.length).toBeGreaterThan(0);
    expect(result.diagnostics.filter(diagnostic => diagnostic.code === 'HOOK_FIELD_UNKNOWN')).toHaveLength(8);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: 'HOOK_PLATFORM_FIELD_UNKNOWN',
    }));
  });

  it('routes platform-only events exclusively to their declared configured Contributor', async () => {
    /** Claude Code Setup 平台事件仍同时配置默认双 Platform 的工程。 */
    const root = await createProject({
      hooks: [{
        id: 'setup',
        definition: `{ event: { platform: 'claude-code', name: 'Setup' }, matcher: 'init', run() {} }`,
      }],
    });
    /** 平台事件成功构建后的兼容性和 Asset 结果。 */
    const result = await runProject({ cwd: root, command: 'build', mode: 'production' });

    expect(result.success).toBe(true);
    expect(result.compatibility).toContainEqual(expect.objectContaining({
      platform: 'claude-code',
      subject: 'hook:setup',
      capability: 'event.setup',
      level: 'native',
    }));
    expect(result.compatibility).toContainEqual(expect.objectContaining({
      platform: 'codex',
      subject: 'hook:setup',
      level: 'unsupported',
    }));
    await expect(fs.access(path.join(root, 'dist/codex/plugin/hooks/hooks.json'))).rejects.toThrow();
    /** Codex Manifest 不应因其他平台事件获得空 hooks 字段。 */
    const codexManifest = JSON.parse(await fs.readFile(
      path.join(root, 'dist/codex/plugin/.codex-plugin/plugin.json'),
      'utf8',
    )) as Record<string, unknown>;
    expect(codexManifest).not.toHaveProperty('hooks');
  });

  it('keeps an empty Extension asset-free and uses the Cursor Contributor when selected', async () => {
    /** 没有 `src/hooks` 的空 Extension 工程。 */
    const emptyRoot = await createProject();
    /** 空 Extension 的成功构建结果。 */
    const empty = await runProject({ cwd: emptyRoot, command: 'build', mode: 'production' });
    expect(empty.success).toBe(true);
    expect(empty.packages
      .flatMap(unit => unit.assets)
      .some(asset => asset.path.startsWith('hooks/'))).toBe(false);

    /** 只配置 Cursor、且拥有实际 Hook 资源的工程。 */
    const cursorRoot = await createProject({
      hooks: [{ id: 'stop', definition: `{ event: 'Stop', run() {} }` }],
      configImports: `import cursor from '@tokenroll/acplugin-platform-cursor';`,
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
      configFields: 'platforms: [claudeCode(), codex()], build: { strict: true },',
    });
    /** strict 模式因当前 Hook 的 Codex matcher 损失而失败。 */
    const strict = await runProject({ cwd: root, command: 'validate', mode: 'production' });
    expect(strict.success).toBe(false);
    expect(strict.diagnostics).toContainEqual(expect.objectContaining({
      code: 'COMPATIBILITY_STRICT_FAILURE',
      platform: 'codex',
    }));
  });

  it('reports Claude Code events that silently ignore meaningful matchers', async () => {
    /** 只配置 Claude Code，避免其他 Platform 的兼容性结论干扰断言。 */
    const root = await createProject({
      hooks: [{ id: 'stop', definition: `{ event: 'Stop', matcher: 'quality-gate', run() {} }` }],
      configImports: `import claudeCode from '@tokenroll/acplugin-platform-claude-code';`,
      configFields: 'platforms: [claudeCode()], build: { strict: true },',
    });
    /** meaningful matcher 被宿主静默忽略，因此严格模式必须失败。 */
    const strict = await runProject({ cwd: root, command: 'validate', mode: 'production' });
    expect(strict.success).toBe(false);
    expect(strict.diagnostics).toContainEqual(expect.objectContaining({
      code: 'COMPATIBILITY_STRICT_FAILURE',
      platform: 'claude-code',
    }));
  }, 15_000);

  it('rejects unconfigured and unknown platform-only events with targeted diagnostics', async () => {
    /** 只配置 Codex 却声明 Claude Code Setup 的工程。 */
    const unconfiguredRoot = await createProject({
      hooks: [{
        id: 'setup',
        definition: `{ event: { platform: 'claude-code', name: 'Setup' }, run() {} }`,
      }],
      configImports: `import codex from '@tokenroll/acplugin-platform-codex';`,
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
    /** Contributor 未知事件应给出独立诊断码。 */
    const unknown = await runProject({ cwd: unknownRoot, command: 'validate', mode: 'production' });
    expect(unknown.diagnostics).toContainEqual(expect.objectContaining({ code: 'HOOK_PLATFORM_EVENT_UNSUPPORTED' }));
  }, 15_000);
});
