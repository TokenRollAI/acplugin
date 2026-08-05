import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/** 构建后 CLI 入口的绝对路径，用于真实子进程契约测试。 */
const cli = path.resolve(import.meta.dirname, '../../acplugin/dist/cli.mjs');
/** 当前测试创建并在 afterEach 中统一删除的临时工程目录。 */
const roots: string[] = [];
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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-cli-test-'));
  roots.push(root);
  return root;
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
  return { child, stdout: () => stdout, stderr: () => stderr };
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
    const closed = (code: number | null): void => finish(new Error(`CLI exited with ${code} while waiting for ${description}.`));
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

/**
 * 写入可供 validate/inspect/build/dev 共同使用的最小规范工程。
 *
 * @param root 测试工程根目录。
 */
async function writeValidProject(root: string): Promise<void> {
  await fs.mkdir(path.join(root, 'src/skills/hello'), { recursive: true });
  await fs.writeFile(path.join(root, 'acplugin.config.ts'), `export default {
  name: 'cli-plugin',
  version: '1.0.0',
  description: 'CLI fixture.',
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
    const root = await temporaryProject();
    const help = await runCli([], root);
    expect(help).toMatchObject({ code: 0, stderr: '' });
    expect(help.stdout).toContain('Usage: acplugin');
    expect(help.stdout).not.toContain('?');

    const usage = await runCli(['build', '--target', 'unknown'], root);
    expect(usage.code).toBe(2);
    expect(usage.stderr).toContain('Allowed choices are claude-code, codex');
  });

  it('emits one JSON document and exit 1 for project configuration errors', async () => {
    const root = await temporaryProject();
    const result = await runCli(['validate', '--json'], root);

    expect(result.code).toBe(1);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: '1',
      command: 'validate',
      success: false,
      diagnostics: [{ code: 'CONFIG_LOAD_FAILED', severity: 'error', phase: 'config' }],
    });
  });

  it('shares the pipeline while only build commits output', async () => {
    const root = await temporaryProject();
    await writeValidProject(root);

    const validate = await runCli(['validate', '--json'], root);
    expect(validate.code).toBe(0);
    expect(JSON.parse(validate.stdout)).toMatchObject({ success: true, committed: false, artifacts: [] });
    await expect(fs.access(path.join(root, 'dist'))).rejects.toThrow();

    const inspect = await runCli(['inspect', '--json'], root);
    expect(inspect.code).toBe(0);
    expect(JSON.parse(inspect.stdout).artifacts.length).toBeGreaterThan(0);
    await expect(fs.access(path.join(root, 'dist'))).rejects.toThrow();

    const build = await runCli(['build', '--json'], root);
    expect(build.code).toBe(0);
    expect(JSON.parse(build.stdout)).toMatchObject({ success: true, committed: true });
    await fs.access(path.join(root, 'dist/codex/.codex-plugin/plugin.json'));
  });

  it('retains the last successful dev output, recovers, and exits 130 on SIGINT', async () => {
    const root = await temporaryProject();
    await writeValidProject(root);
    const skill = path.join(root, 'src/skills/hello/SKILL.md');
    const generated = path.join(root, 'dist/codex/skills/hello/SKILL.md');
    const running = startCli(['dev', '--no-strict'], root);

    await waitForOutput(running, stdout => stdout.includes('dev: success'), 'initial dev build');
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
    const stopped = await waitForExit(running);
    expect(stopped.code).toBe(130);
    expect((await fs.readdir(root)).filter(name => name.startsWith('.acplugin-work-'))).toEqual([]);
    expect((await fs.readdir(root)).filter(name => name.includes('.acplugin.lock'))).toEqual([]);
  });
});
