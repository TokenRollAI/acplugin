import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  defineExtension,
  definePlatform,
  DiagnosticCollector,
  resolveConfig,
  scanProject,
  type AcpluginPlatform,
  type PlatformComponentValidationContext,
  type UserConfig,
} from '../src/index.js';

/** 每个 Scanner 测试创建并在 afterEach 中删除的临时工程。 */
const temporaryDirectories: string[] = [];

/**
 * 创建带可选 Component 字段校验器的最小测试 Platform。
 *
 * @param id 开放的测试 Platform ID。
 * @param validateComponentFields 可选的 Platform 专属字段校验器。
 * @returns 带 Core 私有品牌的最小 Platform。
 */
function testPlatform(
  id: string,
  validateComponentFields?: (context: PlatformComponentValidationContext) => void,
): AcpluginPlatform {
  return definePlatform({
    id,
    apiVersion: '1',
    deliveryType: 'plugin',
    ...(validateComponentFields === undefined ? {} : { validateComponentFields }),
    /** Scanner 测试不会执行 Platform Draft 阶段。 */
    prepare: () => ({ documents: [], artifacts: [] }),
    /** Scanner 测试不会执行 Platform 产物生成。 */
    generateBundle: () => ({ id: 'plugin', role: 'primary', type: 'plugin', artifacts: [] }),
    /** Scanner 测试不会物化候选目录。 */
    validateBundle: () => undefined,
  });
}

/** Core Scanner 测试使用的两个显式 Platform。 */
const defaultPlatforms = [testPlatform('claude-code'), testPlatform('codex')];

/**
 * 创建并登记一个 Scanner 临时工程。
 *
 * @returns 临时工程绝对路径。
 */
async function temporaryProject(): Promise<string> {
  /** 当前测试独占的临时目录。 */
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-scanner-test-'));
  temporaryDirectories.push(root);
  return root;
}

/**
 * 解析 Scanner 测试使用的最终配置。
 *
 * @param root 临时工程根目录。
 * @param input 需要覆盖默认元数据的用户配置。
 * @param platforms 测试配置显式声明的 Platform。
 * @returns 无配置错误的最终 ResolvedConfig。
 */
function projectConfig(
  root: string,
  input: Partial<UserConfig> = {},
  platforms: readonly AcpluginPlatform[] = defaultPlatforms,
): NonNullable<ReturnType<typeof resolveConfig>['config']> {
  /** 测试工程的完整用户配置。 */
  const value: UserConfig = {
    name: 'scanner-fixture',
    version: '1.0.0',
    description: 'Scanner fixture.',
    platforms,
    ...input,
  };
  /** Core 配置解析结果。 */
  const resolved = resolveConfig(value, path.join(root, 'acplugin.config.ts'), 'validate', 'production');
  expect(resolved.diagnostics).toEqual([]);
  return resolved.config!;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

describe('canonical Scanner', () => {
  it('creates a stable platform-neutral project and preserves binary file sources and modes', async () => {
    /** Platform Validator 实际收到的不可变 Component 字段。 */
    const validated: unknown[] = [];
    /** 对 model 字段执行最小 Schema 校验的 Codex Platform。 */
    const codex = testPlatform('codex', (context) => {
      validated.push({ component: context.component, fields: context.fields });
      if (context.fields.model !== 'fast') {
        context.reportDiagnostic({
          code: 'CODEX_COMPONENT_MODEL_INVALID',
          severity: 'error',
          message: 'model must be fast.',
          fieldPath: ['platforms', 'codex', 'model'],
        });
      }
    });
    /** 当前测试的完整规范工程。 */
    const root = await temporaryProject();
    await fs.mkdir(path.join(root, 'src/commands'), { recursive: true });
    await fs.mkdir(path.join(root, 'src/skills/review/references'), { recursive: true });
    await fs.mkdir(path.join(root, 'src/agents'), { recursive: true });
    await fs.mkdir(path.join(root, 'public/bin'), { recursive: true });
    await fs.writeFile(path.join(root, 'src/commands/check.md'), `---
description: Check a release.
argumentHint: <ref>
requires:
  skills: [review]
platforms:
  codex:
    model: fast
---
Check {{arguments}}.
`);
    await fs.writeFile(path.join(root, 'src/skills/review/SKILL.md'), `---
description: Review a release.
requires:
  agents: [reviewer]
---
Review the release.
`);
    /** Skill auxiliary 使用包含无效 UTF-8 的二进制内容验证 Scanner 不会文本化。 */
    const auxiliaryBytes = new Uint8Array([0xff, 0x00, 0x7f]);
    await fs.writeFile(path.join(root, 'src/skills/review/references/data.bin'), auxiliaryBytes);
    await fs.chmod(path.join(root, 'src/skills/review/references/data.bin'), 0o755);
    await fs.writeFile(path.join(root, 'src/agents/reviewer.md'), `---
description: Review implementation correctness.
model: capable
capabilities: [filesystem:read, search]
---
Return evidence-backed findings.
`);
    /** Public 文件同样保留原始字节和可执行 mode。 */
    const publicBytes = new Uint8Array([0x00, 0xff, 0x01]);
    await fs.writeFile(path.join(root, 'public/bin/tool'), publicBytes);
    await fs.chmod(path.join(root, 'public/bin/tool'), 0o755);

    /** Scanner 生成的平台中立工程和诊断。 */
    const diagnostics = new DiagnosticCollector();
    /** 完整扫描后得到的规范 PluginProject。 */
    const { project } = await scanProject(projectConfig(root, { platforms: [testPlatform('claude-code'), codex] }), diagnostics);

    expect(diagnostics.diagnostics).toEqual([]);
    expect({
      metadata: project.metadata,
      commands: project.commands.map(command => ({
        id: command.id,
        requires: command.requires,
        platforms: command.platforms,
      })),
      skills: project.skills.map(skill => ({
        id: skill.id,
        invocation: skill.invocation,
        auxiliary: skill.auxiliaryFiles.map(file => ({ path: file.path, mode: file.mode })),
      })),
      agents: project.agents.map(agent => ({ id: agent.id, model: agent.model, capabilities: agent.capabilities })),
      publicFiles: project.publicFiles.map(file => ({ targetPath: file.targetPath, mode: file.mode })),
    }).toEqual({
      metadata: { name: 'scanner-fixture', version: '1.0.0', description: 'Scanner fixture.' },
      commands: [{ id: 'check', requires: { skills: ['review'], agents: [] }, platforms: { codex: { model: 'fast' } } }],
      skills: [{ id: 'review', invocation: { user: true, model: true }, auxiliary: [{ path: 'references/data.bin', mode: 0o755 }] }],
      agents: [{ id: 'reviewer', model: 'capable', capabilities: ['filesystem:read', 'search'] }],
      publicFiles: [{ targetPath: 'bin/tool', mode: 0o755 }],
    });
    expect(validated).toEqual([{
      component: { kind: 'command', id: 'check', sourcePath: 'src/commands/check.md' },
      fields: { model: 'fast' },
    }]);
    expect(Object.isFrozen(project.commands[0]!.platforms.codex)).toBe(true);
    expect(Object.isFrozen(project)).toBe(true);
    expect(Object.isFrozen(project.skills[0]!.auxiliaryFiles)).toBe(true);
    expect(await fs.readFile(project.skills[0]!.auxiliaryFiles[0]!.sourcePath)).toEqual(Buffer.from(auxiliaryBytes));
    expect(await fs.readFile(project.publicFiles[0]!.sourcePath)).toEqual(Buffer.from(publicBytes));
  });

  it('reports malformed documents, nesting, invocation, capability, and placeholder failures', async () => {
    /** 同时包含多种独立结构错误的临时工程。 */
    const root = await temporaryProject();
    await fs.mkdir(path.join(root, 'src/commands/nested'), { recursive: true });
    await fs.mkdir(path.join(root, 'src/skills/disabled'), { recursive: true });
    await fs.mkdir(path.join(root, 'src/agents'), { recursive: true });
    await fs.writeFile(path.join(root, 'src/commands/broken.md'), '---\ndescription: [\n---\nBroken.\n');
    await fs.writeFile(path.join(root, 'src/commands/placeholder.md'), '---\ndescription: Placeholder.\n---\nUse {{ args }}.\n');
    await fs.writeFile(path.join(root, 'src/skills/disabled/SKILL.md'), '---\ndescription: Disabled.\ninvocation:\n  user: false\n  model: false\n---\nDisabled body.\n');
    await fs.writeFile(path.join(root, 'src/agents/unsafe.md'), '---\ndescription: Unsafe.\ncapabilities: [raw-tool]\n---\nUnsafe body.\n');

    /** 一次扫描收集的全部结构诊断码。 */
    const diagnostics = new DiagnosticCollector();
    await scanProject(projectConfig(root), diagnostics);
    /** 用于验证多类 Scanner 失败的诊断码列表。 */
    const codes = diagnostics.diagnostics.map(diagnostic => diagnostic.code);

    expect(codes).toEqual(expect.arrayContaining([
      'COMMAND_ENTRY_INVALID',
      'FRONTMATTER_INVALID',
      'COMMAND_PLACEHOLDER_INVALID',
      'SKILL_INVOCATION_EMPTY',
      'AGENT_CAPABILITY_INVALID',
    ]));
  });

  it('rejects string-array elements that are empty after trimming', async () => {
    /** 依赖数组包含纯空白元素的临时规范工程。 */
    const root = await temporaryProject();
    await fs.mkdir(path.join(root, 'src/commands'), { recursive: true });
    await fs.writeFile(path.join(root, 'src/commands/blank-requirement.md'), `---
description: Reject a blank dependency.
requires:
  skills:
    - '   '
---
Validate dependencies.
`);
    /** Scanner 应在通用 string-array 边界报告一致诊断。 */
    const diagnostics = new DiagnosticCollector();
    await scanProject(projectConfig(root), diagnostics);

    expect(diagnostics.diagnostics).toContainEqual(expect.objectContaining({
      code: 'FRONTMATTER_STRING_ARRAY',
      fieldPath: ['requires', 'skills'],
    }));
  });

  it('requires configured platforms, delegates field validation, and rejects legacy extensions', async () => {
    /** Validator 会通过受限出口报告专属字段错误的 Codex Platform。 */
    const codex = testPlatform('codex', (context) => {
      context.reportDiagnostic({
        code: 'CODEX_TIMEOUT_INVALID',
        severity: 'error',
        message: 'timeout must be positive.',
        fieldPath: ['platforms', 'codex', 'timeout'],
      });
    });
    /** 同时声明合法 Platform、未配置 Platform 和旧字段的工程。 */
    const root = await temporaryProject();
    await fs.mkdir(path.join(root, 'src/commands'), { recursive: true });
    await fs.writeFile(path.join(root, 'src/commands/deploy.md'), `---
description: Deploy.
platforms:
  codex:
    timeout: -1
  ghost:
    enabled: true
extensions:
  codex: {}
---
Deploy.
`);

    /** Platform 字段解析产生的聚合诊断。 */
    const diagnostics = new DiagnosticCollector();
    /** 即使存在字段诊断也保留有效 Component 的扫描结果。 */
    const { project } = await scanProject(projectConfig(root, { platforms: [codex] }), diagnostics);

    expect(diagnostics.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'CODEX_TIMEOUT_INVALID', platform: 'codex', component: { kind: 'command', id: 'deploy' } }),
      expect.objectContaining({ code: 'COMPONENT_PLATFORM_NOT_CONFIGURED', fieldPath: ['platforms', 'ghost'] }),
      expect.objectContaining({
        code: 'COMPONENT_LEGACY_EXTENSIONS',
        hint: expect.stringContaining('platforms: { \'claude-code\': {} }'),
      }),
    ]));
    expect(project.commands[0]!.platforms).toEqual({ codex: { timeout: -1 } });
  });

  it('reports non-empty Hooks and MCP sources when their Extensions are disabled', async () => {
    /** 包含两个保留 Extension 来源目录的临时工程。 */
    const root = await temporaryProject();
    await fs.mkdir(path.join(root, 'src/hooks/a'), { recursive: true });
    await fs.mkdir(path.join(root, 'src/mcp/b'), { recursive: true });
    await fs.writeFile(path.join(root, 'src/hooks/a/hook.ts'), 'export default {}');
    await fs.writeFile(path.join(root, 'src/mcp/b/mcp.ts'), 'export default {}');

    /** 未启用 Extension 时的目录所有权诊断。 */
    const diagnostics = new DiagnosticCollector();
    await scanProject(projectConfig(root), diagnostics);
    expect(diagnostics.diagnostics.filter(diagnostic => diagnostic.code === 'EXTENSION_REQUIRED')).toHaveLength(2);

    /** 使用最终公开名称启用两个空 Extension 后不再报告目录所有权错误。 */
    const extensions = [
      defineExtension({ name: '@tokenroll/acplugin-extension-hooks', apiVersion: '1', adapters: [] }),
      defineExtension({ name: '@tokenroll/acplugin-extension-mcp', apiVersion: '1', adapters: [] }),
    ];
    /** 启用正式 Extension 名称后的扫描诊断。 */
    const enabledDiagnostics = new DiagnosticCollector();
    await scanProject(projectConfig(root, { extensions }), enabledDiagnostics);
    expect(enabledDiagnostics.diagnostics.filter(diagnostic => diagnostic.code === 'EXTENSION_REQUIRED')).toEqual([]);
  });

  it('rejects invalid UTF-8 Markdown and colliding Public copy targets', async () => {
    /** 使用显式 Public copy rule 制造大小写不敏感目标冲突的工程。 */
    const root = await temporaryProject();
    await fs.mkdir(path.join(root, 'src/commands'), { recursive: true });
    await fs.mkdir(path.join(root, 'public/a'), { recursive: true });
    await fs.mkdir(path.join(root, 'public/b'), { recursive: true });
    await fs.writeFile(path.join(root, 'src/commands/binary.md'), new Uint8Array([0xff, 0xfe]));
    await fs.writeFile(path.join(root, 'public/a/file.txt'), 'a');
    await fs.writeFile(path.join(root, 'public/b/file.txt'), 'b');
    /** 两条规则的最终目标只在大小写上不同。 */
    const publicConfig = {
      copy: [
        { from: 'a/file.txt', to: 'Shared/file.txt' },
        { from: 'b/file.txt', to: 'shared/file.txt' },
      ],
    };

    /** UTF-8 和 Public 目标安全诊断。 */
    const diagnostics = new DiagnosticCollector();
    await scanProject(projectConfig(root, { public: publicConfig }), diagnostics);
    expect(diagnostics.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'MARKDOWN_UTF8_INVALID' }),
      expect.objectContaining({ code: 'PUBLIC_TARGET_COLLISION' }),
    ]));
  });

  it('normalizes backslash Public targets and detects mixed-separator collisions', async () => {
    /** 两个不同来源映射到仅分隔符写法不同的同一交付目标。 */
    const root = await temporaryProject();
    await fs.mkdir(path.join(root, 'public/a'), { recursive: true });
    await fs.mkdir(path.join(root, 'public/b'), { recursive: true });
    await fs.writeFile(path.join(root, 'public/a/file.txt'), 'a');
    await fs.writeFile(path.join(root, 'public/b/file.txt'), 'b');
    /** 分隔符不同但语义目标相同的最终配置。 */
    const config = projectConfig(root, {
      public: {
        copy: [
          { from: 'a/file.txt', to: 'assets\\file.txt' },
          { from: 'b/file.txt', to: 'assets/file.txt' },
        ],
      },
    });

    /** Config 已统一 target，Scanner 仍负责最终来源碰撞诊断。 */
    expect(config.public.copy?.[0]?.to).toBe('assets/file.txt');
    /** 混合分隔符碰撞的 Scanner 诊断。 */
    const diagnostics = new DiagnosticCollector();
    /** 只保留首个目标的规范工程。 */
    const { project } = await scanProject(config, diagnostics);
    expect(project.publicFiles.map(file => file.targetPath)).toEqual(['assets/file.txt']);
    expect(diagnostics.diagnostics).toContainEqual(expect.objectContaining({ code: 'PUBLIC_TARGET_COLLISION' }));
  });

  it('defensively rejects absolute, NUL, and mixed traversal Public targets', async () => {
    /** 构造绕过配置解析边界的 ResolvedConfig，验证 Scanner 自身仍不信任 target。 */
    const root = await temporaryProject();
    await fs.mkdir(path.join(root, 'public'), { recursive: true });
    await fs.writeFile(path.join(root, 'public/file.txt'), 'public');
    /** 先通过公开解析器取得其余字段合法的基础配置。 */
    const base = projectConfig(root, { public: { copy: [{ from: 'file.txt', to: 'safe/file.txt' }] } });
    /** 模拟绕过配置阶段后直接传入 Core 的不可信 target 集合。 */
    const config = {
      ...base,
      public: {
        ...base.public,
        copy: [
          { from: 'file.txt', to: 'C:\\outside\\file.txt' },
          { from: 'file.txt', to: 'C:/outside/file.txt' },
          { from: 'file.txt', to: '\\\\server\\share\\file.txt' },
          { from: 'file.txt', to: '/outside/file.txt' },
          { from: 'file.txt', to: 'safe\\../file.txt' },
          { from: 'file.txt', to: 'safe/\0/file.txt' },
        ],
      },
    };

    /** Scanner 自身产生的第二层路径边界诊断。 */
    const diagnostics = new DiagnosticCollector();
    /** 所有不可信 Public 目标都被排除后的规范工程。 */
    const { project } = await scanProject(config, diagnostics);
    expect(project.publicFiles).toEqual([]);
    expect(diagnostics.diagnostics.filter(diagnostic => diagnostic.code === 'PUBLIC_TARGET_INVALID')).toHaveLength(6);
  });

  it('does not follow a configured source directory symlink', async () => {
    /** 工程外部目录模拟符号链接可能造成的来源边界逃逸。 */
    const external = await temporaryProject();
    await fs.mkdir(path.join(external, 'commands'), { recursive: true });
    await fs.writeFile(path.join(external, 'commands/leaked.md'), '---\ndescription: Leaked.\n---\nLeaked body.\n');
    /** 当前工程把 srcDir 指向外部目录的符号链接。 */
    const root = await temporaryProject();
    await fs.symlink(external, path.join(root, 'linked-src'));

    /** Scanner 应在读取任何外部 Component 前拒绝该来源根。 */
    const diagnostics = new DiagnosticCollector();
    /** 符号链接 srcDir 被拒绝后保持为空的规范工程。 */
    const { project } = await scanProject(projectConfig(root, { srcDir: 'linked-src' }), diagnostics);
    expect(diagnostics.diagnostics).toContainEqual(expect.objectContaining({ code: 'SOURCE_ROOT_SYMLINK' }));
    expect(project.commands).toEqual([]);
  });
});
