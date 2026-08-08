import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DiagnosticCollector,
  type AcpluginPlatform,
  type BuildCommand,
  type BuildMode,
  definePlatform,
  resolveConfig as resolveCoreConfig,
  scanProject,
  type UserConfig,
} from '../src/index.js';

/** 每个测试创建并在 afterEach 中统一删除的临时目录。 */
const temporaryDirectories: string[] = [];

/**
 * 创建 Core 配置测试使用且不依赖私有官方包的最小 Platform。
 *
 * @param id 开放的测试 Platform ID。
 * @returns 带私有品牌的最小 Plugin Platform。
 */
function testPlatform(id: string): AcpluginPlatform {
  return definePlatform({
    id,
    apiVersion: '1',
    deliveryType: 'plugin',
    /** 配置测试不需要实际 Draft。 */
    prepare: () => ({ documents: [], artifacts: [] }),
    /** 配置测试只需要最小主单元定义。 */
    generateBundle: () => ({ id: 'plugin', role: 'primary', type: 'plugin', artifacts: [] }),
    /** 配置测试不执行候选内容校验。 */
    validateBundle: () => undefined,
  });
}

/** Core 测试模拟主包注入的两个默认 Platform。 */
const defaultPlatforms = [testPlatform('claude-code'), testPlatform('codex')];

/**
 * 使用测试默认 Platform 调用最终 Core 配置解析器。
 *
 * @param value 用户配置候选。
 * @param configPath 配置入口路径。
 * @param command 当前构建命令。
 * @param mode 当前运行模式。
 * @returns 最终配置或稳定诊断。
 */
function resolveConfig(value: UserConfig, configPath: string, command: BuildCommand, mode: BuildMode): ReturnType<typeof resolveCoreConfig> {
  return resolveCoreConfig(value, configPath, command, mode, { defaultPlatforms });
}

/**
 * 创建当前 Core 测试独占的临时工程目录。
 *
 * @returns 自动登记清理的绝对目录路径。
 */
async function temporaryProject(): Promise<string> {
  /** 当前测试独占且会在 afterEach 清理的工程根目录。 */
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-core-test-'));
  temporaryDirectories.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

describe('config', () => {
  it('normalizes the default platforms and directories', async () => {
    /** 默认配置解析使用的空工程根目录。 */
    const root = await temporaryProject();
    /** 使用最小用户配置得到的解析结果。 */
    const result = resolveConfig({
      name: 'test-plugin',
      version: '1.0.0',
      description: 'Test plugin.',
    }, path.join(root, 'acplugin.config.ts'), 'build', 'production');

    expect(result.diagnostics).toEqual([]);
    expect(result.config?.platforms.map(item => ({ id: item.platform.id, strict: item.strict }))).toEqual([
      { id: 'claude-code', strict: true },
      { id: 'codex', strict: true },
    ]);
    expect(result.config?.srcDir).toBe(path.join(root, 'src'));
    expect(result.config?.outDir).toBe(path.join(root, 'dist'));
    expect(result.config?.metadata.displayName).toBeUndefined();
  });

  it('never relaxes structural config failures', async () => {
    /** 非法结构配置测试使用的工程根目录。 */
    const root = await temporaryProject();
    /** 同时包含元数据、目录和类型错误的配置解析结果。 */
    const result = resolveConfig({
      name: 'Invalid Name',
      version: 'nope',
      description: '',
      build: { strict: false, outDir: '.' },
    }, path.join(root, 'acplugin.config.ts'), 'build', 'production');

    expect(result.config).toBeUndefined();
    expect(result.diagnostics.every(diagnostic => diagnostic.severity === 'error')).toBe(true);
  });

  it('rejects unknown and incorrectly typed nested config fields', async () => {
    /** 嵌套字段校验测试使用的工程根目录。 */
    const root = await temporaryProject();
    /** 包含未知字段与错误嵌套类型的配置解析结果。 */
    const result = resolveConfig({
      name: 'test-plugin',
      version: '1.0.0',
      description: 'Test plugin.',
      build: { strict: 'yes', clean: true },
      public: { copy: [{ from: 'assets', to: 'assets', transform: 'text' }] },
      platforms: [{ id: 'codex', strict: 'yes', compiler: 'custom' }],
      extensions: { native: {} },
    } as never, path.join(root, 'acplugin.config.ts'), 'build', 'production');

    expect(result.config).toBeUndefined();
    expect(result.diagnostics.map(diagnostic => diagnostic.code)).toEqual(expect.arrayContaining([
      'CONFIG_FIELD_UNKNOWN',
      'CONFIG_STRICT_INVALID',
      'CONFIG_PLATFORM_INVALID',
      'CONFIG_EXTENSIONS_INVALID',
    ]));
  });

  it('rejects legacy targets and modules with final configuration hints', async () => {
    /** 旧配置字段拒绝测试使用的工程根目录。 */
    const root = await temporaryProject();
    /** 同时使用 targets 与 modules 的旧配置解析结果。 */
    const result = resolveConfig({
      name: 'test-plugin', version: '1.0.0', description: 'Test plugin.',
      targets: ['codex'],
      modules: [{ name: 'legacy-module' }],
    } as never, path.join(root, 'acplugin.config.ts'), 'build', 'production');

    expect(result.config).toBeUndefined();
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: 'CONFIG_LEGACY_TARGETS', hint: 'Use platforms: [claudeCode(), codex()] instead.',
    }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: 'CONFIG_LEGACY_MODULES', hint: 'Use extensions: [hooks(), mcp()] instead.',
    }));
  });
});

describe('canonical scanner', () => {
  it('discovers components, dependencies, auxiliary files, and Public', async () => {
    /** 完整 Scanner 样例工程根目录。 */
    const root = await temporaryProject();
    await fs.mkdir(path.join(root, 'src/skills/review/references'), { recursive: true });
    await fs.mkdir(path.join(root, 'src/commands'), { recursive: true });
    await fs.mkdir(path.join(root, 'src/agents'), { recursive: true });
    await fs.mkdir(path.join(root, 'public'), { recursive: true });
    await fs.writeFile(path.join(root, 'src/skills/review/SKILL.md'), '---\ndescription: Review changes.\nrequires:\n  agents: [reviewer]\n---\nReview the change.\n');
    await fs.writeFile(path.join(root, 'src/skills/review/references/checks.md'), 'checks');
    await fs.writeFile(path.join(root, 'src/commands/check.md'), '---\ndescription: Check a change.\nrequires:\n  skills: [review]\n---\nCheck {{arguments}}.\n');
    await fs.writeFile(path.join(root, 'src/agents/reviewer.md'), '---\ndescription: Focused reviewer.\nmodel: capable\ncapabilities: [filesystem:read, search]\n---\nReview carefully.\n');
    await fs.writeFile(path.join(root, 'public/icon.bin'), new Uint8Array([1, 2, 3]));
    /** Scanner 使用的已解析构建配置。 */
    const resolved = resolveConfig({ name: 'test-plugin', version: '1.0.0', description: 'Test.' }, path.join(root, 'acplugin.config.ts'), 'build', 'production');
    /** 收集扫描结构问题的诊断容器。 */
    const diagnostics = new DiagnosticCollector();
    /** Scanner 产生的规范 PluginProject。 */
    const { project } = await scanProject(resolved.config!, diagnostics);

    expect(diagnostics.diagnostics).toEqual([]);
    expect(project.commands.map(component => component.id)).toEqual(['check']);
    expect(project.skills[0]?.auxiliaryFiles[0]?.path).toBe('references/checks.md');
    expect(project.agents[0]?.model).toBe('capable');
    expect(project.publicFiles[0]?.targetPath).toBe('icon.bin');
  });

  it('reports a complete dependency cycle', async () => {
    /** 循环依赖样例工程根目录。 */
    const root = await temporaryProject();
    await fs.mkdir(path.join(root, 'src/skills/a'), { recursive: true });
    await fs.mkdir(path.join(root, 'src/skills/b'), { recursive: true });
    await fs.writeFile(path.join(root, 'src/skills/a/SKILL.md'), '---\ndescription: A.\nrequires:\n  skills: [b]\n---\nA body.\n');
    await fs.writeFile(path.join(root, 'src/skills/b/SKILL.md'), '---\ndescription: B.\nrequires:\n  skills: [a]\n---\nB body.\n');
    /** 循环依赖 Scanner 使用的已解析配置。 */
    const resolved = resolveConfig({ name: 'test-plugin', version: '1.0.0', description: 'Test.' }, path.join(root, 'acplugin.config.ts'), 'build', 'production');
    /** 接收完整依赖环诊断的 Collector。 */
    const diagnostics = new DiagnosticCollector();
    await scanProject(resolved.config!, diagnostics);

    expect(diagnostics.diagnostics).toContainEqual(expect.objectContaining({
      code: 'COMPONENT_DEPENDENCY_CYCLE',
      message: expect.stringContaining('skill:a -> skill:b -> skill:a'),
    }));
  });
});
