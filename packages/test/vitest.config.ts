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

// 集成测试直接 Alias 到工作区源码；pretest 仍会构建 CLI 与公开 Module 以覆盖真实产物路径。
export default defineConfig({
  test: {
    environment: 'node',
  },
  resolve: {
    alias: {
      '@acplugin/core': workspaceSource('../core/src/index.ts'),
      '@acplugin/compiler-claude-code': workspaceSource('../compiler-claude-code/src/index.ts'),
      '@acplugin/compiler-codex': workspaceSource('../compiler-codex/src/index.ts'),
      '@tokenroll/acplugin': workspaceSource('../acplugin/src/index.ts'),
      '@tokenroll/acplugin-module-hooks': workspaceSource('../module-hooks/src/index.ts'),
      '@tokenroll/acplugin-module-mcp': workspaceSource('../module-mcp/src/index.ts'),
    },
  },
});
