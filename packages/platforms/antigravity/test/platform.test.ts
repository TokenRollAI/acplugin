import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  defineExtension,
  resolveKernelConfig,
  runKernelBuildSession,
  type AcpluginExtension,
} from '@acplugin/core';
import { antigravity } from '../src/index.js';
import { PLUGIN_MANIFEST_PATH } from '../src/manifest.js';

/** 测试结束后统一删除的临时工程根目录。 */
const temporaryRoots: string[] = [];

/** 内部严格 Schema 和 Manifest Golden 的固定目录。 */
const goldenRoot = path.join(import.meta.dirname, 'golden');

/** 测试只读取的 Antigravity 内部 Schema 结构。 */
interface AntigravitySchemaFixture {
  /** 内部规则是否禁止未确认字段。 */
  readonly additionalProperties: boolean;
  /** 内部规则要求的最小字段。 */
  readonly required: readonly string[];
  /** 允许的唯一根字段定义。 */
  readonly properties: Readonly<Record<string, unknown>>;
}

/** 创建包含最小配置占位符且登记清理的工程。 */
async function temporaryProject(): Promise<string> {
  /** 当前用例独占的工程根目录。 */
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-antigravity-platform-'));
  temporaryRoots.push(root);
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'acplugin.config.ts'), 'export default {}\n');
  return root;
}

/** 写入原生 Skill、转换 Command、fallback Agent 和 Skill 辅助文件。 */
async function writeCompleteProject(root: string): Promise<void> {
  await fs.mkdir(path.join(root, 'src/commands'), { recursive: true });
  await fs.mkdir(path.join(root, 'src/skills/review/references'), { recursive: true });
  await fs.mkdir(path.join(root, 'src/agents'), { recursive: true });
  await fs.writeFile(path.join(root, 'src/commands/release.md'), `---
description: Prepare a release.
argumentHint: environment
---
Prepare release {{arguments}}.
`);
  await fs.writeFile(path.join(root, 'src/skills/review/SKILL.md'), '---\ndescription: Review a change.\n---\nReview the change.\n');
  await fs.writeFile(path.join(root, 'src/skills/review/references/checklist.md'), 'Review checklist.\n');
  await fs.writeFile(path.join(root, 'src/agents/reviewer.md'), `---
description: Review code.
model: capable
capabilities: [filesystem:read, search]
---
Review code.
`);
}

/** 执行只包含 Antigravity 的真实 Kernel v2 BuildSession。 */
async function run(input: {
  readonly root: string;
  readonly platform?: ReturnType<typeof antigravity>;
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
    platforms: [input.platform ?? antigravity()],
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

/** 创建向 Antigravity 根 Package 追加固定配置 Asset 的测试 Extension。 */
function rootContribution(input: {
  readonly id: string;
  readonly path: string;
  readonly bytes: string;
}): AcpluginExtension {
  return defineExtension({
    id: input.id,
    apiVersion: '1',
    resourceRoots: [],
    /** 每轮创建独立的测试 Session。 */
    createSession: () => ({
      /** 空状态表示 Fixture 已发现。 */
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
            origin: { operation: 'antigravity-fixture', subjects: [`fixture:${input.id}`] },
          }),
        },
      }),
      contributors: [{
        platform: 'antigravity',
        platformApiVersion: '1',
        /** Contributor 只追加自己的根 Asset 并覆盖自己的 tuple。 */
        contribute: (_context, built) => ({
          assets: [{ path: input.path, asset: built.asset }],
          compatibility: [{
            subject: `fixture:${input.id}`,
            capability: 'delivery',
            level: 'native',
            reason: 'The fixture is delivered through the Antigravity Package contribution contract.',
          }],
        }),
      }],
    }),
  });
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe('Antigravity Platform Package API', () => {
  it('emits only the documented manifest and converts all Components into the Skill tree', async () => {
    /** root 包含 native、transform 和 degraded 三类 Component。 */
    const root = await temporaryProject();
    await writeCompleteProject(root);
    /** relaxed 允许已明确报告的 Agent/argumentHint/invocation 降级。 */
    const report = await run({ root, platform: antigravity({ strict: false }) });
    /** 内部严格 Schema Fixture。 */
    const schema = JSON.parse(await fs.readFile(path.join(goldenRoot, 'plugin.schema.json'), 'utf8')) as AntigravitySchemaFixture;
    /** output 是 Antigravity 主 Plugin 根。 */
    const output = path.join(root, 'dist/antigravity/plugin');
    /** manifest 是 Core codec 物化并通过最终 validator 的对象。 */
    const manifest = JSON.parse(await fs.readFile(path.join(output, PLUGIN_MANIFEST_PATH), 'utf8')) as Record<string, unknown>;

    expect(report.success, JSON.stringify(report.diagnostics, null, 2)).toBe(true);
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(manifest)).toEqual(schema.required);
    expect(Object.keys(manifest).every(field => Object.hasOwn(schema.properties, field))).toBe(true);
    await expect(fs.readFile(path.join(output, PLUGIN_MANIFEST_PATH))).resolves.toEqual(
      await fs.readFile(path.join(goldenRoot, PLUGIN_MANIFEST_PATH)),
    );
    await expect(fs.readFile(path.join(output, 'skills/review/references/checklist.md'), 'utf8')).resolves.toBe('Review checklist.\n');
    await expect(fs.readFile(path.join(output, 'skills/command-release/SKILL.md'), 'utf8'))
      .resolves.toContain('the arguments supplied with this explicit invocation');
    await expect(fs.readFile(path.join(output, 'skills/agent-reviewer/SKILL.md'), 'utf8'))
      .resolves.toContain('Intended model class: capable.');
    await expect(fs.access(path.join(output, 'commands'))).rejects.toThrow();
    await expect(fs.access(path.join(output, 'agents'))).rejects.toThrow();
    expect(report.compatibility).toEqual(expect.arrayContaining([
      expect.objectContaining({ subject: 'skill:review', capability: 'component', level: 'native' }),
      expect.objectContaining({
        subject: 'command:release', capability: 'component', level: 'transform',
        transformation: 'explicit-skill:command-release',
      }),
      expect.objectContaining({
        subject: 'agent:reviewer', capability: 'component', level: 'degraded',
        transformation: 'guidance-skill:agent-reviewer',
      }),
    ]));
    expect(report.metadata).toContainEqual(expect.objectContaining({ field: 'version', disposition: 'omitted' }));
  });

  it('rejects native/fallback Skill identity collisions before Package creation', async () => {
    /** root 的 native Skill 占用 Command 最终生成的固定 ID。 */
    const root = await temporaryProject();
    await fs.mkdir(path.join(root, 'src/commands'), { recursive: true });
    await fs.mkdir(path.join(root, 'src/skills/command-release'), { recursive: true });
    await fs.writeFile(path.join(root, 'src/commands/release.md'), '---\ndescription: Release.\n---\nRelease.\n');
    await fs.writeFile(path.join(root, 'src/skills/command-release/SKILL.md'), '---\ndescription: Existing.\n---\nExisting.\n');
    /** report 必须在任何有歧义的 Skill Asset 签发前失败。 */
    const report = await run({ root, command: 'validate', commit: false });

    expect(report.success).toBe(false);
    expect(report.diagnostics).toContainEqual(expect.objectContaining({
      code: 'ANTIGRAVITY_GENERATED_SKILL_ID_COLLISION', platform: 'antigravity', phase: 'package',
    }));
    expect(report.packages).toEqual([]);
  });

  it('accepts Hooks/MCP root contributions and rejects reserved path collisions', async () => {
    /** validRoot 只需要一个原生 Skill 作为 Plugin host。 */
    const validRoot = await temporaryProject();
    await fs.mkdir(path.join(validRoot, 'src/skills/host'), { recursive: true });
    await fs.writeFile(path.join(validRoot, 'src/skills/host/SKILL.md'), '---\ndescription: Host.\n---\nHost.\n');
    /** hooks 和 mcp 通过固定根路径 add-only 交付。 */
    const hooks = rootContribution({ id: 'hooks-fixture', path: 'hooks.json', bytes: '{"hooks":{}}\n' });
    /** mcp 是独立 owner 的第二个根 Asset。 */
    const mcp = rootContribution({ id: 'mcp-fixture', path: 'mcp_config.json', bytes: '{"mcpServers":{}}\n' });
    /** valid 必须通过 Antigravity 最终 JSON 对象校验。 */
    const valid = await run({ root: validRoot, extensions: [hooks, mcp] });
    expect(valid.success, JSON.stringify(valid.diagnostics, null, 2)).toBe(true);
    expect(valid.packages[0]?.assets).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'hooks.json', owner: 'extension:hooks-fixture' }),
      expect.objectContaining({ path: 'mcp_config.json', owner: 'extension:mcp-fixture' }),
    ]));

    /** collisionRoot 的 Extension 试图占用 Platform Document 保留路径。 */
    const collisionRoot = await temporaryProject();
    await fs.mkdir(path.join(collisionRoot, 'src/skills/host'), { recursive: true });
    await fs.writeFile(path.join(collisionRoot, 'src/skills/host/SKILL.md'), '---\ndescription: Host.\n---\nHost.\n');
    /** collision 由 Core Package path Registry 拒绝，不依赖 Contributor 顺序。 */
    const collision = await run({
      root: collisionRoot,
      command: 'validate',
      extensions: [rootContribution({ id: 'reserved-path', path: 'plugin.json', bytes: '{}\n' })],
      commit: false,
    });
    expect(collision.success).toBe(false);
    expect(collision.diagnostics).toContainEqual(expect.objectContaining({
      code: 'PLATFORM_CONTRIBUTION_FAILED', platform: 'antigravity', phase: 'contribute',
    }));
  });

  it('rejects malformed merged Extension configuration at the candidate boundary', async () => {
    /** root 包含合法 base Skill，错误只来自 Contribution wire bytes。 */
    const root = await temporaryProject();
    await fs.mkdir(path.join(root, 'src/skills/host'), { recursive: true });
    await fs.writeFile(path.join(root, 'src/skills/host/SKILL.md'), '---\ndescription: Host.\n---\nHost.\n');
    /** malformed hooks.json 是合法 JSON 但不是平台要求的对象。 */
    const malformed = rootContribution({ id: 'malformed-hooks', path: 'hooks.json', bytes: '[]\n' });
    /** report 必须由最终 Antigravity validator 产生稳定诊断。 */
    const report = await run({ root, command: 'validate', extensions: [malformed], commit: false });

    expect(report.success).toBe(false);
    expect(report.diagnostics).toContainEqual(expect.objectContaining({
      code: 'ANTIGRAVITY_HOOK_CONFIG_INVALID', platform: 'antigravity', phase: 'platform-validate',
    }));

    /** mcpRoot 验证合法 sidecar 容器中的嵌套 Server 字段。 */
    const mcpRoot = await temporaryProject();
    /** invalidMcp 的 headers 不是 Antigravity 协议要求的字符串映射。 */
    const invalidMcp = rootContribution({
      id: 'malformed-mcp', path: 'mcp_config.json',
      bytes: '{"mcpServers":{"docs":{"type":"http","url":"https://example.com/mcp","headers":42}}}\n',
    });
    /** mcpReport 必须由最终 Candidate validator 拒绝。 */
    const mcpReport = await run({ root: mcpRoot, command: 'validate', extensions: [invalidMcp], commit: false });
    expect(mcpReport.success).toBe(false);
    expect(mcpReport.diagnostics).toContainEqual(expect.objectContaining({
      code: 'ANTIGRAVITY_MCP_HEADERS_INVALID', platform: 'antigravity', phase: 'platform-validate',
    }));
  });

  it('reports unsupported Runtime without compiling or generating fake assets', async () => {
    /** Runtime import 若进入 portable-node 必然失败，用于证明 capability 协商发生在 compile 前。 */
    const root = await temporaryProject();
    await fs.mkdir(path.join(root, 'src/skills/host'), { recursive: true });
    await fs.mkdir(path.join(root, 'src/runtime'), { recursive: true });
    await fs.writeFile(path.join(root, 'src/skills/host/SKILL.md'), '---\ndescription: Host.\n---\nHost.\n');
    await fs.writeFile(path.join(root, 'src/runtime/cli.ts'), 'import "missing-runtime-package";\n');
    /** relaxed 接受已报告的 Runtime capability 差异。 */
    const report = await run({ root, platform: antigravity({ strict: false }) });

    expect(report.success, JSON.stringify(report.diagnostics, null, 2)).toBe(true);
    expect(report.runtimes).toEqual([{
      id: 'cli', kind: 'executable', location: { path: 'src/runtime/cli.ts' }, built: false,
    }]);
    expect(report.compatibility).toContainEqual(expect.objectContaining({
      platform: 'antigravity', subject: 'runtime:cli', capability: 'node20-esm', level: 'unsupported',
    }));
    expect(report.packages.flatMap(unit => unit.assets).some(asset => asset.path.startsWith('runtime/'))).toBe(false);
  });

  it('rejects unknown factory and Component fields without raw escape hatches', async () => {
    expect(() => antigravity({ manifest: {} } as never)).toThrow('Unknown Antigravity Platform option');
    /** root 的平台 namespace 包含未公开字段。 */
    const root = await temporaryProject();
    await fs.mkdir(path.join(root, 'src/skills/invalid'), { recursive: true });
    await fs.writeFile(path.join(root, 'src/skills/invalid/SKILL.md'), `---
description: Invalid field.
platforms:
  antigravity:
    raw: true
---
Do not build.
`);
    /** report 应保留 canonical namespace fieldPath。 */
    const report = await run({ root, command: 'validate', commit: false });
    expect(report.diagnostics).toContainEqual(expect.objectContaining({
      code: 'ANTIGRAVITY_COMPONENT_FIELD_UNKNOWN',
      fieldPath: ['platforms', 'antigravity', 'raw'],
    }));
  });
});
