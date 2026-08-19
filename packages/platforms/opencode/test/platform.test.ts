import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  resolveKernelConfig,
  runKernelBuildSession,
} from '@acplugin/core';
import {
  defineExtension,
  type AcpluginExtension,
  type BytesAssetRef,
  type JsonValue,
} from '@tokenroll/acplugin/sdk';
import { openCode } from '../src/index.js';
import { WORKSPACE_CONFIG_PATH } from '../src/config-document.js';

/** 测试结束后统一删除的临时工程根目录。 */
const temporaryRoots: string[] = [];

/** OpenCode 配置 Golden 的固定目录。 */
const goldenRoot = path.join(import.meta.dirname, 'golden');

/** 创建包含最小配置占位符且登记清理的工程。 */
async function temporaryProject(): Promise<string> {
  /** 当前用例独占的工程根目录。 */
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-opencode-platform-'));
  temporaryRoots.push(root);
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'acplugin.config.ts'), 'export default {}\n');
  return root;
}

/** 写入 OpenCode 三类原生 workspace Component 与 Skill 辅助文件。 */
async function writeCompleteProject(root: string): Promise<void> {
  await fs.mkdir(path.join(root, 'src/commands'), { recursive: true });
  await fs.mkdir(path.join(root, 'src/skills/review/references'), { recursive: true });
  await fs.mkdir(path.join(root, 'src/agents'), { recursive: true });
  await fs.writeFile(path.join(root, 'src/commands/release.md'), '---\ndescription: Prepare a release.\n---\nPrepare release {{arguments}}.\n');
  await fs.writeFile(path.join(root, 'src/skills/review/SKILL.md'), '---\ndescription: Review a change.\n---\nReview the change.\n');
  await fs.writeFile(path.join(root, 'src/skills/review/references/checklist.md'), 'Review checklist.\n');
  await fs.writeFile(path.join(root, 'src/agents/reviewer.md'), `---
description: Review code.
model: inherit
capabilities: [filesystem:read, search]
---
Review code.
`);
}

/** 执行只包含 OpenCode 的真实 Kernel v2 BuildSession。 */
async function run(input: {
  readonly root: string;
  readonly platform?: ReturnType<typeof openCode>;
  readonly extensions?: readonly AcpluginExtension[];
  readonly command?: 'validate' | 'inspect' | 'build';
  readonly commit?: boolean;
}) {
  /** command 决定生命周期语义，commit 只允许 build 使用。 */
  const command = input.command ?? 'build';
  /** resolved 使用公开配置相同的 Kernel resolver。 */
  const resolved = resolveKernelConfig({
    name: 'release-tools',
    version: '1.2.3',
    description: 'Release workflow tools.',
    public: false,
    platforms: [input.platform ?? openCode({ workspace: { schema: true } })],
    extensions: input.extensions ?? [],
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

/** 创建占用 `workspace-config.mcp` 且可追加一个根 Asset 的测试 Extension。 */
function mcpContribution(input: {
  readonly id: string;
  readonly value: JsonValue;
  readonly asset?: { readonly path: string; readonly bytes: string; readonly mode?: 0o644 | 0o755 };
}): AcpluginExtension {
  return defineExtension<Record<string, never>, Record<string, never>, Record<string, never>, { readonly asset?: BytesAssetRef }>({
    id: input.id,
    apiVersion: '1',
    options: {},
    resourceRoots: [],
    /** 每轮创建独立且不读取其他 Extension state 的 Session。 */
    createSession: () => ({
      /** 空状态表示 Fixture 已发现。 */
      discover: () => ({}),
      /** capability 声明要求 Contributor 完整覆盖。 */
      validate: (_context, state) => ({
        state,
        subjects: [{ subject: `fixture:${input.id}`, capabilities: ['delivery'] }],
      }),
      /** 可选 bytes 只通过 owner-scoped Asset Service 签发。 */
      async build({ assets }) {
        if (input.asset === undefined)
          return { state: {} };
        /** asset 是 Contributor 后续唯一能追加的受管引用。 */
        const asset = await assets.fromBytes({
          bytes: input.asset.bytes,
          mode: input.asset.mode ?? 0o644,
          origin: { operation: 'opencode-fixture', subjects: [`fixture:${input.id}`] },
        });
        return { state: { asset } };
      },
      contributors: [{
        platform: 'opencode',
        platformApiVersion: '1',
        /** Contributor 只填 MCP 声明点并可追加自己拥有的 Asset。 */
        contribute: (_context, built) => ({
          documentFields: [{ document: 'workspace-config', path: ['mcp'], value: input.value }],
          ...(input.asset === undefined || built.asset === undefined
            ? {}
            : { assets: [{ path: input.asset.path, asset: built.asset }] }),
          compatibility: [{
            subject: `fixture:${input.id}`,
            capability: 'delivery',
            level: 'native',
            reason: 'The fixture is delivered through the OpenCode Package contribution contract.',
          }],
        }),
      }],
    }),
  });
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe('OpenCode Platform Package API', () => {
  it('builds a first-class workspace Package with native Components and config golden', async () => {
    /** root 覆盖全部原生 workspace Resources。 */
    const root = await temporaryProject();
    await writeCompleteProject(root);
    /** report 来自同一 Package lifecycle 和受管事务。 */
    const report = await run({ root });
    /** output 是 workspace overlay 根而非 Plugin root。 */
    const output = path.join(root, 'dist/opencode/workspace');
    /** discovered 模拟 OpenCode 对标准 workspace 目录的资源发现。 */
    const discovered = (await fs.readdir(path.join(output, '.opencode'), { recursive: true }))
      .map(entry => String(entry).split(path.sep).join('/'))
      .filter(entry => entry.endsWith('.md'))
      .sort();

    expect(report.success, JSON.stringify(report.diagnostics, null, 2)).toBe(true);
    expect(report.packages).toContainEqual(expect.objectContaining({
      platform: 'opencode', id: 'workspace', type: 'workspace', role: 'primary', validated: true,
    }));
    await expect(fs.readFile(path.join(output, WORKSPACE_CONFIG_PATH))).resolves.toEqual(
      await fs.readFile(path.join(goldenRoot, WORKSPACE_CONFIG_PATH)),
    );
    expect(discovered).toEqual([
      'agents/reviewer.md',
      'commands/release.md',
      'skills/review/SKILL.md',
      'skills/review/references/checklist.md',
    ]);
    await expect(fs.readFile(path.join(output, '.opencode/commands/release.md'), 'utf8')).resolves.toContain('$ARGUMENTS');
    await expect(fs.readFile(path.join(output, '.opencode/agents/reviewer.md'), 'utf8')).resolves.toContain('permission:');
    await expect(fs.access(path.join(output, 'package.json'))).rejects.toThrow();
    await expect(fs.access(path.join(output, '.cursor-plugin'))).rejects.toThrow();
    expect(report.compatibility).toEqual(expect.arrayContaining([
      expect.objectContaining({ subject: 'command:release', capability: 'component', level: 'native' }),
      expect.objectContaining({ subject: 'skill:review', capability: 'component', level: 'native' }),
      expect.objectContaining({ subject: 'agent:reviewer', capability: 'agent.capabilities', level: 'transform' }),
    ]));
    expect(report.metadata).toContainEqual(expect.objectContaining({ field: 'name', disposition: 'omitted' }));
  });

  it('does not materialize an empty workspace config', async () => {
    /** root 没有 Component，默认 Platform 选项也不产生配置字段。 */
    const root = await temporaryProject();
    /** report 仍创建有效但为空的 workspace Package。 */
    const report = await run({ root, platform: openCode() });

    expect(report.success, JSON.stringify(report.diagnostics, null, 2)).toBe(true);
    expect(report.packages).toContainEqual(expect.objectContaining({ id: 'workspace', assets: [] }));
    await expect(fs.access(path.join(root, 'dist/opencode/workspace/opencode.json'))).rejects.toThrow();
  });

  it('accepts remote/local MCP contribution and validates local Asset references', async () => {
    /** root 可为空，MCP Contribution 会让 omit-if-empty Document 实际物化。 */
    const root = await temporaryProject();
    /** mcp 同时覆盖安全 remote URL 和候选内 local server。 */
    const mcp = mcpContribution({
      id: 'mcp-fixture',
      value: {
        docs: { type: 'remote', url: 'https://example.com/mcp', enabled: true },
        local: { type: 'local', command: ['node', './.opencode/mcp/local/server.mjs'], enabled: true },
      },
      asset: { path: '.opencode/mcp/local/server.mjs', bytes: 'process.exit(0);\n', mode: 0o755 },
    });
    /** report 必须通过 Core merge 与最终 OpenCode wire validation。 */
    const report = await run({ root, extensions: [mcp] });
    /** config 是 Core JSON codec 产生的最终对象。 */
    const config = JSON.parse(await fs.readFile(path.join(root, 'dist/opencode/workspace/opencode.json'), 'utf8'));

    expect(report.success, JSON.stringify(report.diagnostics, null, 2)).toBe(true);
    expect(config).toHaveProperty('mcp.local.command.1', './.opencode/mcp/local/server.mjs');
    expect(report.packages[0]?.assets).toContainEqual(expect.objectContaining({
      path: '.opencode/mcp/local/server.mjs', owner: 'extension:mcp-fixture',
    }));
  });

  it('rejects MCP point collisions and malformed merged wire data', async () => {
    /** collisionRoot 的两个 Extension 无序占用同一个精确 Document point。 */
    const collisionRoot = await temporaryProject();
    /** first 和 second 的 ID 不影响冲突结果。 */
    const first = mcpContribution({ id: 'first-mcp', value: { first: { type: 'remote', url: 'https://example.com/first' } } });
    /** second 占用相同 workspace-config.mcp 字段。 */
    const second = mcpContribution({ id: 'second-mcp', value: { second: { type: 'remote', url: 'https://example.com/second' } } });
    /** collision 必须由 Core merge 拒绝而不是依赖 Extension 顺序。 */
    const collision = await run({ root: collisionRoot, command: 'validate', extensions: [first, second], commit: false });
    expect(collision.diagnostics).toContainEqual(expect.objectContaining({
      code: 'PLATFORM_CONTRIBUTION_FAILED', platform: 'opencode', phase: 'contribute',
    }));

    /** malformedRoot 的 local command 逃逸且没有候选 Asset。 */
    const malformedRoot = await temporaryProject();
    /** malformed 仍是 JSON object，因此必须由细粒度 wire validator 拒绝。 */
    const malformed = mcpContribution({
      id: 'malformed-mcp',
      value: { local: { type: 'local', command: ['node', '../escape.mjs'] } },
    });
    /** malformedReport 保留最终 Platform 诊断。 */
    const malformedReport = await run({ root: malformedRoot, command: 'validate', extensions: [malformed], commit: false });
    expect(malformedReport.diagnostics).toContainEqual(expect.objectContaining({
      code: 'OPENCODE_MCP_LOCAL_ENTRY_INVALID', platform: 'opencode', phase: 'platform-validate',
    }));

    /** 最终 validator 必须把 Server ID、两段 command、固定 suffix 和 0755 mode 绑定为一体。 */
    const hostileCases = [
      {
        id: 'wrong-id',
        value: { local: { type: 'local', command: ['node', './.opencode/mcp/other/server.mjs'] } },
        asset: { path: '.opencode/mcp/other/server.mjs', bytes: 'process.exit(0);\n', mode: 0o755 as const },
        code: 'OPENCODE_MCP_LOCAL_ENTRY_INVALID',
      },
      {
        id: 'wrong-suffix',
        value: { local: { type: 'local', command: ['node', './.opencode/mcp/local/server.js'] } },
        asset: { path: '.opencode/mcp/local/server.js', bytes: 'process.exit(0);\n', mode: 0o755 as const },
        code: 'OPENCODE_MCP_LOCAL_ENTRY_INVALID',
      },
      {
        id: 'extra-argument',
        value: { local: { type: 'local', command: ['node', './.opencode/mcp/local/server.mjs', '--unsafe'] } },
        asset: { path: '.opencode/mcp/local/server.mjs', bytes: 'process.exit(0);\n', mode: 0o755 as const },
        code: 'OPENCODE_MCP_LOCAL_COMMAND_INVALID',
      },
      {
        id: 'non-executable',
        value: { local: { type: 'local', command: ['node', './.opencode/mcp/local/server.mjs'] } },
        asset: { path: '.opencode/mcp/local/server.mjs', bytes: 'process.exit(0);\n', mode: 0o644 as const },
        code: 'OPENCODE_MCP_LOCAL_ENTRY_INVALID',
      },
    ] as const;
    for (const hostile of hostileCases) {
      /** 每个 hostile Contribution 使用独立候选，证明失败不依赖冲突顺序。 */
      const root = await temporaryProject();
      /** Extension 只使用公开 SDK 签发 Bytes Asset 和 Contribution。 */
      const report = await run({
        root,
        command: 'validate',
        extensions: [mcpContribution({ id: hostile.id, value: hostile.value, asset: hostile.asset })],
        commit: false,
      });
      expect(report.success).toBe(false);
      expect(report.diagnostics).toContainEqual(expect.objectContaining({
        code: hostile.code, platform: 'opencode', phase: 'platform-validate',
      }));
    }

    /** 已有 canonical Component Asset 也不能被借作某个 local MCP 的入口。 */
    const borrowedRoot = await temporaryProject();
    await writeCompleteProject(borrowedRoot);
    /** command 指向真实存在但不属于 MCP canonical path 的 Asset。 */
    const borrowed = await run({
      root: borrowedRoot,
      command: 'validate',
      extensions: [mcpContribution({
        id: 'borrowed-asset',
        value: { local: { type: 'local', command: ['node', './.opencode/commands/release.md'] } },
      })],
      commit: false,
    });
    expect(borrowed.diagnostics).toContainEqual(expect.objectContaining({
      code: 'OPENCODE_MCP_LOCAL_ENTRY_INVALID', platform: 'opencode', phase: 'platform-validate',
    }));

    /** remoteRoot 隔离验证 remote Server 的字段形状和未知字段。 */
    const remoteRoot = await temporaryProject();
    /** malformedRemote 同时包含非法 headers 与未确认字段。 */
    const malformedRemote = mcpContribution({
      id: 'malformed-remote-mcp',
      value: {
        docs: { type: 'remote', url: 'https://example.com/mcp', headers: 42, extra: true },
      },
    });
    /** remoteReport 必须保留两个稳定的最终 wire 诊断。 */
    const remoteReport = await run({ root: remoteRoot, command: 'validate', extensions: [malformedRemote], commit: false });
    expect(remoteReport.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'OPENCODE_MCP_HEADERS_INVALID', platform: 'opencode', phase: 'platform-validate' }),
      expect.objectContaining({ code: 'OPENCODE_MCP_FIELD_UNKNOWN', platform: 'opencode', phase: 'platform-validate' }),
    ]));
  });

  it('rejects generic package and Plugin manifest Assets in a workspace delivery', async () => {
    /** packageRoot 的 Extension 同时填合法 MCP 点并追加禁止的 package.json。 */
    const packageRoot = await temporaryProject();
    /** packageExtension 证明最终 validator 不依赖 Asset owner。 */
    const packageExtension = mcpContribution({
      id: 'package-injection',
      value: {},
      asset: { path: 'package.json', bytes: '{}\n' },
    });
    /** packageReport 必须在候选边界拒绝 Plugin/package 语义泄漏。 */
    const packageReport = await run({ root: packageRoot, command: 'validate', extensions: [packageExtension], commit: false });
    expect(packageReport.diagnostics).toContainEqual(expect.objectContaining({ code: 'OPENCODE_PACKAGE_JSON_FORBIDDEN' }));

    /** pluginRoot 的 Extension 追加另一个平台的 Manifest 路径。 */
    const pluginRoot = await temporaryProject();
    /** pluginExtension 不需要猜测 Plugin 内容，路径本身即越界。 */
    const pluginExtension = mcpContribution({
      id: 'plugin-injection',
      value: {},
      asset: { path: '.cursor-plugin/plugin.json', bytes: '{}\n' },
    });
    /** pluginReport 必须拒绝把 Workspace 伪装成安装型 Plugin。 */
    const pluginReport = await run({ root: pluginRoot, command: 'validate', extensions: [pluginExtension], commit: false });
    expect(pluginReport.diagnostics).toContainEqual(expect.objectContaining({ code: 'OPENCODE_PLUGIN_MANIFEST_FORBIDDEN' }));
  });

  it('reports unsupported Runtime without compiling or generating fake assets', async () => {
    /** Runtime import 若被编译必然失败，用于证明 capability 协商发生在 compile 前。 */
    const root = await temporaryProject();
    await fs.mkdir(path.join(root, 'src/runtime'), { recursive: true });
    await fs.writeFile(path.join(root, 'src/runtime/cli.ts'), 'import "missing-runtime-package";\n');
    /** relaxed 接受已明确报告的 Runtime capability 差异。 */
    const report = await run({ root, platform: openCode({ strict: false }) });

    expect(report.success, JSON.stringify(report.diagnostics, null, 2)).toBe(true);
    expect(report.runtimes).toEqual([{
      id: 'cli', kind: 'executable', location: { path: 'src/runtime/cli.ts' }, built: false,
    }]);
    expect(report.compatibility).toContainEqual(expect.objectContaining({
      platform: 'opencode', subject: 'runtime:cli', capability: 'node20-esm', level: 'unsupported',
    }));
    expect(report.packages.flatMap(unit => unit.assets).some(asset => asset.path.startsWith('runtime/'))).toBe(false);
  });

  it('rejects unknown Platform and Component fields without config escape hatches', async () => {
    expect(() => openCode({ workspace: { raw: true } } as never)).toThrow('Unknown OpenCode workspace option');
    expect(() => openCode({ config: {} } as never)).toThrow('Unknown OpenCode Platform option');
    /** root 的 namespace 包含未公开的 raw 字段。 */
    const root = await temporaryProject();
    await fs.mkdir(path.join(root, 'src/commands'), { recursive: true });
    await fs.writeFile(path.join(root, 'src/commands/invalid.md'), `---
description: Invalid field.
platforms:
  opencode:
    raw: true
---
Do not build.
`);
    /** report 应保留 canonical namespace fieldPath。 */
    const report = await run({ root, command: 'validate', commit: false });
    expect(report.diagnostics).toContainEqual(expect.objectContaining({
      code: 'OPENCODE_COMPONENT_FIELD_UNKNOWN', fieldPath: ['platforms', 'opencode', 'raw'],
    }));
  });
});
