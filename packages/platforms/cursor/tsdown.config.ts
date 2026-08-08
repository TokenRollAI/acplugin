import { defineConfig } from 'tsdown';

/** Cursor Platform 使用统一 Node 20 ESM 与声明输出。 */
export default defineConfig({
  entry: ['./src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  dts: { generator: 'oxc' },
  clean: true,
  sourcemap: false,
});
