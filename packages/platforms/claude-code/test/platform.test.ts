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
import { claudeCode } from '../src/index.js';
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
  /** 当前测试独占且不会与并行用例冲突的工程根。 */
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-claude-platform-'));
  temporaryRoots.push(root);
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  return root;
}

/**
 * 写入覆盖 Command、Skill、Agent、辅助文件和 Public 的规范工程。
 *
 * @param root 当前测试独占的工程根目录。
 */
async function writeCompleteProject(root: string): Promise<void> {
  await fs.mkdir(path.join(root, 'src/commands'), { recursive: true });
  await fs.mkdir(path.join(root, 'src/skills/review/references'), { recursive: true });
  await fs.mkdir(path.join(root, 'src/agents'), { recursive: true });
  await fs.mkdir(path.join(root, 'public/shared'), { recursive: true });
  await fs.writeFile(path.join(root, 'src/commands/release.md'), `---
description: Prepare a release.
argumentHint: <version>
platforms:
  claude-code:
    allowedTools:
      - Read
    model: sonnet
---
Prepare release {{arguments}}.
`);
  await fs.writeFile(path.join(root, 'src/skills/review/SKILL.md'), `---
description: Review the current change.
invocation:
  user: false
  model: true
platforms:
  claude-code:
    allowedTools:
      - Read
      - Grep
    context: fork
    agent: reviewer
---
Review the implementation.
`);
  await fs.writeFile(path.join(root, 'src/skills/review/references/checklist.md'), 'Review checklist.\n');
  await fs.writeFile(path.join(root, 'src/agents/reviewer.md'), `---
description: Review code changes.
model: capable
capabilities:
  - filesystem:read
  - search
platforms:
  claude-code:
    tools:
      - Read
      - Grep
    disallowedTools:
      - Write
    effort: high
    maxTurns: 8
    skills:
      - review
    memory: project
    background: false
    isolation: worktree
---
Review code and report findings.
`);
  await fs.writeFile(path.join(root, 'public/shared/logo.bin'), Buffer.from([0, 1, 2, 255]));
}

/**
 * 解析测试使用的完整 Core 配置。
 *
 * @param root 当前测试工程根目录。
 * @param command 生命周期命令。
 * @param platform 当前用例使用的 Claude Code Platform。
 * @param extensions 可选的横向 Extension 列表。
 * @returns 无配置诊断的完整 ResolvedConfig。
 */
function resolvedConfig(
  root: string,
  command: BuildCommand,
  platform: ReturnType<typeof claudeCode>,
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
  }, path.join(root, 'acplugin.config.ts'), command, 'production');
  expect(result.diagnostics).toEqual([]);
  return result.config!;
}

/**
 * 执行一次完整 Claude Code Platform 生命周期。
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
 * 读取 Golden 文本并与实际产物进行字节级比较。
 *
 * @param actual 当前构建输出文件的绝对路径。
 * @param golden Golden 文件相对于 test/golden 的路径。
 */
async function expectGolden(actual: string, golden: string): Promise<void> {
  /** 当前仓库固定保存的期望文本。 */
  const expected = await fs.readFile(path.join(goldenRoot, golden));
  /** 当前 Platform 构建产生的实际字节。 */
  const received = await fs.readFile(actual);
  expect(received).toEqual(expected);
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe('Claude Code Platform', () => {
  it('builds Commands, Skills, Agents, Public, and metadata as a native Plugin golden', async () => {
    /** 包含全部 Core Component 的临时工程。 */
    const root = await temporaryProject();
    await writeCompleteProject(root);
    /** 使用主 Plugin 模式完成的生命周期结果。 */
    const result = await run(resolvedConfig(root, 'build', claudeCode({ defaultEnabled: false })));
    /** Claude Code 主 Plugin 的最终输出根。 */
    const output = path.join(root, 'dist/claude-code/plugin');

    expect(result.success).toBe(true);
    expect(result.committed).toBe(true);
    expect(result.deliveryUnits).toHaveLength(1);
    expect(result.compatibility).toEqual(expect.arrayContaining([
      expect.objectContaining({ subject: 'command:release', level: 'native' }),
      expect.objectContaining({ subject: 'skill:review', level: 'native' }),
      expect.objectContaining({ subject: 'agent:reviewer', level: 'native' }),
    ]));
    expect(result.metadata).toContainEqual(expect.objectContaining({
      field: 'displayName', disposition: 'emitted',
    }));
    await expectGolden(path.join(output, '.claude-plugin/plugin.json'), '.claude-plugin/plugin.json');
    await expectGolden(path.join(output, 'commands/release.md'), 'commands/release.md');
    await expectGolden(path.join(output, 'skills/review/SKILL.md'), 'skills/review/SKILL.md');
    await expectGolden(path.join(output, 'agents/reviewer.md'), 'agents/reviewer.md');
    expect(await fs.readFile(path.join(output, 'skills/review/references/checklist.md'), 'utf8')).toBe('Review checklist.\n');
    expect(await fs.readFile(path.join(output, 'shared/logo.bin'))).toEqual(Buffer.from([0, 1, 2, 255]));
  });

  it('lets independent Hooks and MCP Adapters use only declared add-only extension points', async () => {
    /** 只需要基础 Plugin Manifest 的空工程。 */
    const root = await temporaryProject();
    /** 模拟后续官方 Extension 包所使用的两个 Adapter。 */
    const extension = defineExtension({
      name: 'claude-extension-fixture',
      apiVersion: '1',
      /** discover 返回资源以触发 Adapter 生命周期。 */
      discover: () => ({ enabled: true }),
      /** build 透传当前 Fixture 的平台中立状态。 */
      build: (_context, discovered) => discovered,
      adapters: [{
        extensionApiVersion: '1',
        platform: claudeCode().id,
        platformApiVersion: '1',
        /** apply 只通过公开 Context 新增两个字段和对应 Artifact。 */
        apply(context) {
          context.patchDocument({ document: 'plugin-manifest', path: ['hooks'], value: './hooks/hooks.json' });
          context.patchDocument({ document: 'plugin-manifest', path: ['mcpServers'], value: './.mcp.json' });
          context.emitArtifact(bytesArtifact('hooks/hooks.json', '{"hooks":{}}\n'));
          context.emitArtifact(bytesArtifact('.mcp.json', '{"mcpServers":{}}\n'));
        },
      }],
    });
    /** 完成 Adapter 合并和最终引用校验的生命周期结果。 */
    const result = await run(resolvedConfig(root, 'build', claudeCode(), [extension]));
    /** 最终 Plugin 清单中的 Extension 字段。 */
    const manifest = JSON.parse(await fs.readFile(path.join(root, 'dist/claude-code/plugin/.claude-plugin/plugin.json'), 'utf8'));

    expect(result.success).toBe(true);
    expect(manifest).toMatchObject({ hooks: './hooks/hooks.json', mcpServers: './.mcp.json' });
    expect(result.deliveryUnits[0]?.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'hooks/hooks.json', owner: 'extension:claude-extension-fixture' }),
      expect.objectContaining({ path: '.mcp.json', owner: 'extension:claude-extension-fixture' }),
    ]));
  });

  it('creates an inferred self-contained Marketplace and remains byte deterministic', async () => {
    /** 包含全部主 Plugin 内容的 Marketplace Fixture。 */
    const root = await temporaryProject();
    await writeCompleteProject(root);
    /** 空选项要求 Platform 从统一元数据推导 Marketplace。 */
    const platform = claudeCode({ marketplace: {} });
    /** 第一次完整构建的生命周期结果。 */
    const first = await run(resolvedConfig(root, 'build', platform));
    /** Marketplace Distribution 的最终输出根。 */
    const marketplaceRoot = path.join(root, 'dist/claude-code/marketplace');
    /** 第一次构建后按路径保存的 Artifact 字节快照。 */
    const firstBytes = new Map<string, Buffer>();
    for (const artifact of first.deliveryUnits.find(unit => unit.id === 'marketplace')!.artifacts)
      firstBytes.set(artifact.path, await fs.readFile(path.join(marketplaceRoot, artifact.path)));
    /** 第二次使用相同输入覆盖完整 outDir 的生命周期结果。 */
    const second = await run(resolvedConfig(root, 'build', platform));

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(first.deliveryUnits.map(unit => `${unit.role}:${unit.id}`)).toEqual(['distribution:marketplace', 'primary:plugin']);
    await expectGolden(path.join(marketplaceRoot, '.claude-plugin/marketplace.json'), '.claude-plugin/marketplace.json');
    for (const [artifactPath, bytes] of firstBytes)
      expect(await fs.readFile(path.join(marketplaceRoot, artifactPath))).toEqual(bytes);
    expect(await fs.readFile(path.join(marketplaceRoot, '.claude-plugin/plugin.json')))
      .toEqual(await fs.readFile(path.join(root, 'dist/claude-code/plugin/.claude-plugin/plugin.json')));
  });

  it('combines multiple validated primary Plugins into stable Marketplace subdirectories', async () => {
    /** 多主单元测试使用的临时物化工作目录。 */
    const root = await temporaryProject();
    /** 暴露 Marketplace Distribution Hook 的 Claude Code Platform。 */
    const platform = claudeCode({ marketplace: {} });
    /** 使用真实 Core Registry 创建带完整 owner/hash 的主单元。 */
    const units = new DeliveryUnitRegistry(new Map());
    /** 输入顺序故意与 ID 排序相反的第二个 Plugin。 */
    const beta = await units.add(platform.id, {
      id: 'plugin-b', role: 'primary', type: 'plugin',
      artifacts: [bytesArtifact(PLUGIN_MANIFEST_PATH, stableJson({
        name: 'beta-tools', version: '2.0.0', description: 'Beta tools.',
      }))],
    });
    /** 排序后应出现在 Marketplace 第一项的 Plugin。 */
    const alpha = await units.add(platform.id, {
      id: 'plugin-a', role: 'primary', type: 'plugin',
      artifacts: [
        bytesArtifact(PLUGIN_MANIFEST_PATH, stableJson({
          name: 'alpha-tools', version: '1.0.0', description: 'Alpha tools.',
        })),
        bytesArtifact('assets/readme.txt', 'alpha asset'),
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
    expect(marketplace.plugins.map((plugin: { name: string; source: string }) => [plugin.name, plugin.source])).toEqual([
      ['alpha-tools', './plugins/plugin-a'],
      ['beta-tools', './plugins/plugin-b'],
    ]);
    expect(distribution.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'plugins/plugin-a/.claude-plugin/plugin.json' }),
      expect.objectContaining({ path: 'plugins/plugin-a/assets/readme.txt' }),
      expect.objectContaining({ path: 'plugins/plugin-b/.claude-plugin/plugin.json' }),
    ]));
  });

  it('requires both search and network capabilities before granting WebSearch', async () => {
    /** 包含三种能力组合的 Agent 工程。 */
    const root = await temporaryProject();
    await fs.mkdir(path.join(root, 'src/agents'), { recursive: true });
    await fs.writeFile(path.join(root, 'src/agents/search-only.md'), `---
description: Search local files.
capabilities:
  - search
---
Search local files.
`);
    await fs.writeFile(path.join(root, 'src/agents/network-only.md'), `---
description: Fetch remote content.
capabilities:
  - network
---
Fetch remote content.
`);
    await fs.writeFile(path.join(root, 'src/agents/web-search.md'), `---
description: Search the web.
capabilities:
  - search
  - network
---
Search the web.
`);
    /** 完成能力到 Claude 工具约束映射的构建结果。 */
    const result = await run(resolvedConfig(root, 'build', claudeCode()));
    /** 三个 Agent 共用的最终输出目录。 */
    const agentsRoot = path.join(root, 'dist/claude-code/plugin/agents');
    /** 只有本地检索能力的 Agent Frontmatter。 */
    const searchOnly = await fs.readFile(path.join(agentsRoot, 'search-only.md'), 'utf8');
    /** 只有联网读取能力的 Agent Frontmatter。 */
    const networkOnly = await fs.readFile(path.join(agentsRoot, 'network-only.md'), 'utf8');
    /** 同时具有检索和联网能力的 Agent Frontmatter。 */
    const webSearch = await fs.readFile(path.join(agentsRoot, 'web-search.md'), 'utf8');

    expect(result.success).toBe(true);
    expect(searchOnly).toContain('tools: Glob, Grep');
    expect(searchOnly).not.toContain('WebSearch');
    expect(networkOnly).toContain('tools: WebFetch');
    expect(networkOnly).not.toContain('WebSearch');
    expect(webSearch).toContain('tools: Glob, Grep, WebFetch, WebSearch');
  });

  it('rejects invalid Component fields and unsafe Extension references with stable diagnostics', async () => {
    /** 包含未知 Claude Code Command 字段的工程。 */
    const root = await temporaryProject();
    await fs.mkdir(path.join(root, 'src/commands'), { recursive: true });
    await fs.writeFile(path.join(root, 'src/commands/unsafe.md'), `---
description: Unsafe command.
platforms:
  claude-code:
    rawFrontmatter: true
---
Do work.
`);
    /** Scanner 阶段应拒绝未知平台字段的生命周期结果。 */
    const invalidFields = await run(resolvedConfig(root, 'validate', claudeCode()));

    expect(invalidFields.success).toBe(false);
    expect(invalidFields.diagnostics).toContainEqual(expect.objectContaining({
      code: 'CLAUDE_COMPONENT_FIELD_UNKNOWN',
      fieldPath: ['platforms', 'claude-code', 'rawFrontmatter'],
    }));

    await fs.rm(path.join(root, 'src/commands'), { recursive: true });
    /** 尝试让 Manifest 引用安装根外路径的恶意 Adapter。 */
    const unsafeExtension = defineExtension({
      name: 'unsafe-reference',
      apiVersion: '1',
      /** discover 返回资源以确保不安全 Adapter 会进入当前 Platform。 */
      discover: () => true,
      adapters: [{
        extensionApiVersion: '1',
        platform: claudeCode().id,
        platformApiVersion: '1',
        /** apply 注入应被 Platform 最终 Validator 拒绝的路径。 */
        apply(context) {
          context.patchDocument({ document: 'plugin-manifest', path: ['mcpServers'], value: '../outside.json' });
        },
      }],
    });
    /** 已进入最终候选 Validator 的不安全引用结果。 */
    const unsafeReference = await run(resolvedConfig(root, 'validate', claudeCode(), [unsafeExtension]));

    expect(unsafeReference.success).toBe(false);
    expect(unsafeReference.deliveryUnits).toEqual([]);
    expect(unsafeReference.diagnostics).toContainEqual(expect.objectContaining({
      code: 'CLAUDE_MANIFEST_REFERENCE_UNSAFE', fieldPath: ['mcpServers'],
    }));
  });

  it('validates referenced Hook configuration at the final Platform boundary', async () => {
    /** 不含 Core Component、只由恶意 Extension 注入 Hook 配置的工程。 */
    const root = await temporaryProject();
    /** 模拟绕过正式 Hooks Extension 并贡献无效 command Handler 的第三方 Adapter。 */
    const extension = defineExtension({
      name: 'invalid-claude-hooks',
      apiVersion: '1',
      /** discover 返回资源以触发 Adapter。 */
      discover: () => true,
      adapters: [{
        extensionApiVersion: '1',
        platform: claudeCode().id,
        platformApiVersion: '1',
        /** apply 只能贡献候选，最终是否符合 Claude Code 协议由 Platform 决定。 */
        apply(context) {
          context.patchDocument({ document: 'plugin-manifest', path: ['hooks'], value: './hooks/hooks.json' });
          context.emitArtifact(bytesArtifact('hooks/hooks.json', stableJson({
            hooks: {
              PreToolUse: [{ matcher: '[', hooks: [{ type: 'command', command: '' }] }],
              SessionStart: [{ hooks: [{ type: 'prompt', prompt: 'Unsupported here.' }] }],
            },
          })));
        },
      }],
    });
    /** 最终候选应在提交前同时暴露 matcher 与 command 内容错误。 */
    const result = await run(resolvedConfig(root, 'build', claudeCode(), [extension]));

    expect(result.success).toBe(false);
    expect(result.committed).toBe(false);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'CLAUDE_HOOK_MATCHER_INVALID' }),
      expect.objectContaining({ code: 'CLAUDE_HOOK_HANDLER_TARGET_INVALID' }),
      expect.objectContaining({ code: 'CLAUDE_HOOK_HANDLER_EVENT_UNSUPPORTED' }),
    ]));
  });

  /** Claude Code Hook 官方契约核验日期：2026-08-06。 */
  it('accepts the latest official Claude Code Hook handler schema', async () => {
    /** 只由测试 Adapter 注入完整官方 Handler 矩阵的空工程。 */
    const root = await temporaryProject();
    /** 覆盖 command、prompt、agent、http 与 mcp_tool 最新字段的 Extension。 */
    const extension = defineExtension({
      name: 'current-claude-hooks',
      apiVersion: '1',
      /** discover 返回资源以触发 Adapter。 */
      discover: () => true,
      adapters: [{
        extensionApiVersion: '1',
        platform: claudeCode().id,
        platformApiVersion: '1',
        /** apply 贡献由 Platform 最终 Validator 独立验证的官方 Schema。 */
        apply(context) {
          context.patchDocument({ document: 'plugin-manifest', path: ['hooks'], value: './hooks/hooks.json' });
          context.emitArtifact(bytesArtifact('hooks/hooks.json', stableJson({
            description: 'Complete current Hook schema.',
            hooks: {
              PreToolUse: [{
                matcher: 'Bash',
                hooks: [
                  {
                    type: 'command', command: 'node', args: ['handler.mjs'], shell: 'bash',
                    if: 'git rev-parse --is-inside-work-tree', timeout: 5, statusMessage: 'Checking',
                    once: true, async: true, asyncRewake: true,
                  },
                  { type: 'prompt', prompt: 'Check input', model: 'sonnet', if: 'true', once: true },
                  { type: 'agent', prompt: 'Investigate input', model: 'sonnet', if: 'true', once: true },
                  {
                    type: 'http', url: 'http://localhost:7777/hook', headers: { Authorization: 'Bearer token' },
                    allowedEnvVars: ['HOOK_TOKEN'], if: 'true', once: true,
                  },
                  {
                    type: 'mcp_tool', server: 'review-server', tool: 'review',
                    if: 'true', once: true,
                  },
                ],
              }],
              SessionEnd: [{
                hooks: [
                  { type: 'http', url: 'http://localhost:7777/session-end' },
                  { type: 'mcp_tool', server: 'review-server', tool: 'session-end' },
                ],
              }],
              SessionStart: [{
                hooks: [{ type: 'mcp_tool', server: 'review-server', tool: 'session-start' }],
              }],
            },
          })));
        },
      }],
    });
    /** 最新字段均应在最终平台边界通过。 */
    const result = await run(resolvedConfig(root, 'build', claudeCode(), [extension]));

    expect(result.success).toBe(true);
    expect(result.diagnostics).toEqual([]);
  });

  it('rejects unknown factory options instead of accepting raw Marketplace fields', () => {
    expect(() => claudeCode({ marketplace: { name: 'Bad Name' } })).toThrow('lowercase kebab-case');
    expect(() => claudeCode({ marketplace: { raw: true } } as never)).toThrow('Unknown Claude Code marketplace option');
    expect(() => claudeCode({ compiler: 'custom' } as never)).toThrow('Unknown Claude Code Platform option');
  });

  it('rejects permissionMode because packaged Plugin Agents cannot enforce it', async () => {
    /** 包含宿主会忽略的 Agent 权限模式字段的工程。 */
    const root = await temporaryProject();
    await fs.mkdir(path.join(root, 'src/agents'), { recursive: true });
    await fs.writeFile(path.join(root, 'src/agents/reviewer.md'), `---
description: Review code changes.
platforms:
  claude-code:
    permissionMode: plan
---
Review code.
`);
    /** Scanner 阶段必须拒绝无法由安装式 Plugin 保真的字段。 */
    const result = await run(resolvedConfig(root, 'validate', claudeCode()));

    expect(result.success).toBe(false);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: 'CLAUDE_COMPONENT_FIELD_UNKNOWN',
      fieldPath: ['platforms', 'claude-code', 'permissionMode'],
    }));
  });
});
