import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { VERSION } from 'rolldown';
import type {
  CompileJob,
  ManagedRolldownPlugin,
} from '../../src/contracts/index.js';
import { CompilerHost } from '../../src/compiler/compiler-service.js';
import { AssetRegistry } from '../../src/services/assets.js';
import { BuildSessionScope } from '../../src/services/session-scope.js';
import { SourceRegistry } from '../../src/services/sources.js';
import { WatchRegistry } from '../../src/services/watch.js';
import { WorkDirectoryRegistry } from '../../src/services/work-directories.js';

/** Compiler Host 测试创建的临时工程根。 */
const roots: string[] = [];

/**
 * 创建 owner-scoped Compiler Host 测试夹具。
 *
 * @param owner 当前集成 owner。
 * @returns 来源、service、Asset Registry 与 Watch 记录。
 */
async function fixture(owner = 'extension:managed') {
  /** 当前测试独占的工程根。 */
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-compiler-managed-'));
  roots.push(root);
  /** 受管作者源码根。 */
  const sourceRoot = path.join(root, 'src', 'owned');
  await fs.mkdir(sourceRoot, { recursive: true });
  await fs.writeFile(path.join(sourceRoot, 'main.ts'), [
    'import { message } from "./message.ts";',
    'export const value: string = message;',
  ].join('\n'));
  await fs.writeFile(path.join(sourceRoot, 'message.ts'), 'export const message: string = "source";\n');
  /** 当前 BuildSession 能力作用域。 */
  const scope = new BuildSessionScope();
  /** SourceRef 唯一签发注册表。 */
  const sources = new SourceRegistry(scope, root);
  /** owner workDir 唯一签发注册表。 */
  const work = new WorkDirectoryRegistry(scope, path.join(root, '.work'));
  /** AssetRef 唯一签发注册表。 */
  const assets = new AssetRegistry(scope, sources, work);
  /** 当前 Session 唯一 Watch Registry。 */
  const watch = new WatchRegistry(scope, root);
  /** 当前 owner 的作者来源根 ref。 */
  const sourceDirectory = await sources.issueRoot(owner, sourceRoot);
  /** 当前 owner 来源 service。 */
  const sourceService = sources.service(owner);
  /** 当前 owner 精确入口 ref。 */
  const entry = await sourceService.file(sourceDirectory, 'main.ts');
  /** BuildSession 唯一 Compiler Host。 */
  const host = new CompilerHost({
    projectRoot: root,
    sources,
    workDirectories: work,
    assets,
    watch,
  });
  return {
    root,
    sourceRoot,
    sourceDirectory,
    sourceService,
    entry,
    assets,
    service: await host.service(owner),
    watch,
    owner,
    scope,
  };
}

/**
 * 在 fixture 中写入一个具备完整法律材料的真实 package dependency。
 *
 * @param root 当前测试工程根。
 */
async function writeLicensedPackage(root: string): Promise<void> {
  /** 可由 Rolldown bare import 解析的 package 根。 */
  const packageRoot = path.join(root, 'node_modules', 'managed-license-fixture');
  await fs.mkdir(packageRoot, { recursive: true });
  await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
    name: 'managed-license-fixture',
    version: '1.2.3',
    type: 'module',
    exports: './index.js',
    license: 'MIT',
  }));
  await fs.writeFile(path.join(packageRoot, 'index.js'), 'export const licensed = "licensed";\n');
  await fs.writeFile(path.join(packageRoot, 'LICENSE'), 'Managed license fixture.\n');
}

/**
 * 创建一个使用受管源码的最小 managed Job。
 *
 * @param entry 当前 owner 的 SourceFileRef。
 * @param overrides 需要覆盖的 Job 字段。
 * @returns 可直接交给 CompilerService 的 Job。
 */
function managedJob(
  entry: Awaited<ReturnType<ReturnType<SourceRegistry['service']>['file']>>,
  overrides: Record<string, unknown> = {},
): CompileJob<'managed-rolldown'> {
  return {
    id: 'managed-job',
    profile: 'managed-rolldown',
    entries: { main: { type: 'source', source: entry, mode: 0o755 } },
    options: {
      outputs: [{ id: 'esm', options: { format: 'es', entryFileNames: 'main.mjs' } }],
      policy: { licenses: 'ignore' },
    },
    ...overrides,
  } as CompileJob<'managed-rolldown'>;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe('managed Rolldown Compiler Host', () => {
  it('executes real input/output Plugin lifecycles, multi-output and signs GeneratedAsset refs', async () => {
    /** 当前完整 Compiler Host 夹具。 */
    const current = await fixture();
    /** Plugin lifecycle 的精确执行顺序。 */
    const calls: string[] = [];
    /** input Plugin 引入 resolve/load/transform 真实生命周期。 */
    const inputPlugin: ManagedRolldownPlugin = {
      name: 'input-lifecycle',
      options: options => (calls.push('options'), options),
      buildStart: () => {
        calls.push('build-start');
      },
      resolveId(source) {
        if (source === 'virtual:extra')
          return '\0test:extra';
        return null;
      },
      load(id) {
        if (id === '\0test:extra') {
          calls.push('load');
          return 'export const extra = "extra";';
        }
        return null;
      },
      transform: {
        filter: { id: /main\.ts$/u },
        handler(code) {
          calls.push('transform');
          return `${code}\nimport { extra } from "virtual:extra"; export const combined = value + extra;`;
        },
      },
      buildEnd: () => {
        calls.push('build-end');
      },
      closeBundle: () => {
        calls.push('close-bundle');
      },
    };
    /** 两个 output Plugin 证明声明顺序与各自 render/generate hook。 */
    const outputPlugin = (id: string): ManagedRolldownPlugin => ({
      name: `output-${id}`,
      outputOptions: options => (calls.push(`output-options:${id}`), options),
      renderChunk: code => (calls.push(`render:${id}`), { code: `${code}\n/* ${id} */`, map: null }),
      generateBundle: () => {
        calls.push(`generate:${id}`);
      },
    });
    /** Promise/nested array Plugin option 组合。 */
    const promisedPlugin = Promise.resolve(inputPlugin);
    const job = managedJob(current.entry, {
      options: {
        inputOptions: { plugins: [[false, promisedPlugin]] },
        outputs: [
          { id: 'esm', options: { format: 'es', entryFileNames: 'main.mjs', plugins: [outputPlugin('esm')] } },
          { id: 'cjs', options: { format: 'cjs', entryFileNames: 'main.cjs', plugins: [outputPlugin('cjs')] } },
        ],
        policy: { licenses: 'ignore' },
      },
    });

    const result = await current.service.compile(job);

    expect(current.service.engine).toEqual({ name: 'rolldown', version: VERSION });
    expect(result.engine).toEqual({ name: 'rolldown', version: VERSION });
    expect(result.outputs.map(output => [output.outputId, output.fileName, output.isEntry])).toEqual([
      ['esm', 'main.mjs', true],
      ['cjs', 'main.cjs', true],
    ]);
    expect(result.outputs.every(output => output.asset.kind === 'generated-asset')).toBe(true);
    expect(calls).toContain('options');
    expect(calls).toContain('load');
    expect(calls).toContain('transform');
    expect(calls.indexOf('generate:esm')).toBeLessThan(calls.indexOf('generate:cjs'));
    expect(calls.at(-1)).toBe('close-bundle');
    expect(result.modules.every(module => !module.id.includes(current.root))).toBe(true);
    expect(current.watch.snapshot().paths).toContain(await fs.realpath(path.join(current.sourceRoot, 'message.ts')));
    /** GeneratedAsset 字节可由当前 owner 通过 Registry 安全读取。 */
    const bytes = await current.assets.service(current.owner).read(result.outputs[0]!.asset);
    expect(new TextDecoder().decode(bytes)).toContain('/* esm */');
  });

  it('supports virtual entries resolved from an authorized SourceDirectoryRef', async () => {
    /** 当前完整 Compiler Host 夹具。 */
    const current = await fixture();
    /** 虚拟 entry 的相对 import 必须从 SourceDirectoryRef 解析。 */
    const result = await current.service.compile(managedJob(current.entry, {
      entries: {
        virtual: {
          type: 'virtual',
          code: 'export { message } from "./message.ts";',
          resolveFrom: current.sourceDirectory,
        },
      },
    }));

    expect(result.outputs).toHaveLength(1);
    expect(result.modules.some(module => module.id === 'src/owned/message.ts')).toBe(true);
    expect(JSON.stringify(result)).not.toContain(current.root);
  });

  it('normalizes ordinary deterministic output and audits every emitted byte kind', async () => {
    const current = await fixture();
    /** 默认非压缩 Rolldown region 不得让普通 deterministic Job 自我拒绝。 */
    const success = await current.service.compile(managedJob(current.entry, {
      id: 'deterministic-success',
      options: {
        outputs: [{ id: 'esm', options: { format: 'es', entryFileNames: 'main.mjs' } }],
        policy: { deterministic: true, licenses: 'ignore' },
      },
    }));
    const successBytes = await current.assets.service(current.owner).read(success.outputs[0]!.asset);
    expect(new TextDecoder().decode(successBytes)).not.toContain(current.root);

    /** renderChunk 注入工程根必须在签发 Asset 前失败。 */
    const chunkLeak: ManagedRolldownPlugin = {
      name: 'chunk-path-leak',
      renderChunk: code => ({ code: `${code}\nglobalThis.__managedRoot = ${JSON.stringify(current.root)};`, map: null }),
    };
    await expect(current.service.compile(managedJob(current.entry, {
      id: 'deterministic-chunk-leak',
      options: {
        outputs: [{ id: 'esm', options: { format: 'es', plugins: [chunkLeak] } }],
        policy: { deterministic: true, licenses: 'ignore' },
      },
    }))).rejects.toThrow('absolute build path');

    /** generateBundle 发出的普通 Asset 同样属于 deterministic 字节闭包。 */
    const assetLeak: ManagedRolldownPlugin = {
      name: 'asset-path-leak',
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: 'leak.txt', source: new TextEncoder().encode(current.root) });
      },
    };
    await expect(current.service.compile(managedJob(current.entry, {
      id: 'deterministic-asset-leak',
      options: {
        outputs: [{ id: 'esm', options: { format: 'es', plugins: [assetLeak] } }],
        policy: { deterministic: true, licenses: 'ignore' },
      },
    }))).rejects.toThrow('absolute build path');

    await expect(current.service.compile(managedJob(current.entry, {
      id: 'deterministic-disabled-normalization',
      options: {
        outputs: [{ id: 'esm', options: { format: 'es', minify: false } }],
        policy: { deterministic: true, licenses: 'ignore' },
      },
    }))).rejects.toThrow('cannot disable whitespace normalization');
  });

  it('retains an authorized watch file that does not exist yet', async () => {
    const current = await fixture();
    const pending = path.join(current.sourceRoot, 'future.config.ts');
    /** addWatchFile 的标准 missing-file 用法必须进入 pending Watch snapshot。 */
    const plugin: ManagedRolldownPlugin = {
      name: 'pending-watch-file',
      buildStart() {
        this.addWatchFile(pending);
      },
    };

    await current.service.compile(managedJob(current.entry, {
      options: {
        inputOptions: { plugins: [plugin] },
        outputs: [{ id: 'esm', options: { format: 'es' } }],
        policy: { licenses: 'ignore' },
      },
    }));

    expect(current.watch.snapshot().observations).toContainEqual({
      path: path.join(await fs.realpath(current.sourceRoot), 'future.config.ts'),
      type: 'file',
      identity: 'src/owned/future.config.ts',
      pending: true,
    });
  });

  it('rejects pending watch escape and symlink ancestor paths', async () => {
    const escaped = await fixture();
    /** project 内但 owner source root 外的 missing file 不属于授权恢复入口。 */
    const escapePlugin: ManagedRolldownPlugin = {
      name: 'pending-watch-escape',
      buildStart() { this.addWatchFile(path.join(escaped.root, 'outside.config.ts')); },
    };
    await expect(escaped.service.compile(managedJob(escaped.entry, {
      id: 'pending-watch-escape',
      options: {
        inputOptions: { plugins: [escapePlugin] },
        outputs: [{ id: 'esm', options: { format: 'es' } }],
        policy: { licenses: 'ignore' },
      },
    }))).rejects.toThrow('outside its authorized module graph');

    const linked = await fixture();
    /** 作者 source root 内的 symlink 祖先不能把 pending file 指向其他树。 */
    const external = path.join(linked.root, 'external');
    await fs.mkdir(external);
    await fs.symlink(external, path.join(linked.sourceRoot, 'linked'), 'dir');
    const symlinkPlugin: ManagedRolldownPlugin = {
      name: 'pending-watch-symlink',
      buildStart() { this.addWatchFile(path.join(linked.sourceRoot, 'linked/future.config.ts')); },
    };
    await expect(linked.service.compile(managedJob(linked.entry, {
      id: 'pending-watch-symlink',
      options: {
        inputOptions: { plugins: [symlinkPlugin] },
        outputs: [{ id: 'esm', options: { format: 'es' } }],
        policy: { licenses: 'ignore' },
      },
    }))).rejects.toThrow(/(?:symbolic links|regular directory ancestor)/u);
  });

  it('accepts only an authorized SourceFileRef for explicit tsconfig', async () => {
    /** 当前完整 Compiler Host 夹具。 */
    const current = await fixture();
    await fs.writeFile(path.join(current.sourceRoot, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { useDefineForClassFields: true },
    }));
    /** 当前 owner 精确签发的 tsconfig SourceFileRef。 */
    const tsconfig = await current.sourceService.file(current.sourceDirectory, 'tsconfig.json');

    await expect(current.service.compile(managedJob(current.entry, {
      options: {
        inputOptions: { tsconfig },
        outputs: [{ id: 'esm', options: { format: 'es' } }],
      },
    }))).resolves.toMatchObject({ job: 'managed-job' });

    /** 字符串不是 SourceRef capability，即使工程内存在也必须拒绝。 */
    await expect(current.service.compile(managedJob(current.entry, {
      id: 'string-tsconfig',
      options: {
        inputOptions: { tsconfig: 'src/owned/tsconfig.json' },
        outputs: [{ id: 'esm', options: { format: 'es' } }],
      },
    }))).rejects.toThrow('SourceFileRef');
  });

  it('snapshots nested options and Plugin hook shells before promised Plugins yield', async () => {
    /** 当前完整 Compiler Host 夹具。 */
    const current = await fixture();
    /** 原始输出参数将在 Plugin Promise 解析期间修改。 */
    const outputOptions: Record<string, unknown> = { format: 'es', entryFileNames: 'stable.mjs' };
    /** object-hook 外壳在 await 后修改也不得换掉当次 handler/filter。 */
    let transformed = 0;
    const hook = {
      filter: { id: /main\.ts$/u },
      handler(code: string) {
        transformed += 1;
        return code;
      },
    };
    /** Promise 解析前留出一个 microtask mutation 窗口。 */
    /** 已解析 thenable 仍会使 Compiler 进入 await 边界。 */
    const plugin = { name: 'snapshot-plugin', transform: hook };
    const job = managedJob(current.entry, {
      options: {
        inputOptions: { resolve: { extensions: ['.ts'] }, plugins: [plugin] },
        outputs: [{ id: 'esm', options: outputOptions }],
        policy: { licenses: 'ignore' },
      },
    });
    const pending = current.service.compile(job);
    outputOptions.entryFileNames = 'mutated.mjs';
    hook.handler = () => {
      throw new Error('mutated hook must not run');
    };
    hook.filter.id = /never-match/u;

    const result = await pending;

    expect(result.outputs[0]?.fileName).toBe('stable.mjs');
    expect(transformed).toBe(1);
  });

  it('rejects forbidden/unknown fields and hooks before any Plugin executes', async () => {
    /** 当前完整 Compiler Host 夹具。 */
    const current = await fixture();
    /** 被禁 Plugin 不得触发任何生命周期。 */
    let executed = false;
    const forbiddenPlugin = {
      name: 'forbidden',
      buildStart: () => {
        executed = true;
      },
      writeBundle: () => {
        executed = true;
      },
    };

    await expect(current.service.compile(managedJob(current.entry, {
      options: {
        inputOptions: { plugins: [forbiddenPlugin] },
        outputs: [{ id: 'esm', options: { format: 'es' } }],
      },
    }))).rejects.toThrow('writeBundle');
    expect(executed).toBe(false);

    /** 新 Job ID 验证嵌套 watch/dev 字段在引擎前失败。 */
    await expect(current.service.compile(managedJob(current.entry, {
      id: 'nested-dev',
      options: {
        inputOptions: { experimental: { incrementalBuild: true } },
        outputs: [{ id: 'esm', options: { format: 'es' } }],
      },
    }))).rejects.toThrow('incrementalBuild');
    await expect(current.service.compile(managedJob(current.entry, {
      id: 'unknown-field',
      options: {
        inputOptions: { futureDirectWrite: true },
        outputs: [{ id: 'esm', options: { format: 'es' } }],
      },
    }))).rejects.toThrow('not supported');
  });

  it('blocks options/outputOptions attempts to rewrite Core-owned fields and still closes the bundle', async () => {
    /** 当前完整 Compiler Host 夹具。 */
    const current = await fixture();
    /** closeBundle 证明 generate 失败后仍由 Host 关闭 bundle。 */
    let closed = false;
    const plugin: ManagedRolldownPlugin = {
      name: 'rewrite-input',
      options(options) {
        return { ...options, cwd: '/tmp/escape' };
      },
      closeBundle: () => {
        closed = true;
      },
    };
    await expect(current.service.compile(managedJob(current.entry, {
      options: {
        inputOptions: { plugins: [plugin] },
        outputs: [{ id: 'esm', options: { format: 'es' } }],
      },
    }))).rejects.toThrow('Core-managed field "cwd"');
    /** options hook 在 rolldown() 返回 bundle 前失败，Host 尚无可关闭句柄。 */
    expect(closed).toBe(false);

    /** 输出 hook 同样不能利用 generate-only 操作绑定物理 dir。 */
    const outputPlugin: ManagedRolldownPlugin = {
      name: 'rewrite-output',
      outputOptions(options) {
        return { ...options, dir: '/tmp/escape' };
      },
    };
    await expect(current.service.compile(managedJob(current.entry, {
      id: 'rewrite-output',
      options: {
        outputs: [{ id: 'esm', options: { format: 'es', plugins: [outputPlugin] } }],
      },
    }))).rejects.toThrow('Core-managed field "dir"');
    /** outputOptions 在完整 build 前失败，Rolldown 不调用 Plugin closeBundle hook。 */
    expect(closed).toBe(false);

    /** render 阶段已完成 buildStart，此时 Host finally 关闭会调用 closeBundle。 */
    const closeObserver: ManagedRolldownPlugin = {
      name: 'close-observer',
      closeBundle: () => {
        closed = true;
      },
    };
    const renderFailure: ManagedRolldownPlugin = {
      name: 'render-failure',
      renderChunk() {
        throw new Error('render failed');
      },
    };
    await expect(current.service.compile(managedJob(current.entry, {
      id: 'render-failure',
      options: {
        inputOptions: { plugins: [closeObserver] },
        outputs: [{ id: 'esm', options: { format: 'es', plugins: [renderFailure] } }],
      },
    }))).rejects.toThrow('render failed');
    expect(closed).toBe(true);
  });

  it('audits source escape, output paths, unresolved imports and generated provenance after Plugins', async () => {
    /** 当前完整 Compiler Host 夹具。 */
    const current = await fixture();
    /** 工程外文件不属于作者来源或 package 边界。 */
    const outside = path.join(current.root, 'outside.ts');
    await fs.writeFile(outside, 'export const secret = true;\n');
    const escapePlugin: ManagedRolldownPlugin = {
      name: 'source-escape',
      resolveId(source) {
        return source === 'escape' ? outside : null;
      },
      transform(code, id) {
        return id.endsWith('main.ts') ? `${code}\nimport "escape";` : null;
      },
    };
    await expect(current.service.compile(managedJob(current.entry, {
      options: {
        inputOptions: { plugins: [escapePlugin] },
        outputs: [{ id: 'esm', options: { format: 'es' } }],
      },
    }))).rejects.toThrow('escaped authorized sources');

    /** generateBundle 在最后修改 fileName 仍会被 Host 输出审计拒绝。 */
    const pathPlugin: ManagedRolldownPlugin = {
      name: 'path-escape',
      generateBundle(_options, bundle) {
        const chunk = Object.values(bundle).find(item => item.type === 'chunk');
        if (chunk !== undefined)
          chunk.fileName = '../escape.mjs';
      },
    };
    await expect(current.service.compile(managedJob(current.entry, {
      id: 'path-escape',
      options: { outputs: [{ id: 'esm', options: { format: 'es', plugins: [pathPlugin] } }] },
    }))).rejects.toThrow('output');

    /** external 静态 import 在 reject 策略下不得伪装成成功 Bundle。 */
    const unresolvedPlugin: ManagedRolldownPlugin = {
      name: 'unresolved',
      transform(code, id) {
        return id.endsWith('main.ts') ? `${code}\nimport "missing-runtime";` : null;
      },
    };
    await expect(current.service.compile(managedJob(current.entry, {
      id: 'unresolved',
      options: {
        inputOptions: { external: ['missing-runtime'], plugins: [unresolvedPlugin] },
        outputs: [{ id: 'esm', options: { format: 'es' } }],
        policy: { unresolvedImports: 'reject', licenses: 'ignore' },
      },
    }))).rejects.toThrow('unresolved import');

    /** 成功结果的 compile provenance 只保留逻辑 module identity。 */
    const success = await current.service.compile(managedJob(current.entry, { id: 'provenance' }));
    const metadata = current.assets.describe(current.owner, success.outputs[0]!.asset);
    expect(metadata.origin).toMatchObject({ type: 'compile', job: 'provenance', output: 'esm' });
    expect(JSON.stringify(metadata)).not.toContain(current.root);
  });

  it('rejects forged, cross-owner, mutated and symlink-replaced SourceRefs', async () => {
    /** 当前 owner 的 Compiler Host 夹具。 */
    const current = await fixture('extension:a');
    /** 等形复制 ref 没有 WeakMap 授权。 */
    const forged = Object.freeze({ ...current.entry }) as typeof current.entry;
    await expect(current.service.compile(managedJob(forged))).rejects.toThrow('not authorized');

    /** 另一 owner 的 CompilerService 不能消费 a 的 SourceRef。 */
    const other = await fixture('extension:b');
    await expect(other.service.compile(managedJob(current.entry))).rejects.toThrow('not authorized');

    /** 普通内容修改在 Rolldown 读取前由 Source Registry 指纹拒绝。 */
    await fs.writeFile(path.join(current.sourceRoot, 'main.ts'), 'export const changed = true;\n');
    await expect(current.service.compile(managedJob(current.entry, { id: 'mutated' }))).rejects.toThrow('changed after');

    /** 作者树中任何 symlink 都使整个 Job 失败。 */
    const symlinked = await fixture('extension:symlinked');
    await fs.symlink(path.join(symlinked.sourceRoot, 'message.ts'), path.join(symlinked.sourceRoot, 'linked.ts'));
    await expect(symlinked.service.compile(managedJob(symlinked.entry))).rejects.toThrow('symbolic links');
  });

  it('collects strict licenses by default and allows explicit managed ignore', async () => {
    /** 默认 policy 使用实际 package graph 生成相邻法律材料。 */
    const strict = await fixture();
    await writeLicensedPackage(strict.root);
    const plugin: ManagedRolldownPlugin = {
      name: 'licensed-import',
      /** 把真实 package 引入 managed graph。 */
      transform(code, id) {
        return id.endsWith('main.ts') ? `${code}\nimport { licensed } from "managed-license-fixture"; export { licensed };` : null;
      },
    };
    const result = await strict.service.compile(managedJob(strict.entry, {
      options: {
        inputOptions: { plugins: [plugin] },
        outputs: [{ id: 'esm', options: { format: 'es', entryFileNames: 'main.mjs' } }],
      },
    }));
    const license = result.outputs.find(output => output.type === 'licenses')!;
    const text = new TextDecoder().decode(await strict.assets.service(strict.owner).read(license.asset));
    expect(text).toContain('managed-license-fixture@1.2.3');

    /** 显式 ignore 不生成 Core 法律材料。 */
    const ignored = await fixture();
    await writeLicensedPackage(ignored.root);
    const ignoredResult = await ignored.service.compile(managedJob(ignored.entry, {
      options: {
        inputOptions: { plugins: [plugin] },
        outputs: [{ id: 'esm', options: { format: 'es', entryFileNames: 'main.mjs' } }],
        policy: { licenses: 'ignore' },
      },
    }));
    expect(ignoredResult.outputs.some(output => output.type === 'licenses')).toBe(false);
  });
});
