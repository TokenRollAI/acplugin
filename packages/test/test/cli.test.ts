import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const cli = path.resolve(import.meta.dirname, '../../acplugin/dist/cli.mjs');
const roots: string[] = [];
const children = new Set<ChildProcessWithoutNullStreams>();

interface RunningCli {
  child: ChildProcessWithoutNullStreams;
  stdout(): string;
  stderr(): string;
}

async function temporaryProject(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-cli-test-'));
  roots.push(root);
  return root;
}

function startCli(args: readonly string[], cwd: string): RunningCli {
  const child = spawn(process.execPath, [cli, ...args], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, NO_COLOR: '1' },
  });
  children.add(child);
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => stdout += chunk);
  child.stderr.setEncoding('utf8').on('data', chunk => stderr += chunk);
  child.once('close', () => children.delete(child));
  return { child, stdout: () => stdout, stderr: () => stderr };
}

async function waitForExit(running: RunningCli): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const code = await new Promise<number | null>((resolve, reject) => {
    running.child.once('error', reject);
    running.child.once('close', resolve);
  });
  return { code, stdout: running.stdout(), stderr: running.stderr() };
}

async function runCli(args: readonly string[], cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const running = startCli(args, cwd);
  running.child.stdin.end();
  return waitForExit(running);
}

async function waitForOutput(
  running: RunningCli,
  predicate: (stdout: string, stderr: string) => boolean,
  description: string,
): Promise<void> {
  if (predicate(running.stdout(), running.stderr()))
    return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error(`Timed out waiting for ${description}.\nstdout:\n${running.stdout()}\nstderr:\n${running.stderr()}`)), 10_000);
    const check = (): void => {
      if (predicate(running.stdout(), running.stderr()))
        finish();
    };
    const closed = (code: number | null): void => finish(new Error(`CLI exited with ${code} while waiting for ${description}.`));
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
