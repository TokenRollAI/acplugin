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

// 集成测试直接 Alias 到工作区源码；pretest 仍会构建 CLI 与公开 Extension 以覆盖真实产物路径。
export default defineConfig({
  test: {
    environment: 'node',
  },
  resolve: {
    alias: {
      '@acplugin/core': workspaceSource('../core/src/index.ts'),
      '@tokenroll/acplugin/platforms/claude-code': workspaceSource('../acplugin/src/platforms/claude-code.ts'),
      '@tokenroll/acplugin/platforms/codex': workspaceSource('../acplugin/src/platforms/codex.ts'),
      '@tokenroll/acplugin': workspaceSource('../acplugin/src/index.ts'),
      '@tokenroll/acplugin-extension-mcp': workspaceSource('../extensions/mcp/src/index.ts'),
    },
  },
});
