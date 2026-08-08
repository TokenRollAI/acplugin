import { defineConfig } from 'tsdown';

/** Hooks Extension 骨架保持主包为 Peer Dependency。 */
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
