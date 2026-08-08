import { defineConfig } from 'tsdown';
import { fileURLToPath } from 'node:url';

// 主包同时生成库入口与可执行 CLI；私有 Core/Platform 会内联，Migration 通过动态导入保留独立 Chunk。
export default defineConfig({
  entry: {
    'index': fileURLToPath(new URL('./src/index.ts', import.meta.url)),
    'cli': fileURLToPath(new URL('./src/cli.ts', import.meta.url)),
    'platforms/claude-code': fileURLToPath(new URL('./src/platforms/claude-code.ts', import.meta.url)),
    'platforms/codex': fileURLToPath(new URL('./src/platforms/codex.ts', import.meta.url)),
    'platforms/cursor': fileURLToPath(new URL('./src/platforms/cursor.ts', import.meta.url)),
    'platforms/antigravity': fileURLToPath(new URL('./src/platforms/antigravity.ts', import.meta.url)),
    'platforms/opencode': fileURLToPath(new URL('./src/platforms/opencode.ts', import.meta.url)),
    'platforms/pi': fileURLToPath(new URL('./src/platforms/pi.ts', import.meta.url)),
  },
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  dts: { generator: 'oxc' },
  clean: true,
  sourcemap: false,
  publint: true,
  attw: { profile: 'esm-only', level: 'error' },
  deps: {
    alwaysBundle: [
      '@acplugin/core',
      '@acplugin/platform-antigravity',
      '@acplugin/platform-claude-code',
      '@acplugin/platform-codex',
      '@acplugin/platform-cursor',
      '@acplugin/platform-opencode',
      '@acplugin/platform-pi',
      '@tokenroll/acplugin-extension-mcp',
    ],
    onlyBundle: [
      'image-size',
      'saxes',
      'yaml',
      'xmlchars',
    ],
  },
});
