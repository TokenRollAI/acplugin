import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { executeLifecycle, resolveConfig, type ResolvedConfig } from '@acplugin/core';
import { cursor } from '../src/index.js';

/** 测试结束后统一删除的临时工程根目录。 */
const temporaryRoots: string[] = [];

/** Cursor 官方 Schema 与 Manifest Golden 的固定目录。 */
const goldenRoot = path.join(import.meta.dirname, 'golden');

/** 2026-08-08 重新核验的 Cursor 官方 Schema 内容摘要。 */
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
  await fs.mkdir(path.join(root, 'src/skills/review'), { recursive: true });
  await fs.mkdir(path.join(root, 'src/agents'), { recursive: true });
  await fs.mkdir(path.join(root, 'public/assets'), { recursive: true });
  await fs.writeFile(path.join(root, 'src/commands/release.md'), '---\ndescription: Prepare a release.\n---\nPrepare release {{arguments}}.\n');
  await fs.writeFile(path.join(root, 'src/skills/review/SKILL.md'), '---\ndescription: Review a change.\n---\nReview the change.\n');
  await fs.writeFile(path.join(root, 'src/agents/reviewer.md'), '---\ndescription: Review code.\nmodel: inherit\ncapabilities:\n  - filesystem:read\n  - search\n---\nReview code.\n');
  await fs.writeFile(path.join(root, 'public/assets/logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>\n');
  return root;
}

/** 解析仅包含 Cursor Platform 的严格测试配置。 */
function resolvedConfig(root: string, logo = './assets/logo.svg'): ResolvedConfig {
  /** 使用完整统一元数据和全部 Cursor 平台选项的解析结果。 */
  const result = resolveConfig({
    name: 'release-tools',
    version: '1.2.3',
    description: 'Release workflow tools.',
    displayName: 'Release Tools',
    author: { name: 'TokenRoll', email: 'maintainers@example.com' },
    homepage: 'https://example.com/release-tools',
    repository: 'https://github.com/TokenRollAI/release-tools',
    license: 'MIT',
    keywords: ['release', 'review'],
    platforms: [cursor({
      publisher: 'TokenRoll',
      logo,
      category: 'Developer Tools',
      tags: ['release', 'automation'],
      minClientVersions: { cursor: '1.2.3' },
    })],
  }, path.join(root, 'acplugin.config.ts'), 'build', 'production');
  expect(result.diagnostics).toEqual([]);
  return result.config!;
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

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe('Cursor Platform', () => {
  it('matches the pinned official Schema root contract and the manifest golden', async () => {
    /** 包含三类 Component 和 Public 资源的规范工程。 */
    const root = await createProject();
    /** 完成临时校验和事务提交的 Platform 构建结果。 */
    const result = await executeLifecycle({
      config: resolvedConfig(root),
      /** 纯 Markdown Platform Fixture 不加载 TypeScript descriptor。 */
      loadTypeScriptModule: async () => undefined,
      environment: {},
    });
    /** Cursor 官方 Schema 的冻结原始字节。 */
    const schemaBytes = await fs.readFile(path.join(goldenRoot, 'plugin.schema.json'));
    /** 从冻结 Fixture 解析出的官方 Schema。 */
    const schema = JSON.parse(schemaBytes.toString('utf8')) as CursorSchemaFixture;
    /** Cursor 构建产生的规范 Manifest 路径。 */
    const manifestPath = path.join(root, 'dist/cursor/plugin/.cursor-plugin/plugin.json');
    /** 完成 Platform 校验后的 Manifest 对象。 */
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as Record<string, unknown>;

    expect(result.success).toBe(true);
    expect(createHash('sha256').update(schemaBytes).digest('hex')).toBe(CURSOR_SCHEMA_SHA256);
    expect(CURSOR_SCHEMA_SOURCE).toContain('cursor/plugins');
    expectSchemaCompatible(manifest, schema);
    expect(await fs.readFile(manifestPath)).toEqual(await fs.readFile(path.join(goldenRoot, '.cursor-plugin/plugin.json')));
  });

  it('rejects unowned Platform options at the public factory boundary', () => {
    expect(() => cursor({ experimental: true } as never)).toThrow('Unknown Cursor Platform option');
  });

  it('accepts an absolute credential-free HTTPS logo URL', async () => {
    /** 远端 HTTPS logo 不需要候选交付单元包含同名 Artifact。 */
    const root = await createProject();
    /** 使用远端 logo 完成候选校验的构建结果。 */
    const result = await executeLifecycle({
      config: resolvedConfig(root, 'https://cdn.example.com/plugin/logo.svg'),
      /** 纯静态 Cursor Fixture 不加载作者 TypeScript descriptor。 */
      loadTypeScriptModule: async () => undefined,
      environment: {},
    });

    expect(result.success).toBe(true);
    expect(result.diagnostics.some(diagnostic => diagnostic.code.startsWith('CURSOR_LOGO_'))).toBe(false);
  });

  it.each([
    ['file URL', 'file:///tmp/logo.svg', 'CURSOR_LOGO_URL_INVALID'],
    ['data URL', 'data:image/svg+xml;base64,PHN2Zy8+', 'CURSOR_LOGO_URL_INVALID'],
    ['credential URL', 'https://user:secret@example.com/logo.svg', 'CURSOR_LOGO_URL_INVALID'],
    ['incomplete URL', 'https://', 'CURSOR_LOGO_URL_INVALID'],
    ['POSIX absolute path', '/tmp/logo.svg', 'CURSOR_LOGO_PATH_INVALID'],
    ['Win32 absolute path', 'C:\\temp\\logo.svg', 'CURSOR_LOGO_PATH_INVALID'],
    ['backslash path', 'assets\\logo.svg', 'CURSOR_LOGO_PATH_INVALID'],
    ['parent traversal', '../../logo.svg', 'CURSOR_LOGO_PATH_INVALID'],
    ['missing Artifact', './assets/missing.svg', 'CURSOR_LOGO_ARTIFACT_MISSING'],
  ])('rejects an unsafe or missing %s', async (_label, logo, code) => {
    /** 每个不可信 logo 候选使用独立工程验证稳定诊断。 */
    const root = await createProject();
    /** 当前不可信 logo 对应的生命周期失败结果。 */
    const result = await executeLifecycle({
      config: resolvedConfig(root, logo),
      /** 纯静态 Cursor Fixture 不加载作者 TypeScript descriptor。 */
      loadTypeScriptModule: async () => undefined,
      environment: {},
    });

    expect(result.success).toBe(false);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code, platform: 'cursor', fieldPath: ['logo'] }));
  });
});
