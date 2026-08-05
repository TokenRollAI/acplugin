import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

function workspaceSource(path: string): string {
  return fileURLToPath(new URL(path, import.meta.url));
}

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
