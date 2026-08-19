import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DevSession, SourceFileRef } from '../src/kernel-types.js';
import { defineExtension, definePlatform } from '../src/kernel-contracts.js';
import { resolveKernelConfig } from '../src/kernel/config-resolver.js';
import { createDevSession, type DevSessionRoundInput } from '../src/kernel/dev-session.js';

/** 当前套件创建的工程和外部 package 根。 */
const roots: string[] = [];

/** createDevSession 实际使用的最小、可故障注入 FSWatcher。 */
class FaultWatcher extends EventEmitter {
  /** 当前物理 watcher 已登记的精确路径。 */
  readonly paths = new Set<string>();
  failAdd = false;
  failUnwatch = false;
  failGetWatched = false;
  hideWatched = false;
  failClose = false;

  constructor(paths: string | readonly string[]) {
    super();
    this.addPaths(paths);
    queueMicrotask(() => this.emit('ready'));
  }

  /** 不经过 fault flag 的内部初始登记。 */
  private addPaths(input: string | readonly string[]): void {
    for (const candidate of typeof input === 'string' ? [input] : input)
      this.paths.add(path.resolve(candidate));
  }

  /** 模拟 Chokidar 同步 add。 */
  add(input: string | readonly string[]): this {
    if (this.failAdd)
      throw new Error('injected watcher add failure');
    this.addPaths(input);
    return this;
  }

  /** 模拟 Chokidar 异步 unwatch。 */
  async unwatch(input: string | readonly string[]): Promise<this> {
    if (this.failUnwatch)
      throw new Error('injected watcher unwatch failure');
    for (const candidate of typeof input === 'string' ? [input] : input)
      this.paths.delete(path.resolve(candidate));
    return this;
  }

  /** 为 readiness 检查生成 directory → direct child 快照。 */
  getWatched(): Record<string, string[]> {
    if (this.failGetWatched)
      throw new Error('injected watcher getWatched failure');
    if (this.hideWatched)
      return {};
    const watched: Record<string, string[]> = {};
    for (const candidate of this.paths) {
      const directory = path.dirname(candidate);
      (watched[directory] ??= []).push(path.basename(candidate));
    }
    return watched;
  }

  /** close 可以失败，但不改变 DevSession 必须发布的终态。 */
  async close(): Promise<void> {
    if (this.failClose)
      throw new Error('injected watcher close failure');
  }

  /** 向 DevSession 发布一个真实 Chokidar all event。 */
  change(file: string): void {
    this.emit('all', 'change', path.resolve(file));
  }
}

/** watcher graph 是否包含外部 package 的可变 fixture 开关。 */
interface FixtureControl {
  compileExternal: boolean;
}

/** 创建直接调用私有 Core coordinator 的确定性 dev fixture。 */
async function fixture(initialExternal = false): Promise<{
  readonly root: string;
  readonly command: string;
  readonly control: FixtureControl;
  readonly input: DevSessionRoundInput;
  watcher(): FaultWatcher;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-dev-fault-'));
  roots.push(root);
  const packageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-dev-fault-package-'));
  roots.push(packageRoot);
  await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
    name: 'dev-fault-package', version: '1.0.0', type: 'module', exports: './index.js', license: 'MIT',
  }));
  await fs.writeFile(path.join(packageRoot, 'index.js'), 'export const value = true;\n');
  await fs.writeFile(path.join(packageRoot, 'LICENSE'), 'Dev fault package license.\n');
  await fs.mkdir(path.join(root, 'src/commands'), { recursive: true });
  await fs.mkdir(path.join(root, 'src/probe'), { recursive: true });
  await fs.mkdir(path.join(root, 'node_modules'), { recursive: true });
  await fs.writeFile(path.join(root, 'acplugin.config.ts'), 'export default {};\n');
  const command = path.join(root, 'src/commands/review.md');
  await fs.writeFile(command, '---\ndescription: Review.\n---\nReview.\n');
  await fs.writeFile(path.join(root, 'src/probe/entry.ts'), 'export { value } from "dev-fault-package";\n');
  await fs.symlink(packageRoot, path.join(root, 'node_modules/dev-fault-package'), 'dir');
  const control: FixtureControl = { compileExternal: initialExternal };
  const platform = definePlatform({
    id: 'dev-fault', apiVersion: '1', deliveryType: 'plugin',
    createSession: () => ({
      createPackage: ({ project }) => ({
        documents: [], assets: [],
        compatibility: project.commands.map(item => ({
          subject: `command:${item.id}`, capability: 'component', level: 'native' as const, reason: 'Native command.',
        })),
        metadata: ['name', 'version', 'description'].map(field => ({
          field, disposition: 'emitted' as const, output: `manifest/${field}`, reason: 'Emitted metadata.',
        })),
      }),
      finalizePackage: () => ({ id: 'plugin', type: 'plugin' as const }),
      validatePackage: () => undefined,
    }),
  });
  const extension = defineExtension<Record<string, never>, { readonly entry: SourceFileRef }, { readonly entry: SourceFileRef }, Record<string, never>>({
    id: 'dev-fault-extension', apiVersion: '1', resourceRoots: ['probe'],
    createSession: () => ({
      discover: async context => ({ entry: await context.sources.file(context.roots.probe!, 'entry.ts') }),
      validate: (_context, state) => ({ state, subjects: [] }),
      async build(context, state) {
        if (control.compileExternal) {
          await context.compiler.compile({
            id: 'external', profile: 'portable-node', entries: { main: { type: 'source', source: state.entry } },
          });
        }
        return { state: {} };
      },
      contributors: [{
        platform: 'dev-fault', platformApiVersion: '1', contribute: () => ({ compatibility: [] }),
      }],
    }),
  });
  let currentWatcher: FaultWatcher | undefined;
  /** 仅 Core 内部测试替换实际 Chokidar 工厂。 */
  const watchFactory = ((paths: string | readonly string[]) => {
    currentWatcher = new FaultWatcher(paths);
    return currentWatcher;
  }) as unknown as NonNullable<DevSessionRoundInput['watchFactory']>;
  const input: DevSessionRoundInput = {
    projectRoot: root,
    configFile: path.join(root, 'acplugin.config.ts'),
    frameworkVersion: 'test',
    options: { mode: 'development', commit: false },
    watchFactory,
    watchReadyTimeoutMs: 20,
    loadConfig: async () => {
      const resolved = resolveKernelConfig({
        name: 'dev-fault', version: '1.0.0', description: 'Dev watcher fault fixture.',
        platforms: [platform], extensions: [extension], public: false,
      }, {
        projectRoot: root,
        configFile: path.join(root, 'acplugin.config.ts'),
        command: 'dev',
        mode: 'development',
      });
      if (resolved.config === undefined)
        throw new Error('Fixture config failed.');
      return resolved.config;
    },
  };
  return {
    root,
    command,
    control,
    input,
    watcher: () => currentWatcher!,
  };
}

/** 等待下一次公开 build-complete。 */
function nextComplete(session: DevSession): Promise<Extract<import('../src/kernel-types.js').DevSessionEvent, { readonly type: 'build-complete' }>> {
  return new Promise((resolve) => {
    const unsubscribe = session.subscribe((event) => {
      if (event.type === 'build-complete') {
        unsubscribe();
        resolve(event);
      }
    });
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe('DevSession watcher fault boundaries', () => {
  it.each(['add', 'getWatched', 'readiness'] as const)('pairs start/complete and reports an injected %s failure', async (failure) => {
    const current = await fixture(false);
    const session = await createDevSession(current.input);
    const watcher = current.watcher();
    if (failure === 'add') watcher.failAdd = true;
    if (failure === 'getWatched') watcher.failGetWatched = true;
    if (failure === 'readiness') watcher.hideWatched = true;
    current.control.compileExternal = true;
    /** 同一 sequence 的公开事件必须在 watcher I/O 失败时仍成对。 */
    const events: import('../src/kernel-types.js').DevSessionEvent[] = [];
    session.subscribe(event => events.push(event));
    const complete = nextComplete(session);
    watcher.change(current.command);
    const result = await complete;

    expect(result.report.success).toBe(false);
    expect(result.report.diagnostics).toContainEqual(expect.objectContaining({ code: 'DEV_WATCH_FAILED', phase: 'dev' }));
    expect(events.filter(event => event.type === 'build-start')).toHaveLength(1);
    expect(events.filter(event => event.type === 'build-complete')).toHaveLength(1);
    expect(events[0]?.sequence).toBe(events[1]?.sequence);
    await session.close();
    await session.closed;
  });

  it('keeps logical state uncommitted when unwatch rejects', async () => {
    const current = await fixture(true);
    const session = await createDevSession(current.input);
    const watcher = current.watcher();
    current.control.compileExternal = false;
    watcher.failUnwatch = true;
    const complete = nextComplete(session);
    watcher.change(current.command);

    const result = await complete;
    expect(result.report.success).toBe(false);
    expect(result.report.diagnostics).toContainEqual(expect.objectContaining({ code: 'DEV_WATCH_FAILED' }));
    await session.close();
  });

  it('settles closed and emits one terminal event before surfacing close failure', async () => {
    const current = await fixture(false);
    const session = await createDevSession(current.input);
    current.watcher().failClose = true;
    /** 显式观察 close rejection，防止测试本身制造 unhandledRejection。 */
    const events: import('../src/kernel-types.js').DevSessionEvent[] = [];
    session.subscribe(event => events.push(event));
    const close = session.close();

    await expect(close).rejects.toThrow('DevSession cleanup failed');
    await expect(session.closed).resolves.toBeUndefined();
    expect(events.filter(event => event.type === 'closed')).toHaveLength(1);
    expect(session.close()).toBe(close);
  });
});
