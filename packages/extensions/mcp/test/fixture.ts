import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach } from 'vitest';
import type { BuildReport, RunProjectOptions } from '@tokenroll/acplugin';

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
export async function runProject(
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
export async function executeNode(
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
export async function createProject(options: ProjectFixtureOptions = {}): Promise<string> {
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
