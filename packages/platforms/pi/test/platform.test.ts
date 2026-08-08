import { spawn } from 'node:child_process';
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
import { pi } from '../src/index.js';

/** 测试结束后统一删除的临时工程根目录。 */
const temporaryRoots: string[] = [];

/** 在指定目录运行 pnpm，并在失败时保留完整诊断。 */
async function runPnpm(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    /** 不经过 Shell 插值的 pnpm 子进程。 */
    const child = spawn('pnpm', [...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    /** pnpm 标准输出。 */
    let stdout = '';
    /** pnpm 标准错误。 */
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
        resolve(stdout);
      else
        reject(new Error(`pnpm ${args.join(' ')} failed (${code ?? 'signal'}):\n${stdout}${stderr}`));
    });
  });
}

/** 创建同时包含 Pi Skill 和 Prompt Template 的规范工程。 */
async function createProject(): Promise<string> {
  /** 当前用例独占的工程根目录。 */
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-pi-platform-'));
  temporaryRoots.push(root);
  await fs.mkdir(path.join(root, 'src/commands'), { recursive: true });
  await fs.mkdir(path.join(root, 'src/skills/review'), { recursive: true });
  await fs.mkdir(path.join(root, 'public/assets'), { recursive: true });
  await fs.writeFile(path.join(root, 'src/commands/release.md'), '---\ndescription: Prepare a release.\nargumentHint: <version>\n---\nPrepare release {{arguments}}.\n');
  await fs.writeFile(path.join(root, 'src/skills/review/SKILL.md'), '---\ndescription: Review a change.\n---\nReview the change.\n');
  await fs.writeFile(path.join(root, 'public/assets/cover.png'), Buffer.from([137, 80, 78, 71]));
  return root;
}

/** 解析仅包含 Pi Platform 的严格测试配置。 */
function resolvedConfig(root: string): ResolvedConfig {
  /** 带 Gallery 图片和 npm 元数据的配置解析结果。 */
  const result = resolveConfig({
    name: 'release-tools',
    version: '1.2.3',
    description: 'Release workflow tools.',
    author: { name: 'TokenRoll' },
    license: 'MIT',
    platforms: [pi({ package: { image: './assets/cover.png' } })],
  }, path.join(root, 'acplugin.config.ts'), 'build', 'production');
  expect(result.diagnostics).toEqual([]);
  return result.config!;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe('Pi Platform', () => {
  it('packs, installs, and discovers package Skills and Prompts from an independent consumer', async () => {
    /** 包含全部首期 Pi 原生资源的规范工程。 */
    const root = await createProject();
    /** 经过 Pi package Validator 的构建结果。 */
    const result = await executeLifecycle({
      config: resolvedConfig(root),
      /** 纯 Markdown Platform Fixture 不加载 TypeScript descriptor。 */
      loadTypeScriptModule: async () => undefined,
      environment: {},
    });
    /** Pi npm package 的最终交付根。 */
    const output = path.join(root, 'dist/pi/package');
    /** 独立于生成工程的真实 package 消费目录。 */
    const consumer = path.join(root, 'consumer');
    /** pnpm pack 存放 tarball 的独立目录。 */
    const tarballs = path.join(root, 'tarballs');
    await fs.mkdir(consumer);
    await fs.mkdir(tarballs);
    await fs.writeFile(path.join(consumer, 'package.json'), '{"name":"pi-consumer","version":"1.0.0","private":true}\n');
    await runPnpm(output, ['pack', '--pack-destination', tarballs]);
    /** 当前 pack 命令生成的唯一 tarball。 */
    const tarball = path.join(tarballs, (await fs.readdir(tarballs)).find(file => file.endsWith('.tgz'))!);
    await runPnpm(consumer, ['add', '--ignore-scripts', tarball]);
    /** 从独立 node_modules 加载的 Pi package manifest。 */
    const installedRoot = path.join(consumer, 'node_modules/release-tools');
    /** Pi 启动时用来发现 package 资源的配置。 */
    const manifest = JSON.parse(await fs.readFile(path.join(installedRoot, 'package.json'), 'utf8')) as {
      readonly private?: boolean;
      readonly workspaces?: unknown;
      readonly pi: { readonly skills: readonly string[]; readonly prompts: readonly string[]; readonly image: string };
    };

    expect(result.success).toBe(true);
    expect(manifest.private).toBeUndefined();
    expect(manifest.workspaces).toBeUndefined();
    expect(manifest.pi).toEqual({ image: './assets/cover.png', prompts: ['./prompts'], skills: ['./skills'] });
    await fs.access(path.join(installedRoot, manifest.pi.skills[0]!.slice(2), 'review/SKILL.md'));
    await fs.access(path.join(installedRoot, manifest.pi.prompts[0]!.slice(2), 'release.md'));
    await fs.access(path.join(installedRoot, manifest.pi.image.slice(2)));
  }, 30_000);

  it('rejects workspace metadata in a final package with the platform-specific code', async () => {
    /** 候选物化使用的独占临时父目录。 */
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-pi-validator-'));
    temporaryRoots.push(root);
    /** 真实 Platform Validator 与 Core Registry 共同验证的无效单元。 */
    const platform = pi();
    /** 为无效候选补齐 owner/hash 的 Core Registry。 */
    const units = new DeliveryUnitRegistry(new Map());
    /** 包含禁止 workspace 元数据的已注册候选单元。 */
    const unit = await units.add(platform.id, {
      id: 'package',
      role: 'primary',
      type: 'package',
      artifacts: [bytesArtifact('package.json', stableJson({
        name: 'invalid-pi-package',
        version: '1.0.0',
        description: 'Invalid workspace metadata fixture.',
        type: 'module',
        keywords: ['pi-package'],
        private: true,
        pi: {},
      }))],
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

    expect(diagnostics).toContainEqual(expect.objectContaining({ code: 'PI_PACKAGE_WORKSPACE_LEAK' }));
  });
});
