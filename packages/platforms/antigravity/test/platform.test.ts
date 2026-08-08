import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  bytesArtifact,
  DeliveryUnitRegistry,
  executeLifecycle,
  resolveConfig,
  stableJson,
  withMaterializedDeliveryUnitCandidate,
  type DiagnosticInput,
  type ResolvedConfig,
} from '@acplugin/core';
import { antigravity } from '../src/index.js';

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

/** 创建只包含原生 Skill 的规范工程。 */
async function createProject(): Promise<string> {
  /** 当前用例独占的工程根目录。 */
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-antigravity-platform-'));
  temporaryRoots.push(root);
  await fs.mkdir(path.join(root, 'src/skills/review'), { recursive: true });
  await fs.writeFile(path.join(root, 'src/skills/review/SKILL.md'), '---\ndescription: Review a change.\n---\nReview the change.\n');
  return root;
}

/** 解析仅包含 Antigravity Platform 的严格测试配置。 */
function resolvedConfig(root: string): ResolvedConfig {
  /** 最小 Plugin 元数据和单 Platform 的解析结果。 */
  const result = resolveConfig({
    name: 'release-tools',
    version: '1.2.3',
    description: 'Release workflow tools.',
    platforms: [antigravity()],
  }, path.join(root, 'acplugin.config.ts'), 'build', 'production');
  expect(result.diagnostics).toEqual([]);
  return result.config!;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe('Antigravity Platform', () => {
  it('emits only the documented name field and matches the internal strict golden', async () => {
    /** 只包含官方确认资源的规范工程。 */
    const root = await createProject();
    /** 经过 Platform 最终验证的构建结果。 */
    const result = await executeLifecycle({
      config: resolvedConfig(root),
      /** 纯 Markdown Platform Fixture 不加载 TypeScript descriptor。 */
      loadTypeScriptModule: async () => undefined,
      environment: {},
    });
    /** 内部严格 Schema Fixture。 */
    const schema = JSON.parse(await fs.readFile(path.join(goldenRoot, 'plugin.schema.json'), 'utf8')) as AntigravitySchemaFixture;
    /** 实际生成的最小 Plugin Manifest 路径。 */
    const manifestPath = path.join(root, 'dist/antigravity/plugin/plugin.json');
    /** 实际生成且已通过 Platform Validator 的 Manifest。 */
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as Record<string, unknown>;

    expect(result.success).toBe(true);
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(manifest)).toEqual(schema.required);
    expect(Object.keys(manifest).every(field => Object.hasOwn(schema.properties, field))).toBe(true);
    expect(await fs.readFile(manifestPath)).toEqual(await fs.readFile(path.join(goldenRoot, 'plugin.json')));
    await fs.access(path.join(root, 'dist/antigravity/plugin/skills/review/SKILL.md'));
  });

  it('rejects a structurally invalid final manifest with the platform-specific code', async () => {
    /** 候选物化使用的独占临时父目录。 */
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-antigravity-validator-'));
    temporaryRoots.push(root);
    /** 真实 Platform Validator 与 Core Registry 共同验证的无效单元。 */
    const platform = antigravity();
    /** 为无效候选补齐 owner/hash 的 Core Registry。 */
    const units = new DeliveryUnitRegistry(new Map());
    /** 包含结构错误 Manifest 的已注册候选单元。 */
    const unit = await units.add(platform.id, {
      id: 'plugin',
      role: 'primary',
      type: 'plugin',
      artifacts: [bytesArtifact('plugin.json', stableJson({ name: '', extra: true }))],
    });
    /** Validator 返回的稳定平台诊断。 */
    const diagnostics: DiagnosticInput[] = [];
    await withMaterializedDeliveryUnitCandidate(unit, candidate => platform.validateBundle!({
      command: 'build',
      mode: 'production',
      candidate,
      /** 收集最终候选校验产生的平台诊断。 */
      reportDiagnostic: diagnostic => diagnostics.push(diagnostic),
    }), root);

    expect(diagnostics).toContainEqual(expect.objectContaining({ code: 'ANTIGRAVITY_MANIFEST_INVALID' }));
  });
});
