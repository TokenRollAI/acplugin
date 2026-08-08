import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  definePlatform,
  DiagnosticCollector,
  resolveConfig,
  scanProject,
  type AcpluginPlatform,
} from '../src/index.js';

/** 每个依赖图测试创建并在 afterEach 中清理的临时工程。 */
const temporaryDirectories: string[] = [];

/**
 * 创建依赖图测试所需的最小默认 Platform。
 *
 * @param id 测试 Platform ID。
 * @returns 品牌化 Platform 实例。
 */
function testPlatform(id: string): AcpluginPlatform {
  return definePlatform({
    id,
    apiVersion: '1',
    deliveryType: 'plugin',
    /** 图测试不执行 Draft 准备。 */
    prepare: () => ({ documents: [], artifacts: [] }),
    /** 图测试不生成真实交付单元。 */
    generateBundle: () => ({ id: 'plugin', role: 'primary', type: 'plugin', artifacts: [] }),
    /** 图测试不物化候选目录。 */
    validateBundle: () => undefined,
  });
}

/** 解析最终配置时模拟主包提供的默认 Platform。 */
const defaultPlatforms = [testPlatform('claude-code'), testPlatform('codex')];

/**
 * 创建具有 commands、skills 和 agents 目录的临时工程。
 *
 * @returns 临时工程绝对路径。
 */
async function temporaryProject(): Promise<string> {
  /** 当前图测试独占的临时目录。 */
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-graph-test-'));
  temporaryDirectories.push(root);
  await fs.mkdir(path.join(root, 'src/commands'), { recursive: true });
  await fs.mkdir(path.join(root, 'src/skills'), { recursive: true });
  await fs.mkdir(path.join(root, 'src/agents'), { recursive: true });
  return root;
}

/**
 * 写入一个最小 Skill Component。
 *
 * @param root 工程根目录。
 * @param id Skill ID。
 * @param requires 插入 Frontmatter 的依赖 YAML。
 */
async function writeSkill(root: string, id: string, requires = ''): Promise<void> {
  await fs.mkdir(path.join(root, 'src/skills', id), { recursive: true });
  await fs.writeFile(path.join(root, 'src/skills', id, 'SKILL.md'), `---
description: Skill ${id}.
${requires}---
Skill ${id} body.
`);
}

/**
 * 扫描依赖图测试工程并返回稳定诊断。
 *
 * @param root 工程根目录。
 * @returns Scanner 生成的全部诊断。
 */
async function graphDiagnostics(root: string): Promise<readonly import('../src/index.js').Diagnostic[]> {
  /** 图测试使用的最终配置。 */
  const resolved = resolveConfig({
    name: 'graph-fixture',
    version: '1.0.0',
    description: 'Graph fixture.',
  }, path.join(root, 'acplugin.config.ts'), 'validate', 'production', { defaultPlatforms });
  /** 当前扫描独占的诊断收集器。 */
  const diagnostics = new DiagnosticCollector();
  await scanProject(resolved.config!, diagnostics);
  return diagnostics.diagnostics;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

describe('Component dependency graph', () => {
  it('rejects missing, duplicate, malformed, and self references', async () => {
    /** 包含四类依赖声明错误的临时工程。 */
    const root = await temporaryProject();
    await writeSkill(root, 'base');
    await writeSkill(root, 'broken', `requires:
  skills: [base, base, missing, Invalid, broken]
`);

    /** 图结构校验产生的诊断码。 */
    const diagnostics = await graphDiagnostics(root);
    /** 便于验证四类错误均出现的诊断码列表。 */
    const codes = diagnostics.map(diagnostic => diagnostic.code);
    expect(codes).toEqual(expect.arrayContaining([
      'COMPONENT_REQUIRES_DUPLICATE',
      'COMPONENT_REQUIRES_ID_INVALID',
      'COMPONENT_DEPENDENCY_MISSING',
      'COMPONENT_DEPENDENCY_SELF',
    ]));
  });

  it('reports the complete deterministic path for a dependency cycle', async () => {
    /** 形成 a → b → c → a 的三节点环。 */
    const root = await temporaryProject();
    await writeSkill(root, 'a', 'requires:\n  skills: [b]\n');
    await writeSkill(root, 'b', 'requires:\n  skills: [c]\n');
    await writeSkill(root, 'c', 'requires:\n  skills: [a]\n');

    /** 唯一的完整环路诊断。 */
    const diagnostics = await graphDiagnostics(root);
    /** 从全部诊断中筛出的依赖环条目。 */
    const cycles = diagnostics.filter(diagnostic => diagnostic.code === 'COMPONENT_DEPENDENCY_CYCLE');
    expect(cycles).toHaveLength(1);
    expect(cycles[0]?.message).toContain('skill:a -> skill:b -> skill:c -> skill:a');
  });

  it('allows Command to depend on Skills and Agents without making Command requireable', async () => {
    /** 合法 Command → Skill → Agent 有向无环图。 */
    const root = await temporaryProject();
    await writeSkill(root, 'review', 'requires:\n  agents: [reviewer]\n');
    await fs.writeFile(path.join(root, 'src/agents/reviewer.md'), '---\ndescription: Reviewer.\n---\nReview.\n');
    await fs.writeFile(path.join(root, 'src/commands/check.md'), '---\ndescription: Check.\nrequires:\n  skills: [review]\n  agents: [reviewer]\n---\nCheck.\n');

    expect(await graphDiagnostics(root)).toEqual([]);
  });
});
