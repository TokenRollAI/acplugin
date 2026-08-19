import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * 把测试工作区相对路径解析为可供 Vitest Alias 使用的绝对源码入口。
 *
 * @param path 相对于 packages/test 的入口路径。
 * @returns 绝对文件系统路径。
 */
function workspaceSource(path: string): string {
  return fileURLToPath(new URL(path, import.meta.url));
}

// 集成测试直接 Alias 到工作区源码；pretest 仍会按依赖顺序构建全部正式包，以覆盖真实产物路径。
export default defineConfig({
  test: {
    environment: 'node',
  },
  resolve: {
    alias: [
      { find: '@tokenroll/acplugin/sdk', replacement: workspaceSource('../acplugin/src/sdk.ts') },
      { find: '@acplugin/core/kernel-sdk', replacement: workspaceSource('../core/src/kernel-sdk.ts') },
      { find: '@acplugin/core/kernel-author', replacement: workspaceSource('../core/src/kernel-author.ts') },
      { find: '@acplugin/core', replacement: workspaceSource('../core/src/index.ts') },
      { find: '@tokenroll/acplugin', replacement: workspaceSource('../acplugin/src/index.ts') },
      { find: '@tokenroll/acplugin-platform-antigravity', replacement: workspaceSource('../platforms/antigravity/src/index.ts') },
      { find: '@tokenroll/acplugin-platform-claude-code', replacement: workspaceSource('../platforms/claude-code/src/index.ts') },
      { find: '@tokenroll/acplugin-platform-codex', replacement: workspaceSource('../platforms/codex/src/index.ts') },
      { find: '@tokenroll/acplugin-platform-cursor', replacement: workspaceSource('../platforms/cursor/src/index.ts') },
      { find: '@tokenroll/acplugin-platform-opencode', replacement: workspaceSource('../platforms/opencode/src/index.ts') },
      { find: '@tokenroll/acplugin-platform-pi', replacement: workspaceSource('../platforms/pi/src/index.ts') },
      { find: '@tokenroll/acplugin-extension-hooks', replacement: workspaceSource('../extensions/hooks/src/index.ts') },
      { find: '@tokenroll/acplugin-extension-mcp', replacement: workspaceSource('../extensions/mcp/src/index.ts') },
    ],
  },
});
