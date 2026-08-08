import { defineConfig } from 'tsdown';
import { fileURLToPath } from 'node:url';

/** MCP Extension 骨架保持主包为 Peer Dependency。 */
export default defineConfig({
  entry: {
    index: fileURLToPath(new URL('./src/index.ts', import.meta.url)),
    bundler: fileURLToPath(new URL('./src/bundler.ts', import.meta.url)),
  },
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  dts: { generator: 'oxc' },
  clean: true,
  sourcemap: false,
  deps: { neverBundle: ['@tokenroll/acplugin'] },
});
