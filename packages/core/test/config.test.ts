import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  defineExtension,
  definePlatform,
  resolveConfig,
  type AcpluginPlatform,
  type UserConfig,
} from '../src/index.js';

/**
 * 创建配置测试使用的最小品牌化 Platform。
 *
 * @param id 开放 Platform ID。
 * @param strict 可选的平台级严格度覆盖。
 * @returns 不产生实际 Artifact 的测试 Platform。
 */
function platform(id: string, strict?: boolean): AcpluginPlatform {
  return definePlatform({
    id,
    apiVersion: '1',
    deliveryType: 'plugin',
    ...(strict === undefined ? {} : { strict }),
    /** 配置测试不创建初始 Draft。 */
    prepare: () => ({ documents: [], artifacts: [] }),
    /** 配置测试只声明最小主交付单元。 */
    generateBundle: () => ({ id: 'plugin', role: 'primary', type: 'plugin', artifacts: [] }),
    /** 配置测试不执行候选校验。 */
    validateBundle: () => undefined,
  });
}

/** Core 配置测试使用的显式 Platform 工厂结果。 */
const defaults = [platform('claude-code'), platform('codex')];

/** 允许运行时覆盖必填字段以验证缺失配置诊断的测试输入。 */
type UserConfigInput = Omit<UserConfig, 'platforms'> & { readonly platforms?: UserConfig['platforms'] };

/**
 * 使用固定工程根和默认 Platform 解析配置。
 *
 * @param value 最终 acplugin.config.ts 对象。
 * @returns Core 的配置或诊断结果。
 */
function resolve(value: UserConfigInput): ReturnType<typeof resolveConfig> {
  return resolveConfig(value as UserConfig, path.join('/project', 'acplugin.config.ts'), 'build', 'production');
}

describe('final configuration schema', () => {
  it('resolves complete metadata, Public, strict overrides, Platforms, and Extensions', () => {
    /** 显式配置且覆盖全局 strict 的第三方 Platform。 */
    const community = platform('community', true);
    /** 最小品牌化第三方 Extension。 */
    const extension = defineExtension({ name: 'community-extension', apiVersion: '1', adapters: [] });
    /** 覆盖规范配置示例各主要字段的解析结果。 */
    const result = resolve({
      name: 'release-tools',
      version: '1.2.3',
      description: ' Release workflow tools. ',
      displayName: 'Release Tools',
      author: { name: 'TokenRoll', email: 'team@example.com', url: 'https://github.com/TokenRollAI' },
      homepage: 'https://example.com/release-tools',
      repository: 'https://github.com/TokenRollAI/release-tools',
      license: 'MIT OR Apache-2.0',
      keywords: [' release ', 'review'],
      srcDir: 'source',
      public: { dir: 'assets', copy: [{ from: 'shared', to: 'shared' }] },
      platforms: [community],
      extensions: [extension],
      build: { outDir: 'output', strict: false },
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.config?.metadata).toEqual({
      name: 'release-tools',
      version: '1.2.3',
      description: 'Release workflow tools.',
      displayName: 'Release Tools',
      author: { name: 'TokenRoll', email: 'team@example.com', url: 'https://github.com/TokenRollAI' },
      homepage: 'https://example.com/release-tools',
      repository: 'https://github.com/TokenRollAI/release-tools',
      license: 'MIT OR Apache-2.0',
      keywords: ['release', 'review'],
    });
    expect(result.config?.platforms).toEqual([{ platform: community, strict: true }]);
    expect(result.config?.extensions).toEqual([extension]);
    expect(result.config?.public.copy).toEqual([{ from: 'shared', to: 'shared' }]);
  });

  it('requires explicit platforms and applies build strictness', () => {
    /** 显式配置 Platform 且关闭全局 strict 的配置结果。 */
    const result = resolve({
      name: 'default-platforms',
      version: '1.0.0',
      description: 'Default Platforms.',
      platforms: defaults,
      build: { strict: false },
    });
    /** 完全省略 Platform 时必须返回稳定的必填诊断。 */
    const missing = resolve({
      name: 'missing-platforms',
      version: '1.0.0',
      description: 'Missing Platforms.',
    });

    expect(result.config?.platforms.map(item => ({ id: item.platform.id, strict: item.strict }))).toEqual([
      { id: 'claude-code', strict: false },
      { id: 'codex', strict: false },
    ]);
    expect(missing.diagnostics).toContainEqual(expect.objectContaining({ code: 'CONFIG_PLATFORMS_REQUIRED' }));
  });

  it('rejects empty, duplicate, forged, and API-incompatible Platform instances', () => {
    /** 同一实例重复出现时用于验证 ID 唯一性的 Platform。 */
    const duplicate = platform('duplicate');
    /** 把多个独立 Platform 错误汇总在一次解析中的配置。 */
    const result = resolve({
      name: 'invalid-platforms',
      version: '1.0.0',
      description: 'Invalid Platforms.',
      platforms: [
        duplicate,
        duplicate,
        { id: 'fake', apiVersion: '1', deliveryType: 'plugin', strict: true } as never,
        { id: 'future', apiVersion: '2', deliveryType: 'plugin', strict: true } as never,
      ],
    });
    /** 显式空数组必须完整替换默认值并因此失败。 */
    const empty = resolve({
      name: 'empty-platforms', version: '1.0.0', description: 'Empty.', platforms: [],
    });

    expect(result.diagnostics.map(item => item.code)).toEqual(expect.arrayContaining([
      'CONFIG_PLATFORM_DUPLICATE',
      'CONFIG_PLATFORM_INVALID',
      'CONFIG_PLATFORM_API_INCOMPATIBLE',
    ]));
    expect(empty.diagnostics).toContainEqual(expect.objectContaining({ code: 'CONFIG_PLATFORMS_EMPTY' }));
  });

  it('rejects duplicate, forged, and API-incompatible Extensions', () => {
    /** 同一 Extension 重复出现时用于验证名称唯一性的实例。 */
    const duplicate = defineExtension({ name: 'duplicate-extension', apiVersion: '1', adapters: [] });
    /** 汇总三类 Extension 配置错误的结果。 */
    const result = resolve({
      name: 'invalid-extensions',
      version: '1.0.0',
      description: 'Invalid Extensions.',
      extensions: [
        duplicate,
        duplicate,
        { name: 'fake-extension', apiVersion: '1', adapters: [] } as never,
        { name: 'future-extension', apiVersion: '2', adapters: [] } as never,
      ],
    });

    expect(result.diagnostics.map(item => item.code)).toEqual(expect.arrayContaining([
      'CONFIG_EXTENSION_DUPLICATE',
      'CONFIG_EXTENSION_INVALID',
      'CONFIG_EXTENSION_API_INCOMPATIBLE',
    ]));
  });

  it('validates author, URL, SPDX, keywords, and directory boundaries independently', () => {
    /** 每个可选元数据和路径规则均非法的聚合配置。 */
    const result = resolve({
      name: 'invalid-fields',
      version: '1.0.0',
      description: 'Invalid fields.',
      author: { name: '', email: 'invalid', url: 'file:///tmp/author' },
      homepage: '/relative',
      repository: 'git@example.com:repo.git',
      license: 'Definitely Not SPDX',
      keywords: ['duplicate', ' duplicate ', ''],
      srcDir: '/outside/source',
      public: { dir: 'source/public' },
      build: { outDir: '../output' },
    });

    expect(result.diagnostics.map(item => item.code)).toEqual(expect.arrayContaining([
      'CONFIG_AUTHOR_NAME_INVALID',
      'CONFIG_AUTHOR_EMAIL_INVALID',
      'CONFIG_AUTHOR_URL_INVALID',
      'CONFIG_HOMEPAGE_INVALID',
      'CONFIG_REPOSITORY_INVALID',
      'CONFIG_LICENSE_INVALID',
      'CONFIG_KEYWORD_DUPLICATE',
      'CONFIG_KEYWORD_INVALID',
      'CONFIG_PATH_ABSOLUTE',
      'CONFIG_PATH_ESCAPE',
    ]));
  });

  it('normalizes Public delivery targets without changing source-path semantics', () => {
    /** 反斜杠来源仍由当前宿主解释，交付目标则统一为 POSIX。 */
    const result = resolve({
      name: 'portable-public',
      version: '1.0.0',
      description: 'Portable Public targets.',
      platforms: defaults,
      public: { copy: [{ from: 'source\\logo.svg', to: 'assets\\logo.svg' }] },
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.config?.public.copy).toEqual([{ from: 'source\\logo.svg', to: 'assets/logo.svg' }]);
  });

  it.each([
    ['Win32 drive target', 'C:\\outside\\logo.svg'],
    ['Win32 slash drive target', 'C:/outside/logo.svg'],
    ['UNC target', '\\\\server\\share\\logo.svg'],
    ['POSIX absolute target', '/outside/logo.svg'],
    ['backslash traversal target', 'assets\\..\\logo.svg'],
    ['mixed traversal target', 'assets\\../logo.svg'],
    ['NUL target', 'assets/\0/logo.svg'],
  ])('rejects a non-portable Public %s', (_label, target) => {
    /** 每种目标语法都必须在配置阶段得到相同稳定边界诊断。 */
    const result = resolve({
      name: 'invalid-public-target',
      version: '1.0.0',
      description: 'Invalid Public target.',
      public: { copy: [{ from: 'logo.svg', to: target }] },
    });

    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: 'CONFIG_PUBLIC_RULE_ESCAPE',
      fieldPath: ['public', 'copy', 0],
    }));
  });

  it('rejects Win32 absolute Public sources even on a POSIX host', () => {
    /** 来源使用宿主语义解析，但跨宿主绝对输入始终属于不可信配置。 */
    const result = resolve({
      name: 'invalid-public-source',
      version: '1.0.0',
      description: 'Invalid Public source.',
      public: { copy: [{ from: 'C:\\outside\\logo.svg', to: 'assets/logo.svg' }] },
    });

    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'CONFIG_PUBLIC_RULE_ESCAPE' }));
  });
});
