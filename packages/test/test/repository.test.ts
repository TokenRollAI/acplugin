import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** 当前 monorepo 根目录，用于读取工作流、清单与稳定文档。 */
const root = fileURLToPath(new URL('../../..', import.meta.url));

/**
 * 读取仓库根目录下的 UTF-8 文件。
 *
 * @param relativePath 仓库相对路径。
 * @returns 文件内容。
 */
async function read(relativePath: string): Promise<string> {
  return fs.readFile(path.join(root, relativePath), 'utf8');
}

describe('repository release and documentation guards', () => {
  it('keeps the public packages in one manually publishable cohort', async () => {
    const packageFiles = [
      'packages/acplugin/package.json',
      'packages/module-hooks/package.json',
      'packages/module-mcp/package.json',
    ];
    const manifests = await Promise.all(packageFiles.map(async file => JSON.parse(await read(file)) as {
      name: string;
      version: string;
      private?: boolean;
      publishConfig?: { access?: string; provenance?: boolean };
    }));
    const changeset = JSON.parse(await read('.changeset/config.json')) as { fixed: string[][] };

    expect(new Set(manifests.map(manifest => manifest.version)).size).toBe(1);
    expect(manifests.map(manifest => manifest.name)).toEqual([
      '@tokenroll/acplugin',
      '@tokenroll/acplugin-module-hooks',
      '@tokenroll/acplugin-module-mcp',
    ]);
    expect(manifests.every(manifest => manifest.private !== true)).toBe(true);
    expect(manifests.every(manifest => manifest.publishConfig?.access === 'public')).toBe(true);
    expect(manifests.every(manifest => manifest.publishConfig?.provenance === undefined)).toBe(true);
    expect(changeset.fixed).toContainEqual(expect.arrayContaining(manifests.map(manifest => manifest.name)));
  });

  it('does not expose an automated publication path', async () => {
    const check = await read('.github/workflows/check.yml');
    const patch = await read('.github/workflows/patch.yml');

    await expect(fs.access(path.join(root, '.github/workflows/publish-npm.yml'))).rejects.toThrow();
    await expect(fs.access(path.join(root, 'scripts/publish-release-cohort.mjs'))).rejects.toThrow();
    await expect(fs.access(path.join(root, 'scripts/verify-release-cohort.mjs'))).rejects.toThrow();
    expect(`${check}\n${patch}`).not.toMatch(/npm publish|pnpm publish|gh release|id-token: write|NPM_TOKEN/i);
  });

  it('checks pull requests and creates version PRs only on manual dispatch', async () => {
    const check = await read('.github/workflows/check.yml');
    const patch = await read('.github/workflows/patch.yml');

    expect(check).toContain('pull_request:');
    expect(check).not.toMatch(/\bpush:/);
    expect(check).toContain('pnpm run lint');
    expect(check).toContain('pnpm run typecheck');
    expect(check).not.toMatch(/pnpm run (?:test|build|release:verify)/);
    expect(patch).toContain('workflow_dispatch:');
    expect(patch).toContain('target_branch:');
    expect(patch).toContain('pnpm version-packages');
    expect(patch).toContain('peter-evans/create-pull-request@v8');
    expect(patch).toContain('base: ${{ inputs.target_branch }}');
  });

  it('keeps current docs free of the retired namespace and CLI', async () => {
    const docs = await Promise.all([
      'README.md',
      'README.zh-CN.md',
      'AGENTS.md',
      'llmdoc/index.md',
      'llmdoc/startup.md',
      'llmdoc/overview/project.md',
      'llmdoc/overview/project.zh-CN.md',
      'llmdoc/architecture/system.md',
      'llmdoc/architecture/system.zh-CN.md',
      'llmdoc/guides/usage.md',
      'llmdoc/guides/usage.zh-CN.md',
      'llmdoc/guides/release.md',
      'llmdoc/guides/release.zh-CN.md',
      'llmdoc/reference/conversion-matrix.md',
      'llmdoc/reference/conversion-matrix.zh-CN.md',
    ].map(read));
    const currentDocumentation = docs.join('\n');

    expect(currentDocumentation).not.toContain('@disdjj/acplugin');
    expect(currentDocumentation).not.toMatch(/\bacplugin (?:scan|convert)\b/);
    expect(currentDocumentation).not.toContain('src/converter/');
    expect(currentDocumentation).not.toContain('.github/workflows/acplugin.yml');
  });
});
