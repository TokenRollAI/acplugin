import {
  defineConfig,
  type UserConfig,
} from '@tokenroll/acplugin';
// @ts-expect-error Integration factories are intentionally absent from the root author facade.
import { definePlatform as definePlatformFromRoot } from '@tokenroll/acplugin';
import {
  defineExtension,
  definePlatform,
  type AcpluginExtension,
  type AcpluginPlatform,
  type ExtensionDefinition,
  type ManagedRolldownInputOptions,
  type ManagedRolldownOutputOptions,
  type ManagedRolldownPlugin,
  type PlatformDefinition,
  type SourceFileRef,
} from '@tokenroll/acplugin/sdk';
// @ts-expect-error Project control types belong to the root author facade, not the integration SDK.
import type { Project } from '@tokenroll/acplugin/sdk';

/**
 * 验证普通作者根入口和可信集成 SDK 使用不同且明确的类型表面。
 */
export function verifyKernelV2SdkTypes(): void {
  /** 第三方 Platform 只从 sdk subpath 创建。 */
  const platform: AcpluginPlatform = definePlatform({
    id: 'community-platform',
    apiVersion: '1',
    deliveryType: 'plugin',
    /** 每轮创建独立 Platform Session。 */
    createSession: () => ({
      /** 创建空 base Package。 */
      createPackage: () => ({ documents: [], assets: [], compatibility: [], metadata: [] }),
      /** 创建主 Plugin Package。 */
      finalizePackage: () => ({ id: 'plugin', type: 'plugin' }),
      /** 最小 fixture 不增加 candidate 约束。 */
      validatePackage: () => undefined,
    }),
  });
  /** 第三方 Extension 只从 sdk subpath 创建。 */
  const extension: AcpluginExtension = defineExtension({
    id: 'community-extension',
    apiVersion: '1',
    resourceRoots: ['community'],
    /** 每轮创建独立 Extension Session。 */
    createSession: () => ({
      /** fixture 没有作者资源。 */
      discover: () => undefined,
      /** fixture 没有 compatibility subject。 */
      validate: () => ({ state: {}, subjects: [] }),
      /** fixture 没有 Built State。 */
      build: () => ({ state: {} }),
      contributors: [],
    }),
  });
  /** 作者配置仅消费已完成品牌化的 Integration。 */
  const config: UserConfig = defineConfig({
    name: 'sdk-fixture',
    version: '1.0.0',
    description: 'SDK fixture.',
    platforms: [platform],
    extensions: [extension],
  }) as UserConfig;
  /** defineConfig 必须保留调用方字面量而不是退化成 UserConfig 联合类型。 */
  const inferred = defineConfig({
    name: 'inferred',
    version: '1.0.0',
    description: 'Inferred.',
    platforms: [platform],
    build: { strict: true },
  });
  /** 字面量 true 用于验证 const generic inference。 */
  const strictLiteral: true = inferred.build.strict;
  /** managed Profile 从 Rolldown 派生可使用的 trusted Plugin hook。 */
  const plugin: ManagedRolldownPlugin = {
    name: 'managed-fixture',
    transform: code => code,
    generateBundle: () => undefined,
  };
  /** input 开放浏览器平台、alias 与显式 SourceRef tsconfig。 */
  const managedInput: ManagedRolldownInputOptions = {
    platform: 'browser',
    resolve: { alias: { feature: './feature.ts' } },
    plugins: [plugin],
    tsconfig: undefined as unknown as SourceFileRef,
  };
  /** output 开放多格式、分块、sourcemap 与 output Plugin。 */
  const managedOutput: ManagedRolldownOutputOptions = {
    format: 'es',
    codeSplitting: true,
    sourcemap: true,
    plugins: [plugin],
  };

  // @ts-expect-error Core 从 CompileEntry 建立 input，不接受 Rolldown 裸路径。
  const managedInputEscape: ManagedRolldownInputOptions = { input: '/tmp/escape.ts' };
  // @ts-expect-error Core 接管物理 output dir，只运行 generate()。
  const managedOutputEscape: ManagedRolldownOutputOptions = { dir: '/tmp/escape' };
  // @ts-expect-error write lifecycle 不在 generate-only managed Profile 中假装可用。
  const managedWritePlugin: ManagedRolldownPlugin = { name: 'write', writeBundle: () => undefined };

  // @ts-expect-error v1 Platform prepare 已从 v2 contract 删除。
  const oldPlatform: PlatformDefinition = { id: 'old', apiVersion: '1', deliveryType: 'plugin', prepare: () => ({}) };
  // @ts-expect-error Extension identity 已统一为 id，不再使用 name。
  const oldExtension: ExtensionDefinition = { name: 'old', apiVersion: '1', resourceRoots: [], createSession: () => ({}) };
  // @ts-expect-error SourceRef 的 private type brand 阻止等形对象在类型层伪造。
  const forgedSource: SourceFileRef = { kind: 'source-file', path: 'src/file.ts' };

  void [
    config,
    oldPlatform,
    oldExtension,
    forgedSource,
    definePlatformFromRoot,
    strictLiteral,
    managedInput,
    managedOutput,
    managedInputEscape,
    managedOutputEscape,
    managedWritePlugin,
    undefined as unknown as Project,
  ];
}
