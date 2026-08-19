import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/** 构建后 CLI 入口的绝对路径，用于真实子进程契约测试。 */
const cli = path.resolve(import.meta.dirname, '../../acplugin/dist/cli.mjs');
/** CLI 子进程配置显式加载的两个独立 Platform 构建入口。 */
const claudeCodeEntry = path.resolve(import.meta.dirname, '../../platforms/claude-code/dist/index.mjs');
/** CLI 子进程配置加载的 Codex Platform 构建入口。 */
const codexEntry = path.resolve(import.meta.dirname, '../../platforms/codex/dist/index.mjs');
/** CLI 子进程配置与官方 Integration 共用的主包 SDK 构建入口。 */
const acpluginEntry = path.resolve(import.meta.dirname, '../../acplugin/dist/index.mjs');
/** 所有有效 CLI fixture 共用的独立 Platform 导入源码。 */
const platformImports = `import claudeCode from '@tokenroll/acplugin-platform-claude-code';
import codex from '@tokenroll/acplugin-platform-codex';`;
/** 所有有效 CLI fixture 共用的显式 Platform 字段。 */
const platformField = 'platforms: [claudeCode({ strict: false }), codex({ strict: false })],';
/** 当前测试创建并在 afterEach 中统一删除的临时工程目录。 */
const roots: string[] = [];
/** 测试共用的子进程清理与临时工程登记状态。 */
/** 尚未退出的 CLI 子进程，失败清理时会被强制终止。 */
const children = new Set<ChildProcessWithoutNullStreams>();

/** 正在运行的 CLI 子进程及其增量输出读取接口。 */
interface RunningCli {
  /** 可写 stdin、可监听退出事件的真实 Node 子进程。 */
  child: ChildProcessWithoutNullStreams;
  /** @returns 当前累计 stdout。 */
  stdout(): string;
  /** @returns 当前累计 stderr。 */
  stderr(): string;
}

/**
 * 创建当前 CLI 测试独占的临时工程目录。
 *
 * @returns 自动登记清理的绝对路径。
 */
async function temporaryProject(): Promise<string> {
  /** 当前 CLI 子进程测试独占且会统一清理的工程根。 */
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-cli-test-'));
  roots.push(root);
  await writePackageProxy(root, '@tokenroll/acplugin', acpluginEntry, { './sdk': './sdk.mjs' });
  await writePackageProxy(root, '@tokenroll/acplugin-platform-claude-code', claudeCodeEntry);
  await writePackageProxy(root, '@tokenroll/acplugin-platform-codex', codexEntry);
  return root;
}

/** 在临时工程中建立官方 Platform 的真实构建包代理。 */
async function writePackageProxy(root: string, packageName: string, entry: string, extraExports: Record<string, string> = {}): Promise<void> {
  /** 临时 consumer 中对应包名的物理目录。 */
  const packageRoot = path.join(root, 'node_modules', ...packageName.split('/'));
  await fs.mkdir(packageRoot, { recursive: true });
  /** 已构建包的 dist 目录。 */
  const sourceRoot = path.dirname(entry);
  /** 需复制的所有 ESM chunk 文件。 */
  const files = await fs.readdir(sourceRoot);
  await Promise.all(files.filter(file => file.endsWith('.mjs')).map(file => fs.copyFile(path.join(sourceRoot, file), path.join(packageRoot, file))));
  /** 包代理保留根入口与所需子路径。 */
  const exports = Object.keys(extraExports).length === 0 ? './index.mjs' : { '.': './index.mjs', ...extraExports };
  await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: packageName, version: '1.0.0', type: 'module', exports }));
  await fs.copyFile(entry, path.join(packageRoot, 'index.mjs'));
  /** 官方构建包的外部依赖通过其 Workspace package-manager symlink 进入临时 consumer。 */
  await fs.symlink(path.resolve(sourceRoot, '..', 'node_modules'), path.join(packageRoot, 'node_modules'), 'dir').catch(() => undefined);
  if (extraExports['./sdk'] !== undefined)
    await fs.copyFile(path.join(sourceRoot, 'sdk.mjs'), path.join(packageRoot, 'sdk.mjs'));
}

/**
 * 启动真实 CLI 子进程并持续捕获 stdout/stderr。
 *
 * @param args 传给 CLI 的参数。
 * @param cwd 子进程工作目录。
 * @returns 可等待、终止和读取增量输出的运行记录。
 */
function startCli(args: readonly string[], cwd: string): RunningCli {
  /** 继承环境但关闭颜色的 CLI 子进程。 */
  const child = spawn(process.execPath, [cli, ...args], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, NO_COLOR: '1' },
  });
  children.add(child);
  /** 当前累计标准输出。 */
  let stdout = '';
  /** 当前累计标准错误。 */
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => stdout += chunk);
  child.stderr.setEncoding('utf8').on('data', chunk => stderr += chunk);
  child.once('close', () => children.delete(child));
  return {
    child,
    /** stdout 返回当前累计的标准输出。 */
    stdout: () => stdout,
    /** stderr 返回当前累计的标准错误。 */
    stderr: () => stderr,
  };
}

/**
 * 等待 CLI 子进程退出并返回最终输出快照。
 *
 * @param running startCli 返回的运行记录。
 * @returns 退出码和完整 stdout/stderr。
 */
async function waitForExit(running: RunningCli): Promise<{ code: number | null; stdout: string; stderr: string }> {
  /** close 事件提供的进程退出码。 */
  const code = await new Promise<number | null>((resolve, reject) => {
    running.child.once('error', reject);
    running.child.once('close', resolve);
  });
  return { code, stdout: running.stdout(), stderr: running.stderr() };
}

/**
 * 执行一个不需要持续 stdin 的 CLI 命令并等待退出。
 *
 * @param args 传给 CLI 的参数。
 * @param cwd 子进程工作目录。
 * @returns 退出码和完整输出。
 */
async function runCli(args: readonly string[], cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  /** 当前一次性 CLI 命令的运行记录。 */
  const running = startCli(args, cwd);
  running.child.stdin.end();
  return waitForExit(running);
}

/**
 * 等待持续运行 CLI 的输出满足断言条件，并带超时和提前退出诊断。
 *
 * @param running 正在运行的 CLI。
 * @param predicate 判断累计输出是否已满足条件的函数。
 * @param description 超时错误使用的等待目标描述。
 */
async function waitForOutput(
  running: RunningCli,
  predicate: (stdout: string, stderr: string) => boolean,
  description: string,
): Promise<void> {
  if (predicate(running.stdout(), running.stderr()))
    return;
  await new Promise<void>((resolve, reject) => {
    /** 防止 dev 子进程异常挂起测试的超时器。 */
    const timeout = setTimeout(() => finish(new Error(`Timed out waiting for ${description}.\nstdout:\n${running.stdout()}\nstderr:\n${running.stderr()}`)), 10_000);
    /** 每次收到输出时重新检查等待条件。 */
    const check = (): void => {
      if (predicate(running.stdout(), running.stderr()))
        finish();
    };
    /** CLI 提前退出时生成带退出码的等待失败。 */
    const closed = (code: number | null): void => finish(new Error(`CLI exited with ${code} while waiting for ${description}.\nstdout:\n${running.stdout()}\nstderr:\n${running.stderr()}`));
    /** 清理所有监听器并只完成一次 Promise。 */
    const finish = (error?: Error): void => {
      clearTimeout(timeout);
      running.child.stdout.off('data', check);
      running.child.stderr.off('data', check);
      running.child.off('close', closed);
      if (error)
        reject(error);
      else
        resolve();
    };
    running.child.stdout.on('data', check);
    running.child.stderr.on('data', check);
    running.child.once('close', closed);
  });
}

/** 等待持续构建最终 Asset 达到预期内容。 */
async function waitForFileContent(file: string, content: string): Promise<void> {
  /** 文件事务交换允许的有限等待截止点。 */
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if ((await fs.readFile(file, 'utf8').catch(() => '')).includes(content))
      return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${path.basename(file)} content; current=${await fs.readFile(file, 'utf8').catch(() => '<missing>')}`);
}

/**
 * 写入可供 validate/inspect/build/dev 共同使用的最小规范工程。
 *
 * @param root 测试工程根目录。
 */
async function writeValidProject(root: string): Promise<void> {
  await fs.mkdir(path.join(root, 'src/skills/hello'), { recursive: true });
  await fs.writeFile(path.join(root, 'acplugin.config.ts'), `${platformImports}
export default {
  name: 'cli-plugin',
  version: '1.0.0',
  description: 'CLI fixture.',
  ${platformField}
};\n`);
  await fs.writeFile(path.join(root, 'src/skills/hello/SKILL.md'), `---
description: Say hello.
---
Say hello.
`);
}

afterEach(async () => {
  for (const child of children)
    child.kill('SIGKILL');
  children.clear();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe.sequential('CLI subprocess contract', () => {
  it('prints Help without prompting and classifies usage errors as exit 2', async () => {
    /** 帮助与参数错误测试使用的空工程根。 */
    const root = await temporaryProject();
    /** 不传子命令时 CLI 返回的帮助输出。 */
    const help = await runCli([], root);
    expect(help).toMatchObject({ code: 0, stderr: '' });
    expect(help.stdout).toContain('Usage: acplugin');
    expect(help.stdout).not.toContain('?');

    /** 旧 --target 参数必须给出迁移到 --platform 的定向用法错误。 */
    const usage = await runCli(['build', '--target', 'unknown'], root);
    expect(usage.code).toBe(2);
    expect(usage.stderr).toContain('--target');
    expect(usage.stderr).toContain('--platform');

    /** option 终止符后的同名文本不得触发旧参数专属错误。 */
    const terminated = await runCli(['build', '--', '--target'], root);
    expect(terminated.stderr).not.toContain('has been removed');
  });

  it('surfaces safe init validation reasons without exposing the internal error type', async () => {
    /** 非空目标用于触发已知且可操作的初始化输入错误。 */
    const root = await temporaryProject();
    await fs.mkdir(path.join(root, 'occupied'));
    await fs.writeFile(path.join(root, 'occupied/keep.txt'), 'keep');
    /** JSON 模式应保留安全原因而不是通用命令失败文本。 */
    const result = await runCli(['init', 'occupied', '--yes', '--json'], root);
    /** CLI 返回的稳定失败报告。 */
    const report = JSON.parse(result.stdout);

    expect(result.code).toBe(1);
    expect(result.stderr).toBe('');
    expect(report).toMatchObject({
      command: 'init',
      success: false,
      diagnostics: [{ code: 'INIT_INVALID', message: 'destination directory is not empty', phase: 'init' }],
    });
  });

  it('emits one JSON document and exit 1 for project configuration errors', async () => {
    /** 缺失配置入口的临时工程根。 */
    const root = await temporaryProject();
    /** JSON 模式下配置加载失败的完整 CLI 结果。 */
    const result = await runCli(['validate', '--json'], root);

    expect(result.code).toBe(1);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: 2,
      success: false,
      diagnostics: [{ code: 'CONFIG_LOAD_FAILED', severity: 'error', phase: 'config' }],
    });
  });

  it('shares the pipeline while only build commits output', async () => {
    /** 四个命令共享 Pipeline 的规范测试工程。 */
    const root = await temporaryProject();
    await writeValidProject(root);

    /** 只验证且不落盘的 validate 子进程结果。 */
    const validate = await runCli(['validate', '--json'], root);
    expect(validate.code).toBe(0);
    expect(JSON.parse(validate.stdout)).toMatchObject({
      command: 'validate',
      success: true,
      committed: false,
      platforms: [{ id: 'claude-code' }, { id: 'codex' }],
    });
    await expect(fs.access(path.join(root, 'dist'))).rejects.toThrow();

    /** 返回 Asset 摘要但不落盘的 inspect 子进程结果。 */
    const inspect = await runCli(['inspect', '--json'], root);
    expect(inspect.code).toBe(0);
    /** inspect 必须额外包含七类可审计对象中的结构化详情。 */
    const inspected = JSON.parse(inspect.stdout);
    expect(inspected).toMatchObject({
      components: [{ kind: 'skill', id: 'hello' }],
      extensions: [],
    });
    expect(inspected.packages.flatMap((unit: { assets: unknown[] }) => unit.assets).length).toBeGreaterThan(0);
    await expect(fs.access(path.join(root, 'dist'))).rejects.toThrow();

    /** 唯一应提交 dist 输出的 build 子进程结果。 */
    const build = await runCli(['build', '--json'], root);
    expect(build.code).toBe(0);
    expect(JSON.parse(build.stdout)).toMatchObject({ success: true, committed: true });
    await fs.access(path.join(root, 'dist/codex/plugin/.codex-plugin/plugin.json'));

    /** --platform 只选择已配置子集，并在成功事务中替换先前完整输出。 */
    const selected = await runCli(['build', '--platform', 'codex', '--json'], root);
    expect(selected.code).toBe(0);
    expect(JSON.parse(selected.stdout)).toMatchObject({ platforms: [{ id: 'claude-code', selected: false }, { id: 'codex', selected: true, success: true }], committed: true });
    await fs.access(path.join(root, 'dist/codex/plugin/.codex-plugin/plugin.json'));
    await expect(fs.access(path.join(root, 'dist/claude-code'))).resolves.toBeUndefined();

    /** 未配置 Platform 由统一配置边界拒绝，而不是按 ID 临时实例化。 */
    const unconfigured = await runCli(['validate', '--platform', 'cursor', '--json'], root);
    expect(unconfigured.code).toBe(1);
    expect(JSON.parse(unconfigured.stdout)).toMatchObject({
      success: false,
      diagnostics: [{ code: 'PLATFORM_SELECTION_INVALID' }],
    });
  });

  it('lazy-loads bundled Migration and validates generated projects through the public pipeline', async () => {
    /** CLI 动态 Migration smoke 使用的临时工作目录。 */
    const root = await temporaryProject();
    /** 包含规范资源、远程 MCP 与未映射内容的固定 Legacy Fixture。 */
    const source = path.resolve(import.meta.dirname, '../fixtures/migration/claude-project');
    /** dry-run 不会创建、但仍必须满足目标边界检查的候选路径。 */
    const destination = path.join(root, 'migrated');

    /** 真实 CLI 必须能加载独立 Migration chunk 及其正式验证 Profile。 */
    const execution = await runCli([
      'migrate',
      source,
      destination,
      '--name',
      'cli-migration',
      '--description',
      'CLI Migration fixture.',
      '--dry-run',
      '--json',
    ], root);
    expect(execution.code).toBe(0);
    expect(JSON.parse(execution.stdout)).toMatchObject({
      schemaVersion: '1',
      success: true,
      dryRun: true,
      projects: ['.'],
    });
    await expect(fs.access(destination)).rejects.toThrow();
  });

  // watch 契约需要等待三次独立构建事件；为测试本身保留足够时间，避免外层默认超时先于状态诊断触发。
  it('retains the last successful dev output, recovers, and exits 130 on SIGINT', async () => {
    /** dev 增量重建测试使用的规范工程根。 */
    const root = await temporaryProject();
    await writeValidProject(root);
    /** 用于触发失败与恢复重建的 Skill 源文件。 */
    const skill = path.join(root, 'src/skills/hello/SKILL.md');
    /** dev 应持续保留最近成功版本的生成文件。 */
    const generated = path.join(root, 'dist/codex/plugin/skills/hello/SKILL.md');
    /** 持续运行并监听文件变化的真实 dev 子进程。 */
    const running = startCli(['dev'], root);

    await waitForOutput(running, stdout => stdout.includes('dev: success'), 'initial dev build');
    /** 首次成功构建后的生成内容快照。 */
    const initial = await fs.readFile(generated, 'utf8');

    await fs.writeFile(skill, 'invalid without frontmatter\n');
    await waitForOutput(running, (_stdout, stderr) => stderr.includes('FRONTMATTER_REQUIRED'), 'failed rebuild diagnostic');
    expect(await fs.readFile(generated, 'utf8')).toBe(initial);

    await fs.writeFile(skill, `---
description: Say hello again.
---
Say hello after recovery.
`);
    await waitForOutput(running, stdout => stdout.match(/dev: success/g)?.length === 2, 'recovery build');
    expect(await fs.readFile(generated, 'utf8')).toContain('Say hello after recovery.');

    running.child.kill('SIGINT');
    /** SIGINT 后进程的最终退出状态与输出。 */
    const stopped = await waitForExit(running);
    expect(stopped.code).toBe(130);
    expect((await fs.readdir(root)).filter(name => name.startsWith('.acplugin-work-'))).toEqual([]);
    expect((await fs.readdir(root)).filter(name => name.includes('.acplugin.lock'))).toEqual([]);
  }, 20_000);

  it('watches the project-local TypeScript config closure and recovers after failure', async () => {
    /** 容纳独立项目和本地配置 helper 的临时 workspace。 */
    const workspace = await temporaryProject();
    /** dev 子进程使用的独立项目根。 */
    const root = path.join(workspace, 'plugin');
    /** Core Module Service 随配置入口 Bundle 并监听的本地 helper。 */
    const helperRoot = path.join(root, 'config');
    /** 修改后应触发配置重新执行的 TypeScript 文件。 */
    const helper = path.join(helperRoot, 'value.ts');
    await fs.mkdir(path.join(root, 'src/skills/hello'), { recursive: true });
    await fs.mkdir(helperRoot, { recursive: true });
    await fs.writeFile(helper, `export const description = 'First local config.';\n`);
    await fs.writeFile(path.join(root, 'acplugin.config.ts'), `${platformImports}
import { description } from './config/value.ts';
export default { name: 'local-config-plugin', version: '1.0.0', description, ${platformField} };
`);
    await fs.writeFile(path.join(root, 'src/skills/hello/SKILL.md'), `---
description: Verify external config watching.
---
Watch the external helper.
`);
    /** 持续监听完整本地配置闭包的真实 dev 子进程。 */
    const running = startCli(['dev'], root);
    /** 构建输出中直接反映配置 description 的 Claude Manifest。 */
    const manifestPath = path.join(root, 'dist/claude-code/plugin/.claude-plugin/plugin.json');

    await waitForOutput(running, stdout => stdout.includes('dev: success'), 'local config initial build');
    /** 首次成功提交的 Manifest，配置失败期间必须保持不变。 */
    const initialManifest = await fs.readFile(manifestPath, 'utf8');
    expect(JSON.parse(initialManifest)).toMatchObject({ description: 'First local config.' });

    await fs.writeFile(helper, 'export const description = ;\n');
    await waitForOutput(running, (_stdout, stderr) => stderr.includes('CONFIG_EVALUATION_FAILED'), 'local config failed rebuild');
    expect(await fs.readFile(manifestPath, 'utf8')).toBe(initialManifest);

    await fs.writeFile(helper, `export const description = 'Second local config.';\n`);
    await waitForOutput(running, stdout => stdout.match(/dev: success/g)?.length === 2, 'local config recovery build');
    expect(JSON.parse(await fs.readFile(manifestPath, 'utf8'))).toMatchObject({ description: 'Second local config.' });

    running.child.kill('SIGINT');
    /** 本地配置依赖恢复后的信号退出状态。 */
    const stopped = await waitForExit(running);
    expect(stopped.code).toBe(130);
  }, 20_000);

  it('rebuilds after initial watcher readiness before publishing the first success', async () => {
    /** 初始 ready 竞态测试使用的规范工程根。 */
    const root = await temporaryProject();
    await writeValidProject(root);
    /** 首次 buildEnd 等待测试进程完成源码修改的显式同步文件。 */
    const release = path.join(root, 'release-initial-build');
    await fs.mkdir(path.join(root, 'src/initial-ready-barrier'), { recursive: true });
    /** ready 窗口内修改且最终产物必须包含新正文的 Skill。 */
    const skill = path.join(root, 'src/skills/hello/SKILL.md');
    /** 构造同步 Extension 时与 CLI Bundle 共享品牌 Symbol 的已构建 Facade。 */
    await fs.writeFile(path.join(root, 'acplugin.config.ts'), `${platformImports}
import { promises as fs } from 'node:fs';
import { defineExtension } from '@tokenroll/acplugin/sdk';
const barrier = defineExtension({
  id: 'initial-ready-barrier',
  apiVersion: '1',
  resourceRoots: ['initial-ready-barrier'],
  createSession: () => ({
    discover: () => ({}),
    validate: () => ({ state: {}, subjects: [] }),
    async build() {
      process.stderr.write('fixture: initial snapshot complete\\n');
      while (true) {
        try { await fs.access(${JSON.stringify(release)}); break; }
        catch { await new Promise(resolve => setTimeout(resolve, 10)); }
      }
      return { state: {} };
    },
    contributors: [{ platform: 'codex', platformApiVersion: '1', contribute: () => ({ compatibility: [] }) }],
  }),
});
export default {
  ${platformField}
  name: 'cli-plugin',
  version: '1.0.0',
  description: 'Initial ready fixture.',
  extensions: [barrier],
  build: { strict: false },
};
`);
    /** 首次成功提示必须等到补偿构建完成的真实 dev 子进程。 */
    const running = startCli(['dev'], root);

    await waitForOutput(running, (_stdout, stderr) => stderr.includes('fixture: initial snapshot complete'), 'initial snapshot barrier');
    await fs.writeFile(skill, `---
description: Changed before watcher readiness.
---
Catch-up source content.
`);
    await fs.writeFile(release, 'continue\n');
    await waitForOutput(running, stdout => stdout.includes('dev: success'), 'catch-up initial dev build');
    /** 首个可公开成功应已包含 ready 窗口内的修改。 */
    const initialGenerated = path.join(root, 'dist/codex/plugin/skills/hello/SKILL.md');
    await waitForFileContent(initialGenerated, 'Catch-up source content.');
    expect(await fs.readFile(initialGenerated, 'utf8')).toContain('Catch-up source content.');

    running.child.kill('SIGINT');
    expect((await waitForExit(running)).code).toBe(130);
  }, 20_000);

  // 配置恢复首次发现的工程根必须完成动态 ready，成功提示才能成为后续修改不会丢失的同步边界。
  it('waits for dynamically discovered paths before reporting a recovered dev build', async () => {
    /** 初始缺失配置、但已经包含合法规范资源的临时工程根。 */
    const root = await temporaryProject();
    /** 配置恢复后立即修改、用于验证动态监听就绪边界的 Skill。 */
    const skill = path.join(root, 'src/skills/hello/SKILL.md');
    /** 恢复构建在登记动态工程根前使用的显式同步文件。 */
    const release = path.join(root, 'release-recovered-build');
    await fs.mkdir(path.join(root, 'src/dynamic-ready-barrier'), { recursive: true });
    await fs.mkdir(path.dirname(skill), { recursive: true });
    await fs.writeFile(skill, `---
description: Say hello after configuration recovery.
---
First recovered build.
`);
    /** 只监听尚不存在配置入口的真实 dev 子进程。 */
    const running = startCli(['dev'], root);

    await waitForOutput(running, (_stdout, stderr) => stderr.includes('CONFIG_LOAD_FAILED'), 'initial missing configuration failure');
    /** 构造恢复同步 Extension 时与 CLI Bundle 共享品牌 Symbol 的已构建 Facade。 */
    await fs.writeFile(path.join(root, 'acplugin.config.ts'), `${platformImports}
import { promises as fs } from 'node:fs';
import { defineExtension } from '@tokenroll/acplugin/sdk';
const barrier = defineExtension({
  id: 'dynamic-ready-barrier',
  apiVersion: '1',
  resourceRoots: ['dynamic-ready-barrier'],
  createSession: () => ({
    discover: () => ({}),
    validate: () => ({ state: {}, subjects: [] }),
    async build() {
      process.stderr.write('fixture: recovered snapshot complete\\n');
      while (true) {
        try { await fs.access(${JSON.stringify(release)}); break; }
        catch { await new Promise(resolve => setTimeout(resolve, 10)); }
      }
      return { state: {} };
    },
    contributors: [{ platform: 'codex', platformApiVersion: '1', contribute: () => ({ compatibility: [] }) }],
  }),
});
export default {
  ${platformField}
  name: 'recovered-plugin',
  version: '1.0.0',
  description: 'Recovered CLI fixture.',
  extensions: [barrier],
  build: { strict: false },
};
`);
    await waitForOutput(running, (_stdout, stderr) => stderr.includes('fixture: recovered snapshot complete'), 'recovered snapshot barrier');
    await fs.writeFile(skill, `---
description: Say hello after dynamic watcher readiness.
---
Second recovered build.
`);
    await fs.writeFile(release, 'continue\n');
    await waitForOutput(running, stdout => stdout.includes('dev: success'), 'recovered catch-up build');
    /** 首次公开成功已经包含动态 ready 窗口内发生的修改。 */
    const generated = path.join(root, 'dist/codex/plugin/skills/hello/SKILL.md');
    await waitForFileContent(generated, 'Second recovered build.');
    expect(await fs.readFile(generated, 'utf8')).toContain('Second recovered build.');

    await fs.writeFile(skill, `---
description: Say hello after active dynamic watching.
---
Third watched build.
`);
    await waitForOutput(running, stdout => stdout.match(/dev: success/g)?.length === 2, 'active dynamic path rebuild');
    await waitForFileContent(generated, 'Third watched build.');
    expect(await fs.readFile(generated, 'utf8')).toContain('Third watched build.');

    running.child.kill('SIGINT');
    /** 动态监听回归场景结束后的信号退出状态。 */
    const stopped = await waitForExit(running);
    expect(stopped.code).toBe(130);
  }, 20_000);

  // signal handler 必须在首次 Pipeline 前安装，初始 discover 未完成时也要等待清理并稳定退出 130。
  it('drains an in-flight initial dev build when signalled before the first success', async () => {
    /** 首次构建 signal 竞态测试使用的规范工程根。 */
    const root = await temporaryProject();
    await writeValidProject(root);
    /** 首次 discover 延迟加载的模拟 Extension 包根。 */
    const extensionRoot = path.join(root, 'src/initial-stopping-extension');
    await fs.mkdir(extensionRoot, { recursive: true });
    await fs.writeFile(path.join(extensionRoot, 'package.json'), '{"name":"initial-stopping-extension","type":"module"}\n');
    /** 首次构建结束前加载、但 signal 后不得再登记监听的 descriptor。 */
    const descriptor = path.join(extensionRoot, 'descriptor.ts');
    await fs.writeFile(descriptor, `export default 'initial-stopping-extension';\n`);
    /** 构造初始延迟 Extension 时与 CLI Bundle 共享品牌 Symbol 的已构建 Facade。 */
    const facade = '@tokenroll/acplugin/sdk';
    await fs.writeFile(path.join(root, 'acplugin.config.ts'), `${platformImports}
import { defineExtension } from '${facade}';
process.stderr.write('fixture: initial dev build started\\n');
const extension = defineExtension({
  id: 'initial-stopping-extension',
  apiVersion: '1',
  resourceRoots: ['initial-stopping-extension'],
  createSession: () => ({
  async discover(context) {
    await new Promise(resolve => setTimeout(resolve, 500));
    const root = await context.roots['initial-stopping-extension'];
    await context.modules.loadDefault({ id: 'initial-stopping-extension', entry: await context.sources.file(root, 'descriptor.ts') });
    return undefined;
  },
  validate: () => ({ state: {}, subjects: [] }),
  build: () => ({ state: {} }),
  contributors: [{ platform: 'codex', platformApiVersion: '1', contribute: () => ({ compatibility: [] }) }],
  }),
});
export default {
  ${platformField}
  name: 'cli-plugin',
  version: '1.0.0',
  description: 'Initial signal cleanup fixture.',
  extensions: [extension],
};
`);
    /** 首次 success 前就会收到 SIGINT 的真实 dev 子进程。 */
    const running = startCli(['dev'], root);

    await waitForOutput(running, (_stdout, stderr) => stderr.includes('fixture: initial dev build started'), 'in-flight initial dev build');
    running.child.kill('SIGINT');
    /** 首次 Pipeline 必须完成清理后稳定返回 130，且不得发布 success。 */
    const stopped = await waitForExit(running);
    expect(stopped.code).toBe(130);
    expect(stopped.stdout).not.toContain('dev: success');
  }, 20_000);

  // signal 可能在动态重建发现新路径之前到达；退出必须等待 Pipeline，并禁止随后注册 watcher 或发布结果。
  it('drains an in-flight dynamic rebuild before closing all dev watchers', async () => {
    /** signal 竞态测试使用的初始规范工程根。 */
    const root = await temporaryProject();
    await writeValidProject(root);
    /** 本轮配置变更才会首次加载的模拟 Extension 包根。 */
    const extensionRoot = path.join(root, 'src/stopping-extension');
    /** 延迟 discover 结束时才会成为动态监听来源的 descriptor。 */
    const descriptor = path.join(extensionRoot, 'descriptor.ts');
    /** 持续运行并将在动态重建期间接收 SIGINT 的真实 dev 子进程。 */
    const running = startCli(['dev'], root);

    await waitForOutput(running, stdout => stdout.includes('dev: success'), 'initial signal fixture build');
    /** 资源根只能在配置声明 owner 的同一次编辑中出现。 */
    await fs.mkdir(extensionRoot, { recursive: true });
    await fs.writeFile(path.join(extensionRoot, 'package.json'), '{"name":"stopping-extension","type":"module"}\n');
    await fs.writeFile(descriptor, `export default 'stopping-extension';\n`);
    /** 构造延迟 Extension 时与 CLI Bundle 共享品牌 Symbol 的已构建 Facade。 */
    const facade = '@tokenroll/acplugin/sdk';
    await fs.writeFile(path.join(root, 'acplugin.config.ts'), `${platformImports}
import { defineExtension } from '${facade}';
process.stderr.write('fixture: dynamic rebuild started\\n');
const extension = defineExtension({
  id: 'stopping-extension',
  apiVersion: '1',
  resourceRoots: ['stopping-extension'],
  createSession: () => ({
  async discover(context) {
    await new Promise(resolve => setTimeout(resolve, 500));
    const root = await context.roots['stopping-extension'];
    await context.modules.loadDefault({ id: 'stopping-extension', entry: await context.sources.file(root, 'descriptor.ts') });
    return undefined;
  },
  validate: () => ({ state: {}, subjects: [] }),
  build: () => ({ state: {} }),
  contributors: [],
  }),
});
export default {
  ${platformField}
  name: 'cli-plugin',
  version: '1.0.0',
  description: 'Signal cleanup fixture.',
  extensions: [extension],
};
`);
    await waitForOutput(running, (_stdout, stderr) => stderr.includes('fixture: dynamic rebuild started'), 'in-flight dynamic rebuild');
    running.child.kill('SIGINT');
    /** signal 必须等待在途 Pipeline 收敛，并最终以 130 退出而不是被新 watcher 挂住。 */
    const stopped = await waitForExit(running);
    expect(stopped.code).toBe(130);
    expect(stopped.stdout.match(/dev: success/g)).toHaveLength(2);
  }, 20_000);

  // Extension descriptor 的已解析依赖位于 node_modules 时，显式包根必须覆盖通用依赖忽略规则。
  it('rebuilds when a loaded Extension descriptor dependency changes', async () => {
    /** descriptor 依赖监听测试使用的规范工程根。 */
    const root = await temporaryProject();
    await writeValidProject(root);
    /** 模拟已安装 Extension 包的源码根。 */
    const extensionRoot = path.join(root, 'src/dev-extension');
    await fs.mkdir(extensionRoot, { recursive: true });
    await fs.writeFile(path.join(extensionRoot, 'package.json'), '{"name":"dev-extension","type":"module"}\n');
    /** descriptor 实际解析的同包依赖文件。 */
    const helper = path.join(extensionRoot, 'helper.ts');
    await fs.writeFile(helper, `export const value = 'first';\n`);
    /** discover 通过共享加载器读取且会记录真实包根的 descriptor。 */
    const descriptor = path.join(extensionRoot, 'descriptor.ts');
    await fs.writeFile(descriptor, `import { value } from './helper.ts';\nexport default value;\n`);
    /** 构造 Extension 时必须与 CLI Bundle 共享品牌 Symbol 的已构建 Facade。 */
    const facade = '@tokenroll/acplugin/sdk';
    await fs.writeFile(path.join(root, 'acplugin.config.ts'), `${platformImports}
import { defineExtension } from '${facade}';
const extension = defineExtension({
  id: 'dev-extension',
  apiVersion: '1',
  resourceRoots: ['dev-extension'],
  createSession: () => ({
  async discover(context) {
    const root = await context.roots['dev-extension'];
    await context.modules.loadDefault({ id: 'dev-extension', entry: await context.sources.file(root, 'descriptor.ts') });
    return undefined;
  },
  validate: () => ({ state: {}, subjects: [] }),
  build: () => ({ state: {} }),
  contributors: [],
  }),
});
export default {
  ${platformField}
  name: 'cli-plugin',
  version: '1.0.0',
  description: 'CLI fixture.',
  extensions: [extension],
};
`);
    /** 持续监听 Extension 包依赖的真实 dev 子进程。 */
    const running = startCli(['dev'], root);

    await waitForOutput(running, stdout => stdout.includes('dev: success'), 'descriptor dev build');
    await fs.writeFile(helper, `export const value = 'second';\n`);
    await waitForOutput(running, stdout => stdout.match(/dev: success/g)?.length === 2, 'descriptor dependency rebuild');

    running.child.kill('SIGINT');
    /** 依赖重建完成后正常响应信号的进程状态。 */
    const stopped = await waitForExit(running);
    expect(stopped.code).toBe(130);
  }, 20_000);

  it('watches dependency files registered by an Extension build graph', async () => {
    /** build graph 监听测试使用的规范工程根。 */
    const root = await temporaryProject();
    await writeValidProject(root);
    /** 位于默认 node_modules 忽略边界内、只能通过 addWatchFile 激活的依赖。 */
    const helper = path.join(root, 'node_modules/build-graph-helper/index.js');
    await fs.mkdir(path.dirname(helper), { recursive: true });
    await fs.writeFile(path.join(path.dirname(helper), 'package.json'), '{"name":"build-graph-helper","version":"1.0.0","type":"module","exports":"./index.js","license":"MIT"}\n');
    await fs.writeFile(path.join(path.dirname(helper), 'LICENSE'), 'Build graph fixture license.\n');
    await fs.writeFile(helper, 'export const value = "first";\n');
    /** Extension compiler 读取且登记依赖图的作者入口。 */
    const entry = path.join(root, 'src/build-graph-extension/entry.ts');
    await fs.mkdir(path.dirname(entry), { recursive: true });
    await fs.writeFile(entry, 'import { value } from "build-graph-helper"; export default value;\n');
    /** 构造测试 Extension 时与 CLI Bundle 共享品牌 Symbol 的已构建 Facade。 */
    const facade = '@tokenroll/acplugin/sdk';
    await fs.writeFile(path.join(root, 'acplugin.config.ts'), `${platformImports}
import { promises as fs } from 'node:fs';
import { defineExtension } from '${facade}';
const extension = defineExtension({
  id: 'build-graph-extension',
  apiVersion: '1',
  resourceRoots: ['build-graph-extension'],
  createSession: () => ({
  async discover(context) {
    const root = context.roots['build-graph-extension'];
    return { entry: await context.sources.file(root, 'entry.ts') };
  },
  validate: (_context, discovered) => ({ state: discovered, subjects: [] }),
  async build(context, validated) {
    await context.compiler.compile({ id: 'build-graph-helper', profile: 'portable-node', entries: { main: { type: 'source', source: validated.entry } } });
    const value = (await fs.readFile(${JSON.stringify(helper)}, 'utf8')).trim().match(/"(.*?)"/)?.[1] ?? '';
    process.stderr.write('fixture: build graph ' + value + '\\n');
    return { state: value };
  },
  contributors: [{ platform: 'codex', platformApiVersion: '1', contribute: () => ({ compatibility: [] }) }],
  }),
});
export default {
  ${platformField}
  name: 'cli-plugin',
  version: '1.0.0',
  description: 'Build graph watch fixture.',
  extensions: [extension],
  build: { strict: false },
};
`);
    /** 持续监听 Extension 明确登记依赖的真实 dev 子进程。 */
    const running = startCli(['dev'], root);

    await waitForOutput(running, stdout => stdout.includes('dev: success'), 'initial build graph build');
    await fs.writeFile(helper, 'export const value = "second";\n');
    await waitForOutput(
      running,
      (stdout, stderr) => stdout.match(/dev: success/g)?.length === 2 && stderr.includes('fixture: build graph second'),
      'registered build graph dependency rebuild',
    );

    running.child.kill('SIGINT');
    expect((await waitForExit(running)).code).toBe(130);
  }, 20_000);

  it('rebuilds a local MCP bundle when its resolved package dependency changes', async () => {
    /** 官方 MCP Rolldown 模块图监听测试使用的规范工程根。 */
    const root = await temporaryProject();
    await writeValidProject(root);
    /** 临时工程按公开包名加载的 MCP Extension 代理目录。 */
    /** 真实 MCP Extension 构建产物入口。 */
    const extensionEntry = path.resolve(import.meta.dirname, '../../extensions/mcp/dist/index.mjs');
    await writePackageProxy(root, '@tokenroll/acplugin-extension-mcp', extensionEntry);
    /** 只通过 Server import graph 可达、且位于默认忽略目录的测试依赖。 */
    const helperPackage = path.join(root, 'node_modules/mcp-watch-helper');
    await fs.mkdir(helperPackage, { recursive: true });
    await fs.writeFile(path.join(helperPackage, 'package.json'), JSON.stringify({
      name: 'mcp-watch-helper', version: '1.0.0', type: 'module', exports: './index.js', license: 'MIT',
    }));
    await fs.writeFile(path.join(helperPackage, 'LICENSE'), 'MCP watch fixture license.\n');
    await fs.writeFile(path.join(helperPackage, 'index.js'), 'export const serverName = "first-server";\n');
    await fs.mkdir(path.join(root, 'src/mcp/local-tools'), { recursive: true });
    await fs.writeFile(path.join(root, 'src/mcp/local-tools/mcp.ts'), `
import type { McpServer } from '@tokenroll/acplugin-extension-mcp';
export default { transport: 'stdio' } satisfies McpServer;
`);
    await fs.writeFile(path.join(root, 'src/mcp/local-tools/server.ts'), `
import { serverName } from 'mcp-watch-helper';
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
    await fs.writeFile(path.join(root, 'acplugin.config.ts'), `${platformImports}
import mcp from '@tokenroll/acplugin-extension-mcp';
export default {
  ${platformField}
  name: 'mcp-watch-plugin',
  version: '1.0.0',
  description: 'MCP bundle watch fixture.',
  extensions: [mcp()],
  build: { strict: false },
};
`);
    /** 持续监听官方 MCP Bundle 模块图的真实 dev 子进程。 */
    const running = startCli(['dev'], root);

    await waitForOutput(running, stdout => stdout.includes('dev: success'), 'initial MCP graph build');
    /** 首次生成的 MCP Server 应内联依赖原始值。 */
    const generated = path.join(root, 'dist/codex/plugin/mcp/local-tools/server.mjs');
    expect(await fs.readFile(generated, 'utf8')).toContain('first-server');
    await fs.writeFile(path.join(helperPackage, 'index.js'), 'export const serverName = "second-server";\n');
    await waitForOutput(running, stdout => stdout.match(/dev: success/g)?.length === 2, 'MCP package dependency rebuild');
    expect(await fs.readFile(generated, 'utf8')).toContain('second-server');

    running.child.kill('SIGINT');
    expect((await waitForExit(running)).code).toBe(130);
  }, 20_000);

  // 目录名 dist 不是固定输出语义；自定义 outDir 后它可以合法承载规范源码或 Public。
  it('watches a custom srcDir named dist while excluding only the resolved outDir', async () => {
    /** 自定义源码与输出目录测试使用的工程根。 */
    const root = await temporaryProject();
    await fs.writeFile(path.join(root, 'package.json'), '{"name":"custom-source-plugin","type":"module"}\n');
    /** 名为 dist 的合法源码目录及其最小 Skill。 */
    const skill = path.join(root, 'dist/skills/hello/SKILL.md');
    await fs.mkdir(path.dirname(skill), { recursive: true });
    await fs.writeFile(skill, `---
description: Say hello from a custom source directory.
---
First custom source build.
`);
    /** 位于工程包内、最近 package root 等于 projectRoot 的本地 descriptor。 */
    const descriptor = path.join(root, 'dist/local-extension/descriptor.ts');
    await fs.mkdir(path.dirname(descriptor), { recursive: true });
    await fs.writeFile(descriptor, `export default 'local';\n`);
    /** 构造本地 Extension 时与 CLI Bundle 共享品牌 Symbol 的已构建 Facade。 */
    const facade = '@tokenroll/acplugin/sdk';
    await fs.writeFile(path.join(root, 'acplugin.config.ts'), `${platformImports}
import { defineExtension } from '${facade}';
const extension = defineExtension({
  id: 'local-extension',
  apiVersion: '1',
  resourceRoots: ['local-extension'],
  createSession: () => ({
  async discover(context) {
    const root = await context.roots['local-extension'];
    await context.modules.loadDefault({ id: 'local-extension', entry: await context.sources.file(root, 'descriptor.ts') });
    return undefined;
  },
  validate: () => ({ state: {}, subjects: [] }),
  build: () => ({ state: {} }),
  contributors: [],
  }),
});
export default {
  ${platformField}
  name: 'custom-source-plugin',
  version: '1.0.0',
  description: 'Custom source fixture.',
  srcDir: 'dist',
  build: { outDir: 'output' },
  extensions: [extension],
};
`);
    /** 只排除解析后 output 的真实 dev 子进程。 */
    const running = startCli(['dev'], root);

    await waitForOutput(running, stdout => stdout.includes('dev: success'), 'custom source dev build');
    /** 把一次编辑拆成跨越基础防抖窗口的两段写入，模拟 macOS FSEvents 的延迟 change。 */
    const skillHandle = await fs.open(skill, 'w');
    try {
      await skillHandle.writeFile(`---
description: Say hello from a custom source directory.
---
Second custom source build.
`);
      await new Promise(resolve => setTimeout(resolve, 70));
      await skillHandle.writeFile('Additional content from the same editor save.\n');
    } finally {
      await skillHandle.close();
    }
    await waitForOutput(running, stdout => stdout.match(/dev: success/g)?.length === 2, 'custom source rebuild');
    /** 第二次重建写入自定义 outDir 的最终 Codex Skill。 */
    const generated = path.join(root, 'output/codex/plugin/skills/hello/SKILL.md');
    expect(await fs.readFile(generated, 'utf8')).toContain('Second custom source build.');
    // 等待可能由 outDir 交换错误触发的额外事件，确认监听不会形成自激重建循环。
    await new Promise(resolve => setTimeout(resolve, 250));
    expect(running.stdout().match(/dev: success/g)).toHaveLength(2);

    running.child.kill('SIGINT');
    /** 自定义目录重建完成后的信号退出状态。 */
    const stopped = await waitForExit(running);
    expect(stopped.code).toBe(130);
  }, 20_000);

  // JSON dev 需要跨多次重建保持 stdout 为空，直到退出时才能形成一个完整文档。
  it('emits exactly one final JSON document after multiple dev rebuilds', async () => {
    /** JSON dev 流测试使用的规范工程根。 */
    const root = await temporaryProject();
    await writeValidProject(root);
    /** 触发第二次成功重建的 Skill 源文件。 */
    const skill = path.join(root, 'src/skills/hello/SKILL.md');
    /** JSON 模式持续运行的真实 dev 子进程。 */
    const running = startCli(['dev', '--json'], root);

    await waitForOutput(running, (_stdout, stderr) => stderr.includes('dev: success'), 'initial JSON dev build');
    expect(running.stdout()).toBe('');
    await fs.writeFile(skill, `---
description: Say hello in JSON mode.
---
Say hello after a JSON rebuild.
`);
    await waitForOutput(running, (_stdout, stderr) => stderr.match(/dev: success/g)?.length === 2, 'second JSON dev build');
    expect(running.stdout()).toBe('');

    running.child.kill('SIGINT');
    /** SIGINT 后只包含最终 BuildReport 的进程输出。 */
    const stopped = await waitForExit(running);
    expect(stopped.code).toBe(130);
    expect(JSON.parse(stopped.stdout)).toMatchObject({ command: 'dev', success: true, committed: true });
  }, 20_000);
});
