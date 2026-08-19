import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import hooks, {
  CLAUDE_CODE_PLATFORM_EVENTS,
  EXTENSION_NAME,
  HOOK_EVENTS,
} from '@tokenroll/acplugin-extension-hooks';

/** 跨包 Hooks 契约测试使用的仓库根目录。 */
const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url));

/**
 * 递归读取一个源码目录中的全部 TypeScript 文件。
 *
 * @param directory 当前需要遍历的绝对目录。
 * @returns 按路径稳定拼接的源码文本。
 */
async function sourceTree(directory: string): Promise<string> {
  /** 当前目录按名称稳定排序的文件系统项。 */
  const entries = (await fs.readdir(directory, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name, 'en'));
  /** 当前目录和子目录累计的 TypeScript 源码。 */
  const sources: string[] = [];
  for (const entry of entries) {
    /** 当前目录项的绝对路径。 */
    const target = path.join(directory, entry.name);
    if (entry.isDirectory())
      sources.push(await sourceTree(target));
    else if (entry.isFile() && entry.name.endsWith('.ts'))
      sources.push(await fs.readFile(target, 'utf8'));
  }
  return sources.join('\n');
}

describe('official Hooks Extension ecosystem contract', () => {
  it('exposes the canonical author API and immutable Extension definition', () => {
    /** 从正式公开包创建的 Hooks Extension。 */
    const extension = hooks();
    expect(EXTENSION_NAME).toBe('@tokenroll/acplugin-extension-hooks');
    expect(Object.isFrozen(extension)).toBe(true);
    expect(extension.id).toBe('hooks');
    expect(extension.apiVersion).toBe('1');
    expect(extension.resourceRoots).toEqual(['hooks']);
    expect(extension.options).toEqual({});
    expect(Object.isFrozen(extension.resourceRoots)).toBe(true);
    expect(Object.isFrozen(extension.options)).toBe(true);
    expect(HOOK_EVENTS).toEqual([
      'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse',
      'PermissionRequest', 'PostToolUse', 'PreCompact', 'PostCompact',
      'SubagentStart', 'SubagentStop', 'Stop',
    ]);
    expect(CLAUDE_CODE_PLATFORM_EVENTS).toContain('Setup');
    expect(CLAUDE_CODE_PLATFORM_EVENTS).toContain('ElicitationResult');
  });

  it('keeps Platform packages independent and removes the retired Hooks Module implementation', async () => {
    /** Hooks Extension 发布包的 workspace manifest。 */
    const manifest = JSON.parse(await fs.readFile(
      path.join(repositoryRoot, 'packages/extensions/hooks/package.json'),
      'utf8',
    )) as {
      readonly name: string;
      readonly peerDependencies?: Record<string, string>;
      readonly dependencies?: Record<string, string>;
    };
    /** Claude Code 与 Codex Platform 的完整生产源码。 */
    const platforms = await Promise.all([
      sourceTree(path.join(repositoryRoot, 'packages/platforms/claude-code/src')),
      sourceTree(path.join(repositoryRoot, 'packages/platforms/codex/src')),
    ]);
    /** Hooks Extension 自身的完整生产源码。 */
    const extensionSource = await sourceTree(path.join(repositoryRoot, 'packages/extensions/hooks/src'));

    expect(manifest.name).toBe('@tokenroll/acplugin-extension-hooks');
    expect(manifest.peerDependencies).toEqual({ '@tokenroll/acplugin': 'workspace:^' });
    expect(manifest.dependencies).toBeUndefined();
    expect(platforms.join('\n')).not.toContain('@tokenroll/acplugin-extension-hooks');
    expect(extensionSource).not.toMatch(/\b(?:AcpluginModule|ModuleGenerateContext|TargetContribution|TargetId)\b/);
    await expect(fs.access(path.join(repositoryRoot, 'packages/module-hooks'))).rejects.toThrow();
  });
});
