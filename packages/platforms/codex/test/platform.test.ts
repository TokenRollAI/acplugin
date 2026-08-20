import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  defineExtension,
  resolveKernelConfig,
  runKernelBuildSession,
  type AcpluginExtension,
  type ConfigCommand,
} from '@acplugin/core';
import { codex } from '../src/index.js';
import { MARKETPLACE_MANIFEST_PATH, PLUGIN_MANIFEST_PATH } from '../src/package/manifest.js';

/** 测试结束后统一删除的临时工程根。 */
const temporaryRoots: string[] = [];

/** Golden 文件相对于当前测试模块的固定目录。 */
const goldenRoot = path.join(import.meta.dirname, 'golden');

/** 创建带最小配置占位符且会自动清理的临时工程。 */
async function temporaryProject(): Promise<string> {
  /** root 是当前测试独占工程根。 */
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-codex-platform-'));
  temporaryRoots.push(root);
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'acplugin.config.ts'), 'export default {}\n');
  return root;
}

/** 写入原生 Skill、转换 Command、Public branding 和 Core Runtime。 */
async function writeSupportedProject(root: string): Promise<void> {
  await fs.mkdir(path.join(root, 'src/commands'), { recursive: true });
  await fs.mkdir(path.join(root, 'src/skills/review/references'), { recursive: true });
  await fs.mkdir(path.join(root, 'src/runtime'), { recursive: true });
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
  await fs.writeFile(path.join(root, 'src/runtime/cli.ts'), 'process.stdout.write("runtime-ready\\n");\n');
  await fs.writeFile(path.join(root, 'public/assets/logo.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" fill="#10A37F"/></svg>\n');
}

/** 执行一次只包含 Codex 的真实 Kernel v2 BuildSession。 */
async function run(input: {
  readonly root: string;
  readonly command?: ConfigCommand;
  readonly platform?: ReturnType<typeof codex>;
  readonly extensions?: readonly AcpluginExtension[];
  readonly commit?: boolean;
}) {
  /** command 决定 lifecycle 语义，commit 只允许 build 使用。 */
  const command = input.command ?? 'build';
  /** resolved 使用公开 Project API 的相同 config resolver。 */
  const resolved = resolveKernelConfig({
    name: 'release-tools',
    version: '1.2.3',
    description: 'Release workflow tools.',
    displayName: 'Release Tools',
    author: { name: 'TokenRoll', email: 'maintainers@example.com', url: 'https://github.com/TokenRollAI' },
    homepage: 'https://example.com/release-tools',
    repository: 'https://github.com/TokenRollAI/release-tools',
    license: 'MIT',
    keywords: ['release', 'review'],
    platforms: [input.platform ?? codex()],
    extensions: input.extensions ?? [],
    build: { outDir: 'dist', strict: true },
  }, {
    projectRoot: input.root,
    configFile: path.join(input.root, 'acplugin.config.ts'),
    command,
    mode: 'production',
  });
  expect(resolved.diagnostics).toEqual([]);
  return (await runKernelBuildSession({
    config: resolved.config!, frameworkVersion: 'test',
    commit: command === 'build' && (input.commit ?? true),
  })).report;
}

/** 对比构建结果和仓库内确定性 Golden 字节。 */
async function expectGolden(actual: string, golden: string): Promise<void> {
  await expect(fs.readFile(actual)).resolves.toEqual(await fs.readFile(path.join(goldenRoot, golden)));
}

/** 创建向 Codex Package add-only 贡献一个资源的测试 Extension。 */
function contributionExtension(input: {
  readonly id: string;
  readonly field?: 'hooks' | 'mcpServers';
  readonly value?: string;
  readonly path: string;
  readonly bytes: string;
}): AcpluginExtension {
  return defineExtension({
    id: input.id,
    apiVersion: '1',
    resourceRoots: [],
    /** Session 覆盖完整 Resource 与 Contributor 生命周期。 */
    createSession: () => ({
      /** 空对象标记 Fixture 本轮已发现。 */
      discover: () => ({}),
      /** tuple 用于验证贡献的兼容性覆盖。 */
      validate: (_context, state) => ({
        state, subjects: [{ subject: `fixture:${input.id}`, capabilities: ['delivery'] }],
      }),
      /** bytes 只通过 Extension owner-scoped AssetService 签发。 */
      async build({ assets }, state) {
        return { state: {
          state,
          asset: await assets.fromBytes({
            bytes: input.bytes,
            origin: { operation: 'codex-fixture', subjects: [`fixture:${input.id}`] },
          }),
        } };
      },
      contributors: [{
        platform: 'codex',
        platformApiVersion: '1',
        /** Contributor 只能占用声明点、追加 Asset 并覆盖自己的 tuple。 */
        contribute: (_context, built) => ({
          ...(input.field === undefined
            ? {}
            : {
                documentFields: [{ document: 'plugin-manifest', path: [input.field], value: input.value! }],
              }),
          assets: [{ path: input.path, asset: built.asset }],
          compatibility: [{
            subject: `fixture:${input.id}`, capability: 'delivery', level: 'native',
            reason: 'The fixture is delivered through the Codex Package contribution contract.',
          }],
        }),
      }],
    }),
  });
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe('Codex Platform Package API', () => {
  it('builds Skill, plugin-prefixed Command, Public, Runtime, metadata, and current protocol goldens', async () => {
    /** root 包含 Codex 首期全部严格可接受能力。 */
    const root = await temporaryProject();
    await writeSupportedProject(root);
    /** platform 配置完整官方安装 interface。 */
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
    /** report 来自真实 build 和受管事务。 */
    const report = await run({ root, platform });
    /** output 是 Codex 主 Plugin 根。 */
    const output = path.join(root, 'dist/codex/plugin');

    expect(report.success, JSON.stringify(report.diagnostics, null, 2)).toBe(true);
    expect(report.committed).toBe(true);
    expect(report.compatibility).toEqual(expect.arrayContaining([
      expect.objectContaining({ subject: 'skill:review', capability: 'component', level: 'native' }),
      expect.objectContaining({
        subject: 'command:release', capability: 'component', level: 'transform',
        transformation: 'explicit-skill:release-tools-release',
      }),
      expect.objectContaining({ subject: 'runtime:cli', capability: 'node20-esm', level: 'native' }),
    ]));
    expect(report.metadata).toContainEqual(expect.objectContaining({
      field: 'displayName', disposition: 'emitted',
    }));
    await expectGolden(path.join(output, PLUGIN_MANIFEST_PATH), PLUGIN_MANIFEST_PATH);
    await expectGolden(path.join(output, 'skills/review/SKILL.md'), 'skills/review/SKILL.md');
    await expectGolden(path.join(output, 'skills/review/agents/openai.yaml'), 'skills/review/agents/openai.yaml');
    await expectGolden(path.join(output, 'skills/release-tools-release/SKILL.md'), 'skills/release-tools-release/SKILL.md');
    await expectGolden(path.join(output, 'skills/release-tools-release/agents/openai.yaml'), 'skills/release-tools-release/agents/openai.yaml');
    await expect(fs.access(path.join(output, 'skills/command-release/SKILL.md'))).rejects.toThrow();
    await expect(fs.readFile(path.join(output, 'skills/review/references/checklist.md'), 'utf8')).resolves.toBe('Review checklist.\n');
    await expect(fs.readFile(path.join(output, 'runtime/cli/main.mjs'), 'utf8')).resolves.toContain('runtime-ready');
    expect(report.packages[0]?.assets.find(asset => asset.path === 'runtime/cli/main.mjs')).toMatchObject({
      owner: 'framework:node-runtime', mode: 0o755, origin: { type: 'compile', profile: 'portable-node' },
    });
  });

  it('rejects native/generated and generated/generated Skill namespace collisions before Package creation', async () => {
    /** nativeRoot 让 native Skill 占用默认 generated Command ID。 */
    const nativeRoot = await temporaryProject();
    await fs.mkdir(path.join(nativeRoot, 'src/commands'), { recursive: true });
    await fs.mkdir(path.join(nativeRoot, 'src/skills/release-tools-release'), { recursive: true });
    await fs.writeFile(path.join(nativeRoot, 'src/commands/release.md'), '---\ndescription: Release.\n---\nRelease.\n');
    await fs.writeFile(path.join(nativeRoot, 'src/skills/release-tools-release/SKILL.md'),
      '---\ndescription: Existing Skill.\n---\nExisting.\n');
    /** nativeCollision 必须在 Asset 签发和 Package finalization 前失败。 */
    const nativeCollision = await run({ root: nativeRoot, command: 'validate', commit: false });
    expect(nativeCollision.success).toBe(false);
    expect(nativeCollision.packages).toEqual([]);
    expect(nativeCollision.diagnostics).toContainEqual(expect.objectContaining({
      code: 'CODEX_GENERATED_SKILL_ID_COLLISION', phase: 'package',
    }));

    /** generatedRoot 让 Agent fallback 与 native Skill 占用同一固定 agent 前缀 ID。 */
    const generatedRoot = await temporaryProject();
    await fs.mkdir(path.join(generatedRoot, 'src/agents'), { recursive: true });
    await fs.mkdir(path.join(generatedRoot, 'src/skills/agent-reviewer'), { recursive: true });
    await fs.writeFile(path.join(generatedRoot, 'src/agents/reviewer.md'), '---\ndescription: Review.\n---\nReview.\n');
    await fs.writeFile(path.join(generatedRoot, 'src/skills/agent-reviewer/SKILL.md'),
      '---\ndescription: Existing Skill.\n---\nExisting.\n');
    /** generatedCollision 使用与 native/Command 相同的命名空间检查。 */
    const generatedCollision = await run({ root: generatedRoot, command: 'validate', commit: false });
    expect(generatedCollision.success).toBe(false);
    expect(generatedCollision.diagnostics).toContainEqual(expect.objectContaining({
      code: 'CODEX_GENERATED_SKILL_ID_COLLISION', phase: 'package',
    }));
  });

  it('reports actual argumentHint loss and Agent fallback through final strictness', async () => {
    /** commandRoot 只声明一个存在 UI 损失的 argumentHint。 */
    const commandRoot = await temporaryProject();
    await fs.mkdir(path.join(commandRoot, 'src/commands'), { recursive: true });
    await fs.writeFile(path.join(commandRoot, 'src/commands/deploy.md'), `---
description: Deploy an environment.
argumentHint: <environment>
---
Deploy {{arguments}}.
`);
    /** commandReport 应保留完整降级 tuple 并由 strict 阻止成功。 */
    const commandReport = await run({ root: commandRoot, command: 'validate', commit: false });
    expect(commandReport.success).toBe(false);
    expect(commandReport.compatibility).toContainEqual(expect.objectContaining({
      subject: 'command:deploy', capability: 'argument-hint', level: 'degraded',
    }));
    expect(commandReport.diagnostics).toContainEqual(expect.objectContaining({ code: 'COMPATIBILITY_STRICT_FAILURE' }));

    /** agentRoot 只包含 Codex 无法原生注册的 Agent。 */
    const agentRoot = await temporaryProject();
    await fs.mkdir(path.join(agentRoot, 'src/agents'), { recursive: true });
    await fs.writeFile(path.join(agentRoot, 'src/agents/reviewer.md'), `---
description: Review changes.
model: capable
capabilities: [filesystem:read, search]
---
Review.
`);
    /** strictReport 证明降级先进入报告再执行 strict。 */
    const strictReport = await run({ root: agentRoot, command: 'validate', commit: false });
    /** relaxedReport 允许交付 guidance-only Skill。 */
    const relaxedReport = await run({ root: agentRoot, platform: codex({ strict: false }) });
    expect(strictReport.success).toBe(false);
    expect(strictReport.compatibility).toContainEqual(expect.objectContaining({
      subject: 'agent:reviewer', capability: 'component', level: 'degraded',
    }));
    expect(relaxedReport.success, JSON.stringify(relaxedReport.diagnostics, null, 2)).toBe(true);
    await expect(fs.readFile(path.join(agentRoot, 'dist/codex/plugin/skills/agent-reviewer/SKILL.md'), 'utf8'))
      .resolves.toContain('Intended model class: capable.');
  });

  it('lets Hooks and MCP Extensions use only declared add-only points and validates final wire data', async () => {
    /** root 需要至少一个合法 Skill 作为 Extension host。 */
    const root = await temporaryProject();
    await fs.mkdir(path.join(root, 'src/skills/host'), { recursive: true });
    await fs.writeFile(path.join(root, 'src/skills/host/SKILL.md'), '---\ndescription: Host.\n---\nHost.\n');
    /** hooks 提供最终平台 validator 可接受的 wire schema。 */
    const hooks = contributionExtension({
      id: 'hooks-fixture', field: 'hooks', value: './hooks/hooks.json', path: 'hooks/hooks.json',
      bytes: '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"node hook.mjs"}]}]}}\n',
    });
    /** mcp 提供固定 manifest 引用目标。 */
    const mcp = contributionExtension({
      id: 'mcp-fixture', field: 'mcpServers', value: './.mcp.json', path: '.mcp.json',
      bytes: '{"docs":{"url":"https://developers.openai.com/mcp"}}\n',
    });
    /** valid 验证集中合并和最终引用检查。 */
    const valid = await run({ root, extensions: [hooks, mcp] });
    /** manifest 是 Core codec 序列化后的最终 Document。 */
    const manifest = JSON.parse(await fs.readFile(path.join(root, 'dist/codex/plugin', PLUGIN_MANIFEST_PATH), 'utf8'));
    expect(valid.success, JSON.stringify(valid.diagnostics, null, 2)).toBe(true);
    expect(manifest).toMatchObject({ hooks: './hooks/hooks.json', mcpServers: './.mcp.json' });

    /** invalidRoot 隔离最终 Hook timeout protocol 错误。 */
    const invalidRoot = await temporaryProject();
    await fs.mkdir(path.join(invalidRoot, 'src/skills/host'), { recursive: true });
    await fs.writeFile(path.join(invalidRoot, 'src/skills/host/SKILL.md'), '---\ndescription: Host.\n---\nHost.\n');
    /** invalidHook 的 SessionEnd timeout 超出 Codex 三秒上限。 */
    const invalidHook = contributionExtension({
      id: 'invalid-hook', field: 'hooks', value: './hooks/hooks.json', path: 'hooks/hooks.json',
      bytes: '{"hooks":{"SessionEnd":[{"hooks":[{"type":"command","command":"node hook.mjs","timeout":4}]}]}}\n',
    });
    /** invalid 必须在 candidate validator 阶段失败。 */
    const invalid = await run({ root: invalidRoot, command: 'validate', extensions: [invalidHook], commit: false });
    expect(invalid.success).toBe(false);
    expect(invalid.diagnostics).toContainEqual(expect.objectContaining({
      code: 'CODEX_HOOK_TIMEOUT_LIMIT', phase: 'platform-validate',
    }));
  });

  it('creates a policy-aware Marketplace by inheriting validated primary AssetRefs byte-for-byte', async () => {
    /** root 包含 Component、Public 和 Runtime 三类 inherited Asset。 */
    const root = await temporaryProject();
    await writeSupportedProject(root);
    /** platform 配置 Marketplace 安装策略和缺省分类。 */
    const platform = codex({
      interface: { category: 'Developer Tools' },
      marketplace: { policy: { installation: 'INSTALLED_BY_DEFAULT' } },
    });
    /** first 提供确定性和继承报告基线。 */
    const first = await run({ root, platform });
    /** primary 是已通过完整 Codex validator 的主 Package。 */
    const primary = first.packages.find(unit => unit.id === 'plugin')!;
    /** distribution 应复用 primary 的每个 AssetRef。 */
    const distribution = first.packages.find(unit => unit.id === 'marketplace')!;
    /** second 验证同输入的完整事务替换保持确定性。 */
    const second = await run({ root, platform });
    /** marketplaceRoot 是最终分发根。 */
    const marketplaceRoot = path.join(root, 'dist/codex/marketplace');

    expect(first.success, JSON.stringify(first.diagnostics, null, 2)).toBe(true);
    expect(second.success, JSON.stringify(second.diagnostics, null, 2)).toBe(true);
    await expectGolden(path.join(marketplaceRoot, MARKETPLACE_MANIFEST_PATH), MARKETPLACE_MANIFEST_PATH);
    await expect(fs.readFile(path.join(marketplaceRoot, PLUGIN_MANIFEST_PATH))).resolves.toEqual(
      await fs.readFile(path.join(root, 'dist/codex/plugin', PLUGIN_MANIFEST_PATH)),
    );
    for (const source of primary.assets) {
      expect(distribution.assets.find(asset => asset.path === source.path)).toMatchObject({
        owner: source.owner, mode: source.mode, sha256: source.sha256, origin: source.origin,
      });
    }
    expect(second.packages.find(unit => unit.id === 'marketplace')?.assets).toEqual(distribution.assets);
  });

  it('validates factory and Component fields without ID strategy or raw schema escape hatches', async () => {
    expect(() => codex({ raw: true } as never)).toThrow('Unknown Codex Platform option');
    expect(() => codex({ generatedSkillIds: { command: 'plugin-prefixed' } } as never)).toThrow('Unknown Codex Platform option');
    expect(() => codex({ interface: { displayName: 'duplicate' } } as never)).toThrow('Unknown Codex interface option');
    expect(() => codex({ interface: { websiteURL: 'https://user:secret@example.com' } })).toThrow('without credentials');
    expect(() => codex({ marketplace: { policy: { installation: 'UNKNOWN' } } } as never)).toThrow('not supported');

    /** root 的非法 Skill icon path 必须在 Component validation 阶段失败。 */
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
    /** report 应保留规范 namespace fieldPath。 */
    const report = await run({ root, command: 'validate', commit: false });
    expect(report.success).toBe(false);
    expect(report.diagnostics).toContainEqual(expect.objectContaining({
      code: 'CODEX_COMPONENT_FIELD_INVALID', fieldPath: ['platforms', 'codex', 'iconSmall'],
    }));
  });

  it('rejects invalid Extension Skill, missing Skill icon, and malformed branding at candidate boundary', async () => {
    /** skillRoot 的 Extension 追加无 Frontmatter Skill。 */
    const skillRoot = await temporaryProject();
    await fs.mkdir(path.join(skillRoot, 'src/skills/host'), { recursive: true });
    await fs.writeFile(path.join(skillRoot, 'src/skills/host/SKILL.md'), '---\ndescription: Host.\n---\nHost.\n');
    /** invalidSkill 不占 Document 字段，只追加协议错误的 Skill。 */
    const invalidSkill = contributionExtension({
      id: 'invalid-skill', path: 'skills/invalid-extension/SKILL.md', bytes: 'missing frontmatter\n',
    });
    /** skillReport 必须在最终 validator 阶段失败。 */
    const skillReport = await run({ root: skillRoot, command: 'validate', extensions: [invalidSkill], commit: false });
    expect(skillReport.diagnostics).toContainEqual(expect.objectContaining({ code: 'CODEX_SKILL_FRONTMATTER_INVALID' }));

    /** iconRoot 声明安全但不存在的 Skill-local icon。 */
    const iconRoot = await temporaryProject();
    await fs.mkdir(path.join(iconRoot, 'src/skills/icon-test'), { recursive: true });
    await fs.writeFile(path.join(iconRoot, 'src/skills/icon-test/SKILL.md'), `---
description: Validate Skill metadata assets.
platforms:
  codex:
    iconSmall: ./assets/missing.png
---
Validate.
`);
    /** iconReport 由最终 Skill metadata 引用检查拒绝。 */
    const iconReport = await run({ root: iconRoot, command: 'validate', commit: false });
    expect(iconReport.diagnostics).toContainEqual(expect.objectContaining({ code: 'CODEX_SKILL_ASSET_MISSING' }));

    /** brandingRoot 包含扩展名和内容都不匹配的公开资源。 */
    const brandingRoot = await temporaryProject();
    await fs.mkdir(path.join(brandingRoot, 'src/skills/branding'), { recursive: true });
    await fs.mkdir(path.join(brandingRoot, 'public/assets'), { recursive: true });
    await fs.writeFile(path.join(brandingRoot, 'src/skills/branding/SKILL.md'), '---\ndescription: Branding.\n---\nBranding.\n');
    await fs.writeFile(path.join(brandingRoot, 'public/assets/not-an-image.bin'), Buffer.from([0, 1, 2, 255]));
    /** brandingReport 验证实际候选字节而不是只验证安全路径。 */
    const brandingReport = await run({
      root: brandingRoot, command: 'validate',
      platform: codex({ interface: { logo: './assets/not-an-image.bin' } }), commit: false,
    });
    expect(brandingReport.diagnostics).toContainEqual(expect.objectContaining({
      code: 'CODEX_BRANDING_IMAGE_FORMAT_UNSUPPORTED',
    }));
  });

  it('rejects malformed MCP wire data at the final candidate boundary', async () => {
    /** root 没有其他资源，错误只来自 Extension 贡献的最终 MCP 配置。 */
    const root = await temporaryProject();
    await fs.mkdir(path.join(root, 'src/skills/host'), { recursive: true });
    await fs.writeFile(path.join(root, 'src/skills/host/SKILL.md'), '---\ndescription: Host fixture.\n---\nHost.\n');
    /** malformed 的 HTTP headers 不是字符串映射，并包含未确认字段。 */
    const malformed = contributionExtension({
      id: 'invalid-mcp', field: 'mcpServers', value: './.mcp.json', path: '.mcp.json',
      bytes: '{"docs":{"url":"https://example.com/mcp","http_headers":42,"extra":true}}\n',
    });
    /** report 必须保留 Codex 最终候选 validator 的细粒度诊断。 */
    const report = await run({ root, command: 'validate', extensions: [malformed], commit: false });

    expect(report.success).toBe(false);
    expect(report.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'CODEX_MCP_HEADERS_INVALID', phase: 'platform-validate' }),
      expect.objectContaining({ code: 'CODEX_MCP_FIELD_UNKNOWN', phase: 'platform-validate' }),
    ]));
  });

  it('strictly rejects malformed SVG XML and dimensions with units', async () => {
    /** fixtures 覆盖 XML 未闭合和带单位尺寸两个严格拒绝分支。 */
    const fixtures = [
      ['unclosed.svg', '<svg viewBox="0 0 48 48">'],
      ['unit-size.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="48px" height="48px"></svg>'],
    ] as const;
    for (const [fileName, source] of fixtures) {
      /** root 隔离当前不合法 SVG。 */
      const root = await temporaryProject();
      await fs.mkdir(path.join(root, 'src/skills/branding'), { recursive: true });
      await fs.mkdir(path.join(root, 'public/assets'), { recursive: true });
      await fs.writeFile(path.join(root, 'src/skills/branding/SKILL.md'), '---\ndescription: Branding.\n---\nBranding.\n');
      await fs.writeFile(path.join(root, 'public/assets', fileName), source);
      /** report 必须由严格 XML/尺寸解析失败。 */
      const report = await run({
        root, command: 'validate', platform: codex({ interface: { logo: `./assets/${fileName}` } }), commit: false,
      });
      expect(report.diagnostics).toContainEqual(expect.objectContaining({ code: 'CODEX_BRANDING_IMAGE_DECODE_FAILED' }));
    }
  });
});
