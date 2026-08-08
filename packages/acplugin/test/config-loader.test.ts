import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { definePlatform } from '../src/index.js';
import { loadProjectConfig, ProjectConfigError } from '../src/project-config.js';

/** 每个配置加载测试创建并在 afterEach 中删除的临时工程。 */
const roots: string[] = [];

/** dotenv 隔离测试使用且不会由项目其他逻辑读取的环境变量名。 */
const DOTENV_KEY = 'ACPLUGIN_CONFIG_LOADER_DOTENV_FIXTURE';

/** 测试开始前宿主环境可能已经存在的变量值。 */
const originalDotenvValue = process.env[DOTENV_KEY];

/** 临时配置与测试进程共享品牌化 Platform 时使用的隔离全局键。 */
const CONFIG_TEST_PLATFORM = Symbol.for('tokenroll.acplugin.config-loader-test-platform');

Reflect.set(globalThis, CONFIG_TEST_PLATFORM, definePlatform({
  id: 'config-loader-test',
  apiVersion: '1',
  deliveryType: 'plugin',
  /** 配置加载测试不会执行 Platform 生命周期。 */
  prepare: () => ({ documents: [], artifacts: [] }),
  /** 配置加载测试不会生成交付单元。 */
  generateBundle: () => ({ id: 'plugin', role: 'primary', type: 'plugin', artifacts: [] }),
  /** 配置加载测试不会物化候选目录。 */
  validateBundle: () => undefined,
}));

/**
 * 为配置源码提供一个通过正式公开工厂创建的显式测试 Platform。
 *
 * @param source 引用 `testPlatform` 的配置导出源码。
 * @returns 带公开 SDK 导入和品牌化实例声明的完整模块。
 */
function withPlatform(source: string): string {
  return `const testPlatform = globalThis[Symbol.for('tokenroll.acplugin.config-loader-test-platform')];
${source}`;
}

/**
 * 创建含指定 acplugin.config.ts 源码的临时工程。
 *
 * @param source TypeScript 配置模块源码。
 * @returns 临时工程绝对路径。
 */
async function project(source: string): Promise<string> {
  /** 当前测试独占的临时工程根目录。 */
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-config-loader-'));
  roots.push(root);
  await fs.writeFile(path.join(root, 'acplugin.config.ts'), withPlatform(source));
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
  if (originalDotenvValue === undefined)
    delete process.env[DOTENV_KEY];
  else
    process.env[DOTENV_KEY] = originalDotenvValue;
});

describe('config loader', () => {
  it('loads object, sync factory, and async factory exports', async () => {
    /** 三种受支持配置导出形式的源码。 */
    const sources = [
      `export default { name: 'object-config', version: '1.0.0', description: 'Object.', platforms: [testPlatform] }`,
      `export default ({ command }) => ({ name: 'sync-config', version: '1.0.0', description: command, platforms: [testPlatform] })`,
      `export default async ({ mode }) => ({ name: 'async-config', version: '1.0.0', description: mode, platforms: [testPlatform] })`,
    ];
    /** 三种配置分别加载后的统一名称。 */
    const names: string[] = [];
    for (const source of sources) {
      /** 当前导出形式对应的临时工程。 */
      const cwd = await project(source);
      /** Jiti 执行并由 Core 解析的最终配置。 */
      const loaded = await loadProjectConfig({ cwd, command: 'build', mode: 'production' });
      names.push(loaded.config.metadata.name);
    }

    expect(names).toEqual(['object-config', 'sync-config', 'async-config']);
  });

  it('fresh-loads changed config source during dev', async () => {
    /** 初始版本为 1.0.0 的临时工程。 */
    const cwd = await project(`export default { name: 'fresh-config', version: '1.0.0', description: 'Fresh.', platforms: [testPlatform] }`);
    /** 第一次无缓存配置加载。 */
    const first = await loadProjectConfig({ cwd, command: 'dev', mode: 'development' });
    await fs.writeFile(path.join(cwd, 'acplugin.config.ts'), withPlatform(`export default { name: 'fresh-config', version: '2.0.0', description: 'Fresh.', platforms: [testPlatform] }`));
    /** 文件变化后的第二次无缓存配置加载。 */
    const second = await loadProjectConfig({ cwd, command: 'dev', mode: 'development' });

    expect(first.config.metadata.version).toBe('1.0.0');
    expect(second.config.metadata.version).toBe('2.0.0');
  });

  it('records and fresh-loads an external static TypeScript config dependency', async () => {
    /** 同时包含项目与外部 helper package 的临时 workspace。 */
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-config-closure-'));
    roots.push(workspace);
    /** 配置入口所在的独立项目根。 */
    const cwd = path.join(workspace, 'plugin');
    /** 位于项目根外且需要按 package root 监听的 helper。 */
    const helperRoot = path.join(workspace, 'shared-config');
    /** 配置实际静态导入的 TypeScript helper。 */
    const helper = path.join(helperRoot, 'value.ts');
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(helperRoot, { recursive: true });
    await fs.writeFile(path.join(helperRoot, 'package.json'), '{"name":"shared-config","type":"module"}\n');
    await fs.writeFile(helper, `export const description = 'First external helper.';\n`);
    await fs.writeFile(path.join(cwd, 'acplugin.config.ts'), withPlatform(`import { description } from '../shared-config/value.ts';
export default { name: 'closure-config', version: '1.0.0', description, platforms: [testPlatform] };
`));

    /** 第一次执行观察到的 Jiti transform closure。 */
    const first = await loadProjectConfig({ cwd, command: 'dev', mode: 'development' });
    await fs.writeFile(helper, `export const description = 'Second external helper.';\n`);
    /** 新 Jiti 实例必须读取 helper 的修改而不是原生模块 cache。 */
    const second = await loadProjectConfig({ cwd, command: 'dev', mode: 'development' });

    expect(first.config.metadata.description).toBe('First external helper.');
    expect(second.config.metadata.description).toBe('Second external helper.');
    expect(first.watchFiles).toContain(await fs.realpath(helper));
    expect(first.watchRoots).toContain(await fs.realpath(helperRoot));
  });

  it('does not automatically load project .env files', async () => {
    delete process.env[DOTENV_KEY];
    /** 配置尝试读取仅存在于项目 .env 的值。 */
    const cwd = await project(`export default {
      name: 'dotenv-config',
      version: '1.0.0',
      description: process.env.${DOTENV_KEY} ?? 'not-loaded',
      platforms: [testPlatform],
    }`);
    await fs.writeFile(path.join(cwd, '.env'), `${DOTENV_KEY}=loaded-secret\n`);
    /** 不启用 dotenv 的最终加载结果。 */
    const loaded = await loadProjectConfig({ cwd, command: 'validate', mode: 'production' });

    expect(loaded.config.metadata.description).toBe('not-loaded');
    expect(process.env[DOTENV_KEY]).toBeUndefined();
  });

  it('surfaces legacy fields and explicit empty platforms as structured errors', async () => {
    /** 同时包含两个旧字段和显式空 Platform 集合的非法配置。 */
    const cwd = await project(`export default {
      name: 'legacy-config',
      version: '1.0.0',
      description: 'Legacy.',
      targets: ['codex'],
      modules: [],
      platforms: [],
    }`);

    await expect(loadProjectConfig({ cwd, command: 'validate', mode: 'production' })).rejects.toSatisfy((error: unknown) => {
      if (!(error instanceof ProjectConfigError))
        return false;
      /** 配置加载错误携带的全部稳定诊断码。 */
      const codes = error.diagnostics.map(item => item.code);
      return codes.includes('CONFIG_LEGACY_TARGETS')
        && codes.includes('CONFIG_LEGACY_MODULES')
        && codes.includes('CONFIG_PLATFORMS_EMPTY')
        && error.diagnostics.some(item => item.hint?.includes('platforms: [myPlatform()]'));
    });
  });

  it('records loaded Extension descriptors and their local dependency root for dev', async () => {
    /** descriptor 监听测试使用的有效配置工程。 */
    const cwd = await project(`export default { name: 'watch-config', version: '1.0.0', description: 'Watch.', platforms: [testPlatform] }`);
    /** 模拟 Extension discover 阶段加载的本地 TypeScript descriptor。 */
    const descriptor = path.join(cwd, 'extensions/example.ts');
    await fs.mkdir(path.dirname(descriptor), { recursive: true });
    await fs.writeFile(descriptor, `export default { enabled: true };\n`);
    /** 共享 Jiti 加载器及其实时监听路径集合。 */
    const loaded = await loadProjectConfig({ cwd, command: 'dev', mode: 'development' });

    await loaded.loadTypeScriptModule(descriptor);

    expect(loaded.watchFiles).toContain(path.join(cwd, 'acplugin.config.ts'));
    expect(loaded.watchFiles).toContain(descriptor);
    expect(loaded.watchRoots).toContain(await fs.realpath(path.dirname(descriptor)));
  });
});
