import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { afterEach, describe, expect, it } from 'vitest';
import type { AssetMode, GeneratedAssetRef } from '../src/kernel-types.js';
import { CompilerHost } from '../src/compiler/compiler-host.js';
import { AssetRegistry } from '../src/kernel/asset-registry.js';
import { BuildSessionScope } from '../src/kernel/build-session-scope.js';
import { ExecutionHost } from '../src/kernel/execution-host.js';
import { SourceRegistry } from '../src/kernel/source-registry.js';
import { WatchRegistry } from '../src/kernel/watch-registry.js';
import { WorkDirectoryRegistry } from '../src/kernel/work-directories.js';

/** Execution Host 测试创建的临时工程根。 */
const roots: string[] = [];

/**
 * 创建 Compiler + Execution 共用的一轮 BuildSession。
 *
 * @param code portable-node 测试程序。
 * @param mode 入口 Asset mode。
 * @param id 编译 Job ID。
 * @returns 已签发入口和 owner-scoped Execution service。
 */
async function fixture(code: string, mode: AssetMode = 0o755, id = 'execution-job') {
  /** 当前测试独占工程根。 */
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-execution-host-'));
  roots.push(root);
  /** portable 作者源码 root。 */
  const sourceRoot = path.join(root, 'src', 'runtime');
  await fs.mkdir(sourceRoot, { recursive: true });
  await fs.writeFile(path.join(sourceRoot, 'main.ts'), code);
  /** 当前 BuildSession registries。 */
  const scope = new BuildSessionScope();
  const owner = 'extension:fixture';
  const sources = new SourceRegistry(scope, root);
  const work = new WorkDirectoryRegistry(scope, path.join(root, '.work'));
  const assets = new AssetRegistry(scope, sources, work);
  const watch = new WatchRegistry(scope, root);
  /** 当前 owner 作者来源入口。 */
  const directory = await sources.issueRoot(owner, sourceRoot);
  const entry = await sources.service(owner).file(directory, 'main.ts');
  /** 用真实 portable Profile 生成 Execution Host 唯一接受的 Asset。 */
  const compiler = new CompilerHost({ projectRoot: root, sources, workDirectories: work, assets, watch });
  const result = await (await compiler.service(owner)).compile({
    id,
    profile: 'portable-node',
    entries: { main: { type: 'source', source: entry, mode } },
  });
  /** portable 单入口生成的 main Chunk。 */
  const asset = result.outputs.find(output => output.type === 'chunk')!.asset;
  /** owner 物理根只供 Core 测试验证 cleanup。 */
  const handle = await work.directory(owner);
  const ownerWorkRoot = work.physicalRoot(owner, handle);
  /** 当前 BuildSession 唯一 Execution Host。 */
  const host = new ExecutionHost({ assets, workDirectories: work });
  return { root, owner, ownerWorkRoot, work, assets, asset, service: host.service(owner), other: host.service('extension:other') };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe('ExecutionHost', () => {
  it('runs portable Node with literal args/stdin, minimal env and preserved mode', async () => {
    /** 测试程序只观察显式输入和自身物化 mode。 */
    const current = await fixture([
      'import { statSync } from "node:fs";',
      'const chunks: Buffer[] = [];',
      'for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));',
      'process.stdout.write(JSON.stringify({',
      '  args: process.argv.slice(2),',
      '  stdin: Buffer.concat(chunks).toString("utf8"),',
      '  visible: process.env.VISIBLE ?? null,',
      '  inherited: process.env.ACPLUGIN_TEST_SECRET ?? null,',
      '  mode: statSync(new URL(import.meta.url)).mode & 0o777,',
      '}));',
    ].join('\n'), 0o644);
    /** 宿主 secret 绝不能被最小环境继承。 */
    const previous = process.env.ACPLUGIN_TEST_SECRET;
    process.env.ACPLUGIN_TEST_SECRET = 'must-not-leak';
    try {
      const result = await current.service.runNode({
        entry: current.asset,
        args: ['--literal', 'value with spaces'],
        stdin: 'payload\n',
        timeoutMs: 5_000,
        maxOutputBytes: 16_384,
        environment: { VISIBLE: 'explicit' },
      });
      expect(result.status).toBe('exited');
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(new TextDecoder().decode(result.stdout))).toEqual({
        args: ['--literal', 'value with spaces'],
        stdin: 'payload\n',
        visible: 'explicit',
        inherited: null,
        mode: 0o644,
      });
    } finally {
      if (previous === undefined)
        delete process.env.ACPLUGIN_TEST_SECRET;
      else
        process.env.ACPLUGIN_TEST_SECRET = previous;
    }
    await expect(fs.access(path.join(current.ownerWorkRoot, 'execution', '1'))).rejects.toThrow();
  });

  it('returns stable nonzero, signal, timeout and shared output-limit results', async () => {
    /** 非零退出仍是可检查的稳定 result。 */
    const failed = await fixture('process.stderr.write("failure"); process.exitCode = 7;', 0o755, 'nonzero-job');
    await expect(failed.service.runNode({ entry: failed.asset, timeoutMs: 5_000, maxOutputBytes: 1024 })).resolves.toMatchObject({
      status: 'exited',
      exitCode: 7,
      signal: null,
    });

    /** 固定 timeout 必须终止并返回脱敏状态。 */
    const timed = await fixture('setInterval(() => undefined, 1_000);', 0o755, 'timeout-job');
    await expect(timed.service.runNode({ entry: timed.asset, timeoutMs: 50, maxOutputBytes: 1024 })).resolves.toMatchObject({
      status: 'timed-out',
      exitCode: null,
    });

    /** stdout/stderr 共享同一个输出预算，越界 chunk 不进入返回值。 */
    const output = await fixture('process.stdout.write("x".repeat(2048)); process.stderr.write("y".repeat(2048));', 0o755, 'output-job');
    const limited = await output.service.runNode({ entry: output.asset, timeoutMs: 5_000, maxOutputBytes: 128 });
    expect(limited.status).toBe('output-limit');
    expect(limited.stdout.byteLength + limited.stderr.byteLength).toBeLessThanOrEqual(128);

    if (process.platform !== 'win32') {
      /** POSIX 自发 signal 必须与 timeout 明确区分。 */
      const signaled = await fixture('process.kill(process.pid, "SIGTERM");', 0o755, 'signal-job');
      await expect(signaled.service.runNode({ entry: signaled.asset, timeoutMs: 5_000, maxOutputBytes: 1024 })).resolves.toMatchObject({
        status: 'signaled',
        signal: 'SIGTERM',
      });
    }
  });

  it('rejects forged, cross-owner, non-chunk and unsafe environment inputs', async () => {
    /** 当前合法 portable entry。 */
    const current = await fixture('export {};');
    /** 复制公开字段不能伪造 Registry identity。 */
    const forged = Object.freeze({ ...current.asset }) as GeneratedAssetRef;
    await expect(current.service.runNode({ entry: forged, timeoutMs: 1_000, maxOutputBytes: 1024 })).rejects.toThrow('not authorized');
    await expect(current.other.runNode({ entry: current.asset, timeoutMs: 1_000, maxOutputBytes: 1024 })).rejects.toThrow('not authorized');
    await expect(current.service.runNode({
      entry: current.asset,
      timeoutMs: 1_000,
      maxOutputBytes: 1024,
      environment: { NODE_OPTIONS: '--require=./inject.cjs' },
    })).rejects.toThrow('unsafe');

    /** 由 Core 签发但 provenance kind 不是 chunk 的 Asset。 */
    const handle = await current.work.directory(current.owner);
    const licenseFile = current.work.resolve(current.owner, handle, 'manual/licenses.txt');
    await fs.mkdir(path.dirname(licenseFile), { recursive: true });
    await fs.writeFile(licenseFile, 'license\n');
    const licenses = await current.assets.issueGenerated(current.owner, handle, 'manual/licenses.txt', 0o644, {
      job: 'portable-job',
      output: 'main',
      profile: 'portable-node',
      kind: 'licenses',
      inputs: ['src/runtime/main.ts'],
    });
    await expect(current.service.runNode({ entry: licenses, timeoutMs: 1_000, maxOutputBytes: 1024 })).rejects.toThrow('generated chunk');
  });

  it('cleans the isolated execution root when pre-spawn materialization fails', async () => {
    /** 当前合法 portable entry 及其可预测 Compiler work 文件。 */
    const current = await fixture('export {};', 0o755, 'mutation-job');
    const generated = path.join(current.ownerWorkRoot, 'compile', 'mutation-job', 'main', 'main.mjs');
    await fs.writeFile(generated, 'mutated after issuance\n');

    await expect(current.service.runNode({ entry: current.asset, timeoutMs: 1_000, maxOutputBytes: 1024 })).rejects.toThrow('changed after');
    await expect(fs.access(path.join(current.ownerWorkRoot, 'execution', '1'))).rejects.toThrow();
  });
});
