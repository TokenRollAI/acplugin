import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** 当前 monorepo 根目录，用于读取工作流、清单与稳定文档。 */
const root = fileURLToPath(new URL('../../../..', import.meta.url));

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
  it('keeps nine independently versioned packages manually publishable', async () => {
    /** 九个公开包的清单路径。 */
    const packageFiles = [
      'packages/acplugin/package.json',
      'packages/platforms/claude-code/package.json',
      'packages/platforms/codex/package.json',
      'packages/platforms/cursor/package.json',
      'packages/platforms/antigravity/package.json',
      'packages/platforms/opencode/package.json',
      'packages/platforms/pi/package.json',
      'packages/extensions/hooks/package.json',
      'packages/extensions/mcp/package.json',
    ];
    /** 九个公开包解析后的发布字段。 */
    const manifests = await Promise.all(packageFiles.map(async file => JSON.parse(await read(file)) as {
      name: string;
      version: string;
      private?: boolean;
      publishConfig?: { access?: string; provenance?: boolean };
    }));
    /** Changesets 不再声明固定版本发布组。 */
    const changeset = JSON.parse(await read('.changeset/config.json')) as { fixed: string[][] };

    expect(manifests.map(manifest => manifest.name)).toEqual([
      '@tokenroll/acplugin',
      '@tokenroll/acplugin-platform-claude-code',
      '@tokenroll/acplugin-platform-codex',
      '@tokenroll/acplugin-platform-cursor',
      '@tokenroll/acplugin-platform-antigravity',
      '@tokenroll/acplugin-platform-opencode',
      '@tokenroll/acplugin-platform-pi',
      '@tokenroll/acplugin-extension-hooks',
      '@tokenroll/acplugin-extension-mcp',
    ]);
    expect(manifests.every(manifest => manifest.private !== true)).toBe(true);
    expect(manifests.every(manifest => manifest.publishConfig?.access === 'public')).toBe(true);
    expect(manifests.every(manifest => manifest.publishConfig?.provenance === undefined)).toBe(true);
    expect(changeset.fixed).toEqual([]);
  });

  it('does not expose an automated publication path', async () => {
    /** PR 阶段只做静态检查的 Action 内容。 */
    const check = await read('.github/workflows/check.yml');
    /** 手动消费 Changeset 并创建版本 PR 的 Action 内容。 */
    const patch = await read('.github/workflows/patch.yml');
    /** 手工构建并跨 Node 版本消费 tarball 的只读 Action 内容。 */
    const verify = await read('.github/workflows/verify.yml');

    await expect(fs.access(path.join(root, '.github/workflows/publish-npm.yml'))).rejects.toThrow();
    await expect(fs.access(path.join(root, 'scripts/publish-release-cohort.mjs'))).rejects.toThrow();
    await expect(fs.access(path.join(root, 'scripts/verify-release-cohort.mjs'))).rejects.toThrow();
    expect(`${check}\n${patch}\n${verify}`).not.toMatch(/npm publish|pnpm publish|gh release|dist-tag|id-token: write|NPM_TOKEN/i);
  });

  it('checks pull requests and creates version PRs only on manual dispatch', async () => {
    /** 用于验证 PR 触发器和命令边界的 Check Action。 */
    const check = await read('.github/workflows/check.yml');
    /** 用于验证手动分支输入和版本 PR 的 Patch Action。 */
    const patch = await read('.github/workflows/patch.yml');
    /** 用于验证手动只读 tarball 构建和 Node 20 消费边界的 Verify Action。 */
    const verify = await read('.github/workflows/verify.yml');

    expect(check).toContain('pull_request:');
    expect(check).not.toMatch(/\bpush:/);
    expect(check).toContain('pnpm run lint');
    expect(check).toContain('pnpm run typecheck');
    expect(check).not.toMatch(/pnpm run (?:test|build|release:verify)/);
    expect(check).toContain('pnpm run versions:check');
    expect(check).toContain('node-version: 22.18.0');
    expect(patch).toContain('workflow_dispatch:');
    expect(patch).toContain('target_branch:');
    expect(patch).toContain('pnpm changeset status --output');
    expect(patch).toContain('status.releases.length === 0');
    expect(patch).toContain('pnpm version-packages');
    expect(patch).toContain('beta prerelease versions');
    expect(patch).toContain('peter-evans/create-pull-request@v8');
    expect(patch).toContain('base: ${{ inputs.target_branch }}');
    expect(patch).toContain('node-version: 22.18.0');
    expect(verify).toContain('workflow_dispatch:');
    expect(verify).not.toMatch(/\b(?:pull_request|push|schedule):/);
    expect(verify).toContain('permissions:\n  contents: read');
    expect(verify).toContain('node-version: 22.18.0');
    expect(verify).toContain('node-version: 20.19.0');
    expect(verify).toContain('release:verify -- --tarball-dir');
    expect(verify.match(/name: acplugin-verified-tarballs/g)).toHaveLength(2);
    expect(verify).toContain('actions/upload-artifact@v7');
    expect(verify).toContain('actions/download-artifact@v8');
  });

  it('separates the repository Node toolchain from published runtime support', async () => {
    /** 根工具链和九个公开包的精确清单路径。 */
    const files = [
      'package.json',
      'packages/acplugin/package.json',
      'packages/platforms/claude-code/package.json',
      'packages/platforms/codex/package.json',
      'packages/platforms/cursor/package.json',
      'packages/platforms/antigravity/package.json',
      'packages/platforms/opencode/package.json',
      'packages/platforms/pi/package.json',
      'packages/extensions/hooks/package.json',
      'packages/extensions/mcp/package.json',
    ];
    /** 当前根与公开 manifest 的 engine/dependency 边界。 */
    const [repository, main, ...integrations] = await Promise.all(files.map(async file => JSON.parse(await read(file)) as {
      engines?: { node?: string };
      dependencies?: Record<string, string>;
    }));

    expect(repository.engines?.node).toBe('^22.18.0 || >=24.11.0');
    for (const manifest of [main, ...integrations])
      expect(manifest.engines?.node).toBe('^20.19.0 || ^22.13.0 || >=23.5.0');
    expect(main.dependencies?.commander).toBe('14.0.1');
  });

  it('keeps current docs free of the retired namespace and CLI', async () => {
    /** 当前需要同步且不得残留旧命名的稳定文档集合。 */
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
    /** 便于统一扫描旧 namespace、命令和路径的文档文本。 */
    const currentDocumentation = docs.join('\n');

    expect(currentDocumentation).not.toContain('@disdjj/acplugin');
    expect(currentDocumentation).not.toMatch(/\bacplugin (?:scan|convert)\b/);
    expect(currentDocumentation).not.toContain('src/converter/');
    expect(currentDocumentation).not.toContain('.github/workflows/acplugin.yml');
  });
});
