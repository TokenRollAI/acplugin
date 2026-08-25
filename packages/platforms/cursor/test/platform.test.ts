import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  defineExtension,
  type AcpluginExtension,
  type JsonValue,
  type PlatformContributor,
} from '@acplugin/core';
import {
  resolveKernelConfig,
  runKernelBuildSession,
} from '@acplugin/core';
import { cursor, type CursorPackageComponent } from '../src/index.js';
import { PLUGIN_MANIFEST_PATH } from '../src/package/manifest.js';

/** 测试结束后统一删除的临时工程根目录。 */
const temporaryRoots: string[] = [];

/** Cursor 官方 Schema 与 Manifest Golden 的固定目录。 */
const goldenRoot = path.join(import.meta.dirname, 'golden');

/** 2026-08-13 从 Cursor 官方仓库重新核验的 Schema 内容摘要。 */
const CURSOR_SCHEMA_SHA256 = 'a393b758901803fcf5cfe0d77bda8a83e987d32c3377dfce2d9edf445af884ed';

/** Cursor 官方 Schema 的固定上游来源。 */
const CURSOR_SCHEMA_SOURCE = 'https://github.com/cursor/plugins/blob/main/schemas/plugin.schema.json';

/** 测试只读取的 Cursor Schema 最小结构。 */
interface CursorSchemaFixture {
  /** 官方 Schema 是否禁止未知根字段。 */
  readonly additionalProperties: boolean;
  /** 官方 Manifest 必填字段。 */
  readonly required: readonly string[];
  /** 官方 Manifest 根字段定义。 */
  readonly properties: Readonly<Record<string, { readonly pattern?: string }>>;
}

/** 创建已登记自动清理的规范工程。 */
async function createProject(): Promise<string> {
  /** 当前用例独占的工程根目录。 */
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-cursor-platform-'));
  temporaryRoots.push(root);
  await fs.mkdir(path.join(root, 'src/commands'), { recursive: true });
  await fs.mkdir(path.join(root, 'src/skills/review/references'), { recursive: true });
  await fs.mkdir(path.join(root, 'src/agents'), { recursive: true });
  await fs.mkdir(path.join(root, 'public/assets'), { recursive: true });
  await fs.writeFile(path.join(root, 'acplugin.config.ts'), 'export default {}\n');
  await fs.writeFile(path.join(root, 'src/commands/release.md'), '---\ndescription: Prepare a release.\n---\nPrepare release {{arguments}}.\n');
  await fs.writeFile(path.join(root, 'src/skills/review/SKILL.md'), '---\ndescription: Review a change.\n---\nReview the change.\n');
  await fs.writeFile(path.join(root, 'src/skills/review/references/checklist.md'), 'Review checklist.\n');
  await fs.writeFile(path.join(root, 'src/agents/reviewer.md'), '---\ndescription: Review code.\nmodel: inherit\ncapabilities:\n  - filesystem:read\n  - search\n---\nReview code.\n');
  await fs.writeFile(path.join(root, 'public/assets/logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>\n');
  return root;
}

/** 执行只包含 Cursor 的真实 Kernel v2 BuildSession。 */
async function run(input: {
  readonly root: string;
  readonly platform?: ReturnType<typeof cursor>;
  readonly extensions?: readonly AcpluginExtension[];
  readonly command?: 'validate' | 'inspect' | 'build';
  readonly commit?: boolean;
}) {
  /** command 决定生命周期语义，commit 只允许 build 使用。 */
  const command = input.command ?? 'build';
  /** config 覆盖 Cursor 官方 Schema 支持的统一和平台专属字段。 */
  const resolved = resolveKernelConfig({
    name: 'release-tools',
    version: '1.2.3',
    description: 'Release workflow tools.',
    displayName: 'Release Tools',
    author: { name: 'TokenRoll', email: 'maintainers@example.com' },
    homepage: 'https://example.com/release-tools',
    repository: 'https://github.com/TokenRollAI/release-tools',
    license: 'MIT',
    keywords: ['release', 'review'],
    platforms: [input.platform ?? cursor({
      publisher: 'TokenRoll',
      logo: './assets/logo.svg',
      category: 'Developer Tools',
      tags: ['release', 'automation'],
      minClientVersions: { cursor: '1.2.3' },
    })],
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

/** 用冻结 Schema 的根字段约束校验生成 Manifest。 */
function expectSchemaCompatible(manifest: Record<string, unknown>, schema: CursorSchemaFixture): void {
  expect(schema.additionalProperties).toBe(false);
  expect(Object.keys(manifest).every(field => Object.hasOwn(schema.properties, field))).toBe(true);
  expect(schema.required.every(field => Object.hasOwn(manifest, field))).toBe(true);
  /** namePattern 来自固定官方 Schema，而不是复制生产实现的规则。 */
  const namePattern = schema.properties.name?.pattern;
  expect(namePattern).toBeTypeOf('string');
  expect(String(manifest.name)).toMatch(new RegExp(namePattern!));
}

/** 创建向 Cursor 声明点 add-only 贡献配置和 Asset 的测试 Extension。 */
function contribution(input: {
  readonly id: string;
  readonly field: 'hooks' | 'mcpServers';
  readonly value: JsonValue;
  readonly path: string;
  readonly bytes: string;
}): AcpluginExtension {
  return defineExtension({
    id: input.id,
    apiVersion: '1',
    resourceRoots: [],
    /** 每轮创建无共享可变状态的测试 Session。 */
    createSession: () => ({
      /** 非 undefined 空对象表示当前 Fixture 已发现。 */
      discover: () => ({}),
      /** capability 声明要求 Contributor 完整覆盖。 */
      validate: (_context, state) => ({
        state,
        subjects: [{ subject: `fixture:${input.id}`, capabilities: ['delivery'] }],
      }),
      /** bytes 只通过 Extension owner-scoped Asset Service 签发。 */
      build: async ({ assets }, state) => ({
        state: {
          state,
          asset: await assets.fromBytes({
            bytes: input.bytes,
            origin: { operation: 'cursor-fixture', subjects: [`fixture:${input.id}`] },
          }),
        },
      }),
      contributors: [{
        platform: 'cursor',
        platformApiVersion: '1',
        /** Contributor 只填写声明点、追加自己的 Asset 并报告自己的 tuple。 */
        contribute: (_context, built) => ({
          documentFields: [{ document: 'plugin-manifest', path: [input.field], value: input.value }],
          assets: [{ path: input.path, asset: built.asset }],
          compatibility: [{
            subject: `fixture:${input.id}`,
            capability: 'delivery',
            level: 'native',
            reason: 'The fixture is delivered through the Cursor Package contribution contract.',
          }],
        }),
      }],
    }),
  });
}

/** 创建只由 Cursor Platform Component transport 交付 Native Agent 的中立 Extension。 */
function nativeAgentContribution(input: {
  readonly id: string;
  readonly agents: readonly Record<string, JsonValue>[];
}): AcpluginExtension {
  /** payload 类型只存在于 Cursor Platform 与其 Contributor 的边界。 */
  const contributor: PlatformContributor<Record<string, never>, CursorPackageComponent> = {
    platform: 'cursor',
    platformApiVersion: '1',
    contribute: () => ({
      components: input.agents.map(agent => ({
        subject: `fixture:${input.id}`,
        value: agent as CursorPackageComponent,
      })),
      compatibility: [{
        subject: `fixture:${input.id}`,
        capability: 'delivery',
        level: 'native',
        reason: 'The fixture is delivered as a native Cursor Subagent.',
      }],
    }),
  };
  return defineExtension({
    id: input.id,
    apiVersion: '1',
    resourceRoots: [],
    createSession: () => ({
      discover: () => ({}),
      validate: (_context, discovered) => ({
        state: discovered,
        subjects: [{ subject: `fixture:${input.id}`, capabilities: ['delivery'] }],
      }),
      build: (_context, validated) => ({ state: validated }),
      contributors: [contributor],
    }),
  });
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe('Cursor Platform Package API', () => {
  it('builds native Components, Public, metadata and the pinned official manifest golden', async () => {
    /** root 包含三类原生 Component 和清单引用的 Public logo。 */
    const root = await createProject();
    /** report 来自真实 Package lifecycle、候选校验和事务。 */
    const report = await run({ root });
    /** Cursor 官方 Schema 的冻结原始字节。 */
    const schemaBytes = await fs.readFile(path.join(goldenRoot, 'plugin.schema.json'));
    /** 从冻结 Fixture 解析出的官方 Schema。 */
    const schema = JSON.parse(schemaBytes.toString('utf8')) as CursorSchemaFixture;
    /** output 是 Cursor 主 Plugin 根。 */
    const output = path.join(root, 'dist/cursor/plugin');
    /** manifest 是 Core JSON codec 生成并通过最终 validator 的对象。 */
    const manifest = JSON.parse(await fs.readFile(path.join(output, PLUGIN_MANIFEST_PATH), 'utf8')) as Record<string, unknown>;

    expect(report.success, JSON.stringify(report.diagnostics, null, 2)).toBe(true);
    expect(report.committed).toBe(true);
    expect(report.compatibility).toEqual(expect.arrayContaining([
      expect.objectContaining({ subject: 'command:release', capability: 'component', level: 'native' }),
      expect.objectContaining({ subject: 'skill:review', capability: 'component', level: 'native' }),
      expect.objectContaining({ subject: 'agent:reviewer', capability: 'component', level: 'native' }),
    ]));
    expect(createHash('sha256').update(schemaBytes).digest('hex')).toBe(CURSOR_SCHEMA_SHA256);
    expect(CURSOR_SCHEMA_SOURCE).toContain('cursor/plugins');
    expectSchemaCompatible(manifest, schema);
    await expect(fs.readFile(path.join(output, PLUGIN_MANIFEST_PATH))).resolves.toEqual(
      await fs.readFile(path.join(goldenRoot, PLUGIN_MANIFEST_PATH)),
    );
    await expect(fs.readFile(path.join(output, 'commands/release.md'), 'utf8')).resolves.toContain('$ARGUMENTS');
    await expect(fs.readFile(path.join(output, 'skills/review/references/checklist.md'), 'utf8')).resolves.toBe('Review checklist.\n');
    await expect(fs.readFile(path.join(output, 'agents/reviewer.md'), 'utf8')).resolves.toContain('readonly: true');
  });

  it('reports unsupported Runtime without generating fake assets', async () => {
    /** Cursor 没有稳定 Plugin-local Node 契约，Runtime 只能显式 unsupported。 */
    const root = await createProject();
    await fs.mkdir(path.join(root, 'src/runtime'), { recursive: true });
    await fs.writeFile(path.join(root, 'src/runtime/cli.ts'), 'import "missing-runtime-package";\n');
    /** relaxed 只接受已报告的 capability 差异，不改变结构校验。 */
    const report = await run({ root, platform: cursor({ strict: false }) });

    expect(report.success, JSON.stringify(report.diagnostics, null, 2)).toBe(true);
    expect(report.runtimes).toEqual([{
      id: 'cli', kind: 'executable', location: { path: 'src/runtime/cli.ts' }, built: false,
    }]);
    expect(report.compatibility).toContainEqual(expect.objectContaining({
      platform: 'cursor', subject: 'runtime:cli', capability: 'node20-esm', level: 'unsupported',
    }));
    expect(report.packages.flatMap(unit => unit.assets).some(asset => asset.path.startsWith('runtime/'))).toBe(false);
    await expect(fs.access(path.join(root, 'dist/cursor/plugin/runtime'))).rejects.toThrow();
  });

  it('renders Platform-owned Native Agent contributions and records only trusted contributor provenance', async () => {
    /** 没有 canonical Agent 时，唯一 Agent 来自独立 Extension 的 private payload。 */
    const root = await createProject();
    await fs.rm(path.join(root, 'src/agents/reviewer.md'));
    const report = await run({
      root,
      extensions: [nativeAgentContribution({
        id: 'private-fixture',
        agents: [{ kind: 'native-agent', id: 'observer', description: 'Observe the project.', body: 'Observe.', readonly: true }],
      })],
    });
    const output = path.join(root, 'dist/cursor/plugin');
    const manifest = JSON.parse(await fs.readFile(path.join(output, PLUGIN_MANIFEST_PATH), 'utf8')) as Record<string, unknown>;
    const asset = report.packages[0]!.assets.find(candidate => candidate.path === 'agents/observer.md');

    expect(report.success, JSON.stringify(report.diagnostics, null, 2)).toBe(true);
    expect(manifest.agents).toBe('./agents/*.md');
    await expect(fs.readFile(path.join(output, 'agents/observer.md'), 'utf8')).resolves.toContain('readonly: true');
    expect(asset).toMatchObject({
      owner: 'platform:cursor',
      origin: { contributors: [{ owner: 'extension:private-fixture', subject: 'fixture:private-fixture' }] },
    });
    expect(report.packages[0]!.assets.find(candidate => candidate.path === PLUGIN_MANIFEST_PATH)).toMatchObject({
      origin: { contributors: [{ owner: 'extension:private-fixture', subject: 'fixture:private-fixture' }] },
    });
  });

  it('rejects malformed and colliding Native Agent contributions independently of Extension order', async () => {
    /** canonical 与 private Agent 共享 Cursor 的目标文件命名空间。 */
    const canonicalRoot = await createProject();
    const canonical = await run({
      root: canonicalRoot,
      command: 'validate',
      commit: false,
      extensions: [nativeAgentContribution({
        id: 'canonical-collision',
        agents: [{ kind: 'native-agent', id: 'reviewer', description: 'Duplicate.', body: 'Duplicate.' }],
      })],
    });
    expect(canonical.success).toBe(false);
    expect(canonical.diagnostics).toContainEqual(expect.objectContaining({
      code: 'CURSOR_COMPONENT_CONTRIBUTION_COLLISION', phase: 'finalize', platform: 'cursor',
    }));

    /** 未知 wire field 由 Cursor，而非 Core 或 Extension，进行最终 schema 拒绝。 */
    const malformedRoot = await createProject();
    await fs.rm(path.join(malformedRoot, 'src/agents/reviewer.md'));
    const malformed = await run({
      root: malformedRoot,
      command: 'validate',
      commit: false,
      extensions: [nativeAgentContribution({
        id: 'malformed-agent',
        agents: [{ kind: 'native-agent', id: 'invalid', description: 'Invalid.', body: 'Invalid.', unsupported: true }],
      })],
    });
    expect(malformed.success).toBe(false);
    expect(malformed.diagnostics).toContainEqual(expect.objectContaining({
      code: 'CURSOR_COMPONENT_CONTRIBUTION_INVALID', phase: 'finalize', platform: 'cursor',
    }));

    /** 两个 private Agent 使用同一稳定 ID 时，异常摘要不能依赖配置顺序。 */
    const ordered = [
      nativeAgentContribution({ id: 'zeta-fixture', agents: [{ kind: 'native-agent', id: 'same', description: 'Same.', body: 'Same.' }] }),
      nativeAgentContribution({ id: 'alpha-fixture', agents: [{ kind: 'native-agent', id: 'same', description: 'Same.', body: 'Same.' }] }),
    ];
    const firstRoot = await createProject();
    await fs.rm(path.join(firstRoot, 'src/agents/reviewer.md'));
    const first = await run({ root: firstRoot, command: 'validate', commit: false, extensions: ordered });
    const secondRoot = await createProject();
    await fs.rm(path.join(secondRoot, 'src/agents/reviewer.md'));
    const second = await run({ root: secondRoot, command: 'validate', commit: false, extensions: [...ordered].reverse() });
    expect(first.success).toBe(false);
    expect(second.success).toBe(false);
    expect(first.diagnostics).toEqual(second.diagnostics);
    expect(first.diagnostics).toContainEqual(expect.objectContaining({
      code: 'CURSOR_COMPONENT_CONTRIBUTION_COLLISION', phase: 'finalize', platform: 'cursor',
    }));
  });

  it('accepts Hooks/MCP add-only contributions and rejects duplicate point occupation', async () => {
    /** validRoot 验证两个独立声明点及最终引用闭包。 */
    const validRoot = await createProject();
    /** hooks 引用一个 Cursor 配置文件。 */
    const hooks = contribution({
      id: 'hooks-fixture', field: 'hooks', value: './hooks/hooks.json',
      path: 'hooks/hooks.json', bytes: '{"version":1,"hooks":{}}\n',
    });
    /** mcpServers 引用一个独立配置文件。 */
    const mcp = contribution({
      id: 'mcp-fixture', field: 'mcpServers', value: './mcp.json',
      path: 'mcp.json', bytes: '{"mcpServers":{}}\n',
    });
    /** valid 必须在集中合并后通过最终候选 validator。 */
    const valid = await run({ root: validRoot, extensions: [hooks, mcp] });
    /** manifest 精确观察 Core 合并后的两个字段。 */
    const manifest = JSON.parse(await fs.readFile(path.join(validRoot, 'dist/cursor/plugin', PLUGIN_MANIFEST_PATH), 'utf8'));
    expect(valid.success, JSON.stringify(valid.diagnostics, null, 2)).toBe(true);
    expect(manifest).toMatchObject({ hooks: './hooks/hooks.json', mcpServers: './mcp.json' });

    /** collisionRoot 隔离两个 Extension 同时占用 hooks 声明点。 */
    const collisionRoot = await createProject();
    /** secondHooks 使用不同 Asset 但占用完全相同的 Document path。 */
    const secondHooks = contribution({
      id: 'second-hooks', field: 'hooks', value: './hooks/second.json',
      path: 'hooks/second.json', bytes: '{"version":1,"hooks":{}}\n',
    });
    /** collision 必须由 Core merge 拒绝而不是依赖 Extension 执行顺序。 */
    const collision = await run({
      root: collisionRoot,
      command: 'validate',
      extensions: [hooks, secondHooks],
      commit: false,
    });
    expect(collision.success).toBe(false);
    expect(collision.diagnostics).toContainEqual(expect.objectContaining({
      code: 'PLATFORM_CONTRIBUTION_FAILED', platform: 'cursor', phase: 'contribute',
    }));
  });

  it('rejects malformed merged extension data at the final candidate boundary', async () => {
    /** root 包含合法 base Package，错误只来自贡献后的最终 wire data。 */
    const root = await createProject();
    /** malformed 将 hooks 填成官方 Schema 不接受的布尔值。 */
    const malformed = contribution({
      id: 'malformed-hooks', field: 'hooks', value: false,
      path: 'hooks/unused.json', bytes: '{}\n',
    });
    /** report 应保留 Cursor validator 的稳定诊断。 */
    const report = await run({ root, command: 'validate', extensions: [malformed], commit: false });

    expect(report.success).toBe(false);
    expect(report.diagnostics).toContainEqual(expect.objectContaining({
      code: 'CURSOR_EXTENSION_REFERENCE_INVALID', platform: 'cursor', phase: 'platform-validate',
    }));

    /** mcpRoot 验证合法 sidecar 容器中的嵌套 Server 字段。 */
    const mcpRoot = await createProject();
    /** invalidMcp 的 headers 不是 Cursor 协议要求的字符串映射。 */
    const invalidMcp = contribution({
      id: 'invalid-mcp', field: 'mcpServers', value: './mcp.json', path: 'mcp.json',
      bytes: '{"mcpServers":{"docs":{"url":"https://example.com/mcp","headers":42}}}\n',
    });
    /** mcpReport 必须由最终 Candidate validator 而不是 Contributor 自校验拒绝。 */
    const mcpReport = await run({ root: mcpRoot, command: 'validate', extensions: [invalidMcp], commit: false });
    expect(mcpReport.success).toBe(false);
    expect(mcpReport.diagnostics).toContainEqual(expect.objectContaining({
      code: 'CURSOR_MCP_HEADERS_INVALID', platform: 'cursor', phase: 'platform-validate',
    }));
  });

  it('validates factory options, Component fields and HTTPS/local logo boundaries', async () => {
    expect(() => cursor({ experimental: true } as never)).toThrow('Unknown Cursor Platform option');
    expect(() => cursor({ tags: ['duplicate', 'duplicate'] })).toThrow('unique');
    expect(() => cursor({ minClientVersions: { cursor: 'latest' } })).toThrow('semantic versions');

    /** componentRoot 的 raw Cursor namespace 必须在 Asset 创建前失败。 */
    const componentRoot = await createProject();
    await fs.writeFile(path.join(componentRoot, 'src/commands/release.md'), `---
description: Invalid platform field.
platforms:
  cursor:
    raw: true
---
Do not build.
`);
    /** componentReport 保留 canonical field path。 */
    const componentReport = await run({ root: componentRoot, command: 'validate', commit: false });
    expect(componentReport.diagnostics).toContainEqual(expect.objectContaining({
      code: 'CURSOR_COMPONENT_FIELD_UNKNOWN', fieldPath: ['platforms', 'cursor', 'raw'],
    }));

    /** httpsRoot 的无凭据 HTTPS logo 不要求候选中存在同名 Asset。 */
    const httpsRoot = await createProject();
    /** httpsReport 验证 URL 与本地引用是互斥分支。 */
    const httpsReport = await run({
      root: httpsRoot,
      platform: cursor({ logo: 'https://cdn.example.com/plugin/logo.svg' }),
    });
    expect(httpsReport.success, JSON.stringify(httpsReport.diagnostics, null, 2)).toBe(true);

    /** unsafe logo 候选必须各自得到稳定诊断而不是读取宿主路径。 */
    const fixtures = [
      ['file:///tmp/logo.svg', 'CURSOR_LOGO_URL_INVALID'],
      ['https://user:secret@example.com/logo.svg', 'CURSOR_LOGO_URL_INVALID'],
      ['/tmp/logo.svg', 'CURSOR_LOGO_PATH_INVALID'],
      ['C:\\temp\\logo.svg', 'CURSOR_LOGO_PATH_INVALID'],
      ['../../logo.svg', 'CURSOR_LOGO_PATH_INVALID'],
      ['./assets/missing.svg', 'CURSOR_LOGO_ASSET_MISSING'],
    ] as const;
    for (const [logo, code] of fixtures) {
      /** 当前 logo 使用独立工程，避免失败事务互相影响。 */
      const root = await createProject();
      /** report 必须在最终候选边界拒绝不可信引用。 */
      const report = await run({ root, command: 'validate', platform: cursor({ logo }), commit: false });
      expect(report.diagnostics).toContainEqual(expect.objectContaining({ code, platform: 'cursor', fieldPath: ['logo'] }));
    }
  });
});
