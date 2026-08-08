import { defineConfig } from 'tsdown';

/** Codex Platform 骨架使用统一 Node ESM 与声明输出。 */
export default defineConfig({
  entry: ['./src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  dts: { generator: 'oxc' },
  clean: true,
  sourcemap: false,
});
