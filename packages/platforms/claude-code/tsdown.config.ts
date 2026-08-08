import { defineConfig } from 'tsdown';

/** Claude Code Platform 包使用统一 Node ESM 与声明输出。 */
export default defineConfig({
  entry: ['./src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  dts: { generator: 'oxc' },
  clean: true,
  sourcemap: false,
  deps: { neverBundle: ['@tokenroll/acplugin'] },
});
