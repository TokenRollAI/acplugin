import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import claudeCode, { PLATFORM_ID } from '@tokenroll/acplugin-platform-claude-code';

/** 跨包契约测试读取源码边界时使用的仓库根目录。 */
const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url));

/**
 * 递归读取 Claude Code Platform 的全部 TypeScript 源码。
 *
 * @param directory 当前需要遍历的源码目录。
 * @returns 按文件名稳定排序并拼接后的源码文本。
 */
async function platformSources(directory: string): Promise<string> {
  /** 当前目录按名称排序后的文件系统项。 */
  const entries = (await fs.readdir(directory, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name, 'en'));
  /** 当前目录与全部子目录累计的 TypeScript 源码。 */
  const sources: string[] = [];
  for (const entry of entries) {
    /** 当前目录项的绝对路径。 */
    const target = path.join(directory, entry.name);
    if (entry.isDirectory())
      sources.push(await platformSources(target));
    else if (entry.isFile() && entry.name.endsWith('.ts'))
      sources.push(await fs.readFile(target, 'utf8'));
  }
  return sources.join('\n');
}

describe('Claude Code public Platform integration', () => {
  it('exports an independent Platform factory with a frozen Marketplace contract', () => {
    /** 通过独立公开 package 创建的 Claude Code Platform。 */
    const platform = claudeCode({
      strict: false,
      defaultEnabled: false,
      marketplace: {
        owner: {
          name: 'TokenRoll',
          email: 'maintainers@example.com',
          url: 'https://github.com/TokenRollAI',
        },
        category: 'Developer Tools',
        tags: ['release'],
      },
    });

    expect(platform.id).toBe(PLATFORM_ID);
    expect(platform.strict).toBe(false);
    expect(platform.deliveryType).toBe('plugin');
    expect(platform.options).toEqual({
      defaultEnabled: false,
      marketplace: {
        owner: {
          name: 'TokenRoll',
          email: 'maintainers@example.com',
          url: 'https://github.com/TokenRollAI',
        },
        category: 'Developer Tools',
        tags: ['release'],
      },
    });
    expect(Object.isFrozen(platform.options)).toBe(true);
    expect(Object.isFrozen(platform.options!.marketplace)).toBe(true);
  });

  it('keeps Hooks and MCP implementation packages outside the Platform dependency boundary', async () => {
    /** Claude Code 公开 Platform 的完整源码文本。 */
    const source = await platformSources(path.join(repositoryRoot, 'packages/platforms/claude-code/src'));

    expect(source).not.toContain('@tokenroll/acplugin-extension-hooks');
    expect(source).not.toContain('@tokenroll/acplugin-extension-mcp');
    expect(source).not.toContain('@tokenroll/acplugin-module-hooks');
    expect(source).not.toContain('@tokenroll/acplugin-module-mcp');
  });
});
