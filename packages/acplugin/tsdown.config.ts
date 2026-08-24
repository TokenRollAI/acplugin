import { defineConfig } from 'tsdown';
import { fileURLToPath } from 'node:url';

// 主包同时生成库入口与可执行 CLI；私有 Core 会内联，Migration 通过动态导入保留独立 Chunk。
export default defineConfig({
  entry: {
    index: fileURLToPath(new URL('./src/index.ts', import.meta.url)),
    sdk: fileURLToPath(new URL('./src/sdk.ts', import.meta.url)),
    cli: fileURLToPath(new URL('./src/cli.ts', import.meta.url)),
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
    // 主包内联私有 Core 与其闭包；新增 node_modules 依赖必须显式审阅后才能进入 tarball。
    onlyBundle: ['chokidar', 'readdirp', 'smol-toml', 'yaml'],
  },
});
