import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { BuildReport, RunProjectOptions } from '@tokenroll/acplugin';
import mcp, { EXTENSION_NAME } from '../src/index.js';
import { compareCodeUnits } from '../src/sorting.js';

/** 当前测试文件所在仓库的绝对根目录。 */
const repositoryRoot = path.resolve(import.meta.dirname, '../../../..');

/** 测试描述文件通过临时包入口加载的 MCP Extension 构建产物。 */
const extensionEntry = path.join(repositoryRoot, 'packages/extensions/mcp/dist/index.mjs');

/** 测试子进程直接加载的主包构建产物。 */
const acpluginEntry = path.join(repositoryRoot, 'packages/acplugin/dist/index.mjs');

/** MCP 生命周期测试显式配置的两个独立 Platform 构建入口。 */
const claudeCodeEntry = path.join(repositoryRoot, 'packages/platforms/claude-code/dist/index.mjs');
/** MCP 生命周期测试显式配置的 Codex Platform 构建入口。 */
const codexEntry = path.join(repositoryRoot, 'packages/platforms/codex/dist/index.mjs');

/** 真实 MCP SDK package root，测试工程通过正常 package-manager symlink 使用。 */
const mcpSdkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.resolve('@modelcontextprotocol/sdk/server/index.js'))), '../../..');

/** 当前测试创建并在 afterEach 中统一删除的临时工程。 */
const temporaryRoots: string[] = [];

/** 子进程的稳定退出状态和有限输出。 */
interface ProcessResult {
  /** Node 子进程退出码。 */
  readonly code: number | null;
  /** 子进程完整标准输出。 */
  readonly stdout: string;
  /** 子进程完整标准错误。 */
  readonly stderr: string;
}

/** 创建临时规范工程时使用的 MCP fixture 选项。 */
interface ProjectFixtureOptions {
  /** 直接传入 `mcp(...)` 的可选 TypeScript 参数表达式。 */
  readonly mcpOptions?: string;
  /** 远程 Server 描述对象表达式；false 表示不创建。 */
  readonly remote?: string | false;
  /** 本地 Server 描述对象表达式；false 表示不创建。 */
  readonly local?: string | false;
  /** 本地 Server 入口源码。 */
  readonly serverSource?: string;
  /** 构建命令使用的顶层配置补充。 */
  readonly configFields?: string;
}

/**
 * 在原生 Node ESM 子进程中运行公开 API，确保共享 registry brand 只绑定一个主包实例。
 *
 * @param options 可 JSON 序列化的项目运行选项。
 * @param environment 测试构建阶段显式加入的环境变量。
 * @returns 公开 API 产生的结构化 BuildReport。
 */
async function runProject(
  options: RunProjectOptions,
  environment: Readonly<Record<string, string>> = {},
): Promise<BuildReport> {
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
  /** 原生 ESM 子进程的执行结果。 */
  const execution = await executeNode(['--input-type=module', '--eval', source], '', environment);
  if (execution.code !== 0)
    throw new Error(`Project subprocess failed: ${execution.stderr}`);
  /** 子进程返回的成功结果或安全异常摘要。 */
  const payload = JSON.parse(execution.stdout) as {
    readonly ok: boolean;
    readonly result?: BuildReport;
    readonly name?: string;
    readonly message?: string;
  };
  if (!payload.ok || payload.result === undefined)
    throw new Error(`${payload.name ?? 'Error'}: ${payload.message ?? 'Project execution failed.'}`);
  return payload.result;
}

/**
 * 运行一个 Node 子进程并完整收集测试所需输出。
 *
 * @param arguments_ 传给 Node 的参数。
 * @param input 写入标准输入的协议文本。
 * @param environment 追加到宿主环境的测试变量。
 * @returns 稳定退出码和标准输出、错误输出。
 */
async function executeNode(
  arguments_: readonly string[],
  input: string,
  environment: Readonly<Record<string, string>> = {},
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    /** 不经过 shell 的真实 Node 子进程。 */
    const child = spawn(process.execPath, arguments_, {
      env: { ...process.env, ...environment },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    /** 子进程累计的标准输出。 */
    let stdout = '';
    /** 子进程累计的标准错误。 */
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
 * 在临时工程中创建可由统一 Module Service 和 Rolldown 共同解析的 Extension 包入口。
 *
 * @param root 临时工程根目录。
 */
async function writeExtensionProxy(root: string): Promise<void> {
  /** 临时 node_modules 中的 MCP Extension 包目录。 */
  const packageRoot = path.join(root, 'node_modules/@tokenroll/acplugin-extension-mcp');
  await fs.mkdir(packageRoot, { recursive: true });
  await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
    name: '@tokenroll/acplugin-extension-mcp',
    version: '1.0.0',
    type: 'module',
    exports: './index.mjs',
  }));
  await fs.writeFile(
    path.join(packageRoot, 'index.mjs'),
    `export * from ${JSON.stringify(extensionEntry)}; export { default } from ${JSON.stringify(extensionEntry)};\n`,
  );
  /** 主包与 SDK 代理保持与真实 tarball 相同的 package identity。 */
  const acpluginRoot = path.join(root, 'node_modules/@tokenroll/acplugin');
  await fs.mkdir(acpluginRoot, { recursive: true });
  await fs.writeFile(path.join(acpluginRoot, 'package.json'), JSON.stringify({
    name: '@tokenroll/acplugin', version: '1.0.0', type: 'module', exports: { '.': './index.mjs', './sdk': './sdk.mjs' },
  }));
  await fs.writeFile(path.join(acpluginRoot, 'index.mjs'), `export * from ${JSON.stringify(acpluginEntry)};\n`);
  await fs.writeFile(path.join(acpluginRoot, 'sdk.mjs'), `export * from ${JSON.stringify(path.join(repositoryRoot, 'packages/acplugin/dist/sdk.mjs'))};\n`);
  for (const [name, entry] of [
    ['@tokenroll/acplugin-platform-claude-code', claudeCodeEntry],
    ['@tokenroll/acplugin-platform-codex', codexEntry],
  ] as const) {
    /** 当前官方 Platform 的测试代理目录。 */
    const platformRoot = path.join(root, 'node_modules', name);
    await fs.mkdir(platformRoot, { recursive: true });
    await fs.writeFile(path.join(platformRoot, 'package.json'), JSON.stringify({ name, version: '1.0.0', type: 'module', exports: './index.mjs' }));
    await fs.writeFile(path.join(platformRoot, 'index.mjs'), `export * from ${JSON.stringify(entry)}; export { default } from ${JSON.stringify(entry)};\n`);
  }
  /** pnpm 依赖 symlink 是合法 package 边界，不属于作者源码 symlink。 */
  const sdkRoot = path.join(root, 'node_modules/@modelcontextprotocol/sdk');
  await fs.mkdir(path.dirname(sdkRoot), { recursive: true });
  await fs.symlink(mcpSdkRoot, sdkRoot, 'dir');
}

/**
 * 写入一个实际参与 Bundle 和第三方许可收集的本地 npm 依赖。
 *
 * @param root 临时工程根目录。
 */
async function writeLicensedDependency(root: string): Promise<void> {
  /** 临时 node_modules 中的第三方测试包目录。 */
  const packageRoot = path.join(root, 'node_modules/mcp-fixture-dependency');
  await fs.mkdir(packageRoot, { recursive: true });
  await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
    name: 'mcp-fixture-dependency',
    version: '4.5.6',
    type: 'module',
    exports: './index.js',
    license: 'MIT',
  }));
  await fs.writeFile(path.join(packageRoot, 'index.js'), 'export const serverName = "fixture";\n');
  await fs.writeFile(path.join(packageRoot, 'LICENSE'), 'MCP fixture dependency license.\n');
}

/**
 * 创建带最小 Skill、配置和可选远程/本地 MCP 的真实临时工程。
 *
 * @param options MCP 定义、入口和构建配置。
 * @returns 已登记清理的工程绝对路径。
 */
async function createProject(options: ProjectFixtureOptions = {}): Promise<string> {
  /** 当前测试独占的临时工程根目录。 */
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-mcp-test-'));
  temporaryRoots.push(root);
  await writeExtensionProxy(root);
  await writeLicensedDependency(root);
  await fs.mkdir(path.join(root, 'src/skills/hello'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'src/skills/hello/SKILL.md'),
    '---\ndescription: Say hello.\n---\nSay hello to the user.\n',
  );
  if (options.remote !== false) {
    await fs.mkdir(path.join(root, 'src/mcp/docs'), { recursive: true });
    await fs.writeFile(path.join(root, 'src/mcp/docs/mcp.ts'), `
import type { McpServer } from '@tokenroll/acplugin-extension-mcp';
export default ${options.remote ?? `{
  transport: 'http',
  url: 'https://mcp.example.com/mcp',
  auth: { type: 'bearer', env: 'DOCS_TOKEN' },
  headers: { 'X-Tenant': { env: 'DOCS_TENANT' }, 'X-Client': { value: 'acplugin-test' } },
}`} satisfies McpServer;
`);
  }
  if (options.local !== false) {
    await fs.mkdir(path.join(root, 'src/mcp/local-tools'), { recursive: true });
    await fs.writeFile(path.join(root, 'src/mcp/local-tools/mcp.ts'), `
import type { McpServer } from '@tokenroll/acplugin-extension-mcp';
export default ${options.local ?? `{
  transport: 'stdio',
  env: { LOG_LEVEL: { value: 'warn' }, API_TOKEN: { env: 'LOCAL_TOKEN' } },
}`} satisfies McpServer;
`);
    await fs.writeFile(path.join(root, 'src/mcp/local-tools/server.ts'), options.serverSource ?? `
import { serverName } from 'mcp-fixture-dependency';
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
        serverInfo: { name: serverName, version: '1.0.0' },
      } }) + '\\n');
    } else if (message.method === 'tools/list') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [] } }) + '\\n');
    }
  }
});
`);
  }
  await fs.writeFile(path.join(root, 'acplugin.config.ts'), `
import mcp from '@tokenroll/acplugin-extension-mcp';
import claudeCode from '@tokenroll/acplugin-platform-claude-code';
import codex from '@tokenroll/acplugin-platform-codex';
export default {
  name: 'mcp-fixture',
  version: '1.0.0',
  description: 'MCP integration fixture.',
  platforms: [claudeCode(), codex()],
  extensions: [mcp(${options.mcpOptions ?? ''})],
  ${options.configFields ?? 'build: { strict: false },'}
};
`);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe('MCP Extension', () => {
  it('exposes plain descriptor types, filters resources, and rejects invalid options', async () => {
    /** 公开工厂创建的默认 MCP Extension。 */
    const extension = mcp();
    expect(EXTENSION_NAME).toBe('@tokenroll/acplugin-extension-mcp');
    expect(extension.id).toBe('mcp');
    expect(extension.resourceRoots).toEqual(['mcp']);
    expect(Object.isFrozen(extension)).toBe(true);
    expect(() => mcp({ include: ['docs', 'docs'] })).toThrow('duplicate ID');
    expect(() => mcp({ include: ['Not-Kebab'] })).toThrow('lowercase kebab-case');
    expect(() => mcp({ include: ['mcp-é'] })).toThrow('lowercase kebab-case');
    expect(() => mcp({ unknown: true } as never)).toThrow('Unknown MCP option');

    /** include 只选择远程 Server 的真实工程。 */
    const root = await createProject({ mcpOptions: `{ include: ['docs'] }` });
    /** 筛选后的双 Platform 构建结果。 */
    const result = await runProject({ cwd: root, command: 'build', mode: 'production' });
    expect(result.success).toBe(true);
    await expect(fs.access(path.join(root, 'dist/codex/plugin/mcp/local-tools/server.mjs'))).rejects.toThrow();
    expect(JSON.parse(await fs.readFile(path.join(root, 'dist/codex/plugin/.mcp.json'), 'utf8')))
      .toHaveProperty('docs.url', 'https://mcp.example.com/mcp');
  });

  it('uses locale-independent code-unit ordering for deterministic internal maps', () => {
    /** 非 ASCII 样本证明排序不委托给宿主 locale 或 ICU。 */
    const values = ['é', 'z', 'ä', 'a'];
    expect(values.sort(compareCodeUnits)).toEqual(['a', 'z', 'ä', 'é']);
  });

  it('rejects non-enumerable descriptor accessors without evaluating them', async () => {
    /** 不可枚举 getter 不能绕过 plain descriptor 的无行为数据边界。 */
    const root = await createProject({
      local: false,
      remote: `(() => {
        const value = { transport: 'http', url: 'https://mcp.example.com/mcp' };
        Object.defineProperty(value, 'hidden', { get() { throw new Error('MUST_NOT_RUN'); } });
        return value;
      })() as never`,
    });
    /** discover 以稳定错误码拒绝，并且原始 getter 文本不进入诊断。 */
    const result = await runProject({ cwd: root, command: 'validate', mode: 'production' });

    expect(result.success).toBe(false);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'MCP_DESCRIPTOR_LOAD_FAILED' }));
    expect(JSON.stringify(result.diagnostics)).not.toContain('MUST_NOT_RUN');
  });

  it('rejects non-enumerable unknown descriptor fields', async () => {
    /** data property 即使不可枚举也必须保留到 HTTP Server Schema 检查。 */
    const root = await createProject({
      local: false,
      remote: `(() => {
        const value = { transport: 'http', url: 'https://mcp.example.com/mcp' };
        Object.defineProperty(value, 'hidden', { value: true });
        return value;
      })() as never`,
    });
    /** 隐藏字段不能因 Module Service 快照规则而消失。 */
    const result = await runProject({ cwd: root, command: 'validate', mode: 'production' });

    expect(result.success).toBe(false);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'MCP_FIELD_UNKNOWN' }));
  });

  it('rejects array accessors, custom fields, Symbols and __proto__ fields without executing accessors', async () => {
    /** nested array getter 写 stdout；若被执行会直接破坏子进程 JSON 协议并使测试失败。 */
    const accessorRoot = await createProject({
      local: false,
      remote: `(() => {
        const scopes = [];
        Object.defineProperty(scopes, '0', { get() { process.stdout.write('GETTER_EXECUTED'); return 'docs:read'; } });
        Object.defineProperty(scopes, 'length', { value: 1 });
        const value = { transport: 'http', url: 'https://mcp.example.com/mcp', auth: { type: 'oauth', scopes } };
        Object.defineProperty(value, '__proto__', { value: true });
        return value;
      })() as never`,
    });
    /** 快照必须在执行 getter 前拒绝整个 descriptor。 */
    const accessor = await runProject({ cwd: accessorRoot, command: 'validate', mode: 'production' });

    expect(accessor.success).toBe(false);
    expect(accessor.diagnostics).toContainEqual(expect.objectContaining({ code: 'MCP_DESCRIPTOR_LOAD_FAILED' }));

    /** 类似索引的自定义字段也不能被 snapshot 静默忽略。 */
    const fieldRoot = await createProject({
      local: false,
      remote: `(() => {
        const scopes = ['docs:read'];
        Object.defineProperty(scopes, '01', { value: 'docs:write' });
        return { transport: 'http', url: 'https://mcp.example.com/mcp', auth: { type: 'oauth', scopes } };
      })() as never`,
    });
    /** 伪索引必须在 discover 数据边界失败。 */
    const field = await runProject({ cwd: fieldRoot, command: 'validate', mode: 'production' });

    expect(field.success).toBe(false);
    expect(field.diagnostics).toContainEqual(expect.objectContaining({ code: 'MCP_FIELD_UNKNOWN' }));

    /** 字符串字段检查不能遗漏数组自身携带的 Symbol。 */
    const symbolRoot = await createProject({
      local: false,
      remote: `(() => {
        const scopes = ['docs:read'];
        Object.defineProperty(scopes, Symbol.for('hidden'), { value: true });
        return { transport: 'http', url: 'https://mcp.example.com/mcp', auth: { type: 'oauth', scopes } };
      })() as never`,
    });
    /** Symbol 不能进入纯 JSON descriptor State。 */
    const symbol = await runProject({ cwd: symbolRoot, command: 'validate', mode: 'production' });

    expect(symbol.success).toBe(false);
    expect(symbol.diagnostics).toContainEqual(expect.objectContaining({ code: 'MCP_DESCRIPTOR_LOAD_FAILED' }));
  });

  it('builds remote and local Servers once without reading or leaking Secret values', async () => {
    /** 同时覆盖 HTTP、stdio、环境引用和第三方许可的工程。 */
    const root = await createProject();
    /** 用可检测的 Secret 值证明构建阶段只保留变量名称。 */
    const secret = 'MUST_NOT_APPEAR_IN_BUILD_OUTPUT_9f6a';
    /** 完整提交双 Platform 交付单元的构建结果。 */
    const result = await runProject(
      { cwd: root, command: 'build', mode: 'production' },
      { DOCS_TOKEN: secret, DOCS_TENANT: secret, LOCAL_TOKEN: secret },
    );
    expect(result.success).toBe(true);

    /** Claude Code wrapped MCP 清单。 */
    const claude = JSON.parse(await fs.readFile(
      path.join(root, 'dist/claude-code/plugin/.mcp.json'),
      'utf8',
    )) as Record<string, unknown>;
    /** Codex direct MCP 清单。 */
    const codex = JSON.parse(await fs.readFile(
      path.join(root, 'dist/codex/plugin/.mcp.json'),
      'utf8',
    )) as Record<string, unknown>;
    expect(claude).toHaveProperty('mcpServers.docs.headers.Authorization', 'Bearer ${DOCS_TOKEN}');
    expect(claude).toHaveProperty('mcpServers.local-tools.args.0', '${CLAUDE_PLUGIN_ROOT}/mcp/local-tools/server.mjs');
    expect(codex).toMatchObject({
      'docs': {
        url: 'https://mcp.example.com/mcp',
        bearer_token_env_var: 'DOCS_TOKEN',
        env_http_headers: { 'X-Tenant': 'DOCS_TENANT' },
        http_headers: { 'X-Client': 'acplugin-test' },
      },
      'local-tools': {
        command: 'node',
        args: ['./mcp/local-tools/server.mjs'],
        cwd: '.',
        env: { LOG_LEVEL: 'warn' },
        env_vars: ['LOCAL_TOKEN'],
      },
    });
    expect(JSON.stringify({ result, claude, codex })).not.toContain(secret);

    /** 两个平台复用同一平台中立 Server Bundle。 */
    const claudeServer = path.join(root, 'dist/claude-code/plugin/mcp/local-tools/server.mjs');
    /** Codex 安装包中的同一 Server Bundle。 */
    const codexServer = path.join(root, 'dist/codex/plugin/mcp/local-tools/server.mjs');
    expect(await fs.readFile(claudeServer)).toEqual(await fs.readFile(codexServer));
    expect((await fs.stat(codexServer)).mode & 0o111).not.toBe(0);
    expect(await fs.readFile(
      path.join(root, 'dist/codex/plugin/mcp/local-tools/THIRD_PARTY_LICENSES.txt'),
      'utf8',
    )).toContain('mcp-fixture-dependency@4.5.6');

    /** 使用真实 initialize/list-tools JSON-RPC 流验证安装产物可执行。 */
    const protocolInput = [
      JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } },
      }),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      '',
    ].join('\n');
    /** 本地 Bundle 的实际协议响应。 */
    const execution = await executeNode([codexServer], protocolInput);
    expect(execution).toMatchObject({ code: 0, stderr: '' });
    expect(execution.stdout.trim().split('\n').map(line => JSON.parse(line))).toEqual([
      expect.objectContaining({ id: 1, result: expect.objectContaining({ serverInfo: { name: 'fixture', version: '1.0.0' } }) }),
      { jsonrpc: '2.0', id: 2, result: { tools: [] } },
    ]);
  });

  it('enforces production URL, value-source, entry, and include safety', async () => {
    /** 使用 HTTP、非法认证和值来源的远程定义。 */
    const remoteRoot = await createProject({
      local: false,
      remote: `{
        transport: 'http',
        url: 'http://example.com/mcp',
        auth: { type: 'bearer', env: 'INVALID-NAME' },
        headers: { 'X-Secret': { value: 'public', env: 'PRIVATE_TOKEN' } },
      } as never`,
      mcpOptions: `{ include: ['docs'] }`,
    });
    /** 远程安全策略产生的结构化失败结果。 */
    const remote = await runProject({ cwd: remoteRoot, command: 'validate', mode: 'production' });
    expect(remote.success).toBe(false);
    expect(remote.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'MCP_HTTPS_REQUIRED' }),
      expect.objectContaining({ code: 'MCP_BEARER_INVALID' }),
      expect.objectContaining({ code: 'MCP_VALUE_SOURCE_INVALID' }),
    ]));
    /** 单独工程验证 include 指向不存在资源时的诊断。 */
    const includeRoot = await createProject({ local: false, mcpOptions: `{ include: ['missing'] }` });
    /** 执行 include fixture 并读取稳定诊断。 */
    const include = await runProject({ cwd: includeRoot, command: 'validate', mode: 'production' });
    expect(include.diagnostics).toContainEqual(expect.objectContaining({ code: 'MCP_INCLUDE_MISSING' }));

    /** 使用目录逃逸入口的本地定义。 */
    const localRoot = await createProject({
      remote: false,
      local: `{ transport: 'stdio', entry: '../outside.ts' }`,
    });
    /** 入口边界验证必须在 Bundle 之前失败。 */
    const local = await runProject({ cwd: localRoot, command: 'validate', mode: 'production' });
    expect(local.success).toBe(false);
    expect(local.diagnostics).toContainEqual(expect.objectContaining({ code: 'MCP_ENTRY_ESCAPE' }));
  });

  it('enforces exact transport, auth, URL, and stdio entry variants', async () => {
    /** HTTP 不能携带 stdio 字段，none auth 不能携带 bearer 字段。 */
    const httpRoot = await createProject({
      local: false,
      remote: `{ transport: 'http', url: 'https://mcp.example.com/mcp', entry: 'server.ts', env: {}, auth: { type: 'none', env: 'TOKEN' } } as never`,
    });
    /** 跨判别分支字段必须在 Extension validate 阶段失败。 */
    const http = await runProject({ cwd: httpRoot, command: 'validate', mode: 'production' });
    expect(http.success).toBe(false);
    expect(http.diagnostics.filter(diagnostic => diagnostic.code === 'MCP_FIELD_UNKNOWN').length).toBeGreaterThanOrEqual(3);

    /** bearer 与 oauth 认证分支各自拒绝另一分支的字段。 */
    for (const auth of [
      `{ type: 'bearer', env: 'TOKEN', scopes: ['docs:read'] }`,
      `{ type: 'oauth', scopes: ['docs:read'], env: 'TOKEN' }`,
    ]) {
      /** 当前认证分支交叉字段的独立 HTTP fixture。 */
      const authRoot = await createProject({
        local: false,
        remote: `{ transport: 'http', url: 'https://mcp.example.com/mcp', auth: ${auth} } as never`,
      });
      /** exact discriminated union 必须在领域 validate 阶段拒绝交叉字段。 */
      const authResult = await runProject({ cwd: authRoot, command: 'validate', mode: 'production' });
      expect(authResult.success).toBe(false);
      expect(authResult.diagnostics).toContainEqual(expect.objectContaining({ code: 'MCP_FIELD_UNKNOWN' }));
    }

    /** stdio 不能携带 HTTP 字段或任何 HTTP auth。 */
    const stdioRoot = await createProject({
      remote: false,
      local: `{ transport: 'stdio', entry: 'server.ts', url: 'https://mcp.example.com', headers: {}, auth: { type: 'bearer', env: 'TOKEN' } } as never`,
    });
    /** 顶层 transport exact union 不依赖 TypeScript 静态检查。 */
    const stdio = await runProject({ cwd: stdioRoot, command: 'validate', mode: 'production' });
    expect(stdio.success).toBe(false);
    expect(stdio.diagnostics.filter(diagnostic => diagnostic.code === 'MCP_FIELD_UNKNOWN').length).toBeGreaterThanOrEqual(3);

    /** development 也只允许 HTTPS 或 loopback HTTP，不能放行其他 scheme。 */
    const schemeRoot = await createProject({ local: false, remote: `{ transport: 'http', url: 'ftp://localhost/mcp' }` });
    /** 非 HTTP(S) scheme 必须产生稳定 URL 失败。 */
    const scheme = await runProject({ cwd: schemeRoot, command: 'validate', mode: 'development' });
    expect(scheme.diagnostics).toContainEqual(expect.objectContaining({ code: 'MCP_URL_INVALID' }));

    /** 文档化的 canonical entry 和 development loopback URL 都合法。 */
    const validRoot = await createProject({ remote: `{ transport: 'http', url: 'http://127.0.0.1:3000/mcp' }`, local: `{ transport: 'stdio', entry: 'server.ts' }` });
    /** validate 不执行 stdio smoke，但应完整通过作者 schema。 */
    const valid = await runProject({ cwd: validRoot, command: 'validate', mode: 'development' });
    expect(valid.success).toBe(true);

    /** dot、空 segment、反斜线和父目录 spelling 都不能被静默 normalize。 */
    for (const entry of ['./server.ts', '.', 'nested//server.ts', 'nested\\server.ts', '../server.ts', '/server.ts']) {
      /** 每个非法 spelling 使用独立工程，避免诊断相互掩盖。 */
      const root = await createProject({ remote: false, local: `{ transport: 'stdio', entry: ${JSON.stringify(entry)} }` });
      /** 路径语法错误必须与真实缺失文件区分。 */
      const result = await runProject({ cwd: root, command: 'validate', mode: 'production' });
      expect(result.success).toBe(false);
      expect(result.diagnostics).toContainEqual(expect.objectContaining({
        code: entry.startsWith('/') || entry.includes('../') ? 'MCP_ENTRY_ESCAPE' : 'MCP_ENTRY_INVALID',
      }));
      expect(result.diagnostics).not.toContainEqual(expect.objectContaining({ code: 'MCP_ENTRY_MISSING' }));
    }
  });

  it('accepts a complete server implemented with the official MCP SDK', async () => {
    /** SDK Server 提供真实 initialize 协商和 tools/list handler。 */
    const root = await createProject({
      remote: false,
      serverSource: `
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
const server = new Server({ name: 'sdk-fixture', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
await server.connect(new StdioServerTransport());
`,
    });
    /** 真实 SDK 响应必须通过同一 Core Execution Host smoke。 */
    const result = await runProject({ cwd: root, command: 'build', mode: 'production' });
    expect(result.success, JSON.stringify(result)).toBe(true);
    expect(result.diagnostics).not.toContainEqual(expect.objectContaining({ code: 'MCP_STDIO_SMOKE_FAILED' }));
  });

  it('rejects protocol-shaped output that is not a valid MCP handshake', async () => {
    /** 所有 case 都会正常退出并打印 JSON，差异只在 JSON-RPC/MCP shape。 */
    const validInitialize = { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'fixture', version: '1.0.0' } } };
    /** 标准空 tool list 响应。 */
    const validTools = { jsonrpc: '2.0', id: 2, result: { tools: [] } };
    /** 旧实现会误接受的响应及各类 envelope/result 反例。 */
    const cases: readonly (readonly unknown[])[] = [
      [{ id: 1, result: {} }, { id: 2, result: {} }],
      [validInitialize, validInitialize, validTools],
      [{ jsonrpc: '2.0', id: 1, error: { code: -32_000, message: 'failed' } }, validTools],
      [{ ...validInitialize, jsonrpc: '1.0' }, validTools],
      [{ jsonrpc: '2.0', id: 1, result: 'initialized' }, validTools],
      [validInitialize, { jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'broken' }] } }],
    ];
    for (const messages of cases) {
      /** Fixture 不解析输入，只伪造旧 validator 所需的两行 JSON。 */
      const stdout = `${messages.map(message => JSON.stringify(message)).join('\n')}\n`;
      /** 每个反例独立编译和执行，证明失败发生在真实 Extension build path。 */
      const root = await createProject({ remote: false, serverSource: `process.stdout.write(${JSON.stringify(stdout)});\n` });
      /** 伪 handshake 不得形成可提交 Platform candidate。 */
      const result = await runProject({ cwd: root, command: 'build', mode: 'production' });
      expect(result.success).toBe(false);
      expect(result.committed).toBe(false);
      expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'MCP_STDIO_SMOKE_FAILED', phase: 'compile' }));
    }
  });

  it('rejects local bundles that fail the MCP protocol smoke in both build modes', async () => {
    /** mode 表示当前必须执行真实 initialize/tools-list 探测的构建模式。 */
    for (const mode of ['development', 'production'] as const) {
      /** 立即退出且不响应 initialize 的无效本地实现。 */
      const root = await createProject({
        remote: false,
        serverSource: 'process.exit(0);\n',
      });
      /** 两种模式都必须在提交任何 Platform 产物前执行真实协议探测。 */
      const result = await runProject({ cwd: root, command: 'build', mode });
      expect(result.success).toBe(false);
      expect(result.committed).toBe(false);
      expect(result.diagnostics).toContainEqual(expect.objectContaining({
        code: 'MCP_STDIO_SMOKE_FAILED',
        phase: 'compile',
      }));
      await expect(fs.access(path.join(root, 'dist'))).rejects.toThrow();
    }
  });

  it('rejects unresolved runtime dynamic imports in local MCP bundles', async () => {
    /** Rolldown 无法静态解析且会原样保留到运行时的动态 import。 */
    const root = await createProject({
      remote: false,
      serverSource: 'await import(process.argv[2]);\n',
    });
    /** 不完整模块图由 Extension build 阶段拒绝。 */
    const result = await runProject({ cwd: root, command: 'build', mode: 'production' });
    expect(result.success).toBe(false);
    expect(result.committed).toBe(false);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: 'BUILD_UNRESOLVED_IMPORT',
      phase: 'compile',
    }));
  });
});
