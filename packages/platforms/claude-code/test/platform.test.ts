import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  resolveKernelConfig,
  runKernelBuildSession,
  type ConfigCommand,
} from '@acplugin/core';
import { defineExtension, type AcpluginExtension } from '@tokenroll/acplugin/sdk';
import { claudeCode } from '../src/index.js';
import { MARKETPLACE_MANIFEST_PATH, PLUGIN_MANIFEST_PATH } from '../src/package/manifest.js';

/** 测试结束后统一删除的临时工程根。 */
const temporaryRoots: string[] = [];

/** Golden 文件相对于当前测试模块的固定目录。 */
const goldenRoot = path.join(import.meta.dirname, 'golden');

/** 创建带最小配置占位符且会自动清理的临时工程。 */
async function temporaryProject(): Promise<string> {
  /** root 是当前测试独占的工程根。 */
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-claude-platform-'));
  temporaryRoots.push(root);
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'acplugin.config.ts'), 'export default {}\n');
  return root;
}

/** 写入覆盖 canonical Component、Public 与内建 Runtime 的完整工程。 */
async function writeCompleteProject(root: string): Promise<void> {
  await fs.mkdir(path.join(root, 'src/commands'), { recursive: true });
  await fs.mkdir(path.join(root, 'src/skills/review/references'), { recursive: true });
  await fs.mkdir(path.join(root, 'src/agents'), { recursive: true });
  await fs.mkdir(path.join(root, 'src/runtime'), { recursive: true });
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
  await fs.writeFile(path.join(root, 'src/runtime/cli.ts'), 'process.stdout.write("runtime-ready\\n");\n');
  await fs.writeFile(path.join(root, 'public/shared/logo.bin'), Buffer.from([0, 1, 2, 255]));
}

/** 执行一次只包含 Claude Code 的真实 Kernel v2 BuildSession。 */
async function run(input: {
  readonly root: string;
  readonly command?: ConfigCommand;
  readonly platform?: ReturnType<typeof claudeCode>;
  readonly extensions?: readonly AcpluginExtension[];
  readonly commit?: boolean;
}) {
  /** command 同时控制报告语义，commit 只在 build 时实际生效。 */
  const command = input.command ?? 'build';
  /** resolved 使用与公开 Project API 相同的严格配置边界。 */
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
    platforms: [input.platform ?? claudeCode()],
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
    config: resolved.config!,
    frameworkVersion: 'test',
    commit: command === 'build' && (input.commit ?? true),
  })).report;
}

/** 对比构建结果和仓库内确定性 Golden 字节。 */
async function expectGolden(actual: string, golden: string): Promise<void> {
  await expect(fs.readFile(actual)).resolves.toEqual(await fs.readFile(path.join(goldenRoot, golden)));
}

/** 创建通过 add-only Package Contribution 注入最终清单字段的测试 Extension。 */
function wireExtension(input: {
  readonly id: string;
  readonly field?: 'hooks' | 'mcpServers';
  readonly value?: string;
  readonly path?: string;
  readonly bytes?: string;
}): AcpluginExtension {
  return defineExtension({
    id: input.id,
    apiVersion: '1',
    resourceRoots: [],
    /** 测试 Session 最小实现 discover/validate/build/contribute 四段契约。 */
    createSession: () => ({
      /** 空对象足以标记当前 Fixture 本轮已发现。 */
      discover: () => ({}),
      /** 每个 Fixture 声明一个必须由 Contributor 完整覆盖的 tuple。 */
      validate: (_context, discovered) => ({
        state: discovered,
        subjects: [{ subject: `fixture:${input.id}`, capabilities: ['delivery'] }],
      }),
      /** 需要文件时只通过 owner-scoped AssetService 创建字节。 */
      async build({ assets }, validated) {
        /** asset 只在当前 Extension owner scope 中签发。 */
        const asset = input.path === undefined
          ? undefined
          : await assets.fromBytes({
              bytes: input.bytes ?? '{}\n',
              origin: { operation: 'wire-fixture', subjects: [`fixture:${input.id}`] },
            });
        return { state: { validated, ...(asset === undefined ? {} : { asset }) } };
      },
      contributors: [{
        platform: 'claude-code',
        platformApiVersion: '1',
        /** Contributor 只占用一个声明点并可追加自己的 Asset。 */
        contribute: (_context, built) => ({
          ...(input.field === undefined || input.value === undefined
            ? {}
            : { documentFields: [{ document: 'plugin-manifest', path: [input.field], value: input.value }] }),
          ...(built.asset === undefined ? {} : { assets: [{ path: input.path!, asset: built.asset }] }),
          compatibility: [{
            subject: `fixture:${input.id}`,
            capability: 'delivery',
            level: 'native',
            reason: 'The fixture is delivered through a declared Claude Code extension point.',
          }],
        }),
      }],
    }),
  });
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe('Claude Code Platform Package API', () => {
  it('builds native Components, Public, Core Runtime, metadata, and deterministic Documents', async () => {
    /** root 承载当前完整能力测试的隔离工程。 */
    const root = await temporaryProject();
    await writeCompleteProject(root);
    /** report 来自真实 build 与受管事务提交。 */
    const report = await run({ root, platform: claudeCode({ defaultEnabled: false }) });
    /** output 是事务提交后的主 Plugin 根。 */
    const output = path.join(root, 'dist/claude-code/plugin');

    expect(report.success, JSON.stringify(report.diagnostics, null, 2)).toBe(true);
    expect(report.committed).toBe(true);
    expect(report.packages).toHaveLength(1);
    expect(report.compatibility).toEqual(expect.arrayContaining([
      expect.objectContaining({ subject: 'command:release', capability: 'component', level: 'native' }),
      expect.objectContaining({ subject: 'skill:review', capability: 'component', level: 'native' }),
      expect.objectContaining({ subject: 'agent:reviewer', capability: 'component', level: 'native' }),
      expect.objectContaining({ subject: 'runtime:cli', capability: 'node20-esm', level: 'native' }),
    ]));
    expect(report.metadata).toContainEqual(expect.objectContaining({ field: 'author.email', disposition: 'emitted' }));
    await expectGolden(path.join(output, PLUGIN_MANIFEST_PATH), PLUGIN_MANIFEST_PATH);
    await expectGolden(path.join(output, 'commands/release.md'), 'commands/release.md');
    await expectGolden(path.join(output, 'skills/review/SKILL.md'), 'skills/review/SKILL.md');
    await expectGolden(path.join(output, 'agents/reviewer.md'), 'agents/reviewer.md');
    await expect(fs.readFile(path.join(output, 'skills/review/references/checklist.md'), 'utf8')).resolves.toBe('Review checklist.\n');
    await expect(fs.readFile(path.join(output, 'shared/logo.bin'))).resolves.toEqual(Buffer.from([0, 1, 2, 255]));
    await expect(fs.readFile(path.join(output, 'runtime/cli/main.mjs'), 'utf8')).resolves.toContain('runtime-ready');
    expect(report.packages[0]?.assets.find(asset => asset.path === 'runtime/cli/main.mjs')).toMatchObject({
      owner: 'framework:node-runtime', mode: 0o755, origin: { type: 'compile', profile: 'portable-node' },
    });
  });

  it('lets independent Extensions add only declared Hooks and MCP fields and Assets', async () => {
    /** root 不含 canonical Component，只验证两个 add-only extension points。 */
    const root = await temporaryProject();
    /** hooks 独占 hooks 字段和对应配置文件。 */
    const hooks = wireExtension({
      id: 'hooks-fixture', field: 'hooks', value: './hooks/hooks.json', path: 'hooks/hooks.json',
      bytes: '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"node runner.mjs"}]}]}}\n',
    });
    /** mcp 独占 mcpServers 字段和对应配置文件。 */
    const mcp = wireExtension({
      id: 'mcp-fixture', field: 'mcpServers', value: './.mcp.json', path: '.mcp.json',
      bytes: '{"mcpServers":{}}\n',
    });
    /** report 必须同时保留两个 Extension 的真实 Asset owner。 */
    const report = await run({ root, extensions: [hooks, mcp] });
    /** manifest 是经过 Core 集中 contribution 合并后序列化的 Document。 */
    const manifest = JSON.parse(await fs.readFile(path.join(root, 'dist/claude-code/plugin', PLUGIN_MANIFEST_PATH), 'utf8'));

    expect(report.success, JSON.stringify(report.diagnostics, null, 2)).toBe(true);
    expect(manifest).toMatchObject({ hooks: './hooks/hooks.json', mcpServers: './.mcp.json' });
    expect(report.packages[0]?.assets).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'hooks/hooks.json', owner: 'extension:hooks-fixture' }),
      expect.objectContaining({ path: '.mcp.json', owner: 'extension:mcp-fixture' }),
    ]));
  });

  it('creates a self-contained Marketplace by inheriting validated primary AssetRefs byte-for-byte', async () => {
    /** root 提供足够多的 Asset 类型验证完整继承。 */
    const root = await temporaryProject();
    await writeCompleteProject(root);
    /** platform 开启唯一可选 Distribution。 */
    const platform = claudeCode({ marketplace: {} });
    /** first 用于建立确定性报告和字节基线。 */
    const first = await run({ root, platform });
    /** firstDistribution 保存首次构建的完整分发报告。 */
    const firstDistribution = first.packages.find(unit => unit.id === 'marketplace')!;
    /** primary 与 distribution 使用相同 AssetRef，因此报告 hash/origin 必须一致。 */
    const primary = first.packages.find(unit => unit.id === 'plugin')!;
    /** second 使用相同输入验证完整事务替换不改变字节。 */
    const second = await run({ root, platform });
    /** marketplaceRoot 是第二次原子替换后的最终分发目录。 */
    const marketplaceRoot = path.join(root, 'dist/claude-code/marketplace');

    expect(first.success, JSON.stringify(first.diagnostics, null, 2)).toBe(true);
    expect(second.success, JSON.stringify(second.diagnostics, null, 2)).toBe(true);
    await expectGolden(path.join(marketplaceRoot, MARKETPLACE_MANIFEST_PATH), MARKETPLACE_MANIFEST_PATH);
    await expect(fs.readFile(path.join(marketplaceRoot, PLUGIN_MANIFEST_PATH))).resolves.toEqual(
      await fs.readFile(path.join(root, 'dist/claude-code/plugin', PLUGIN_MANIFEST_PATH)),
    );
    for (const source of primary.assets) {
      expect(firstDistribution.assets.find(asset => asset.path === source.path)).toMatchObject({
        owner: source.owner, mode: source.mode, sha256: source.sha256, origin: source.origin,
      });
    }
    expect(second.packages.find(unit => unit.id === 'marketplace')?.assets).toEqual(firstDistribution.assets);
  });

  it('maps WebSearch only when portable Agent capabilities include search and network', async () => {
    /** root 包含三种能力组合以验证组合授权规则。 */
    const root = await temporaryProject();
    await fs.mkdir(path.join(root, 'src/agents'), { recursive: true });
    await fs.writeFile(path.join(root, 'src/agents/search-only.md'), '---\ndescription: Search local files.\ncapabilities: [search]\n---\nSearch.\n');
    await fs.writeFile(path.join(root, 'src/agents/network-only.md'), '---\ndescription: Fetch remote content.\ncapabilities: [network]\n---\nFetch.\n');
    await fs.writeFile(path.join(root, 'src/agents/web-search.md'), '---\ndescription: Search the web.\ncapabilities: [search, network]\n---\nSearch.\n');
    /** report 确认三项 Agent 都完成 native 交付。 */
    const report = await run({ root });
    /** agentsRoot 包含三个能力组合的原生 Agent 文档。 */
    const agentsRoot = path.join(root, 'dist/claude-code/plugin/agents');
    /** searchOnly 不应仅凭本地检索能力得到 WebSearch。 */
    const searchOnly = await fs.readFile(path.join(agentsRoot, 'search-only.md'), 'utf8');
    /** networkOnly 不应仅凭联网读取能力得到 WebSearch。 */
    const networkOnly = await fs.readFile(path.join(agentsRoot, 'network-only.md'), 'utf8');
    /** webSearch 同时具备两个必要 capability。 */
    const webSearch = await fs.readFile(path.join(agentsRoot, 'web-search.md'), 'utf8');

    expect(report.success).toBe(true);
    expect(searchOnly).toContain('tools: Glob, Grep');
    expect(searchOnly).not.toContain('WebSearch');
    expect(networkOnly).toContain('tools: WebFetch');
    expect(networkOnly).not.toContain('WebSearch');
    expect(webSearch).toContain('tools: Glob, Grep, WebFetch, WebSearch');
  });

  it('rejects invalid Component namespaces before Package creation', async () => {
    /** root 中的未知字段必须在 canonical validation 阶段失败。 */
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
    /** report 不应包含任何已建立的 Package。 */
    const report = await run({ root, command: 'validate', commit: false });

    expect(report.success).toBe(false);
    expect(report.packages).toEqual([]);
    expect(report.diagnostics).toContainEqual(expect.objectContaining({
      code: 'CLAUDE_COMPONENT_FIELD_UNKNOWN',
      fieldPath: ['platforms', 'claude-code', 'rawFrontmatter'],
    }));
  });

  it('rejects unsafe Extension references and invalid Hook wire data at the final candidate boundary', async () => {
    /** unsafeRoot 验证路径逃逸不会越过最终候选校验。 */
    const unsafeRoot = await temporaryProject();
    /** unsafe 只贡献恶意引用，不创建逃逸目标。 */
    const unsafe = await run({
      root: unsafeRoot,
      command: 'validate',
      extensions: [wireExtension({ id: 'unsafe-reference', field: 'mcpServers', value: '../outside.json' })],
      commit: false,
    });
    expect(unsafe.success).toBe(false);
    expect(unsafe.diagnostics).toContainEqual(expect.objectContaining({
      code: 'CLAUDE_MANIFEST_REFERENCE_UNSAFE', fieldPath: ['mcpServers'], phase: 'platform-validate',
    }));

    /** hookRoot 独立验证已存在文件的 wire schema。 */
    const hookRoot = await temporaryProject();
    /** invalidHook 缺少 command handler 的必填 command。 */
    const invalidHook = await run({
      root: hookRoot,
      command: 'validate',
      extensions: [wireExtension({
        id: 'invalid-hook', field: 'hooks', value: './hooks/hooks.json', path: 'hooks/hooks.json',
        bytes: '{"hooks":{"SessionStart":[{"hooks":[{"type":"command"}]}]}}\n',
      })],
      commit: false,
    });
    expect(invalidHook.success).toBe(false);
    expect(invalidHook.diagnostics).toContainEqual(expect.objectContaining({
      code: 'CLAUDE_HOOK_HANDLER_TARGET_INVALID', phase: 'platform-validate',
    }));

    /** mcpRoot 验证容器合法时仍会深入拒绝非法 Server 字段。 */
    const mcpRoot = await temporaryProject();
    /** invalidMcp 的 headers 不是 Claude Code 协议要求的字符串映射。 */
    const invalidMcp = await run({
      root: mcpRoot,
      command: 'validate',
      extensions: [wireExtension({
        id: 'invalid-mcp', field: 'mcpServers', value: './.mcp.json', path: '.mcp.json',
        bytes: '{"mcpServers":{"docs":{"type":"http","url":"https://example.com/mcp","headers":42}}}\n',
      })],
      commit: false,
    });
    expect(invalidMcp.success).toBe(false);
    expect(invalidMcp.diagnostics).toContainEqual(expect.objectContaining({
      code: 'CLAUDE_MCP_HEADERS_INVALID', phase: 'platform-validate',
    }));

    /** orphanRoot 不修改 Manifest，只投递 Claude 会自动发现的根 `.mcp.json`。 */
    const orphanRoot = await temporaryProject();
    /** 非法 orphan 文件必须经过与显式引用相同的深层 wire 校验。 */
    const orphanMcp = await run({
      root: orphanRoot,
      command: 'validate',
      extensions: [wireExtension({
        id: 'orphan-mcp', path: '.mcp.json',
        bytes: '{"mcpServers":{"docs":{"type":"http","url":"https://user:pass@example.com/mcp","junk":true}}}\n',
      })],
      commit: false,
    });
    expect(orphanMcp.success).toBe(false);
    expect(orphanMcp.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'CLAUDE_MCP_FIELD_UNKNOWN', phase: 'platform-validate' }),
      expect.objectContaining({ code: 'CLAUDE_MCP_URL_INVALID', phase: 'platform-validate' }),
    ]));
  });

  it('validates and defensively copies Platform options at the factory boundary', () => {
    expect(() => claudeCode({ defaultEnabled: 'yes' as never })).toThrow(/defaultEnabled/u);
    expect(() => claudeCode({ marketplace: { name: 'Not-Kebab' } })).toThrow(/lowercase kebab-case/u);
    /** input 在工厂返回后继续可变，最终 Platform options 必须保持原快照。 */
    const input = { marketplace: { tags: ['tools'] } };
    /** platform 必须复制 input 而不是保留作者对象 identity。 */
    const platform = claudeCode(input);
    input.marketplace.tags.push('mutated');
    expect(platform.options).toEqual({ marketplace: { tags: ['tools'] } });
    expect(Object.isFrozen((platform.options as { marketplace: object }).marketplace)).toBe(true);
  });
});
