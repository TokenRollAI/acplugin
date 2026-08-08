import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  bytesArtifact,
  defineExtension,
  DeliveryUnitRegistry,
  executeLifecycle,
  resolveConfig,
  stableJson,
  withMaterializedDeliveryUnitCandidate,
  type AcpluginExtension,
  type BuildCommand,
  type DiagnosticInput,
  type PlatformDistributionContext,
  type ResolvedConfig,
} from '@acplugin/core';
import { codex } from '../src/index.js';
import { MARKETPLACE_MANIFEST_PATH, PLUGIN_MANIFEST_PATH } from '../src/manifest.js';

/** 测试结束后统一删除的临时工程根目录。 */
const temporaryRoots: string[] = [];

/** Golden 文件相对于当前测试模块的固定目录。 */
const goldenRoot = path.join(import.meta.dirname, 'golden');

/**
 * 创建已登记自动清理的空临时工程。
 *
 * @returns 新建工程的绝对路径。
 */
async function temporaryProject(): Promise<string> {
  /** 当前用例独占且不会与并行测试冲突的工程根。 */
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-codex-platform-'));
  temporaryRoots.push(root);
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  return root;
}

/**
 * 写入包含原生 Skill、无 hint Command、辅助文件和 Public 的严格兼容工程。
 *
 * @param root 当前测试工程根目录。
 */
async function writeSupportedProject(root: string): Promise<void> {
  await fs.mkdir(path.join(root, 'src/commands'), { recursive: true });
  await fs.mkdir(path.join(root, 'src/skills/review/references'), { recursive: true });
  await fs.mkdir(path.join(root, 'public/assets'), { recursive: true });
  await fs.writeFile(path.join(root, 'src/commands/release.md'), `---
description: Prepare a release.
platforms:
  codex:
    displayName: Release command
    shortDescription: Prepare a release
---
Prepare release {{arguments}}.
`);
  await fs.writeFile(path.join(root, 'src/skills/review/SKILL.md'), `---
description: Review the current change.
invocation:
  user: true
  model: false
platforms:
  codex:
    displayName: Review change
    shortDescription: Review a change
    brandColor: "#10A37F"
    products:
      - CODEX
---
Review the implementation.
`);
  await fs.writeFile(path.join(root, 'src/skills/review/references/checklist.md'), 'Review checklist.\n');
  await fs.writeFile(path.join(root, 'public/assets/logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" fill="#10A37F"/></svg>\n');
}

/**
 * 解析仅包含 Codex Platform 的测试配置。
 *
 * @param root 当前测试工程根目录。
 * @param command 生命周期命令。
 * @param platform 当前用例使用的 Codex Platform。
 * @param extensions 可选横向 Extension 列表。
 * @returns 无配置诊断的完整 ResolvedConfig。
 */
function resolvedConfig(
  root: string,
  command: BuildCommand,
  platform: ReturnType<typeof codex>,
  extensions: readonly AcpluginExtension[] = [],
): ResolvedConfig {
  /** 通过公开配置解析器建立的测试配置结果。 */
  const result = resolveConfig({
    name: 'release-tools',
    version: '1.2.3',
    description: 'Release workflow tools.',
    displayName: 'Release Tools',
    author: { name: 'TokenRoll', email: 'maintainers@example.com', url: 'https://github.com/TokenRollAI' },
    homepage: 'https://example.com/release-tools',
    repository: 'https://github.com/TokenRollAI/release-tools',
    license: 'MIT',
    keywords: ['release', 'review'],
    platforms: [platform],
    extensions,
    build: { outDir: 'dist', strict: true },
  }, path.join(root, 'acplugin.config.ts'), command, 'production', { defaultPlatforms: [platform] });
  expect(result.diagnostics).toEqual([]);
  return result.config!;
}

/**
 * 执行一次完整 Codex Platform 生命周期。
 *
 * @param config 已解析且只包含当前 Platform 的配置。
 * @returns Core 的稳定 BuildResult。
 */
async function run(config: ResolvedConfig) {
  return executeLifecycle({
    config,
    /** 当前 Platform Fixture 不加载作者 TypeScript 模块。 */
    loadTypeScriptModule: async () => undefined,
    environment: {},
  });
}

/**
 * 读取 Golden 文本并与实际产物执行字节级比较。
 *
 * @param actual 当前构建输出文件的绝对路径。
 * @param golden Golden 文件相对于 test/golden 的路径。
 */
async function expectGolden(actual: string, golden: string): Promise<void> {
  /** 当前仓库固定保存的期望字节。 */
  const expected = await fs.readFile(path.join(goldenRoot, golden));
  /** 当前 Platform 构建产生的实际字节。 */
  const received = await fs.readFile(actual);
  expect(received).toEqual(expected);
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe('Codex Platform', () => {
  it('builds native Skills, transformed Commands, Public, metadata, and current openai.yaml', async () => {
    /** 只使用 strict 可接受能力的完整工程。 */
    const root = await temporaryProject();
    await writeSupportedProject(root);
    /** 配置完整官方安装 interface 的 Codex Platform。 */
    const platform = codex({
      interface: {
        category: 'Developer Tools',
        capabilities: ['Prepare releases', 'Review changes'],
        defaultPrompt: 'Use Release Tools to review this change.',
        brandColor: '#10A37F',
        composerIcon: './assets/logo.svg',
        logo: './assets/logo.svg',
      },
    });
    /** 完成 strict 主 Plugin 构建后的稳定结果。 */
    const result = await run(resolvedConfig(root, 'build', platform));
    /** Codex 主 Plugin 的最终输出根。 */
    const output = path.join(root, 'dist/codex/plugin');

    expect(result.success).toBe(true);
    expect(result.committed).toBe(true);
    expect(result.compatibility).toEqual(expect.arrayContaining([
      expect.objectContaining({ subject: 'skill:review', level: 'native' }),
      expect.objectContaining({ subject: 'command:release', level: 'transform' }),
    ]));
    expect(result.metadata).toContainEqual(expect.objectContaining({
      field: 'displayName',
      disposition: 'emitted',
      output: '.codex-plugin/plugin.json.interface.displayName',
    }));
    await expectGolden(path.join(output, '.codex-plugin/plugin.json'), '.codex-plugin/plugin.json');
    await expectGolden(path.join(output, 'skills/review/SKILL.md'), 'skills/review/SKILL.md');
    await expectGolden(path.join(output, 'skills/review/agents/openai.yaml'), 'skills/review/agents/openai.yaml');
    await expectGolden(path.join(output, 'skills/command-release/SKILL.md'), 'skills/command-release/SKILL.md');
    await expectGolden(path.join(output, 'skills/command-release/agents/openai.yaml'), 'skills/command-release/agents/openai.yaml');
    expect(await fs.readFile(path.join(output, 'skills/review/references/checklist.md'), 'utf8')).toBe('Review checklist.\n');
    expect(await fs.readFile(path.join(output, 'assets/logo.svg'), 'utf8')).toContain('viewBox="0 0 48 48"');
  });

  it('rejects only an actually declared Command argument hint in strict mode', async () => {
    /** 单 Command 工程用于隔离 hint 兼容性。 */
    const root = await temporaryProject();
    await fs.mkdir(path.join(root, 'src/commands'), { recursive: true });
    await fs.writeFile(path.join(root, 'src/commands/deploy.md'), `---
description: Deploy an environment.
argumentHint: <environment>
---
Deploy {{arguments}}.
`);
    /** strict 应在 fallback 生成 checkpoint 拒绝实际 hint 损失。 */
    const result = await run(resolvedConfig(root, 'build', codex()));

    expect(result.success).toBe(false);
    expect(result.committed).toBe(false);
    expect(result.compatibility).toContainEqual(expect.objectContaining({
      subject: 'command:deploy',
      capability: 'argumentHint',
      level: 'degraded',
    }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'COMPATIBILITY_STRICT' }));
  });

  it('rejects Agent fallback in strict mode and writes explicit guidance in relaxed mode', async () => {
    /** 单 Agent 工程用于验证三类运行约束损失。 */
    const root = await temporaryProject();
    await fs.mkdir(path.join(root, 'src/agents'), { recursive: true });
    await fs.writeFile(path.join(root, 'src/agents/reviewer.md'), `---
description: Review code changes.
model: capable
capabilities:
  - filesystem:read
  - search
---
Review code and report findings.
`);
    /** strict 运行不应提交降级 Agent。 */
    const strictResult = await run(resolvedConfig(root, 'build', codex()));
    /** relaxed 运行允许生成带明确限制说明的 fallback。 */
    const relaxedResult = await run(resolvedConfig(root, 'build', codex({ strict: false })));
    /** relaxed 模式最终生成的指导型 Skill。 */
    const fallback = await fs.readFile(path.join(root, 'dist/codex/plugin/skills/agent-reviewer/SKILL.md'), 'utf8');

    expect(strictResult.success).toBe(false);
    expect(strictResult.committed).toBe(false);
    expect(relaxedResult.success).toBe(true);
    expect(relaxedResult.compatibility).toEqual(expect.arrayContaining([
      expect.objectContaining({ subject: 'agent:reviewer', capability: 'component', level: 'degraded' }),
      expect.objectContaining({ subject: 'agent:reviewer', capability: 'agent.model', level: 'degraded' }),
      expect.objectContaining({ subject: 'agent:reviewer', capability: 'agent.capabilities', level: 'degraded' }),
    ]));
    expect(fallback).toContain('Intended model class: capable.');
    expect(fallback).toContain('These settings are guidance, not enforced registration.');
  });

  it('reports user:false as an actual invocation degradation', async () => {
    /** 单 Skill 工程用于隔离禁止显式调用的兼容性。 */
    const root = await temporaryProject();
    await fs.mkdir(path.join(root, 'src/skills/manual'), { recursive: true });
    await fs.writeFile(path.join(root, 'src/skills/manual/SKILL.md'), `---
description: Run only when explicitly selected.
invocation:
  user: false
  model: true
---
Perform the manual workflow.
`);
    /** relaxed 运行应保留 Skill 内容并只警告 user:false。 */
    const result = await run(resolvedConfig(root, 'build', codex({ strict: false })));
    expect(result.success, JSON.stringify(result.diagnostics)).toBe(true);

    expect(result.compatibility).toContainEqual(expect.objectContaining({
      subject: 'skill:manual',
      capability: 'invocation.user',
      level: 'degraded',
    }));
    expect(await fs.readFile(path.join(root, 'dist/codex/plugin/skills/manual/SKILL.md'), 'utf8'))
      .toContain('Perform the manual workflow.');
  });

  it('fails when a canonical Skill collides with a generated fallback Skill ID', async () => {
    /** 同时声明 command:release 与 skill:command-release 的冲突工程。 */
    const root = await temporaryProject();
    await fs.mkdir(path.join(root, 'src/commands'), { recursive: true });
    await fs.mkdir(path.join(root, 'src/skills/command-release'), { recursive: true });
    await fs.writeFile(path.join(root, 'src/commands/release.md'), `---
description: Prepare a release.
---
Prepare the release.
`);
    await fs.writeFile(path.join(root, 'src/skills/command-release/SKILL.md'), `---
description: Existing colliding Skill.
---
Run the existing workflow.
`);
    /** prepare 应在任何 Artifact 注册前报告稳定结构错误。 */
    const result = await run(resolvedConfig(root, 'build', codex()));

    expect(result.success).toBe(false);
    expect(result.committed).toBe(false);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: 'CODEX_GENERATED_SKILL_ID_COLLISION',
      message: expect.stringContaining('skill:command-release'),
    }));
  });

  it('lets independent Hooks and MCP Adapters use only declared add-only extension points', async () => {
    /** 至少含一个原生 Skill 的 Extension host 工程。 */
    const root = await temporaryProject();
    await fs.mkdir(path.join(root, 'src/skills/host'), { recursive: true });
    await fs.writeFile(path.join(root, 'src/skills/host/SKILL.md'), `---
description: Host extension resources.
---
Use the extension resources.
`);
    /** 模拟官方 Hooks/MCP Extension 包的两个 add-only patch。 */
    const extension = defineExtension({
      name: 'codex-extension-fixture',
      apiVersion: '1',
      /** discover 返回资源以触发 Adapter 生命周期。 */
      discover: () => ({ enabled: true }),
      /** build 透传当前 Fixture 的平台中立状态。 */
      build: (_context, discovered) => discovered,
      adapters: [{
        extensionApiVersion: '1',
        platform: codex().id,
        platformApiVersion: '1',
        /** apply 只能新增 Manifest 字段和自己拥有的 Artifact。 */
        apply(context) {
          context.patchDocument({ document: 'plugin-manifest', path: ['hooks'], value: './hooks/hooks.json' });
          context.patchDocument({ document: 'plugin-manifest', path: ['mcpServers'], value: './.mcp.json' });
          context.emitArtifact(bytesArtifact('hooks/hooks.json', '{"hooks":{}}\n'));
          context.emitArtifact(bytesArtifact('.mcp.json', '{"docs":{"url":"https://developers.openai.com/mcp"}}\n'));
        },
      }],
    });
    /** 完成 Extension 合并和最终引用验证的生命周期结果。 */
    const result = await run(resolvedConfig(root, 'build', codex(), [extension]));
    /** 最终 Plugin Manifest 中的两个 Extension 引用。 */
    const manifest = JSON.parse(await fs.readFile(path.join(root, 'dist/codex/plugin/.codex-plugin/plugin.json'), 'utf8'));

    expect(result.success).toBe(true);
    expect(manifest).toMatchObject({ hooks: './hooks/hooks.json', mcpServers: './.mcp.json' });
    expect(result.deliveryUnits[0]?.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'hooks/hooks.json', owner: 'extension:codex-extension-fixture' }),
      expect.objectContaining({ path: '.mcp.json', owner: 'extension:codex-extension-fixture' }),
    ]));
  });

  it('creates a policy-aware self-contained Marketplace and remains byte deterministic', async () => {
    /** Marketplace 必须完整复制的主 Plugin 工程。 */
    const root = await temporaryProject();
    await writeSupportedProject(root);
    /** 显式安装策略与分类进入 Codex Marketplace 条目。 */
    const platform = codex({
      interface: { category: 'Developer Tools' },
      marketplace: { policy: { installation: 'INSTALLED_BY_DEFAULT' } },
    });
    /** 第一次完整构建的生命周期结果。 */
    const first = await run(resolvedConfig(root, 'build', platform));
    /** Marketplace Distribution 的最终输出根。 */
    const marketplaceRoot = path.join(root, 'dist/codex/marketplace');
    /** 第一次构建后按路径保存的 Artifact 字节快照。 */
    const firstBytes = new Map<string, Buffer>();
    for (const artifact of first.deliveryUnits.find(unit => unit.id === 'marketplace')!.artifacts)
      firstBytes.set(artifact.path, await fs.readFile(path.join(marketplaceRoot, artifact.path)));
    /** 第二次使用相同输入覆盖完整 outDir 的生命周期结果。 */
    const second = await run(resolvedConfig(root, 'build', platform));

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(first.deliveryUnits.map(unit => `${unit.role}:${unit.id}`)).toEqual(['distribution:marketplace', 'primary:plugin']);
    await expectGolden(path.join(marketplaceRoot, '.agents/plugins/marketplace.json'), '.agents/plugins/marketplace.json');
    for (const [artifactPath, bytes] of firstBytes)
      expect(await fs.readFile(path.join(marketplaceRoot, artifactPath))).toEqual(bytes);
    expect(await fs.readFile(path.join(marketplaceRoot, '.codex-plugin/plugin.json')))
      .toEqual(await fs.readFile(path.join(root, 'dist/codex/plugin/.codex-plugin/plugin.json')));
  });

  it('combines multiple validated primary Plugins into stable Marketplace subdirectories', async () => {
    /** 多主单元测试使用的临时物化工作目录。 */
    const root = await temporaryProject();
    /** 暴露 Marketplace Distribution Hook 的 Codex Platform。 */
    const platform = codex({ marketplace: { policy: { installation: 'AVAILABLE' } } });
    /** 使用真实 Core Registry 创建带完整 owner/hash 的主单元。 */
    const units = new DeliveryUnitRegistry(new Map());
    /** 每个 Codex Plugin 都必须携带至少一个有效 Skill。 */
    const skill = (name: string) => `---\nname: ${name}\ndescription: ${name} workflow.\n---\nRun ${name}.\n`;
    /** 输入顺序故意与 ID 排序相反的第二个 Plugin。 */
    const beta = await units.add(platform.id, {
      id: 'plugin-b', role: 'primary', type: 'plugin',
      artifacts: [
        bytesArtifact(PLUGIN_MANIFEST_PATH, stableJson({
          name: 'beta-tools', version: '2.0.0', description: 'Beta tools.', skills: './skills/',
        })),
        bytesArtifact('skills/beta/SKILL.md', skill('beta')),
      ],
    });
    /** 排序后应出现在 Marketplace 第一项的 Plugin。 */
    const alpha = await units.add(platform.id, {
      id: 'plugin-a', role: 'primary', type: 'plugin',
      artifacts: [
        bytesArtifact(PLUGIN_MANIFEST_PATH, stableJson({
          name: 'alpha-tools', version: '1.0.0', description: 'Alpha tools.', skills: './skills/',
        })),
        bytesArtifact('skills/alpha/SKILL.md', skill('alpha')),
      ],
    });
    /** Distribution 与最终 Validator 共同产生的结构化诊断。 */
    const diagnostics: DiagnosticInput[] = [];
    /** 模拟未来 Monorepo 编排器提供的 Marketplace 根上下文。 */
    const context: PlatformDistributionContext = {
      command: 'build',
      mode: 'production',
      project: {
        root,
        metadata: { name: 'tool-catalog', version: '1.0.0', description: 'Tool catalog.' },
        commands: [], skills: [], agents: [], publicFiles: [],
      },
      options: platform.options ?? {},
      workDir: root,
      /** 收集 Distribution 生成阶段的结构化诊断。 */
      reportDiagnostic: diagnostic => diagnostics.push(diagnostic),
    };
    /** Platform 必须直接接受数组，无需未来重写 Marketplace Builder。 */
    const distributionInputs = await platform.generateDistributions!(context, [beta, alpha]);
    /** 使用两个主单元的继承边界注册最终 Distribution。 */
    const distribution = await units.add(
      platform.id,
      distributionInputs[0]!,
      [...alpha.artifacts, ...beta.artifacts],
    );
    await withMaterializedDeliveryUnitCandidate(distribution, candidate => platform.validateBundle({
      command: 'build', mode: 'production', candidate,
      /** 收集最终候选 Validator 的结构化诊断。 */
      reportDiagnostic: diagnostic => diagnostics.push(diagnostic),
    }), root);
    /** 解析最终 Marketplace 清单以验证稳定条目顺序和本地来源。 */
    const marketplaceArtifact = distribution.artifacts.find(artifact => artifact.path === MARKETPLACE_MANIFEST_PATH)!;
    /** Marketplace 清单由 Platform 生成，因此固定为内存字节来源。 */
    const marketplace = JSON.parse(new TextDecoder().decode(
      marketplaceArtifact.source.type === 'bytes' ? marketplaceArtifact.source.value : new Uint8Array(),
    ));

    expect(diagnostics).toEqual([]);
    expect(marketplace.plugins.map((plugin: { name: string; source: { path: string } }) => [plugin.name, plugin.source.path])).toEqual([
      ['alpha-tools', './plugins/plugin-a'],
      ['beta-tools', './plugins/plugin-b'],
    ]);
    expect(distribution.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'plugins/plugin-a/.codex-plugin/plugin.json' }),
      expect.objectContaining({ path: 'plugins/plugin-a/skills/alpha/SKILL.md' }),
      expect.objectContaining({ path: 'plugins/plugin-b/.codex-plugin/plugin.json' }),
    ]));
  });

  it('validates factory and Component fields without raw schema escape hatches', async () => {
    expect(() => codex({ raw: true } as never)).toThrow('Unknown Codex Platform option');
    expect(() => codex({ interface: { displayName: 'duplicate' } } as never)).toThrow('Unknown Codex interface option');
    expect(() => codex({ interface: { websiteURL: 'https://user:secret@example.com' } })).toThrow('without credentials');
    expect(() => codex({ marketplace: { policy: { installation: 'UNKNOWN' } } } as never)).toThrow('not supported');

    /** 非法 Component 专属字段应在 Scanner 阶段失败。 */
    const root = await temporaryProject();
    await fs.mkdir(path.join(root, 'src/skills/invalid'), { recursive: true });
    await fs.writeFile(path.join(root, 'src/skills/invalid/SKILL.md'), `---
description: Invalid platform field fixture.
platforms:
  codex:
    iconSmall: ../escape.png
---
Do not build.
`);
    /** Scanner 应附带稳定平台字段路径。 */
    const result = await run(resolvedConfig(root, 'validate', codex()));

    expect(result.success).toBe(false);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: 'CODEX_COMPONENT_FIELD_INVALID',
      fieldPath: ['platforms', 'codex', 'iconSmall'],
    }));
  });

  it('rejects invalid Skills appended by an Extension at the final candidate boundary', async () => {
    /** 一个有效规范 Skill 保证错误只来自 Extension 追加内容。 */
    const root = await temporaryProject();
    await fs.mkdir(path.join(root, 'src/skills/host'), { recursive: true });
    await fs.writeFile(path.join(root, 'src/skills/host/SKILL.md'), `---
description: Host extension output.
---
Use the host workflow.
`);
    /** 模拟错误地向 Platform 安装根注入无 Frontmatter Skill 的第三方 Extension。 */
    const extension = defineExtension({
      name: 'invalid-skill-fixture',
      apiVersion: '1',
      /** discover 返回资源以触发 Adapter。 */
      discover: () => ({ enabled: true }),
      /** build 透传 Fixture 状态。 */
      build: (_context, discovered) => discovered,
      adapters: [{
        extensionApiVersion: '1',
        platform: codex().id,
        platformApiVersion: '1',
        /** apply 追加一个结构路径正确但内容协议错误的 Skill。 */
        apply(context) {
          context.emitArtifact(bytesArtifact('skills/invalid-extension/SKILL.md', 'missing frontmatter\n'));
        },
      }],
    });
    /** 最终 Validator 必须阻止无效 Extension 内容进入交付单元。 */
    const result = await run(resolvedConfig(root, 'build', codex(), [extension]));

    expect(result.success).toBe(false);
    expect(result.committed).toBe(false);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'CODEX_SKILL_FRONTMATTER_INVALID' }));
  });

  it('validates referenced Hook configuration at the final Platform boundary', async () => {
    /** 有效 Skill 保证最终错误只来自 Extension 贡献的 Hook 配置。 */
    const root = await temporaryProject();
    await fs.mkdir(path.join(root, 'src/skills/host'), { recursive: true });
    await fs.writeFile(path.join(root, 'src/skills/host/SKILL.md'), `---
description: Host invalid Hook validation.
---
Validate the extension output.
`);
    /** 模拟绕过正式 Hooks Extension 并贡献无效 Codex Handler 的第三方 Adapter。 */
    const extension = defineExtension({
      name: 'invalid-codex-hooks',
      apiVersion: '1',
      /** discover 返回资源以触发 Adapter。 */
      discover: () => true,
      adapters: [{
        extensionApiVersion: '1',
        platform: codex().id,
        platformApiVersion: '1',
        /** apply 只贡献候选，Platform 最终 Validator 负责原生协议检查。 */
        apply(context) {
          context.patchDocument({ document: 'plugin-manifest', path: ['hooks'], value: './hooks/hooks.json' });
          context.emitArtifact(bytesArtifact('hooks/hooks.json', stableJson({
            hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: 'node hook.mjs', timeout: 4 }] }] },
          })));
        },
      }],
    });
    /** SessionEnd 四秒超出 Codex 官方三秒上限，候选不得提交。 */
    const result = await run(resolvedConfig(root, 'build', codex(), [extension]));

    expect(result.success).toBe(false);
    expect(result.committed).toBe(false);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'CODEX_HOOK_TIMEOUT_LIMIT' }));
  });

  it('validates openai.yaml and its Skill-local icon references', async () => {
    /** 声明缺失 Skill 图标的工程用于覆盖元数据资源验证。 */
    const root = await temporaryProject();
    await fs.mkdir(path.join(root, 'src/skills/icon-test'), { recursive: true });
    await fs.writeFile(path.join(root, 'src/skills/icon-test/SKILL.md'), `---
description: Validate Skill metadata assets.
platforms:
  codex:
    iconSmall: ./assets/missing.png
---
Validate metadata assets.
`);
    /** 最终 Validator 应拒绝 Scanner 无法提前确认的产物相对引用。 */
    const result = await run(resolvedConfig(root, 'build', codex()));

    expect(result.success).toBe(false);
    expect(result.committed).toBe(false);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'CODEX_SKILL_ASSET_MISSING' }));
  });

  it('rejects branding paths whose bytes are not a supported square image', async () => {
    /** 包含有效 Skill 和伪造品牌图片的最终候选。 */
    const root = await temporaryProject();
    await fs.mkdir(path.join(root, 'src/skills/branding'), { recursive: true });
    await fs.mkdir(path.join(root, 'public/assets'), { recursive: true });
    await fs.writeFile(path.join(root, 'src/skills/branding/SKILL.md'), `---
description: Validate plugin branding.
---
Validate the branding files.
`);
    await fs.writeFile(path.join(root, 'public/assets/not-an-image.bin'), Buffer.from([0, 1, 2, 255]));
    /** Factory 允许安全路径，最终 Validator 负责检查实际文件内容。 */
    const result = await run(resolvedConfig(root, 'build', codex({
      interface: { logo: './assets/not-an-image.bin' },
    })));

    expect(result.success).toBe(false);
    expect(result.committed).toBe(false);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: 'CODEX_BRANDING_IMAGE_FORMAT_UNSUPPORTED',
    }));
  });

  it('strictly rejects malformed SVG XML and dimensions with units', async () => {
    /** 每个无效 SVG Fixture 的稳定文件名和原始内容。 */
    const fixtures = [
      ['unclosed.svg', '<svg viewBox="0 0 48 48">'],
      ['unit-size.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="48px" height="48px"></svg>'],
    ] as const;
    /** [fileName, source] 表示当前应被严格 SVG 解析拒绝的候选。 */
    for (const [fileName, source] of fixtures) {
      /** 当前无效 SVG 用例的独立工程。 */
      const root = await temporaryProject();
      await fs.mkdir(path.join(root, 'src/skills/branding'), { recursive: true });
      await fs.mkdir(path.join(root, 'public/assets'), { recursive: true });
      await fs.writeFile(path.join(root, 'src/skills/branding/SKILL.md'), `---
description: Validate strict SVG parsing.
---
Validate the branding SVG.
`);
      await fs.writeFile(path.join(root, 'public/assets', fileName), source);
      /** image-size 曾错误接受这两个 SVG，最终 Validator 现在必须失败。 */
      const result = await run(resolvedConfig(root, 'build', codex({
        interface: { logo: `./assets/${fileName}` },
      })));

      expect(result.success).toBe(false);
      expect(result.diagnostics).toContainEqual(expect.objectContaining({
        code: 'CODEX_BRANDING_IMAGE_DECODE_FAILED',
      }));
    }
  });
});
