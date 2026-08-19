import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  defineExtension,
  definePlatform,
  type ManagedRolldownPlugin,
  type SourceFileRef,
} from '@acplugin/core/kernel-sdk';
import { createProject } from '../src/project.js';

/** DevSession 程序化测试统一清理的临时工程根。 */
const roots: string[] = [];

/** 配置 Module 与测试进程共享 Platform 的稳定全局键。 */
const PLATFORM_KEY = Symbol.for('tokenroll.acplugin.dev-session-test-platform');

/** 配置 Module 与测试进程共享 Extension 的稳定全局键。 */
const EXTENSION_KEY = Symbol.for('tokenroll.acplugin.dev-session-test-extension');

/** 在动态 rebuild 中建立 close 竞态的测试控制器。 */
interface DevControl {
  round: number;
  readonly started: Promise<void>;
  start(): void;
  readonly gate: Promise<void>;
  release(): void;
}

afterEach(async () => {
  Reflect.deleteProperty(globalThis, PLATFORM_KEY);
  Reflect.deleteProperty(globalThis, EXTENSION_KEY);
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

/** @returns 可在第二轮 Platform package 阶段暂停的程序化工程。 */
async function fixture(options: { readonly pauseSecond?: boolean; readonly extension?: unknown } = {}): Promise<{ readonly root: string; readonly control: DevControl }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-dev-session-'));
  roots.push(root);
  await fs.mkdir(path.join(root, 'src', 'commands'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'commands', 'review.md'), [
    '---', 'description: Review changes.', '---', 'Review the initial change.', '',
  ].join('\n'));
  /** 第二轮进入 Platform package 阶段时通知测试。 */
  let notifyStarted!: () => void;
  /** close() 发起后才允许第二轮完成。 */
  let releaseGate!: () => void;
  const control: DevControl = {
    round: 0,
    started: new Promise<void>((resolve) => { notifyStarted = resolve; }),
    start: notifyStarted,
    gate: new Promise<void>((resolve) => { releaseGate = resolve; }),
    release: releaseGate,
  };
  Reflect.set(globalThis, PLATFORM_KEY, definePlatform({
    id: 'dev-api',
    apiVersion: '1',
    deliveryType: 'plugin',
    createSession: () => ({
      async createPackage({ project }) {
        control.round += 1;
        if (control.round === 2 && options.pauseSecond !== false) {
          control.start();
          await control.gate;
        }
        return {
          documents: [],
          assets: [],
          compatibility: project.commands.map(command => ({
            subject: `command:${command.id}`, capability: 'component', level: 'native', reason: 'Native command.',
          })),
          metadata: ['name', 'version', 'description'].map(field => ({
            field, disposition: 'emitted', output: `manifest/${field}`, reason: 'Emitted metadata.',
          })),
        };
      },
      finalizePackage: () => ({ id: 'plugin', type: 'plugin' }),
      validatePackage: () => undefined,
    }),
  }));
  if (options.extension !== undefined)
    Reflect.set(globalThis, EXTENSION_KEY, options.extension);
  await fs.writeFile(path.join(root, 'acplugin.config.ts'), `
const platform = globalThis[Symbol.for('tokenroll.acplugin.dev-session-test-platform')];
const extension = globalThis[Symbol.for('tokenroll.acplugin.dev-session-test-extension')];
export default {
  name: 'dev-api', version: '1.0.0', description: 'Programmatic DevSession fixture.', platforms: [platform],
  extensions: extension === undefined ? [] : [extension],
};
`);
  return { root, control };
}

/** @returns 下一次公开 build-complete，并在命中后自动取消订阅。 */
function nextBuildComplete(session: Awaited<ReturnType<ReturnType<typeof createProject>['dev']>>) {
  return new Promise<Extract<import('@acplugin/core/kernel-author').DevSessionEvent, { readonly type: 'build-complete' }>>((resolve) => {
    const unsubscribe = session.subscribe((event) => {
      if (event.type === 'build-complete') {
        unsubscribe();
        resolve(event);
      }
    });
  });
}

/** @returns start 中包含指定逻辑 identity 的同 sequence 完成事件。 */
function nextBuildForChange(
  session: Awaited<ReturnType<ReturnType<typeof createProject>['dev']>>,
  identity: string,
) {
  return new Promise<Extract<import('@acplugin/core/kernel-author').DevSessionEvent, { readonly type: 'build-complete' }>>((resolve) => {
    /** 只有明确匹配的 start sequence 才能完成当前等待。 */
    const matching = new Set<number>();
    const unsubscribe = session.subscribe((event) => {
      if (event.type === 'build-start' && event.changes.includes(identity))
        matching.add(event.sequence);
      if (event.type === 'build-complete' && matching.has(event.sequence)) {
        unsubscribe();
        resolve(event);
      }
    });
  });
}

describe('DevSession API', () => {
  it('pairs an active rebuild with build-complete and one closed event while removing a failed listener', async () => {
    const current = await fixture();
    const session = await createProject({ cwd: current.root }).dev();
    /** initial ready 只通过 resolve/current 表达，不发布不可订阅事件。 */
    const initial = session.current;
    /** 抛错 listener 只能被调用一次，随后由 Core 自动移除。 */
    let failedListenerCalls = 0;
    session.subscribe(() => {
      failedListenerCalls += 1;
      throw new Error('listener failure');
    });
    /** 正常 listener 记录完整公开事件序列。 */
    const events: import('@acplugin/core/kernel-author').DevSessionEvent[] = [];
    session.subscribe(event => events.push(event));

    await fs.writeFile(path.join(current.root, 'src', 'commands', 'review.md'), [
      '---', 'description: Review changes again.', '---', 'Review the rebuilt change.', '',
    ].join('\n'));
    await current.control.started;
    /** 两次 close 必须共享同一个关闭任务且不抑制在途轮事件。 */
    const firstClose = session.close();
    const secondClose = session.close();
    expect(secondClose).toBe(firstClose);
    current.control.release();
    await firstClose;
    await session.closed;

    expect(events.map(event => event.type)).toEqual(['build-start', 'build-complete', 'closed']);
    expect(events.map(event => event.sequence)).toEqual([1, 1, 1]);
    expect(failedListenerCalls).toBe(1);
    expect(session.current).not.toBe(initial);
    expect(session.current).toMatchObject({ command: 'dev', success: true, committed: true });
  }, 10_000);

  it('keeps a failed-round external graph and reports its stable package identity on recovery', async () => {
    /** 外部 package root 模拟 pnpm store/workspace package 的真实物理位置。 */
    const packageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-dev-external-package-'));
    roots.push(packageRoot);
    await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
      name: 'recovery-package', version: '1.0.0', type: 'module', exports: './index.js', license: 'MIT',
    }));
    await fs.writeFile(path.join(packageRoot, 'LICENSE'), 'Recovery package license.\n');
    const packageEntry = path.join(packageRoot, 'index.js');
    await fs.writeFile(packageEntry, 'export const value = "first";\n');
    /** 初始轮跳过 Compiler，失败轮才首次发现外部依赖。 */
    const recovery = { enabled: false, fail: false };
    const extension = defineExtension<Record<string, never>, { readonly entry: SourceFileRef }, { readonly entry: SourceFileRef }, Record<string, never>>({
      id: 'recovery',
      apiVersion: '1',
      resourceRoots: ['recovery'],
      createSession: () => ({
        async discover(context) {
          return { entry: await context.sources.file(context.roots.recovery!, 'entry.ts') };
        },
        validate: (_context, discovered) => ({ state: discovered, subjects: [] }),
        async build(context, validated) {
          if (!recovery.enabled)
            return { state: {} };
          await context.compiler.compile({
            id: 'recovery-package',
            profile: 'portable-node',
            entries: { main: { type: 'source', source: validated.entry } },
          });
          if (recovery.fail)
            throw new Error('intentional failed round');
          return { state: {} };
        },
        contributors: [{
          platform: 'dev-api',
          platformApiVersion: '1',
          contribute: () => ({ compatibility: [] }),
        }],
      }),
    });
    const current = await fixture({ pauseSecond: false, extension });
    await fs.mkdir(path.join(current.root, 'src', 'recovery'), { recursive: true });
    await fs.writeFile(path.join(current.root, 'src', 'recovery', 'entry.ts'), 'export { value } from "recovery-package";\n');
    await fs.mkdir(path.join(current.root, 'node_modules'), { recursive: true });
    await fs.symlink(packageRoot, path.join(current.root, 'node_modules', 'recovery-package'), 'dir');
    const session = await createProject({ cwd: current.root }).dev();
    /** 下一轮启用 Compiler 并在依赖图已登记后制造业务失败。 */
    recovery.enabled = true;
    recovery.fail = true;
    const failed = nextBuildComplete(session);
    await fs.writeFile(path.join(current.root, 'src', 'commands', 'review.md'), [
      '---', 'description: Trigger failed discovery.', '---', 'Trigger the failed graph.', '',
    ].join('\n'));
    expect((await failed).report.success).toBe(false);
    /** 只有失败轮 watch graph 被保留时，修改工程外物理文件才会触发恢复。 */
    recovery.fail = false;
    const packageIdentity = 'package:recovery-package@1.0.0/index.js';
    const recovered = nextBuildForChange(session, packageIdentity);
    await fs.writeFile(packageEntry, 'export const value = "second";\n');
    const recoveredEvent = await recovered;
    expect(recoveredEvent.report.success).toBe(true);
    expect(recoveredEvent.changes).toContain(packageIdentity);
    expect(recoveredEvent.changes.some(change => change.includes('..') || change.includes(packageRoot))).toBe(false);
    await session.close();
  }, 15_000);

  it('rebuilds once when an authorized pending managed watch file is created', async () => {
    /** pending path 在 initial compile 时不存在，但位于 Extension 授权 source root。 */
    const pendingRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-dev-pending-'));
    roots.push(pendingRoot);
    const pending = path.join(pendingRoot, 'src/pending/future.config.ts');
    const plugin: ManagedRolldownPlugin = {
      name: 'dev-pending-watch',
      buildStart() { this.addWatchFile(pending); },
    };
    const extension = defineExtension<Record<string, never>, { readonly entry: SourceFileRef }, { readonly entry: SourceFileRef }, Record<string, never>>({
      id: 'pending-watch',
      apiVersion: '1',
      resourceRoots: ['pending'],
      createSession: () => ({
        discover: async context => ({ entry: await context.sources.file(context.roots.pending!, 'entry.ts') }),
        validate: (_context, state) => ({ state, subjects: [] }),
        async build(context, state) {
          await context.compiler.compile({
            id: 'pending-watch',
            profile: 'managed-rolldown',
            entries: { main: { type: 'source', source: state.entry } },
            options: {
              inputOptions: { plugins: [plugin] },
              outputs: [{ id: 'esm', options: { format: 'es' } }],
              policy: { licenses: 'ignore' },
            },
          });
          return { state: {} };
        },
        contributors: [{
          platform: 'dev-api', platformApiVersion: '1', contribute: () => ({ compatibility: [] }),
        }],
      }),
    });
    /** 实际 Project 必须使用与 pending closure 相同的物理根。 */
    await fs.mkdir(path.join(pendingRoot, 'src/commands'), { recursive: true });
    await fs.mkdir(path.join(pendingRoot, 'src/pending'), { recursive: true });
    await fs.writeFile(path.join(pendingRoot, 'src/commands/review.md'), '---\ndescription: Review.\n---\nReview.\n');
    await fs.writeFile(path.join(pendingRoot, 'src/pending/entry.ts'), 'export const value = true;\n');
    await fs.writeFile(path.join(pendingRoot, 'acplugin.config.ts'), `
const platform = globalThis[Symbol.for('tokenroll.acplugin.dev-session-test-platform')];
const extension = globalThis[Symbol.for('tokenroll.acplugin.dev-session-test-extension')];
export default {
  name: 'dev-api', version: '1.0.0', description: 'Pending watch fixture.',
  platforms: [platform], extensions: [extension],
};
`);
    /** Platform 不暂停第二轮，Extension 通过全局 identity 进入每轮 fresh config。 */
    await fixture({ pauseSecond: false, extension });
    /** fixture() 创建的其他工程仅用于取得同一测试 Platform；实际 Session 使用 pendingRoot。 */
    const session = await createProject({ cwd: pendingRoot }).dev();
    const identity = 'src/pending/future.config.ts';
    const events: import('@acplugin/core/kernel-author').DevSessionEvent[] = [];
    session.subscribe(event => events.push(event));
    const rebuilt = nextBuildForChange(session, identity);
    await fs.writeFile(pending, 'export default true;\n');
    const result = await rebuilt;

    expect(result.report.success).toBe(true);
    expect(result.changes).toContain(identity);
    /** 等待 debounce 窗口，证明 duplicate physical subscriptions 没有产生补偿轮。 */
    await new Promise(resolve => setTimeout(resolve, 250));
    expect(events.filter(event => event.type === 'build-start' && event.changes.includes(identity))).toHaveLength(1);
    await session.close();
  }, 10_000);
});
