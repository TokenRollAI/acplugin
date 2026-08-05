import { defineConfig } from 'tsdown';
import { fileURLToPath } from 'node:url';

// 私有 Claude Code Compiler 只构建 Node ESM，由主包内联而不单独发布。
export default defineConfig({
  entry: [fileURLToPath(new URL('./src/index.ts', import.meta.url))],
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  dts: { generator: 'oxc' },
  clean: true,
  sourcemap: false,
});
