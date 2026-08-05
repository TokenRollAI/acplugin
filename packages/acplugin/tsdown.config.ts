import { defineConfig } from 'tsdown';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  entry: {
    index: fileURLToPath(new URL('./src/index.ts', import.meta.url)),
    cli: fileURLToPath(new URL('./src/cli.ts', import.meta.url)),
  },
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  dts: true,
  clean: true,
  sourcemap: false,
  publint: true,
  attw: { profile: 'esm-only', level: 'error' },
  deps: {
    alwaysBundle: [
      '@acplugin/core',
      '@acplugin/compiler-claude-code',
      '@acplugin/compiler-codex',
    ],
    onlyBundle: [
      'semver',
      'yaml',
    ],
  },
});
