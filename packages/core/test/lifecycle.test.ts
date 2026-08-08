import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  bytesArtifact,
  defineExtension,
  definePlatform,
  executeLifecycle,
  resolveConfig,
  stableJson,
  type AcpluginExtension,
  type AcpluginPlatform,
  type BuildCommand,
  type ResolvedConfig,
} from '../src/index.js';

/** 生命周期测试创建并统一清理的临时工程。 */
const temporaryDirectories: string[] = [];

/** @returns 已登记清理的临时工程根。 */
async function temporaryRoot(): Promise<string> {
  /** 当前测试独占的临时工程。 */
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-lifecycle-test-'));
  temporaryDirectories.push(root);
  return root;
}

/**
 * 创建能够完整透传 Draft 并序列化 Manifest 的虚拟 Platform。
 *
 * @param id 虚拟 Platform ID。
 * @param events 生命周期顺序记录。
 * @param failPrepare 是否在 prepare 阶段注入失败。
 * @returns 第三方生态可实现的品牌化 Platform。
 */
function virtualPlatform(
  id: string,
  events: string[],
  failPrepare = false,
): AcpluginPlatform {
  return definePlatform({
    id,
    apiVersion: '1',
    deliveryType: 'plugin',
    options: { fixture: { id } },
    /** configResolved 记录虚拟 Platform 的配置阶段。 */
    configResolved() { events.push(`${id}:config`); },
    /** buildStart 验证最小 Context 并记录启动阶段。 */
    buildStart(context) {
      events.push(`${id}:start`);
      expect('outDir' in context).toBe(false);
    },
    /** prepare 创建带一个 add-only 扩展点的 Manifest Draft。 */
    prepare(context) {
      events.push(`${id}:prepare`);
      expect('extensions' in context).toBe(false);
      expect(context.options).toEqual({ fixture: { id } });
      expect(Object.isFrozen(context.options)).toBe(true);
      context.reportMetadata({
        field: 'name',
        disposition: 'emitted',
        output: 'manifest.name',
        reason: 'Virtual Platform emits the canonical name.',
      });
      if (failPrepare)
        throw new Error('virtual prepare failure');
      return {
        documents: [{
          id: 'manifest',
          path: 'manifest.json',
          format: 'json',
          owner: `platform:${id}`,
          value: { name: context.project.metadata.name, extensions: {} },
          extensionPoints: [['extensions', 'bridge']],
        }],
        artifacts: [],
      };
    },
    /** generateBundle 序列化合并后的 Manifest 与继承 Artifact。 */
    generateBundle(context) {
      events.push(`${id}:generate`);
      /** Platform 序列化的当前 owner-merged Manifest。 */
      const manifest = context.documents.find(document => document.id === 'manifest')!;
      return {
        id: 'plugin',
        role: 'primary',
        type: 'plugin',
        artifacts: [
          ...context.artifacts,
          bytesArtifact(manifest.path, stableJson(manifest.value)),
        ],
      };
    },
    /** validateBundle 从物化候选读取并验证最终 Manifest。 */
    async validateBundle(context) {
      events.push(`${id}:validate-bundle`);
      expect(await fs.readFile(path.join(context.candidate.root, 'manifest.json'), 'utf8')).toContain('lifecycle-fixture');
    },
    /** buildEnd 记录成功或失败状态用于验证逆序清理。 */
    buildEnd(context) {
      events.push(`${id}:end:${context.status}`);
    },
  });
}

/**
 * 创建拥有一个 Platform Adapter 的虚拟 Extension。
 *
 * @param name Extension 名称。
 * @param platform Adapter 支持的 Platform。
 * @param events 生命周期顺序记录。
 * @param workDirs Extension Context 暴露的隔离目录记录。
 * @param empty discover 是否返回无资源信号。
 * @returns 品牌化第三方 Extension。
 */
function virtualExtension(
  name: string,
  platform: AcpluginPlatform,
  events: string[],
  workDirs: string[],
  empty = false,
): AcpluginExtension {
  return defineExtension({
    name,
    apiVersion: '1',
    adapters: empty
      ? []
      : [{
          extensionApiVersion: '1',
          platform: platform.id,
          platformApiVersion: '1',
          /** apply 通过 add-only Context 提交字段、Artifact 与兼容性。 */
          apply(context, built) {
            events.push(`${name}:adapter:${context.platform.id}`);
            expect(Object.keys(context).sort()).toEqual([
              'command', 'emitArtifact', 'getDocument', 'mode', 'patchDocument', 'platform', 'project',
              'reportCompatibility', 'reportDiagnostic',
            ]);
            context.patchDocument({ document: 'manifest', path: ['extensions', 'bridge'], value: built as never });
            context.emitArtifact(bytesArtifact('extensions/bridge.txt', 'bridge'));
            context.reportCompatibility({
              subject: `extension:${name}`,
              capability: 'bridge',
              level: 'native',
              reason: 'Virtual Adapter preserves the fixture.',
            });
          },
        }],
    /** configResolved 记录虚拟 Extension 的配置阶段。 */
    configResolved() { events.push(`${name}:config`); },
    /** buildStart 验证 Extension workDir 与最小 Context。 */
    buildStart(context) {
      events.push(`${name}:start`);
      workDirs.push(context.workDir);
      expect('outDir' in context).toBe(false);
    },
    /** discover 返回有资源状态或明确的空 Extension 信号。 */
    discover(context) {
      events.push(`${name}:discover`);
      expect(Object.keys(context).sort()).toEqual([
        'command', 'loadTypeScriptModule', 'mode', 'reportDiagnostic', 'srcDir', 'workDir',
      ]);
      return empty ? undefined : { count: 1 };
    },
    /** validate 记录发现状态是否包含资源。 */
    validate(_context, discovered) {
      events.push(`${name}:validate:${discovered === undefined ? 'empty' : 'resource'}`);
    },
    /** build 把发现状态转换为 Adapter 可见的 Built State。 */
    build(_context, discovered) {
      events.push(`${name}:build`);
      return discovered === undefined ? undefined : { enabled: true };
    },
    /** buildEnd 记录 Extension 最终清理状态。 */
    buildEnd(context) {
      events.push(`${name}:end:${context.status}`);
    },
  });
}

/**
 * 解析虚拟生态测试使用的最终配置。
 *
 * @param root 工程根目录。
 * @param command 当前固定生命周期命令。
 * @param platforms 配置顺序 Platform。
 * @param extensions 配置顺序 Extension。
 * @param strict 全局严格度。
 * @returns 无配置诊断的 ResolvedConfig。
 */
function lifecycleConfig(
  root: string,
  command: BuildCommand,
  platforms: readonly AcpluginPlatform[],
  extensions: readonly AcpluginExtension[],
  strict = true,
): ResolvedConfig {
  /** 虚拟生态的最终配置解析结果。 */
  const resolved = resolveConfig({
    name: 'lifecycle-fixture',
    version: '1.0.0',
    description: 'Lifecycle fixture.',
    platforms,
    extensions,
    build: { strict },
  }, path.join(root, 'acplugin.config.ts'), command, 'production', { defaultPlatforms: platforms });
  expect(resolved.diagnostics).toEqual([]);
  return resolved.config!;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

describe('fixed Core lifecycle', () => {
  it('allows a Platform to omit an empty optional Document but requires it after an Adapter patch', async () => {
    /** 记录 Platform 是否观察到 Extension 合并结果。 */
    const serializedValues: unknown[] = [];
    /** 使用 omit-if-empty 契约的虚拟 workspace Platform。 */
    const platform = definePlatform({
      id: 'optional-document',
      apiVersion: '1',
      deliveryType: 'workspace',
      /** 空配置只为 Extension 保留 add-only 扩展点。 */
      prepare: () => ({
        documents: [{
          id: 'workspace-config', path: 'workspace.json', format: 'json', owner: 'platform:optional-document',
          value: {}, emission: 'omit-if-empty', extensionPoints: [['mcp']],
        }],
        artifacts: [],
      }),
      /** 非空配置才序列化，复现 workspace Platform 的按需配置。 */
      generateBundle(context) {
        /** 当前 Adapter 合并后的配置对象。 */
        const value = context.documents[0]!.value;
        serializedValues.push(value);
        return {
          id: 'workspace', role: 'primary', type: 'workspace',
          artifacts: Object.keys(value as object).length === 0 ? [] : [bytesArtifact('workspace.json', stableJson(value))],
        };
      },
      /** 候选只验证配置存在性由 Core 控制。 */
      validateBundle: () => undefined,
    });
    /** 空工程用于隔离 Document emission 行为。 */
    const root = await temporaryRoot();
    await fs.mkdir(path.join(root, 'src'));
    /** 没有 Extension patch 的空配置构建结果。 */
    const empty = await executeLifecycle({
      config: lifecycleConfig(root, 'build', [platform], []),
      /** 当前空状态 Fixture 不需要加载作者 descriptor。 */
      loadTypeScriptModule: async () => undefined,
      environment: {},
    });
    /** 通过 add-only patch 让同一可选 Document 变为必需的 Extension。 */
    const extension = defineExtension({
      name: 'optional-document-extension',
      apiVersion: '1',
      /** 非空发现状态用于激活当前测试 Extension。 */
      discover: () => ({ enabled: true }),
      adapters: [{
        extensionApiVersion: '1', platform: platform.id, platformApiVersion: '1',
        /** apply 新增 mcp 字段，使 Core 必须观察到对应序列化文件。 */
        apply(context) {
          context.patchDocument({ document: 'workspace-config', path: ['mcp'], value: { docs: true } });
        },
      }],
    });
    /** 第二个工程避免第一次事务输出影响断言。 */
    const patchedRoot = await temporaryRoot();
    await fs.mkdir(path.join(patchedRoot, 'src'));
    /** 合并 Extension 后必须物化配置的构建结果。 */
    const patched = await executeLifecycle({
      config: lifecycleConfig(patchedRoot, 'build', [platform], [extension]),
      /** 当前 add-only patch Fixture 不需要加载作者 descriptor。 */
      loadTypeScriptModule: async () => undefined,
      environment: {},
    });

    expect(empty.success).toBe(true);
    expect(empty.deliveryUnits[0]?.artifacts).toEqual([]);
    expect(patched.success).toBe(true);
    expect(patched.deliveryUnits[0]?.artifacts).toEqual([expect.objectContaining({ path: 'workspace.json' })]);
    expect(serializedValues).toEqual([{}, { mcp: { docs: true } }]);
  });

  it('runs virtual Platform, Extension, and Adapter hooks in deterministic order with minimal contexts', async () => {
    /** 全生命周期事件顺序。 */
    const events: string[] = [];
    /** Extension 获得且不得彼此共享的临时目录。 */
    const workDirs: string[] = [];
    /** 两个平台验证跨 Platform 串行顺序。 */
    const first = virtualPlatform('virtual-one', events);
    /** 第二个虚拟 Platform 用于验证隔离和配置顺序。 */
    const second = virtualPlatform('virtual-two', events);
    /** 有资源 Extension 只适配第一个 Platform。 */
    const bridge = virtualExtension('virtual-bridge', first, events, workDirs);
    /** 空 Extension 不需要任何 Adapter。 */
    const empty = virtualExtension('virtual-empty', first, events, workDirs, true);
    /** 带一个 Public 文件的规范工程。 */
    const root = await temporaryRoot();
    await fs.mkdir(path.join(root, 'public'), { recursive: true });
    await fs.writeFile(path.join(root, 'public/shared.txt'), 'public');

    /** 第二个平台使用 relaxed 避免缺失 Bridge Adapter 阻止虚拟构建。 */
    const relaxedSecond = definePlatform({ ...second, strict: false });
    /** 完整虚拟生态执行后的生命周期结果。 */
    const result = await executeLifecycle({
      config: lifecycleConfig(root, 'validate', [first, relaxedSecond], [bridge, empty]),
      /** 当前 Fixture 不加载真实 TypeScript 作者模块。 */
      loadTypeScriptModule: async () => undefined,
      environment: {},
    });

    expect(result.success).toBe(true);
    expect(result.committed).toBe(false);
    expect(result.deliveryUnits).toHaveLength(2);
    expect(result.deliveryUnits.find(unit => unit.platform === 'virtual-one')?.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'extensions/bridge.txt', owner: 'extension:virtual-bridge' }),
      expect.objectContaining({ path: 'shared.txt', owner: 'public' }),
      expect.objectContaining({ path: 'manifest.json', owner: 'platform:virtual-one' }),
    ]));
    expect(result.compatibility).toEqual(expect.arrayContaining([
      expect.objectContaining({ platform: 'virtual-one', level: 'native' }),
      expect.objectContaining({ platform: 'virtual-two', level: 'unsupported' }),
    ]));
    expect(result.metadata).toEqual([
      expect.objectContaining({ platform: 'virtual-one', field: 'name', disposition: 'emitted' }),
      expect.objectContaining({ platform: 'virtual-two', field: 'name', disposition: 'emitted' }),
    ]);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: 'COMPATIBILITY_RELAXED', platform: 'virtual-two', severity: 'warning',
    }));
    expect(result.compatibility.some(entry => entry.subject === 'extension:virtual-empty')).toBe(false);
    expect(workDirs).toHaveLength(2);
    expect(new Set(workDirs).size).toBe(2);
    /** workDir 表示当前验证已被 finally 清理的 Extension 临时目录。 */
    for (const workDir of workDirs)
      await expect(fs.access(workDir)).rejects.toThrow();
    expect(events).toEqual([
      'virtual-one:config', 'virtual-two:config', 'virtual-bridge:config', 'virtual-empty:config',
      'virtual-one:start', 'virtual-two:start', 'virtual-bridge:start', 'virtual-empty:start',
      'virtual-bridge:discover', 'virtual-empty:discover',
      'virtual-bridge:validate:resource', 'virtual-empty:validate:empty',
      'virtual-bridge:build', 'virtual-empty:build',
      'virtual-one:prepare', 'virtual-bridge:adapter:virtual-one', 'virtual-one:generate', 'virtual-one:validate-bundle',
      'virtual-two:prepare', 'virtual-two:generate', 'virtual-two:validate-bundle',
      'virtual-empty:end:success', 'virtual-bridge:end:success', 'virtual-two:end:success', 'virtual-one:end:success',
    ]);
  });

  it('continues later Platforms after failure and appends cleanup errors without replacing it', async () => {
    /** 故障隔离与逆序清理事件。 */
    const events: string[] = [];
    /** prepare 会失败的第一个 Platform。 */
    const broken = virtualPlatform('broken-platform', events, true);
    /** 仍应完整生成和验证的后续 Platform。 */
    const healthy = virtualPlatform('healthy-platform', events);
    /** buildEnd 失败的空 Extension。 */
    const cleanup = defineExtension({
      name: 'cleanup-failure',
      apiVersion: '1',
      adapters: [],
      /** discover 返回空资源，避免 Adapter 兼容性干扰清理测试。 */
      discover: () => undefined,
      /** buildEnd 主动抛错以验证首错优先和逆序清理。 */
      buildEnd() {
        events.push('cleanup-failure:end');
        throw new Error('cleanup failure');
      },
    });
    /** 不需要 Component 的空规范工程。 */
    const root = await temporaryRoot();

    /** 同时包含 prepare 与 cleanup 失败的生命周期结果。 */
    const result = await executeLifecycle({
      config: lifecycleConfig(root, 'validate', [broken, healthy], [cleanup]),
      /** 当前 Fixture 不加载真实 TypeScript 作者模块。 */
      loadTypeScriptModule: async () => undefined,
      environment: {},
    });

    expect(result.success).toBe(false);
    expect(result.committed).toBe(false);
    expect(events).toContain('healthy-platform:validate-bundle');
    expect(events.slice(-3)).toEqual([
      'cleanup-failure:end',
      'healthy-platform:end:failed',
      'broken-platform:end:failed',
    ]);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'PLATFORM_GENERATION_FAILED', platform: 'broken-platform' }),
      expect.objectContaining({ code: 'EXTENSION_BUILD_END_FAILED', extension: 'cleanup-failure' }),
    ]));
  });

  it('treats resources without an Adapter as strict unsupported and emits no unit', async () => {
    /** 严格 Platform 和无 Adapter Extension。 */
    const events: string[] = [];
    /** 严格模式下不得接受 unsupported Extension 的 Platform。 */
    const strictPlatform = virtualPlatform('strict-platform', events);
    /** discover 有资源但未声明任何 Adapter 的 Extension。 */
    const unsupported = defineExtension({
      name: 'unsupported-extension',
      apiVersion: '1',
      adapters: [],
      /** discover 返回资源以触发缺失 Adapter 的兼容性结论。 */
      discover: () => ({ count: 1 }),
    });
    /** 无其他结构错误的工程。 */
    const root = await temporaryRoot();

    /** 严格模式下预期不生成任何单元的生命周期结果。 */
    const result = await executeLifecycle({
      config: lifecycleConfig(root, 'validate', [strictPlatform], [unsupported]),
      /** 当前 Fixture 不加载真实 TypeScript 作者模块。 */
      loadTypeScriptModule: async () => undefined,
      environment: {},
    });

    expect(result.success).toBe(false);
    expect(result.deliveryUnits).toEqual([]);
    expect(result.compatibility).toContainEqual(expect.objectContaining({ level: 'unsupported', platform: 'strict-platform' }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'COMPATIBILITY_STRICT' }));
  });

  it('authorizes scanned Component files relative to project.root instead of process.cwd()', async () => {
    /** 与测试进程 cwd 不同且包含一个规范 Command 的工程根。 */
    const root = await temporaryRoot();
    await fs.mkdir(path.join(root, 'src/commands'), { recursive: true });
    await fs.writeFile(path.join(root, 'src/commands/check.md'), '---\ndescription: Check changes.\n---\nCheck changes.\n');
    /** 将 Scanner 相对 sourcePath 解析为真实文件 Artifact 的虚拟 Platform。 */
    const platform = definePlatform({
      id: 'scanned-source',
      apiVersion: '1',
      deliveryType: 'plugin',
      /** prepare 把 Scanner 相对路径解析为真实工程文件来源。 */
      prepare(context) {
        /** Scanner 返回的工程相对 Command 来源路径。 */
        const sourcePath = context.project.commands[0]!.sourcePath;
        return {
          documents: [],
          artifacts: [{
            path: 'commands/check.md',
            source: { type: 'file', path: path.resolve(context.project.root, sourcePath) },
          }],
        };
      },
      /** generateBundle 透传已完成 owner 校验的扫描文件 Artifact。 */
      generateBundle(context) {
        return { id: 'plugin', role: 'primary', type: 'plugin', artifacts: context.artifacts };
      },
      /** validateBundle 接受成功物化的扫描来源候选。 */
      validateBundle: () => undefined,
    });

    /** 在非进程 cwd 工程上执行完整生命周期的结果。 */
    const result = await executeLifecycle({
      config: lifecycleConfig(root, 'validate', [platform], []),
      /** 当前 Fixture 不加载真实 TypeScript 作者模块。 */
      loadTypeScriptModule: async () => undefined,
      environment: {},
    });

    expect(result.success).toBe(true);
    expect(result.deliveryUnits[0]?.artifacts).toContainEqual(expect.objectContaining({
      path: 'commands/check.md', owner: 'platform:scanned-source',
    }));
  });

  it('preserves primary Artifact metadata through the Distribution lifecycle', async () => {
    /** 同时生成主 Plugin 和 Marketplace Distribution 的虚拟 Platform。 */
    const platform = definePlatform({
      id: 'distribution-platform',
      apiVersion: '1',
      deliveryType: 'plugin',
      /** prepare 为当前 Distribution 测试创建空 Draft。 */
      prepare: () => ({ documents: [], artifacts: [] }),
      /** generateBundle 创建带可执行 Artifact 的主单元。 */
      generateBundle: () => ({
        id: 'plugin', role: 'primary', type: 'plugin',
        artifacts: [{ ...bytesArtifact('bin/runner', 'run'), mode: 0o755 }],
      }),
      /** validateBundle 同时接受主单元和 Distribution 候选。 */
      validateBundle: () => undefined,
      /** generateDistributions 复用主单元 Artifact 创建 Marketplace。 */
      generateDistributions(_context, primaryUnits) {
        return [{
          id: 'marketplace', role: 'distribution', type: 'marketplace',
          artifacts: primaryUnits[0]!.artifacts,
        }];
      },
    });
    /** 空工程上的双 DeliveryUnit 生命周期结果。 */
    const root = await temporaryRoot();
    /** 用于对比主单元与 Distribution 元数据的构建报告。 */
    const result = await executeLifecycle({
      config: lifecycleConfig(root, 'validate', [platform], []),
      /** 当前 Fixture 不加载真实 TypeScript 作者模块。 */
      loadTypeScriptModule: async () => undefined,
      environment: {},
    });
    /** 主 Plugin 单元的唯一 Artifact 报告。 */
    const primary = result.deliveryUnits.find(unit => unit.role === 'primary')!.artifacts[0]!;
    /** Marketplace Distribution 复用后的唯一 Artifact 报告。 */
    const distribution = result.deliveryUnits.find(unit => unit.role === 'distribution')!.artifacts[0]!;

    expect(result.success).toBe(true);
    expect(distribution).toEqual(primary);
  });
});
