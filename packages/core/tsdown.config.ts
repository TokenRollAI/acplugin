import { defineConfig } from 'tsdown';
import { fileURLToPath } from 'node:url';

// 私有 Core 生成 Node ESM 与 OXC 声明，由主包内联并供工作区类型检查复用。
export default defineConfig({
  entry: {
    'index': fileURLToPath(new URL('./src/index.ts', import.meta.url)),
    'kernel-author': fileURLToPath(new URL('./src/kernel-author.ts', import.meta.url)),
    'kernel-sdk': fileURLToPath(new URL('./src/kernel-sdk.ts', import.meta.url)),
  },
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  dts: { generator: 'oxc' },
  clean: true,
  sourcemap: false,
});
