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

  it('keeps pull-request checks, version PRs, and stable publication separate', async () => {
    /** 四条有意保持单一职责的发行工作流。 */
    const [lint, typecheck, changelog, release] = await Promise.all([
      read('.github/workflows/lint.yml'),
      read('.github/workflows/typecheck.yml'),
      read('.github/workflows/changelog.yml'),
      read('.github/workflows/release.yml'),
    ]);
    /** 根命令定义本地 beta 与手工 stable 的同一发布边界。 */
    const manifest = JSON.parse(await read('package.json')) as { scripts?: Record<string, string> };

    expect(lint).toContain('pull_request:');
    expect(lint).toContain('pnpm run lint');
    expect(lint).not.toMatch(/(?:pnpm|npm) publish|NPM_TOKEN|changesets\/action/u);
    expect(typecheck).toContain('pull_request:');
    expect(typecheck).toContain('pnpm run typecheck');
    expect(typecheck).not.toMatch(/(?:pnpm|npm) publish|NPM_TOKEN|changesets\/action/u);

    expect(changelog).toContain('push:');
    expect(changelog).toContain('branches: [main]');
    expect(changelog).toContain('changesets/action@v1');
    expect(changelog).toContain('version: pnpm run version-packages');
    expect(changelog).not.toMatch(/(?:pnpm|npm) publish|NPM_TOKEN/u);

    expect(release).toContain('workflow_dispatch:');
    expect(release).not.toMatch(/\b(?:pull_request|push):/u);
    expect(release).toContain('pnpm run release');
    expect(release).toContain('NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}');

    expect(manifest.scripts?.['publish:beta:dry-run']).toContain('pnpm -r --filter \'@tokenroll/*\' publish');
    expect(manifest.scripts?.['publish:beta']).toContain('--tag beta');
    expect(manifest.scripts?.release).toContain('--tag latest');
    expect(manifest.scripts?.['publish:beta']).toContain('--ignore-scripts');
    expect(manifest.scripts?.release).toContain('--ignore-scripts');
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
