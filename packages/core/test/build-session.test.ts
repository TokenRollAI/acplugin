import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BytesAssetRef, SourceAssetRef, SourceFileRef } from '../src/kernel-types.js';
import { defineExtension, definePlatform } from '../src/kernel-contracts.js';
import {
  createKernelBuildEnvironment,
  disposeKernelBuildEnvironment,
  runKernelBuildSession,
} from '../src/kernel/build-session.js';
import { resolveKernelConfig } from '../src/kernel/config-resolver.js';

/** 当前套件创建并统一删除的临时工程。 */
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

/** 创建包含 canonical/public/Extension resource 的最小工程。 */
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-build-session-'));
  roots.push(root);
  await fs.mkdir(path.join(root, 'src', 'commands'), { recursive: true });
  await fs.mkdir(path.join(root, 'src', 'addons'), { recursive: true });
  await fs.mkdir(path.join(root, 'public'), { recursive: true });
  await fs.writeFile(path.join(root, 'acplugin.config.ts'), 'export default {}\n');
  await fs.writeFile(path.join(root, 'src', 'commands', 'review.md'), [
    '---',
    'description: Review changes.',
    '---',
    'Review the current changes.',
    '',
  ].join('\n'));
  await fs.writeFile(path.join(root, 'src', 'addons', 'notice.txt'), 'extension notice\n');
  await fs.writeFile(path.join(root, 'public', 'README.txt'), 'public readme\n');
  return root;
}

/** Platform 必须对当前 metadata 和 Component 提供完整兼容结论。 */
function metadata() {
  return ['name', 'version', 'description'].map(field => ({
    field,
    disposition: 'emitted' as const,
    output: `manifest/${field}`,
    reason: 'The field is emitted by the conformance package.',
  }));
}

describe('Kernel BuildSession', () => {
  it('runs the fixed package pipeline, contributes Resources and closes in reverse setup order', async () => {
    const root = await fixture();
    /** 调用序列验证 setup、Resource、Package、candidate 和 cleanup 顺序。 */
    const events: string[] = [];
    /** validate hook 对每个 canonical Component 只允许调用一次。 */
    const validated: string[] = [];
    const platform = definePlatform({
      id: 'conformance',
      apiVersion: '1',
      deliveryType: 'plugin',
      createSession() {
        events.push('setup:platform');
        return {
          validateComponent({ component }) {
            events.push(`validate:${component.kind}:${component.id}`);
            validated.push(`${component.kind}:${component.id}`);
          },
          createPackage({ project, assets }) {
            events.push('package:create');
            return assets.fromBytes({ bytes: 'base\n', origin: { operation: 'base-package' } }).then(asset => ({
              documents: [],
              assets: [{ path: 'base.txt', asset }],
              compatibility: project.commands.map(command => ({
                subject: `command:${command.id}`,
                capability: 'component',
                level: 'native' as const,
                reason: 'The command is delivered natively.',
              })),
              metadata: metadata(),
            }));
          },
          finalizePackage() {
            events.push('package:finalize');
            return { id: 'plugin', type: 'plugin' as const };
          },
          async validatePackage({ candidate }) {
            events.push(`package:validate:${candidate.unit.role}`);
            await expect(fs.readFile(path.join(candidate.root, 'base.txt'), 'utf8')).resolves.toBe('base\n');
            await expect(fs.readFile(path.join(candidate.root, 'README.txt'), 'utf8')).resolves.toBe('public readme\n');
            await expect(fs.readFile(path.join(candidate.root, 'extension', 'notice.txt'), 'utf8')).resolves.toBe('extension notice\n');
          },
          close({ outcome, committed }) {
            events.push(`close:platform:${outcome}:${committed}`);
          },
        };
      },
    });
    const extension = defineExtension<Record<string, never>, { readonly file: SourceFileRef }, { readonly file: SourceFileRef }, { readonly asset: SourceAssetRef }>({
      id: 'conformance-extension',
      apiVersion: '1',
      options: {},
      resourceRoots: ['addons'],
      createSession() {
        events.push('setup:extension');
        return {
          async discover({ roots, sources }) {
            events.push('extension:discover');
            const root = roots.addons;
            if (root === undefined)
              return undefined;
            return { file: await sources.file(root, 'notice.txt') };
          },
          validate(_context, discovered) {
            events.push('extension:validate');
            return { state: discovered, subjects: [{ subject: 'addon:notice', capabilities: ['delivery'] }] };
          },
          async build({ assets }, validatedState) {
            events.push('extension:build');
            return { state: { asset: await assets.fromSource(validatedState.file) } };
          },
          contributors: [{
            platform: 'conformance',
            platformApiVersion: '1',
            async contribute({ assets: _assets }, built) {
              events.push('extension:contribute');
              return {
                assets: [{ path: 'extension/notice.txt', asset: built.asset }],
                compatibility: [{
                  subject: 'addon:notice',
                  capability: 'delivery',
                  level: 'native',
                  reason: 'The addon is delivered natively.',
                }],
              };
            },
          }],
          close({ outcome, committed }) {
            events.push(`close:extension:${outcome}:${committed}`);
          },
        };
      },
    });
    const resolved = resolveKernelConfig({
      name: 'conformance-plugin',
      version: '1.0.0',
      description: 'BuildSession conformance.',
      platforms: [platform],
      extensions: [extension],
    }, {
      projectRoot: root,
      configFile: path.join(root, 'acplugin.config.ts'),
      command: 'build',
      mode: 'production',
    });
    expect(resolved.diagnostics).toEqual([]);
    const result = await runKernelBuildSession({
      config: resolved.config!,
      frameworkVersion: 'test',
      commit: false,
    });

    expect(result.report.success, JSON.stringify(result.report.diagnostics, null, 2)).toBe(true);
    expect(result.report.committed).toBe(false);
    expect(validated).toEqual(['command:review']);
    expect(result.report.packages).toHaveLength(1);
    expect(result.report.packages[0]?.assets.map(asset => [asset.path, asset.owner])).toEqual([
      ['README.txt', 'framework:public'],
      ['base.txt', 'platform:conformance'],
      ['extension/notice.txt', 'extension:conformance-extension'],
    ]);
    expect(events).toEqual([
      'setup:platform',
      'setup:extension',
      'extension:discover',
      'validate:command:review',
      'extension:validate',
      'extension:build',
      'package:create',
      'extension:contribute',
      'package:finalize',
      'package:validate:primary',
      'close:extension:success:false',
      'close:platform:success:false',
    ]);
  });

  it('places reverse close in the rollback window and reports cleanup failure without committing', async () => {
    const root = await fixture();
    await fs.mkdir(path.join(root, 'dist', 'conformance', 'old'), { recursive: true });
    await fs.writeFile(path.join(root, 'dist', 'conformance', 'old', 'stable.txt'), 'old\n');
    const platform = definePlatform({
      id: 'conformance', apiVersion: '1', deliveryType: 'plugin',
      createSession: () => ({
        createPackage: ({ project, assets }) => assets.fromBytes({ bytes: 'new\n', origin: { operation: 'new-package' } }).then(asset => ({
          documents: [], assets: [{ path: 'new.txt', asset }],
          compatibility: project.commands.map(command => ({
            subject: `command:${command.id}`, capability: 'component', level: 'native' as const, reason: 'Native command.',
          })),
          metadata: metadata(),
        })),
        finalizePackage: () => ({ id: 'plugin', type: 'plugin' as const }),
        validatePackage: () => undefined,
        close: () => { throw new Error('secret=/private/build-machine'); },
      }),
    });
    const resolved = resolveKernelConfig({
      name: 'rollback-plugin', version: '1.0.0', description: 'Rollback.', platforms: [platform], public: false,
    }, {
      projectRoot: root, configFile: path.join(root, 'acplugin.config.ts'), command: 'build', mode: 'production',
    });
    const result = await runKernelBuildSession({ config: resolved.config!, frameworkVersion: 'test', commit: true });

    expect(result.report.success).toBe(false);
    expect(result.report.committed).toBe(false);
    expect(result.report.diagnostics).toContainEqual(expect.objectContaining({ code: 'PLATFORM_CLOSE_FAILED', phase: 'cleanup' }));
    expect(result.report.diagnostics.map(item => item.message).join('\n')).not.toContain('/private/build-machine');
    await expect(fs.readFile(path.join(root, 'dist', 'conformance', 'old', 'stable.txt'), 'utf8')).resolves.toBe('old\n');
    await expect(fs.access(path.join(root, 'dist', 'conformance', 'plugin', 'new.txt'))).rejects.toThrow();
  });

  it('continues independent setup and closes every initialized session once in reverse order', async () => {
    const root = await fixture();
    /** 部分 setup 失败前后发生的调用必须保持固定配置顺序。 */
    const events: string[] = [];
    const healthy = definePlatform({
      id: 'healthy', apiVersion: '1', deliveryType: 'plugin',
      createSession: () => {
        events.push('setup:healthy');
        return {
          createPackage: ({ project }) => ({
            documents: [], assets: [],
            compatibility: project.commands.map(command => ({
              subject: `command:${command.id}`, capability: 'component', level: 'native' as const, reason: 'Native command.',
            })),
            metadata: metadata(),
          }),
          finalizePackage: () => ({ id: 'plugin', type: 'plugin' as const }),
          validatePackage: () => undefined,
          close: () => { events.push('close:healthy'); },
        };
      },
    });
    const broken = definePlatform({
      id: 'broken', apiVersion: '1', deliveryType: 'plugin',
      createSession: () => {
        events.push('setup:broken');
        throw new Error('setup secret');
      },
    });
    const extension = defineExtension({
      id: 'cleanup-probe', apiVersion: '1', resourceRoots: ['addons'],
      createSession: () => {
        events.push('setup:extension');
        return {
          discover: () => undefined,
          validate: (_context, state) => ({ state, subjects: [] }),
          build: (_context, state) => ({ state }),
          contributors: [],
          close: () => { events.push('close:extension'); },
        };
      },
    });
    const resolved = resolveKernelConfig({
      name: 'partial-setup', version: '1.0.0', description: 'Partial setup.',
      platforms: [healthy, broken], extensions: [extension], public: false,
    }, {
      projectRoot: root, configFile: path.join(root, 'acplugin.config.ts'), command: 'validate', mode: 'production',
    });
    const result = await runKernelBuildSession({ config: resolved.config!, frameworkVersion: 'test', commit: false });

    expect(result.report.success).toBe(false);
    expect(result.report.packages).toContainEqual(expect.objectContaining({ platform: 'healthy', validated: true }));
    expect(result.report.diagnostics).toContainEqual(expect.objectContaining({ code: 'PLATFORM_SETUP_FAILED', platform: 'broken' }));
    expect(events).toEqual([
      'setup:healthy',
      'setup:broken',
      'setup:extension',
      'close:extension',
      'close:healthy',
    ]);
  });

  it('preserves the primary package failure in close context when cleanup also fails', async () => {
    const root = await fixture();
    await fs.rm(path.join(root, 'src', 'addons'), { recursive: true });
    /** close 只能观察脱敏后的首个业务失败，而不能收到原始异常。 */
    let closeFailure: { readonly code: string; readonly phase: string; readonly message: string } | undefined;
    const platform = definePlatform({
      id: 'failed-package', apiVersion: '1', deliveryType: 'plugin',
      createSession: () => ({
        createPackage: () => { throw new Error('token=package-secret'); },
        finalizePackage: () => ({ id: 'plugin', type: 'plugin' as const }),
        validatePackage: () => undefined,
        close: (context) => {
          closeFailure = context.failure;
          throw new Error('token=cleanup-secret');
        },
      }),
    });
    const resolved = resolveKernelConfig({
      name: 'failure-precedence', version: '1.0.0', description: 'Failure precedence.', platforms: [platform], public: false,
    }, {
      projectRoot: root, configFile: path.join(root, 'acplugin.config.ts'), command: 'build', mode: 'production',
    });
    const result = await runKernelBuildSession({ config: resolved.config!, frameworkVersion: 'test', commit: false });

    expect(closeFailure).toEqual({
      code: 'PLATFORM_CREATE_PACKAGE_FAILED',
      phase: 'package',
      message: 'Platform "failed-package" createPackage failed.',
    });
    expect(result.report.diagnostics.map(item => item.code)).toEqual(expect.arrayContaining([
      'PLATFORM_CREATE_PACKAGE_FAILED', 'PLATFORM_CLOSE_FAILED',
    ]));
    expect(JSON.stringify(result.report)).not.toContain('package-secret');
    expect(JSON.stringify(result.report)).not.toContain('cleanup-secret');
  });

  it('keeps successful Platform packages inspectable when another Platform fails concurrently', async () => {
    const root = await fixture();
    await fs.rm(path.join(root, 'src', 'addons'), { recursive: true });
    /** 不同延迟组合用于证明完成顺序不影响稳定报告。 */
    const execute = async (healthyDelay: number, brokenDelay: number) => {
      const healthy = definePlatform({
        id: 'healthy', apiVersion: '1', deliveryType: 'plugin',
        createSession: () => ({
          async createPackage({ project, assets }) {
            await new Promise(resolve => setTimeout(resolve, healthyDelay));
            const asset = await assets.fromBytes({ bytes: 'stable\n', origin: { operation: 'stable-package' } });
            return {
              documents: [], assets: [{ path: 'stable.txt', asset }],
              compatibility: project.commands.map(command => ({
                subject: `command:${command.id}`, capability: 'component', level: 'native' as const, reason: 'Native command.',
              })),
              metadata: metadata(),
            };
          },
          finalizePackage: () => ({ id: 'plugin', type: 'plugin' as const }),
          validatePackage: () => undefined,
        }),
      });
      const broken = definePlatform({
        id: 'broken', apiVersion: '1', deliveryType: 'plugin',
        createSession: () => ({
          async createPackage() {
            await new Promise(resolve => setTimeout(resolve, brokenDelay));
            throw new Error('nondeterministic raw failure');
          },
          finalizePackage: () => ({ id: 'plugin', type: 'plugin' as const }),
          validatePackage: () => undefined,
        }),
      });
      const resolved = resolveKernelConfig({
        name: 'parallel-platforms', version: '1.0.0', description: 'Parallel Platforms.',
        platforms: [healthy, broken], public: false,
      }, {
        projectRoot: root, configFile: path.join(root, 'acplugin.config.ts'), command: 'inspect', mode: 'production',
      });
      return (await runKernelBuildSession({ config: resolved.config!, frameworkVersion: 'test', commit: false })).report;
    };

    const first = await execute(20, 0);
    const second = await execute(0, 20);
    expect(first).toEqual(second);
    expect(first.success).toBe(false);
    expect(first.platforms).toContainEqual({ id: 'healthy', selected: true, success: true, packageIds: ['plugin'] });
    expect(first.platforms).toContainEqual({ id: 'broken', selected: true, success: false, packageIds: [] });
    expect(first.packages).toContainEqual(expect.objectContaining({ platform: 'healthy', validated: true }));
    expect(first.diagnostics).toContainEqual(expect.objectContaining({ code: 'PLATFORM_CREATE_PACKAGE_FAILED', platform: 'broken' }));
  });

  it.each([
    ['createPackage', 'package', 'PLATFORM_CREATE_PACKAGE_FAILED'],
    ['contribute', 'contribute', 'PLATFORM_CONTRIBUTION_FAILED'],
    ['finalizePackage', 'finalize', 'PLATFORM_FINALIZE_PACKAGE_FAILED'],
    ['createDistributions', 'finalize', 'PLATFORM_FINALIZE_PACKAGE_FAILED'],
    ['materialize', 'materialize', 'PACKAGE_CANDIDATE_MATERIALIZATION_FAILED'],
    ['validatePackage', 'platform-validate', 'PLATFORM_VALIDATE_PACKAGE_FAILED'],
  ] as const)('reports %s failure in its exact stage while another Platform completes', async (failure, phase, code) => {
    const root = await fixture();
    /** 只有 Contribution case 需要 addons root，其他 case 删除未认领 Extension 来源。 */
    if (failure !== 'contribute')
      await fs.rm(path.join(root, 'src', 'addons'), { recursive: true });
    /** 两个平台共享的有效 base output 让断言只改变目标阶段。 */
    const platform = (id: 'healthy' | 'broken') => definePlatform({
      id,
      apiVersion: '1',
      deliveryType: 'plugin',
      createSession: () => ({
        async createPackage({ project, assets }) {
          if (id === 'broken' && failure === 'createPackage')
            throw new Error('raw create failure');
          const asset = await assets.fromBytes({ bytes: `${id}\n`, origin: { operation: 'stage-probe' } });
          return {
            documents: [],
            assets: [{ path: `${id}.txt`, asset }],
            compatibility: project.commands.map(command => ({
              subject: `command:${command.id}`,
              capability: 'component',
              level: 'native' as const,
              reason: 'The stage probe delivers the command natively.',
            })),
            metadata: metadata(),
          };
        },
        finalizePackage() {
          if (id === 'broken' && failure === 'finalizePackage')
            throw new Error('raw finalize failure');
          return { id: 'plugin', type: 'plugin' as const };
        },
        async validatePackage({ candidate }) {
          if (id !== 'broken')
            return;
          if (failure === 'validatePackage')
            throw new Error('raw validator failure');
          if (failure === 'materialize')
            await fs.writeFile(path.join(candidate.root, 'unexpected.txt'), 'mutation\n');
        },
        createDistributions() {
          if (id === 'broken' && failure === 'createDistributions')
            throw new Error('raw distribution failure');
          return [];
        },
      }),
    });
    /** Contribution failure 由真实 Extension Contributor 抛出，不能归到 package。 */
    const extension = failure === 'contribute'
      ? defineExtension({
          id: 'stage-probe',
          apiVersion: '1',
          resourceRoots: ['addons'],
          createSession: () => ({
            discover: () => ({}),
            validate: (_context, discovered) => ({ state: discovered, subjects: [] }),
            build: (_context, validated) => ({ state: validated }),
            contributors: [{
              platform: 'broken',
              platformApiVersion: '1',
              contribute: () => { throw new Error('raw contribution failure'); },
            }],
          }),
        })
      : undefined;
    const resolved = resolveKernelConfig({
      name: 'stage-boundaries',
      version: '1.0.0',
      description: 'Stage diagnostic boundaries.',
      platforms: [platform('healthy'), platform('broken')],
      ...(extension === undefined ? {} : { extensions: [extension] }),
      public: false,
    }, {
      projectRoot: root,
      configFile: path.join(root, 'acplugin.config.ts'),
      command: 'inspect',
      mode: 'production',
    });
    const result = await runKernelBuildSession({ config: resolved.config!, frameworkVersion: 'test', commit: false });

    expect(result.report.success).toBe(false);
    expect(result.report.platforms).toContainEqual({ id: 'healthy', selected: true, success: true, packageIds: ['plugin'] });
    expect(result.report.platforms).toContainEqual({ id: 'broken', selected: true, success: false, packageIds: [] });
    expect(result.report.packages).toContainEqual(expect.objectContaining({ platform: 'healthy', validated: true }));
    expect(result.report.packages.some(unit => unit.platform === 'broken')).toBe(false);
    expect(result.report.diagnostics.filter(item => item.platform === 'broken')).toContainEqual(expect.objectContaining({
      code,
      phase,
      owner: 'platform:broken',
    }));
    expect(JSON.stringify(result.report)).not.toContain('raw ');
  });

  it('preserves Extension build failure ownership and blocks only matching consumers', async () => {
    const root = await fixture();
    /** 当前用例的两个 Extension 不声明 Resource root，移除通用 addons fixture。 */
    await fs.rm(path.join(root, 'src', 'addons'), { recursive: true });
    /** 两个平台的阶段调用用于证明 failed Built State 在 createPackage 前完成路由。 */
    const created: string[] = [];
    /** 独立 Platform 使用 relaxed strict 以保留 failed Extension 的显式 unsupported tuple。 */
    const platform = (id: 'supported' | 'independent') => definePlatform({
      id,
      apiVersion: '1',
      deliveryType: 'plugin',
      strict: false,
      createSession: () => ({
        createPackage: ({ project }) => {
          created.push(id);
          return {
            documents: [],
            assets: [],
            compatibility: project.commands.map(command => ({
              subject: `command:${command.id}`,
              capability: 'component',
              level: 'native' as const,
              reason: 'The fixture delivers canonical commands.',
            })),
            metadata: metadata(),
          };
        },
        finalizePackage: () => ({ id: 'plugin', type: 'plugin' as const }),
        validatePackage: () => undefined,
      }),
    });
    /** build throw 是当前失败唯一权威来源；Contributor 只匹配 supported。 */
    const failed = defineExtension({
      id: 'failed-extension',
      apiVersion: '1',
      resourceRoots: [],
      createSession: () => ({
        discover: () => ({}),
        validate: (_context, state) => ({
          state,
          subjects: [{ subject: 'failed:resource', capabilities: ['delivery'] }],
        }),
        build: () => { throw new Error('raw failed Extension build'); },
        contributors: [{
          platform: 'supported',
          platformApiVersion: '1',
          contribute: () => ({
            compatibility: [{
              subject: 'failed:resource', capability: 'delivery', level: 'native', reason: 'Unreachable.',
            }],
          }),
        }],
      }),
    });
    /** 成功 Extension 只服务 independent，证明独立 build/contribution 继续执行。 */
    const successful = defineExtension<Record<string, never>, Record<string, never>, Record<string, never>, { readonly asset: BytesAssetRef }>({
      id: 'successful-extension',
      apiVersion: '1',
      resourceRoots: [],
      createSession: () => ({
        discover: () => ({}),
        validate: (_context, state) => ({
          state,
          subjects: [{ subject: 'successful:resource', capabilities: ['delivery'] }],
        }),
        async build({ assets }) {
          return { state: { asset: await assets.fromBytes({ bytes: 'ready\n', origin: { operation: 'successful-extension' } }) } };
        },
        contributors: [{
          platform: 'independent',
          platformApiVersion: '1',
          contribute: (_context, state) => ({
            assets: [{ path: 'successful.txt', asset: state.asset }],
            compatibility: [{
              subject: 'successful:resource', capability: 'delivery', level: 'native', reason: 'Delivered independently.',
            }],
          }),
        }],
      }),
    });
    const resolved = resolveKernelConfig({
      name: 'extension-failure-ownership',
      version: '1.0.0',
      description: 'Extension failure ownership fixture.',
      platforms: [platform('supported'), platform('independent')],
      extensions: [failed, successful],
      public: false,
    }, {
      projectRoot: root,
      configFile: path.join(root, 'acplugin.config.ts'),
      command: 'inspect',
      mode: 'production',
    });
    const result = await runKernelBuildSession({ config: resolved.config!, frameworkVersion: 'test', commit: false });

    expect(result.report.success).toBe(false);
    expect(created).toEqual(['independent']);
    expect(result.report.platforms).toEqual(expect.arrayContaining([
      { id: 'supported', selected: true, success: false, packageIds: [] },
      { id: 'independent', selected: true, success: true, packageIds: ['plugin'] },
    ]));
    expect(result.report.packages).toContainEqual(expect.objectContaining({ platform: 'independent', validated: true }));
    expect(result.report.packages.some(unit => unit.platform === 'supported')).toBe(false);
    expect(result.report.compatibility).toEqual(expect.arrayContaining([
      expect.objectContaining({ platform: 'independent', subject: 'failed:resource', capability: 'delivery', level: 'unsupported' }),
      expect.objectContaining({ platform: 'independent', subject: 'successful:resource', capability: 'delivery', level: 'native' }),
    ]));
    expect(result.report.diagnostics.filter(diagnostic => diagnostic.code === 'EXTENSION_BUILD_FAILED')).toHaveLength(1);
    expect(result.report.diagnostics.some(diagnostic => diagnostic.code === 'PLATFORM_CONTRIBUTION_FAILED')).toBe(false);
    expect(JSON.stringify(result.report)).not.toContain('raw failed');
  });

  it('uses exactly one aggregate or transaction materialization after candidate validation', async () => {
    /** 每个执行建立独立环境，以 materializationBytes 次数识别完整物化路径。 */
    const execute = async (command: 'validate' | 'inspect' | 'build', withExtensionError = false) => {
      const root = await fixture();
      await fs.rm(path.join(root, 'src', 'addons'), { recursive: true });
      await fs.rm(path.join(root, 'public'), { recursive: true });
      const environment = await createKernelBuildEnvironment(root);
      /** 当前 Platform 的唯一 Asset 每次完整物化恰好读取一次。 */
      const reads = vi.spyOn(environment.assets, 'materializationBytes');
      const platform = definePlatform({
        id: 'materialization-probe', apiVersion: '1', deliveryType: 'plugin',
        createSession: () => ({
          async createPackage({ project, assets }) {
            const asset = await assets.fromBytes({ bytes: 'probe\n', origin: { operation: 'materialization-probe' } });
            return {
              documents: [], assets: [{ path: 'probe.txt', asset }],
              compatibility: project.commands.map(item => ({
                subject: `command:${item.id}`, capability: 'component', level: 'native' as const, reason: 'Native command.',
              })),
              metadata: metadata(),
            };
          },
          finalizePackage: () => ({ id: 'plugin', type: 'plugin' as const }),
          validatePackage: () => undefined,
        }),
      });
      /** Extension-owned validation error prevents commit without becoming a project-wide package blocker。 */
      const extension = withExtensionError
        ? defineExtension({
            id: 'materialization-error', apiVersion: '1', resourceRoots: [],
            createSession: () => ({
              discover: () => ({}),
              validate(context, state) {
                context.diagnostics.report({ code: 'MATERIALIZATION_FIXTURE_ERROR', severity: 'error', message: 'Fixture error.' });
                return { state, subjects: [{ subject: 'fixture:error', capabilities: ['delivery'] }] };
              },
              build: (_context, state) => ({ state }),
              contributors: [],
            }),
          })
        : undefined;
      const resolved = resolveKernelConfig({
        name: 'materialization-probe', version: '1.0.0', description: 'Materialization probe.',
        platforms: [platform],
        ...(extension === undefined ? {} : { extensions: [extension] }),
        public: false,
      }, {
        projectRoot: root, configFile: path.join(root, 'acplugin.config.ts'), command, mode: 'production',
      });
      try {
        const result = await runKernelBuildSession({
          config: resolved.config!, frameworkVersion: 'test', commit: command === 'build', environment,
        });
        return { report: result.report, reads: reads.mock.calls.length };
      } finally {
        reads.mockRestore();
        await disposeKernelBuildEnvironment(environment);
      }
    };

    /** validate/inspect 使用 candidate + aggregate；clean build 使用 candidate + transaction。 */
    for (const command of ['validate', 'inspect'] as const) {
      const result = await execute(command);
      expect(result.report.success).toBe(true);
      expect(result.reads).toBe(2);
    }
    const committed = await execute('build');
    expect(committed.report.success).toBe(true);
    expect(committed.report.committed).toBe(true);
    expect(committed.reads).toBe(2);
    /** build error 阻止 transaction，因此仍必须保留 candidate + aggregate 两次读取。 */
    const failed = await execute('build', true);
    expect(failed.report.success).toBe(false);
    expect(failed.report.committed).toBe(false);
    expect(failed.reads).toBe(2);
  });

  it('compiles built-in Runtime once and contributes identical refs to capability-compatible Platforms', async () => {
    const root = await fixture();
    await fs.rm(path.join(root, 'src', 'addons'), { recursive: true });
    await fs.mkdir(path.join(root, 'src', 'runtime'), { recursive: true });
    await fs.writeFile(path.join(root, 'src', 'runtime', 'cli.ts'), 'process.stdout.write("runtime-ready\\n");\n');
    /** 两个支持 Platform 必须读取到同一份 Bundle 字节与 executable mode。 */
    const observed: { platform: string; bytes: Uint8Array }[] = [];
    const supported = (id: string) => definePlatform({
      id, apiVersion: '1', deliveryType: 'plugin',
      capabilities: { nodeRuntime: { target: 'node20', format: 'esm', root: 'plugin' } },
      createSession: () => ({
        createPackage: ({ project }) => ({
          documents: [], assets: [],
          compatibility: project.commands.map(command => ({
            subject: `command:${command.id}`, capability: 'component', level: 'native' as const, reason: 'Native command.',
          })),
          metadata: metadata(),
        }),
        finalizePackage: () => ({ id: 'plugin', type: 'plugin' as const }),
        async validatePackage({ candidate }) {
          /** Candidate 物化证明 Runtime 由 Framework Contribution 自动继承。 */
          const runtime = await fs.readFile(path.join(candidate.root, 'runtime', 'cli', 'main.mjs'));
          observed.push({ platform: id, bytes: runtime });
          expect(candidate.unit.assets.find(asset => asset.path === 'runtime/cli/main.mjs')).toMatchObject({
            owner: 'framework:node-runtime',
          });
        },
      }),
    });
    const resolved = resolveKernelConfig({
      name: 'runtime-build', version: '1.0.0', description: 'Runtime build.',
      platforms: [supported('alpha'), supported('beta')], public: false,
    }, {
      projectRoot: root, configFile: path.join(root, 'acplugin.config.ts'), command: 'inspect', mode: 'production',
    });
    const result = await runKernelBuildSession({ config: resolved.config!, frameworkVersion: 'test', commit: false });

    expect(result.report.success, JSON.stringify(result.report.diagnostics, null, 2)).toBe(true);
    expect(result.report.runtimes).toEqual([{
      id: 'cli', kind: 'executable', location: { path: 'src/runtime/cli.ts' }, built: true,
    }]);
    expect(result.watch.paths).toContain(await fs.realpath(path.join(root, 'src', 'runtime', 'cli.ts')));
    expect(result.report.compatibility.filter(entry => entry.subject === 'runtime:cli')).toEqual([
      {
        platform: 'alpha', subject: 'runtime:cli', capability: 'node20-esm', level: 'native',
        reason: 'The platform can install and execute the bundled Node.js runtime.',
      },
      {
        platform: 'beta', subject: 'runtime:cli', capability: 'node20-esm', level: 'native',
        reason: 'The platform can install and execute the bundled Node.js runtime.',
      },
    ]);
    expect(observed).toHaveLength(2);
    expect(observed[0]!.bytes).toEqual(observed[1]!.bytes);
    const runtimeAssets = result.report.packages.flatMap(unit => unit.assets.filter(asset => asset.path === 'runtime/cli/main.mjs'));
    expect(runtimeAssets).toHaveLength(2);
    expect(runtimeAssets.map(asset => [asset.mode, asset.sha256, asset.origin])).toEqual([
      [0o755, runtimeAssets[0]!.sha256, runtimeAssets[0]!.origin],
      [0o755, runtimeAssets[0]!.sha256, runtimeAssets[0]!.origin],
    ]);
  });

  it('preserves Runtime owner, bytes, hash and origin through Marketplace inheritance', async () => {
    const root = await fixture();
    await fs.rm(path.join(root, 'src', 'addons'), { recursive: true });
    await fs.mkdir(path.join(root, 'src', 'runtime'), { recursive: true });
    await fs.writeFile(path.join(root, 'src', 'runtime', 'main.ts'), 'process.stdout.write("marketplace-runtime\\n");\n');
    const platform = definePlatform({
      id: 'marketplace-runtime', apiVersion: '1', deliveryType: 'plugin',
      capabilities: { nodeRuntime: { target: 'node20', format: 'esm', root: 'plugin' } },
      createSession: () => ({
        createPackage: ({ project }) => ({
          documents: [], assets: [],
          compatibility: project.commands.map(command => ({
            subject: `command:${command.id}`, capability: 'component', level: 'native' as const, reason: 'Native command.',
          })),
          metadata: metadata(),
        }),
        finalizePackage: () => ({ id: 'plugin', type: 'plugin' as const }),
        validatePackage: () => undefined,
        createDistributions: ({ primary }) => [{
          id: 'marketplace', type: 'marketplace' as const,
          assets: primary.assets.map(asset => ({ path: `plugin/${asset.path}`, asset: asset.asset })),
        }],
      }),
    });
    const resolved = resolveKernelConfig({
      name: 'runtime-marketplace', version: '1.0.0', description: 'Runtime Marketplace.', platforms: [platform], public: false,
    }, {
      projectRoot: root, configFile: path.join(root, 'acplugin.config.ts'), command: 'inspect', mode: 'production',
    });
    const result = await runKernelBuildSession({ config: resolved.config!, frameworkVersion: 'test', commit: false });

    expect(result.report.success, JSON.stringify(result.report.diagnostics, null, 2)).toBe(true);
    const primary = result.report.packages.find(unit => unit.role === 'primary')!.assets
      .find(asset => asset.path === 'runtime/main/main.mjs')!;
    const distribution = result.report.packages.find(unit => unit.role === 'distribution')!.assets
      .find(asset => asset.path === 'plugin/runtime/main/main.mjs')!;
    expect(distribution).toEqual({ ...primary, path: 'plugin/runtime/main/main.mjs' });
  });

  it('skips broken Runtime compilation when every selected Platform is unsupported', async () => {
    const root = await fixture();
    await fs.rm(path.join(root, 'src', 'addons'), { recursive: true });
    await fs.mkdir(path.join(root, 'src', 'runtime'), { recursive: true });
    /** 该 import 若被 portable-node 执行必然失败，用于证明 capability 协商发生在 compile 前。 */
    await fs.writeFile(path.join(root, 'src', 'runtime', 'cli.ts'), 'import "missing-runtime-package";\n');
    const platform = definePlatform({
      id: 'unsupported', apiVersion: '1', deliveryType: 'plugin', strict: false,
      createSession: () => ({
        createPackage: ({ project }) => ({
          documents: [], assets: [],
          compatibility: project.commands.map(command => ({
            subject: `command:${command.id}`, capability: 'component', level: 'native' as const, reason: 'Native command.',
          })),
          metadata: metadata(),
        }),
        finalizePackage: () => ({ id: 'plugin', type: 'plugin' as const }),
        validatePackage: () => undefined,
      }),
    });
    const resolved = resolveKernelConfig({
      name: 'runtime-skip', version: '1.0.0', description: 'Runtime skip.', platforms: [platform], public: false,
    }, {
      projectRoot: root, configFile: path.join(root, 'acplugin.config.ts'), command: 'inspect', mode: 'production',
    });
    const result = await runKernelBuildSession({ config: resolved.config!, frameworkVersion: 'test', commit: false });

    expect(result.report.success, JSON.stringify(result.report.diagnostics, null, 2)).toBe(true);
    expect(result.report.runtimes).toEqual([{
      id: 'cli', kind: 'executable', location: { path: 'src/runtime/cli.ts' }, built: false,
    }]);
    expect(result.report.packages.flatMap(unit => unit.assets).some(asset => asset.path.startsWith('runtime/'))).toBe(false);
    expect(result.report.compatibility).toContainEqual({
      platform: 'unsupported', subject: 'runtime:cli', capability: 'node20-esm', level: 'unsupported',
      reason: 'The platform does not provide a stable Plugin-local Node.js runtime.',
    });
    expect(result.report.diagnostics).toContainEqual(expect.objectContaining({
      code: 'COMPATIBILITY_RELAXED', severity: 'warning', platform: 'unsupported',
    }));
    expect(result.report.diagnostics.some(item => item.code === 'NODE_RUNTIME_BUILD_FAILED')).toBe(false);
  });

  it('delivers Runtime only to supported Platforms in a mixed capability build', async () => {
    const root = await fixture();
    await fs.rm(path.join(root, 'src', 'addons'), { recursive: true });
    await fs.mkdir(path.join(root, 'src', 'runtime'), { recursive: true });
    await fs.writeFile(path.join(root, 'src', 'runtime', 'worker.mts'), 'export const worker = "ready";\n');
    const platform = (id: string, runtime: boolean) => definePlatform({
      id, apiVersion: '1', deliveryType: 'plugin', strict: false,
      ...(runtime ? { capabilities: { nodeRuntime: { target: 'node20' as const, format: 'esm' as const, root: 'plugin' as const } } } : {}),
      createSession: () => ({
        createPackage: ({ project }) => ({
          documents: [], assets: [],
          compatibility: project.commands.map(command => ({
            subject: `command:${command.id}`, capability: 'component', level: 'native' as const, reason: 'Native command.',
          })),
          metadata: metadata(),
        }),
        finalizePackage: () => ({ id: 'plugin', type: 'plugin' as const }),
        validatePackage: () => undefined,
      }),
    });
    const resolved = resolveKernelConfig({
      name: 'runtime-mixed', version: '1.0.0', description: 'Runtime mixed.',
      platforms: [platform('supported', true), platform('unsupported', false)], public: false,
      runtime: { entries: { worker: { entry: 'worker.mts', kind: 'module' } }, compile: { treeshake: false } },
    }, {
      projectRoot: root, configFile: path.join(root, 'acplugin.config.ts'), command: 'inspect', mode: 'production',
    });
    const result = await runKernelBuildSession({ config: resolved.config!, frameworkVersion: 'test', commit: false });

    expect(result.report.success, JSON.stringify(result.report.diagnostics, null, 2)).toBe(true);
    expect(result.report.runtimes).toContainEqual(expect.objectContaining({ id: 'worker', kind: 'module', built: true }));
    const supported = result.report.packages.find(unit => unit.platform === 'supported')!;
    const unsupported = result.report.packages.find(unit => unit.platform === 'unsupported')!;
    expect(supported.assets).toContainEqual(expect.objectContaining({
      path: 'runtime/worker/main.mjs', owner: 'framework:node-runtime', mode: 0o644,
    }));
    expect(unsupported.assets.some(asset => asset.path.startsWith('runtime/'))).toBe(false);
    expect(result.report.compatibility.filter(entry => entry.subject === 'runtime:worker').map(entry => [entry.platform, entry.level])).toEqual([
      ['supported', 'native'],
      ['unsupported', 'unsupported'],
    ]);
  });

  it('fails all package finalization when a selected supported Runtime build fails', async () => {
    const root = await fixture();
    await fs.rm(path.join(root, 'src', 'addons'), { recursive: true });
    await fs.mkdir(path.join(root, 'src', 'runtime'), { recursive: true });
    await fs.writeFile(path.join(root, 'src', 'runtime', 'cli.ts'), 'import "missing-runtime-package";\n');
    /** finalize 调用数证明 Runtime build failure 位于全部 Platform finalization 之前。 */
    let finalized = 0;
    const platform = definePlatform({
      id: 'supported', apiVersion: '1', deliveryType: 'plugin',
      capabilities: { nodeRuntime: { target: 'node20', format: 'esm', root: 'plugin' } },
      createSession: () => ({
        createPackage: ({ project }) => ({
          documents: [], assets: [],
          compatibility: project.commands.map(command => ({
            subject: `command:${command.id}`, capability: 'component', level: 'native' as const, reason: 'Native command.',
          })),
          metadata: metadata(),
        }),
        finalizePackage: () => {
          finalized += 1;
          return { id: 'plugin', type: 'plugin' as const };
        },
        validatePackage: () => undefined,
      }),
    });
    const resolved = resolveKernelConfig({
      name: 'runtime-failure', version: '1.0.0', description: 'Runtime failure.', platforms: [platform], public: false,
    }, {
      projectRoot: root, configFile: path.join(root, 'acplugin.config.ts'), command: 'build', mode: 'production',
    });
    const result = await runKernelBuildSession({ config: resolved.config!, frameworkVersion: 'test', commit: true });

    expect(result.report.success).toBe(false);
    expect(result.report.committed).toBe(false);
    expect(result.report.packages).toEqual([]);
    expect(finalized).toBe(0);
    expect(result.report.diagnostics).toContainEqual(expect.objectContaining({
      code: 'NODE_RUNTIME_BUILD_FAILED', phase: 'compile', owner: 'framework:node-runtime',
    }));
  });
});
