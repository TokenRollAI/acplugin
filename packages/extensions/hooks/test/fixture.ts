import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach } from 'vitest';
import type { BuildReport, RunProjectOptions } from '@tokenroll/acplugin';
import { HOOK_EVENTS } from '../src/index.js';

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
export async function runProject(options: RunProjectOptions): Promise<BuildReport> {
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
export async function createProject(options: ProjectFixtureOptions = {}): Promise<string> {
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
export async function runHandler(
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
export function canonicalHooks(): readonly HookFixture[] {
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
