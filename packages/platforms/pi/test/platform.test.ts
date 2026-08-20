import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  defineExtension,
  resolveKernelConfig,
  runKernelBuildSession,
  type AcpluginExtension,
  type BytesAssetRef,
  type DiagnosticInput,
  type JsonValue,
  type ValidatePackageContext,
} from '@acplugin/core';
import { pi } from '../src/index.js';
import { PACKAGE_MANIFEST_PATH } from '../src/package/manifest.js';
import { validatePiPackage } from '../src/package/validator.js';

/** 测试结束后统一删除的临时工程根目录。 */
const temporaryRoots: string[] = [];

/** 创建包含最小配置占位符且登记清理的工程。 */
async function temporaryProject(): Promise<string> {
  /** root 是当前测试独占的临时工程。 */
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-pi-platform-'));
  temporaryRoots.push(root);
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'acplugin.config.ts'), 'export default {}\n');
  return root;
}

/** 写入 Prompt、Skill、Agent fallback、辅助文件和 Gallery 图片。 */
async function writeCompleteProject(root: string): Promise<void> {
  await fs.mkdir(path.join(root, 'src/commands'), { recursive: true });
  await fs.mkdir(path.join(root, 'src/skills/review/references'), { recursive: true });
  await fs.mkdir(path.join(root, 'src/agents'), { recursive: true });
  await fs.mkdir(path.join(root, 'public/assets'), { recursive: true });
  await fs.writeFile(path.join(root, 'src/commands/release.md'), `---
description: Prepare a release.
argumentHint: <version>
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
  await fs.writeFile(path.join(root, 'public/assets/cover.png'), Buffer.from([137, 80, 78, 71]));
}

/** 执行只包含 Pi 的真实 Kernel v2 BuildSession。 */
async function run(input: {
  readonly root: string;
  readonly platform?: ReturnType<typeof pi>;
  readonly extensions?: readonly AcpluginExtension[];
  readonly command?: 'validate' | 'inspect' | 'build';
  readonly commit?: boolean;
}) {
  /** command 决定生命周期语义，commit 只允许 build 使用。 */
  const command = input.command ?? 'build';
  /** resolved 与公开 Project API 使用相同的严格配置边界。 */
  const resolved = resolveKernelConfig({
    name: 'release-tools',
    version: '1.2.3',
    description: 'Release workflow tools.',
    author: { name: 'TokenRoll', email: 'maintainers@example.com' },
    license: 'MIT',
    keywords: ['release'],
    platforms: [input.platform ?? pi()],
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

/** 不经过 Shell 插值运行 pnpm，用于真实 npm Package 消费验证。 */
async function runPnpm(cwd: string, args: readonly string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    /** child 保留 stdout/stderr，失败时给出完整 pack/install 诊断。 */
    const child = spawn('pnpm', [...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    /** stdout 保存真实包管理器输出。 */
    let stdout = '';
    /** stderr 保存真实包管理器错误。 */
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0)
        resolve();
      else
        reject(new Error(`pnpm ${args.join(' ')} failed (${code ?? 'signal'}):\n${stdout}${stderr}`));
    });
  });
}

/** 创建向 package.json.pi.extensions add-only 贡献一个 Pi Extension 的 Fixture。 */
function hooksContribution(input: {
  readonly id?: string;
  readonly reference?: JsonValue;
  readonly asset?: { readonly path: string; readonly bytes: string };
} = {}): AcpluginExtension {
  /** id 允许碰撞测试创建不同 Extension owner。 */
  const id = input.id ?? 'hooks-fixture';
  return defineExtension<Record<string, never>, Record<string, never>, Record<string, never>, { readonly asset?: BytesAssetRef }>({
    id,
    apiVersion: '1',
    options: {},
    resourceRoots: [],
    /** 当前 Fixture 没有跨 Session 状态或依赖。 */
    createSession: () => ({
      /** 空对象表示 Fixture 本轮已发现。 */
      discover: () => ({}),
      /** delivery tuple 必须由 Pi Contributor 完整覆盖。 */
      validate: (_context, state) => ({
        state,
        subjects: [{ subject: `hook:${id}`, capabilities: ['delivery'] }],
      }),
      /** 可选 Extension JS 只通过 owner-scoped Asset Service 创建。 */
      async build({ assets }) {
        if (input.asset === undefined)
          return { state: {} };
        /** asset 将由同 owner Contributor add-only 追加。 */
        const asset = await assets.fromBytes({
          bytes: input.asset.bytes,
          origin: { operation: 'pi-hooks-fixture', subjects: [`hook:${id}`] },
        });
        return { state: { asset } };
      },
      contributors: [{
        platform: 'pi',
        platformApiVersion: '1',
        /** Contributor 只填写精确声明点并追加自己的 Asset。 */
        contribute: (_context, built) => ({
          documentFields: [{
            document: 'package-manifest',
            path: ['pi', 'extensions'],
            value: input.reference ?? ['./extensions/acplugin-hooks.mjs'],
          }],
          ...(input.asset === undefined || built.asset === undefined
            ? {}
            : { assets: [{ path: input.asset.path, asset: built.asset }] }),
          compatibility: [{
            subject: `hook:${id}`,
            capability: 'delivery',
            level: 'native',
            reason: 'Pi loads the generated Hook bridge as a native package Extension.',
          }],
        }),
      }],
    }),
  });
}

/** 创建没有 Pi Contributor 的 MCP Fixture，验证显式 unsupported。 */
function unsupportedMcp(): AcpluginExtension {
  return defineExtension({
    id: 'mcp-fixture',
    apiVersion: '1',
    resourceRoots: [],
    /** 缺少 consumer 时 Core 不应调用 build。 */
    createSession: () => ({
      /** 空状态表示测试 MCP 已被发现。 */
      discover: () => ({}),
      /** transport tuple 必须由 Core 为缺失 consumer 报告 unsupported。 */
      validate: (_context, state) => ({
        state,
        subjects: [{ subject: 'mcp:docs', capabilities: ['transport'] }],
      }),
      /** 该回调被调用即表示 Core 错误构建了不受支持的 MCP。 */
      build: () => {
        throw new Error('Pi must not build an unsupported MCP server.');
      },
      contributors: [],
    }),
  });
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe('Pi Platform Package API', () => {
  it('packs, installs, and discovers native Prompts/Skills and Agent guidance from an independent consumer', async () => {
    /** root 覆盖 Pi Package 的全部 canonical Component 和 Public 继承。 */
    const root = await temporaryProject();
    await writeCompleteProject(root);
    /** relaxed 只接受已明确报告的 Agent fallback 降级。 */
    const report = await run({ root, platform: pi({ strict: false, package: { image: './assets/cover.png' } }) });
    /** output 是已通过 Pi candidate validator 的 npm Package 根。 */
    const output = path.join(root, 'dist/pi/package');
    /** consumer 与生成工程隔离，证明 npm pack 后资源仍可发现。 */
    const consumer = path.join(root, 'consumer');
    /** tarballs 避免 pack 输出污染受管 dist。 */
    const tarballs = path.join(root, 'tarballs');
    await fs.mkdir(consumer);
    await fs.mkdir(tarballs);
    await fs.writeFile(path.join(consumer, 'package.json'), '{"name":"pi-consumer","version":"1.0.0","private":true}\n');
    await runPnpm(output, ['pack', '--pack-destination', tarballs]);
    /** tarball 是 pack 生成的唯一安装输入。 */
    const tarball = path.join(tarballs, (await fs.readdir(tarballs)).find(file => file.endsWith('.tgz'))!);
    await runPnpm(consumer, ['add', '--ignore-scripts', tarball]);
    /** installedRoot 模拟 Pi 从 node_modules 读取已安装 Package。 */
    const installedRoot = path.join(consumer, 'node_modules/release-tools');
    /** manifest 保留 ACPlugin 控制的最小 npm/Pi 发现契约。 */
    const manifest = JSON.parse(await fs.readFile(path.join(installedRoot, PACKAGE_MANIFEST_PATH), 'utf8')) as {
      readonly private?: boolean;
      readonly workspaces?: unknown;
      readonly pi: { readonly skills: readonly string[]; readonly prompts: readonly string[]; readonly image: string };
    };

    expect(report.success, JSON.stringify(report.diagnostics, null, 2)).toBe(true);
    expect(manifest.private).toBeUndefined();
    expect(manifest.workspaces).toBeUndefined();
    expect(manifest.pi).toEqual({ image: './assets/cover.png', prompts: ['./prompts'], skills: ['./skills'] });
    await fs.access(path.join(installedRoot, 'prompts/release.md'));
    await fs.access(path.join(installedRoot, 'skills/review/SKILL.md'));
    await fs.access(path.join(installedRoot, 'skills/review/references/checklist.md'));
    await fs.access(path.join(installedRoot, 'skills/agent-reviewer/SKILL.md'));
    await fs.access(path.join(installedRoot, 'assets/cover.png'));
    await expect(fs.readFile(path.join(installedRoot, 'prompts/release.md'), 'utf8')).resolves.toContain('$ARGUMENTS');
    expect(report.compatibility).toEqual(expect.arrayContaining([
      expect.objectContaining({ subject: 'command:release', capability: 'component', level: 'transform' }),
      expect.objectContaining({ subject: 'skill:review', capability: 'component', level: 'native' }),
      expect.objectContaining({ subject: 'agent:reviewer', capability: 'component', level: 'degraded' }),
    ]));
    expect(report.metadata).toContainEqual(expect.objectContaining({ field: 'author.email', disposition: 'emitted' }));
  }, 30_000);

  it('accepts a Hooks add-only Contribution and rejects duplicate ownership of the same Document point', async () => {
    /** validRoot 只验证一个原生 Pi Extension Asset 与声明。 */
    const validRoot = await temporaryProject();
    /** hooks 追加候选内实际存在的 JS 文件。 */
    const hooks = hooksContribution({
      asset: { path: 'extensions/acplugin-hooks.mjs', bytes: 'export default function setup() {}\n' },
    });
    /** valid 必须通过 Core merge 和最终 discovery closure 校验。 */
    const valid = await run({ root: validRoot, extensions: [hooks] });
    /** manifest 是 Core codec 合并后的最终 Document。 */
    const manifest = JSON.parse(await fs.readFile(path.join(validRoot, 'dist/pi/package/package.json'), 'utf8'));
    expect(valid.success, JSON.stringify(valid.diagnostics, null, 2)).toBe(true);
    expect(manifest.pi.extensions).toEqual(['./extensions/acplugin-hooks.mjs']);
    expect(valid.packages[0]?.assets).toContainEqual(expect.objectContaining({
      path: 'extensions/acplugin-hooks.mjs', owner: 'extension:hooks-fixture',
    }));

    /** collisionRoot 的两个无序 Contributor 占用相同精确 point。 */
    const collisionRoot = await temporaryProject();
    /** collision 与 Extension 配置顺序无关。 */
    const collision = await run({
      root: collisionRoot,
      command: 'validate',
      commit: false,
      extensions: [hooksContribution({ id: 'first-hooks' }), hooksContribution({ id: 'second-hooks' })],
    });
    expect(collision.success).toBe(false);
    expect(collision.diagnostics).toContainEqual(expect.objectContaining({
      code: 'PLATFORM_CONTRIBUTION_FAILED', platform: 'pi', phase: 'contribute',
    }));
  });

  it('reports unsupported MCP and Runtime without compiling or generating fake assets', async () => {
    /** root 中不可解析 Runtime import 证明 capability 协商发生在 compile 前。 */
    const root = await temporaryProject();
    await fs.mkdir(path.join(root, 'src/runtime'), { recursive: true });
    await fs.writeFile(path.join(root, 'src/runtime/cli.ts'), 'import "missing-runtime-package";\n');
    /** relaxed 接受两个显式 unsupported tuple。 */
    const report = await run({ root, platform: pi({ strict: false }), extensions: [unsupportedMcp()] });

    expect(report.success, JSON.stringify(report.diagnostics, null, 2)).toBe(true);
    expect(report.runtimes).toEqual([{
      id: 'cli', kind: 'executable', location: { path: 'src/runtime/cli.ts' }, built: false,
    }]);
    expect(report.compatibility).toEqual(expect.arrayContaining([
      expect.objectContaining({ platform: 'pi', subject: 'runtime:cli', capability: 'node20-esm', level: 'unsupported' }),
      expect.objectContaining({ platform: 'pi', subject: 'mcp:docs', capability: 'transport', level: 'unsupported' }),
    ]));
    expect(report.packages[0]?.assets.some(asset => asset.path.startsWith('runtime/') || asset.path.startsWith('mcp/'))).toBe(false);
  });

  it('rejects native/fallback Skill identity collisions and unknown Component fields before Package creation', async () => {
    /** collisionRoot 的 native Skill 占用 Agent fallback 最终 ID。 */
    const collisionRoot = await temporaryProject();
    await fs.mkdir(path.join(collisionRoot, 'src/skills/agent-reviewer'), { recursive: true });
    await fs.mkdir(path.join(collisionRoot, 'src/agents'), { recursive: true });
    await fs.writeFile(path.join(collisionRoot, 'src/skills/agent-reviewer/SKILL.md'), '---\ndescription: Existing.\n---\nExisting.\n');
    await fs.writeFile(path.join(collisionRoot, 'src/agents/reviewer.md'), '---\ndescription: Reviewer.\n---\nReview.\n');
    /** collision 必须发生在有歧义的 Asset 签发前。 */
    const collision = await run({ root: collisionRoot, command: 'validate', commit: false });
    expect(collision.diagnostics).toContainEqual(expect.objectContaining({
      code: 'PI_GENERATED_SKILL_ID_COLLISION', platform: 'pi', phase: 'package',
    }));
    expect(collision.packages).toEqual([]);

    /** fieldRoot 验证 canonical Pi namespace 没有 raw escape hatch。 */
    const fieldRoot = await temporaryProject();
    await fs.mkdir(path.join(fieldRoot, 'src/commands'), { recursive: true });
    await fs.writeFile(path.join(fieldRoot, 'src/commands/invalid.md'), `---
description: Invalid.
platforms:
  pi:
    raw: true
---
Invalid.
`);
    /** fieldReport 必须保留 canonical namespace 的准确 fieldPath。 */
    const fieldReport = await run({ root: fieldRoot, command: 'validate', commit: false });
    expect(fieldReport.diagnostics).toContainEqual(expect.objectContaining({
      code: 'PI_COMPONENT_FIELD_UNKNOWN', fieldPath: ['platforms', 'pi', 'raw'],
    }));
  });

  it('rejects unsafe or missing Extension discovery references at the final candidate boundary', async () => {
    /** root 的 Contribution 使用 parent escape 且不产生对应 Asset。 */
    const root = await temporaryProject();
    /** report 必须来自 Platform final candidate validator。 */
    const report = await run({
      root,
      command: 'validate',
      commit: false,
      extensions: [hooksContribution({ reference: ['../escape.mjs'] })],
    });

    expect(report.success).toBe(false);
    expect(report.diagnostics).toContainEqual(expect.objectContaining({
      code: 'PI_DISCOVERY_PATH_INVALID', platform: 'pi', phase: 'platform-validate',
    }));
  });

  it('rejects malformed package candidates, workspace fields, unsafe Gallery URLs, and missing discovery assets', async () => {
    /** root 是直接候选校验用的隔离 materialization 根。 */
    const root = await temporaryProject();
    await fs.writeFile(path.join(root, PACKAGE_MANIFEST_PATH), JSON.stringify({
      name: 'invalid-package',
      version: '1.0.0',
      description: 'Invalid Pi package.',
      type: 'module',
      keywords: ['pi-package'],
      private: true,
      pi: {
        skills: ['./skills'],
        image: 'https://user:secret@example.com/cover.png',
      },
    }));
    /** diagnostics 收集 Platform Validator 的稳定错误码。 */
    const diagnostics: DiagnosticInput[] = [];
    /** context 只构造 validator 公开读取的 candidate snapshot 字段。 */
    const context = {
      command: 'validate',
      mode: 'production',
      candidate: {
        root,
        unit: {
          platform: 'pi', id: 'package', type: 'package', role: 'primary',
          assets: [], compatibility: [], metadata: [],
        },
      },
      diagnostics: {
        /** report 只收集稳定结构化诊断，不读取候选外信息。 */
        report: (diagnostic: DiagnosticInput) => diagnostics.push(diagnostic),
      },
    } as unknown as ValidatePackageContext;
    await validatePiPackage(context);

    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'PI_PACKAGE_FIELD_UNKNOWN' }),
      expect.objectContaining({ code: 'PI_PACKAGE_WORKSPACE_LEAK' }),
      expect.objectContaining({ code: 'PI_DISCOVERY_PATH_MISSING' }),
      expect.objectContaining({ code: 'PI_GALLERY_REFERENCE_INVALID' }),
    ]));
  });

  it('validates and defensively copies factory options without raw npm escape hatches', () => {
    expect(() => pi({ package: { dependencies: {} } } as never)).toThrow('Unknown Pi package option');
    expect(() => pi({ package: { video: '' } })).toThrow('package.video');
    /** input 在 factory 返回后继续可变，Platform options 必须保持原快照。 */
    const input = { package: { image: 'https://example.com/cover.png' } };
    /** platform 不能保留作者 input identity。 */
    const platform = pi(input);
    input.package.image = 'https://example.com/mutated.png';
    expect(platform.options).toEqual({ package: { image: 'https://example.com/cover.png' } });
    expect(Object.isFrozen((platform.options as { package: object }).package)).toBe(true);
  });
});
