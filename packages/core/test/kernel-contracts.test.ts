import { describe, expect, it } from 'vitest';
import {
  defineExtension,
  definePlatform,
  isAcpluginExtension,
  isAcpluginPlatform,
  LIFECYCLE_API_VERSION,
} from '../src/kernel-sdk.js';

/**
 * 创建 Kernel v2 契约测试使用的最小 Platform。
 *
 * @param overrides 需要覆盖的定义字段。
 * @returns 交给 definePlatform 的完整定义。
 */
function platformDefinition(overrides: Record<string, unknown> = {}) {
  return {
    id: 'third-party',
    apiVersion: '1',
    deliveryType: 'plugin',
    /** 每个 BuildSession 返回独立生命周期对象。 */
    createSession: () => ({
      /** 最小 Platform 产生空 base Package。 */
      createPackage: () => ({ documents: [], assets: [], compatibility: [], metadata: [] }),
      /** 最小 Platform 确定一个 Plugin 主单元。 */
      finalizePackage: () => ({ id: 'plugin', type: 'plugin' }),
      /** 最小 Platform 没有额外 candidate 约束。 */
      validatePackage: () => undefined,
    }),
    ...overrides,
  };
}

/**
 * 创建 Kernel v2 契约测试使用的最小 Extension。
 *
 * @param overrides 需要覆盖的定义字段。
 * @returns 交给 defineExtension 的完整定义。
 */
function extensionDefinition(overrides: Record<string, unknown> = {}) {
  return {
    id: 'third-party-extension',
    apiVersion: '1',
    resourceRoots: ['third-party'],
    /** 每个 BuildSession 返回独立 Extension 生命周期对象。 */
    createSession: () => ({
      /** 空资源使后续阶段可以跳过。 */
      discover: () => undefined,
      /** 最小验证输出没有 compatibility subject。 */
      validate: () => ({ state: {}, subjects: [] }),
      /** 最小 build 输出为空状态。 */
      build: () => ({ state: {} }),
      contributors: [],
    }),
    ...overrides,
  };
}

describe('Kernel v2 definition contract', () => {
  it('keeps API version one while branding and freezing complete Platform definitions', () => {
    /** 调用方仍持有并将在工厂返回后修改的 options。 */
    const options = { marketplace: { states: ['AVAILABLE'] } };
    /** 共享工厂生成的最终 Platform。 */
    const platform = definePlatform({
      ...platformDefinition(),
      options,
      capabilities: { nodeRuntime: { target: 'node20', format: 'esm', root: 'plugin' } },
    } as never);

    options.marketplace.states.push('PRIVATE');
    expect(LIFECYCLE_API_VERSION).toBe('1');
    expect(isAcpluginPlatform(platform)).toBe(true);
    expect(Object.isFrozen(platform)).toBe(true);
    expect(Object.isFrozen(platform.options)).toBe(true);
    expect(Object.isFrozen(platform.options!.marketplace)).toBe(true);
    expect(platform.options).toEqual({ marketplace: { states: ['AVAILABLE'] } });
  });

  it('rejects unknown fields, accessors, classes, cycles, sparse arrays and non-finite options', () => {
    /** 循环 JSON 不能被复制成稳定 options。 */
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    /** 稀疏数组不能借助 JSON stringify 隐式变为 null。 */
    const sparse = new Array(2);
    sparse[1] = 'value';
    /** class instance 不能把 prototype 行为藏入配置。 */
    class Options {}

    expect(() => definePlatform(platformDefinition({ unknown: true }) as never)).toThrow('Unknown Platform definition field');
    expect(() => definePlatform(Object.defineProperty(platformDefinition(), 'options', {
      /** accessor 用于验证工厂不会执行不可信 getter。 */
      get: () => ({}),
      enumerable: true,
    }) as never)).toThrow('accessor');
    expect(() => definePlatform(platformDefinition({ options: new Options() }) as never)).toThrow('plain object');
    expect(() => definePlatform(platformDefinition({ options: cycle }) as never)).toThrow('cycles');
    expect(() => definePlatform(platformDefinition({ options: { sparse } }) as never)).toThrow('sparse');
    expect(() => definePlatform(platformDefinition({ options: { invalid: Number.POSITIVE_INFINITY } }) as never)).toThrow('finite');
  });

  it('rejects wrong API versions, invalid identities and shape-compatible forgeries', () => {
    /** 没有工厂品牌的完整等形对象。 */
    const forged = Object.freeze(platformDefinition());

    expect(isAcpluginPlatform(forged)).toBe(false);
    expect(() => definePlatform(platformDefinition({ apiVersion: '2' }) as never)).toThrow('Unsupported Platform API version');
    expect(() => definePlatform(platformDefinition({ id: 'Third Party' }) as never)).toThrow('lowercase kebab-case');
    expect(() => definePlatform(platformDefinition({ capabilities: { nodeRuntime: { target: 'node18' } } }) as never)).toThrow('Node 20 ESM');
  });

  it('rejects discovered brand copies whose public shape or deep freeze was forged', () => {
    /** 有效对象用于证明 copied brand 仍不能替代完整 shape validation。 */
    const platform = definePlatform({ ...platformDefinition(), options: { nested: { enabled: true } } } as never);
    /** 从合法对象复制到可修改等形对象的全部自有描述符。 */
    const descriptors = Object.getOwnPropertyDescriptors(platform);
    /** forged 删除 createSession 后重新冻结，仍保留发现到的 Symbol 品牌。 */
    const missingSession = {};
    Object.defineProperties(missingSession, Object.fromEntries(Reflect.ownKeys(descriptors)
      .filter(key => key !== 'createSession')
      .map(key => [key, Reflect.get(descriptors, key)])));
    Object.freeze(missingSession);
    /** shallowFrozen 复制完整 shape，但替换为内部未冻结的 options。 */
    const shallowFrozen = {};
    Object.defineProperties(shallowFrozen, Object.fromEntries(Reflect.ownKeys(descriptors)
      .filter(key => key !== 'options')
      .map(key => [key, Reflect.get(descriptors, key)])));
    Object.defineProperty(shallowFrozen, 'options', {
      value: Object.freeze({ nested: { enabled: true } }),
      enumerable: true,
      configurable: false,
      writable: false,
    });
    Object.freeze(shallowFrozen);

    expect(isAcpluginPlatform(missingSession)).toBe(false);
    expect(isAcpluginPlatform(shallowFrozen)).toBe(false);
  });

  it('normalizes Extension id, roots and options without lifecycle ordering fields', () => {
    /** 调用方仍持有的 resource root 与 options 容器。 */
    const resourceRoots = ['third-party'];
    /** 调用方仍持有的 Extension options。 */
    const options = { include: ['alpha'] };
    /** 共享工厂生成的最终 Extension。 */
    const extension = defineExtension({ ...extensionDefinition(), resourceRoots, options } as never);

    resourceRoots.push('other');
    options.include.push('beta');
    expect(isAcpluginExtension(extension)).toBe(true);
    expect(extension.id).toBe('third-party-extension');
    expect(extension.resourceRoots).toEqual(['third-party']);
    expect(extension.options).toEqual({ include: ['alpha'] });
    expect('name' in extension).toBe(false);
    expect('dependsOn' in extension).toBe(false);
  });

  it('rejects duplicate roots, unknown fields, wrong versions and Extension forgeries', () => {
    /** 没有工厂品牌的完整等形 Extension。 */
    const forged = Object.freeze(extensionDefinition());

    expect(isAcpluginExtension(forged)).toBe(false);
    expect(() => defineExtension(extensionDefinition({ apiVersion: '2' }) as never)).toThrow('Unsupported Extension API version');
    expect(() => defineExtension(extensionDefinition({ resourceRoots: ['hooks', 'hooks'] }) as never)).toThrow('duplicates');
    expect(() => defineExtension(extensionDefinition({ resourceRoots: ['nested/root'] }) as never)).toThrow('lowercase kebab-case');
    expect(() => defineExtension(extensionDefinition({ dependsOn: ['other'] }) as never)).toThrow('Unknown Extension definition field');
  });
});
