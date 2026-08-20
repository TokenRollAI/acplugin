import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defineExtension, definePlatform } from '../../src/api/definitions.js';
import { resolveKernelConfig } from '../../src/config/resolver.js';

/** @returns 配置测试使用的最小 Platform。 */
function platform(id: string, strict?: boolean) {
  return definePlatform({
    id,
    apiVersion: '1',
    deliveryType: 'plugin',
    ...(strict === undefined ? {} : { strict }),
    createSession: () => ({
      createPackage: () => ({ documents: [], assets: [], compatibility: [], metadata: [] }),
      finalizePackage: () => ({ id: 'plugin', type: 'plugin' }),
      validatePackage: () => undefined,
    }),
  });
}

/** @returns 配置测试使用的最小 Extension。 */
function extension(id: string, roots: readonly string[]) {
  return defineExtension({
    id,
    apiVersion: '1',
    resourceRoots: roots,
    createSession: () => ({
      discover: () => ({}),
      validate: () => ({ state: {}, subjects: [] }),
      build: () => ({ state: {} }),
      contributors: [],
    }),
  });
}

/** 固定工程根的 config resolver。 */
function resolve(value: unknown) {
  return resolveKernelConfig(value, {
    projectRoot: '/project',
    configFile: '/project/acplugin.config.ts',
    command: 'build',
    mode: 'production',
  });
}

describe('Kernel config resolver', () => {
  it('normalizes metadata, Runtime, integrations and strictness as immutable data', () => {
    /** Platform override 与全局 strict 共同验证最终行为。 */
    const primary = platform('primary');
    const relaxed = platform('relaxed', false);
    const hooks = extension('hooks', ['hooks']);
    const result = resolve({
      name: 'release-tools',
      version: '1.2.3',
      description: ' Release tools. ',
      author: { name: 'TokenRoll', email: 'team@example.com' },
      keywords: ['release', 'review'],
      runtime: {
        entries: { cli: { entry: 'bin/cli.ts', kind: 'module' } },
        compile: { treeshake: false, transform: { define: { FLAG: 'true' } } },
      },
      platforms: [primary, relaxed],
      extensions: [hooks],
      build: { strict: true },
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.config).toMatchObject({
      projectRoot: '/project',
      srcDirectory: path.join('/project', 'src'),
      metadata: { name: 'release-tools', version: '1.2.3', description: 'Release tools.' },
      runtime: { target: 'node20', entries: { cli: { entry: 'bin/cli.ts', kind: 'module' } } },
      strict: true,
    });
    expect(result.config?.platforms.map(item => [item.definition.id, item.strict])).toEqual([['primary', true], ['relaxed', false]]);
    expect(Object.isFrozen(result.config)).toBe(true);
    expect(Object.isFrozen(result.config?.runtime.compile)).toBe(true);
  });

  it('allows project-root Public only through per-source exact non-overlapping copy rules', () => {
    const ok = resolve({
      name: 'public-copy', version: '1.0.0', description: 'Public copy.', platforms: [platform('target')],
      public: { dir: '.', copy: [{ from: 'schemas', to: 'schemas' }, { from: 'rulepacks', to: 'runtime/rulepacks' }] },
    });
    const overlap = resolve({
      name: 'public-overlap', version: '1.0.0', description: 'Public overlap.', platforms: [platform('target')],
      public: { dir: '.', copy: [{ from: 'src', to: 'source' }] },
    });
    const full = resolve({
      name: 'public-full', version: '1.0.0', description: 'Public full.', platforms: [platform('target')],
      public: { dir: '.' },
    });

    expect(ok.diagnostics).toEqual([]);
    expect(ok.config?.public.copy?.map(rule => [rule.from, rule.to])).toEqual([
      ['schemas', 'schemas'],
      ['rulepacks', 'runtime/rulepacks'],
    ]);
    expect(overlap.diagnostics).toContainEqual(expect.objectContaining({ code: 'CONFIG_PUBLIC_OVERLAP' }));
    expect(full.diagnostics).toContainEqual(expect.objectContaining({ code: 'CONFIG_PUBLIC_OVERLAP' }));
  });

  it('rejects getters, class instances, unknown fields, unsafe paths and duplicate integration IDs', () => {
    /** getter 不得在配置检查期间被执行。 */
    let getterRead = false;
    const withGetter = Object.defineProperty({
      name: 'getter', version: '1.0.0', description: 'Getter.', platforms: [platform('target')],
    }, 'srcDir', {
      enumerable: true,
      get: () => {
        getterRead = true;
        return 'src';
      },
    });
    /** class instance 不属于纯配置。 */
    class Config {}
    const duplicate = platform('duplicate');
    const invalid = resolve({
      name: 'invalid', version: '1.0.0', description: 'Invalid.',
      srcDir: '../outside',
      unknown: true,
      platforms: [duplicate, duplicate],
    });

    expect(resolve(withGetter).diagnostics).toContainEqual(expect.objectContaining({ code: 'CONFIG_ACCESSOR_INVALID' }));
    expect(getterRead).toBe(false);
    expect(resolve(new Config()).diagnostics).toContainEqual(expect.objectContaining({ code: 'CONFIG_OBJECT_INVALID' }));
    expect(invalid.diagnostics.map(item => item.code)).toEqual(expect.arrayContaining([
      'CONFIG_FIELD_UNKNOWN', 'CONFIG_PATH_INVALID', 'CONFIG_PLATFORM_DUPLICATE',
    ]));
  });

  it('aggregates independent metadata and structural failures in one deterministic result', () => {
    const result = resolve({
      name: 'Invalid Name',
      version: 'invalid',
      description: '',
      author: { name: '', email: 'invalid', url: 'file:///secret' },
      keywords: ['duplicate', ' duplicate ', ''],
      srcDir: '../outside',
      platforms: [],
    });

    expect(result.config).toBeUndefined();
    expect(result.diagnostics.map(item => item.code)).toEqual(expect.arrayContaining([
      'CONFIG_NAME_INVALID', 'CONFIG_VERSION_INVALID', 'CONFIG_DESCRIPTION_REQUIRED',
      'CONFIG_AUTHOR_NAME_INVALID', 'CONFIG_AUTHOR_EMAIL_INVALID', 'CONFIG_AUTHOR_URL_INVALID',
      'CONFIG_KEYWORD_DUPLICATE', 'CONFIG_KEYWORD_INVALID', 'CONFIG_PATH_INVALID',
      'CONFIG_PLATFORMS_REQUIRED',
    ]));
  });
});
