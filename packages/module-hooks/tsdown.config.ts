import { defineConfig } from 'tsdown';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  entry: [fileURLToPath(new URL('./src/index.ts', import.meta.url))],
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  dts: true,
  clean: true,
  sourcemap: false,
  publint: true,
  attw: { profile: 'esm-only', level: 'error' },
  deps: { neverBundle: ['@tokenroll/acplugin'] },
});
