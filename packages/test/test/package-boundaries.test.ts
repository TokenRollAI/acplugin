import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

/** 包边界测试读取构建产物和清单时使用的仓库根目录。 */
const root = fileURLToPath(new URL('../../..', import.meta.url));

/** 六个独立 Platform package 目录及其公开工厂名。 */
const platformEntries = [
  ['claude-code', 'claudeCode'],
  ['codex', 'codex'],
  ['cursor', 'cursor'],
  ['antigravity', 'antigravity'],
  ['opencode', 'openCode'],
  ['pi', 'pi'],
] as const;

/** 九个正式公开包的清单路径。 */
const publicManifests = [
  'packages/acplugin/package.json',
  ...platformEntries.map(([id]) => `packages/platforms/${id}/package.json`),
  'packages/extensions/hooks/package.json',
  'packages/extensions/mcp/package.json',
] as const;

/**
 * 递归读取目录中满足后缀要求的全部文件。
 *
 * @param directory 待遍历目录。
 * @param suffixes 需要保留的文件后缀。
 * @returns 按路径排序的绝对文件列表。
 */
async function filesWithSuffixes(directory: string, suffixes: readonly string[]): Promise<string[]> {
  /** 当前层按文件名排序后的目录项。 */
  const entries = await fs.readdir(directory, { withFileTypes: true });
  /** 当前目录和所有子目录累计的匹配文件。 */
  const files: string[] = [];
  /** entry 表示当前排序后的目录项，用于递归收集目标后缀。 */
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))) {
    if (entry.name === 'node_modules')
      continue;
    /** 当前目录项的绝对路径。 */
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory())
      files.push(...await filesWithSuffixes(candidate, suffixes));
    else if (suffixes.some(suffix => entry.name.endsWith(suffix)))
      files.push(candidate);
  }
  return files;
}

/**
 * 读取并拼接一组文本构建产物，便于执行跨 Chunk 边界扫描。
 *
 * @param files 需要读取的绝对文件路径。
 * @returns 包含相对路径标记的完整文本。
 */
async function joinedSources(files: readonly string[]): Promise<string> {
  /** 各文件路径和源码组成的确定性片段。 */
  const sources = await Promise.all(files.map(async (file) => {
    /** 当前产物的 UTF-8 源码。 */
    const source = await fs.readFile(file, 'utf8');
    return `\n${path.relative(root, file)}\n${source}`;
  }));
  return sources.join('');
}

describe('published package boundaries', () => {
  it('bundles every private workspace runtime out of the main package', async () => {
    /** 主包所有 ESM 和声明构建产物。 */
    const files = await filesWithSuffixes(path.join(root, 'packages/acplugin/dist'), ['.mjs', '.d.mts']);
    /** 用于检测私有工作区引用泄漏的完整产物文本。 */
    const source = await joinedSources(files);

    expect(source).not.toMatch(/from\s+["']@acplugin\//);
    expect(source).not.toMatch(/import\s*\(\s*["']@acplugin\//);
    expect(source).not.toMatch(/^\s*(?:import|export)\s.*from\s+["'](?:@tokenroll\/acplugin-extension-(?:hooks|mcp)|rolldown|@rolldown\/)/m);
    expect(source).not.toMatch(/^\s*import\s*\(\s*["'](?:@tokenroll\/acplugin-extension-(?:hooks|mcp)|rolldown|@rolldown\/)/m);
    expect(source).not.toMatch(/type\s+(?:AcpluginModule|TargetContribution|TargetId)\b/);
    expect(source).not.toMatch(/type\s+Module(?:Build|Discover|Generate|Validate)Context\b/);
  });

  it('keeps the local MCP Bundler in its published Extension entry', async () => {
    /** 不触达 Rolldown 的 MCP Extension 轻量公开入口。 */
    const index = await fs.readFile(path.join(root, 'packages/extensions/mcp/dist/index.mjs'), 'utf8');
    /** 只有发现本地 stdio Server 后才动态加载的重型构建入口。 */
    const bundler = await fs.readFile(path.join(root, 'packages/extensions/mcp/dist/bundler.mjs'), 'utf8');

    expect(index).toContain('new URL("./bundler.mjs", import.meta.url)');
    expect(index).not.toMatch(/^\s*import\s.*from\s+["'](?:rolldown|@rolldown\/)/m);
    expect(bundler).toMatch(/^\s*import\s.*from\s+["']rolldown["']/m);
  });

  it('keeps each independent Platform package limited to its public factory contract', async () => {
    /** id 与 factory 表示当前检查的 Platform package 及其具名工厂导出。 */
    for (const [id, factory] of platformEntries) {
      /** 从独立 package 真实构建文件加载的运行时命名空间。 */
      const module = await import(pathToFileURL(path.join(root, `packages/platforms/${id}/dist/index.mjs`)).href);
      expect(Object.keys(module).sort()).toEqual(['PLATFORM_API_VERSION', 'PLATFORM_ID', 'default', factory].sort());
      expect(module.default).toBe(module[factory]);
      /** 当前独立 package 生成的声明入口。 */
      const declaration = await fs.readFile(path.join(root, `packages/platforms/${id}/dist/index.d.mts`), 'utf8');
      expect(declaration).toContain('from "@tokenroll/acplugin"');
      expect(declaration).not.toContain('@acplugin/');
      expect(declaration).not.toMatch(/\b(?:Compiler|Serializer|Validator|Registry|executeLifecycle|buildProject)\b/);
    }
  });

  it('externalizes the public main package from all Platform and Extension packages', async () => {
    /** integration 表示当前检查的正式生态包目录。 */
    const integrations = [
      ...platformEntries.map(([id]) => `platforms/${id}`),
      'extensions/hooks',
      'extensions/mcp',
    ];
    for (const integration of integrations) {
      /** 当前生态包的 ESM 与声明入口源码。 */
      const files = [
        path.join(root, `packages/${integration}/dist/index.mjs`),
        path.join(root, `packages/${integration}/dist/index.d.mts`),
      ];
      /** 两个入口共同构成的包边界文本。 */
      const source = await joinedSources(files);
      expect(source).toContain('from "@tokenroll/acplugin"');
      expect(source).not.toContain('@acplugin/');
    }
  });

  it('publishes only the nine independent packages and a Node 20 ESM CLI', async () => {
    /** Workspace 中所有 package.json 路径。 */
    const manifests = await filesWithSuffixes(path.join(root, 'packages'), ['package.json']);
    /** 未声明 private 的实际公开包名称。 */
    const publicNames: string[] = [];
    /** manifestPath 表示当前解析公开性字段的 Workspace 清单。 */
    for (const manifestPath of manifests) {
      /** 当前 Workspace 包清单。 */
      const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as { name: string; private?: boolean };
      if (manifest.private !== true)
        publicNames.push(manifest.name);
    }
    expect(publicNames.sort()).toEqual([
      '@tokenroll/acplugin',
      ...platformEntries.map(([id]) => `@tokenroll/acplugin-platform-${id}`),
      '@tokenroll/acplugin-extension-hooks',
      '@tokenroll/acplugin-extension-mcp',
    ].sort());
    expect(publicManifests).toHaveLength(9);

    /** 主包不得再声明或生成官方 Platform subpath。 */
    const mainManifest = JSON.parse(await fs.readFile(path.join(root, 'packages/acplugin/package.json'), 'utf8')) as { exports: Record<string, unknown> };
    expect(Object.keys(mainManifest.exports)).toEqual(['.']);
    await expect(fs.access(path.join(root, 'packages/acplugin/dist/platforms'))).rejects.toThrow();

    /** 主包生成并由 package.json bin 指向的 CLI 文件。 */
    const cliPath = path.join(root, 'packages/acplugin/dist/cli.mjs');
    /** CLI shebang 与 ESM 源码。 */
    const cli = await fs.readFile(cliPath, 'utf8');
    /** CLI 文件系统权限。 */
    const stat = await fs.stat(cliPath);
    expect(cli.startsWith('#!/usr/bin/env node\n')).toBe(true);
    expect(stat.mode & 0o111).not.toBe(0);
    expect(cli).not.toMatch(/\brequire\s*\(/);
  });
});
