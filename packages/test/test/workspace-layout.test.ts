import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** Workspace 边界测试读取的仓库绝对根目录。 */
const root = fileURLToPath(new URL('../../..', import.meta.url));

/** 六个内置 Platform 的目录名与私有包名。 */
const platformPackages = [
  ['claude-code', '@acplugin/platform-claude-code'],
  ['codex', '@acplugin/platform-codex'],
  ['cursor', '@acplugin/platform-cursor'],
  ['antigravity', '@acplugin/platform-antigravity'],
  ['opencode', '@acplugin/platform-opencode'],
  ['pi', '@acplugin/platform-pi'],
] as const;

/** 正式发布版本组包含的三个公开包清单路径。 */
const publicPackageFiles = [
  'packages/acplugin/package.json',
  'packages/extensions/hooks/package.json',
  'packages/extensions/mcp/package.json',
] as const;

/** Workspace 边界断言需要读取的 package.json 字段。 */
interface PackageManifest {
  name: string;
  version: string;
  private?: boolean;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/**
 * 读取仓库内一个 JSON 文件。
 *
 * @param relativePath 仓库相对路径。
 * @returns 解析后的 JSON 值。
 */
async function readJson<T>(relativePath: string): Promise<T> {
  /** JSON 文件的 UTF-8 原文。 */
  const source = await fs.readFile(path.join(root, relativePath), 'utf8');
  return JSON.parse(source) as T;
}

describe('final workspace skeleton', () => {
  it('declares every built-in Platform as an independent private package', async () => {
    /** 六个 Platform 实际读取到的包清单。 */
    const manifests = await Promise.all(platformPackages.map(async ([directory]) => readJson<PackageManifest>(`packages/platforms/${directory}/package.json`)));

    expect(manifests.map(manifest => manifest.name)).toEqual(platformPackages.map(([, name]) => name));
    expect(manifests.every(manifest => manifest.private === true)).toBe(true);
    expect(manifests.every(manifest => manifest.version === '0.0.0')).toBe(true);
    expect(manifests.every(manifest => manifest.dependencies?.['@acplugin/core'] === 'workspace:*')).toBe(true);
  });

  it('keeps exactly the intended public release cohort on one version', async () => {
    /** 主包和两个 Extension 的公开清单。 */
    const manifests = await Promise.all(publicPackageFiles.map(async file => readJson<PackageManifest>(file)));
    /** 三个公开包的预期正式名称。 */
    const expectedNames = [
      '@tokenroll/acplugin',
      '@tokenroll/acplugin-extension-hooks',
      '@tokenroll/acplugin-extension-mcp',
    ];

    expect(manifests.map(manifest => manifest.name)).toEqual(expectedNames);
    expect(new Set(manifests.map(manifest => manifest.version))).toEqual(new Set(['1.0.0']));
    expect(manifests.every(manifest => manifest.private !== true)).toBe(true);
    for (const manifest of manifests) {
      /** 公开运行时依赖中可能泄漏的私有包名。 */
      const privateRuntimeDependencies = Object.keys(manifest.dependencies ?? {}).filter(name => name.startsWith('@acplugin/'));
      expect(privateRuntimeDependencies).toEqual([]);
    }
    for (const manifest of manifests.slice(1))
      expect(manifest.peerDependencies?.['@tokenroll/acplugin']).toBe('workspace:^');
  });

  it('uses nested pnpm workspace patterns and TypeScript 7 for source packages', async () => {
    /** pnpm workspace 与 catalog 配置原文。 */
    const workspace = await fs.readFile(path.join(root, 'pnpm-workspace.yaml'), 'utf8');
    /** 所有新源码包的 package.json 路径。 */
    const sourcePackageFiles = [
      ...platformPackages.map(([directory]) => `packages/platforms/${directory}/package.json`),
      'packages/extensions/hooks/package.json',
      'packages/extensions/mcp/package.json',
    ];
    /** 新源码包实际读取到的清单。 */
    const manifests = await Promise.all(sourcePackageFiles.map(async file => readJson<PackageManifest>(file)));

    expect(workspace).toContain('- packages/*');
    expect(workspace).toContain('- packages/platforms/*');
    expect(workspace).toContain('- packages/extensions/*');
    expect(workspace).toContain('\'@typescript/native\': npm:typescript@^7.0.2');
    expect(manifests.every(manifest => manifest.devDependencies?.['@typescript/native'] === 'catalog:')).toBe(true);
  });
});
