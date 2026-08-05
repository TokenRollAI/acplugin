import { defineConfig } from 'tsdown';
import { fileURLToPath } from 'node:url';

// 公开 MCP Module 保持主包为 Peer Dependency，并在构建后执行发布结构检查。
export default defineConfig({
  entry: [fileURLToPath(new URL('./src/index.ts', import.meta.url))],
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  dts: { generator: 'oxc' },
  clean: true,
  sourcemap: false,
  publint: true,
  attw: { profile: 'esm-only', level: 'error' },
  deps: { neverBundle: ['@tokenroll/acplugin'] },
});
