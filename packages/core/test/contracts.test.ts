import { describe, expect, it } from 'vitest';
import {
  defineExtension,
  definePlatform,
  isAcpluginExtension,
  isAcpluginPlatform,
  type AcpluginPlatform,
  type ExtensionPlatformAdapter,
} from '../src/index.js';

/**
 * 创建品牌与版本测试共用的最小第三方 Platform。
 *
 * @returns 通过公开工厂构造的可安装 Plugin Platform。
 */
function thirdPartyPlatform(): AcpluginPlatform {
  return definePlatform({
    id: 'third-party',
    apiVersion: '1',
    deliveryType: 'plugin',
    strict: true,
    /** 创建不含 Document 与 Artifact 的初始 Draft。 */
    prepare: () => ({ documents: [], artifacts: [] }),
    /** 创建最小主 Plugin DeliveryUnit。 */
    generateBundle: () => ({ id: 'plugin', role: 'primary', type: 'plugin', artifacts: [] } as const),
    /** 最小 Platform 不需要附加候选校验。 */
    validateBundle: () => undefined,
  });
}

describe('Platform contract', () => {
  it('brands and freezes factory results while rejecting shape-compatible objects', () => {
    /** 公开工厂生成的有效第三方 Platform。 */
    const platform = thirdPartyPlatform();
    /** 具有相同公共字段但缺少私有 Symbol 的伪造对象。 */
    const fake = {
      id: 'third-party',
      apiVersion: '1',
      deliveryType: 'plugin',
      strict: true,
      /** prepare 提供当前对象协议要求的回调实现。 */ prepare: () => ({ documents: [], artifacts: [] }),
      /** generateBundle 提供当前对象协议要求的回调实现。 */ generateBundle: () => ({ id: 'plugin', role: 'primary', type: 'plugin', artifacts: [] } as const),
      /** validateBundle 提供当前对象协议要求的回调实现。 */ validateBundle: () => undefined,
    };

    expect(isAcpluginPlatform(platform)).toBe(true);
    expect(isAcpluginPlatform(fake)).toBe(false);
    expect(Object.isFrozen(platform)).toBe(true);
  });

  it('rejects invalid ids and unsupported API versions at runtime', () => {
    /** 用于验证运行时版本守卫的最小定义。 */
    const definition = {
      id: 'third-party',
      apiVersion: '1',
      deliveryType: 'plugin',
      strict: true,
      /** prepare 提供当前对象协议要求的回调实现。 */ prepare: () => ({ documents: [], artifacts: [] }),
      /** generateBundle 提供当前对象协议要求的回调实现。 */ generateBundle: () => ({ id: 'plugin', role: 'primary', type: 'plugin', artifacts: [] } as const),
      /** validateBundle 提供当前对象协议要求的回调实现。 */ validateBundle: () => undefined,
    } as const;

    expect(() => definePlatform({ ...definition, id: 'Third Party' })).toThrow('lowercase kebab-case');
    expect(() => definePlatform({ ...definition, apiVersion: '2' } as never)).toThrow('Unsupported Platform API version');
  });

  it('copies and deeply freezes JSON-only Platform options', () => {
    /** 配置作者仍持有并可能在工厂返回后修改的原始对象。 */
    const options = { marketplace: { policy: ['AVAILABLE'] } };
    /** 带 Platform 专属配置的第三方实例。 */
    const platform = definePlatform({
      ...thirdPartyPlatform(),
      options,
    });

    options.marketplace.policy.push('PRIVATE');
    expect(platform.options).toEqual({ marketplace: { policy: ['AVAILABLE'] } });
    expect(Object.isFrozen(platform.options)).toBe(true);
    expect(Object.isFrozen(platform.options!.marketplace)).toBe(true);
    expect(() => definePlatform({ ...thirdPartyPlatform(), options: [] } as never)).toThrow('JSON object');
    expect(() => definePlatform({
      ...thirdPartyPlatform(),
      options: {
        /** invalid 提供当前对象协议要求的回调实现。 */
        invalid: () => undefined,
      },
    } as never)).toThrow('JSON values');
  });
});

describe('Extension contract', () => {
  it('brands adapters with both API versions and rejects duplicate platform ownership', () => {
    /** Extension Adapter 引用的第三方 Platform。 */
    const platform = thirdPartyPlatform();
    /** 正向 Bridge Adapter，显式声明 Extension 与 Platform API 版本。 */
    const adapter: ExtensionPlatformAdapter<{ readonly file: string }> = {
      extensionApiVersion: '1',
      platform: platform.id,
      platformApiVersion: '1',
      /** 最小 Adapter 不需要修改 Draft。 */
      apply: () => undefined,
    };
    /** 使用泛型 Discovered/Built State 的有效第三方 Extension。 */
    const extension = defineExtension<{ readonly source: string }, { readonly file: string }>({
      name: 'third-party-extension',
      apiVersion: '1',
      /** 返回 Extension 自己拥有的发现状态。 */
      discover: () => ({ source: 'feature.ts' }),
      /** 把发现状态转换为跨 Platform 共用的 Built State。 */
      build: (_context, discovered) => ({ file: discovered.source }),
      adapters: [adapter],
    });

    expect(isAcpluginExtension(extension)).toBe(true);
    expect(Object.isFrozen(extension)).toBe(true);
    expect(Object.isFrozen(extension.adapters)).toBe(true);
    expect(() => defineExtension({
      name: 'duplicate-extension',
      apiVersion: '1',
      adapters: [adapter, { ...adapter }],
    })).toThrow('duplicate Adapter');
  });

  it('rejects fake Extension objects and incompatible Adapter versions', () => {
    /** Extension Adapter 引用的第三方 Platform。 */
    const platform = thirdPartyPlatform();
    /** 缺少私有 Extension Symbol 的普通对象。 */
    const fake = { name: 'fake', apiVersion: '1', adapters: [] };
    /** 通过 never 绕过静态检查，仅验证加载不可信配置时的运行时守卫。 */
    const incompatibleAdapter = {
      extensionApiVersion: '1',
      platform: platform.id,
      platformApiVersion: '2',
      /** apply 提供当前对象协议要求的回调实现。 */ apply: () => undefined,
    } as never;

    expect(isAcpluginExtension(fake)).toBe(false);
    expect(() => defineExtension({
      name: 'incompatible-extension',
      apiVersion: '1',
      adapters: [incompatibleAdapter],
    })).toThrow('Unsupported Platform Adapter API version');
  });
});
