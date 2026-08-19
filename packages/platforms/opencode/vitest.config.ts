import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/** OpenCode 单测让公开主包与私有 Core 共享同一源码品牌实例。 */
export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@tokenroll\/acplugin\/sdk$/,
        replacement: fileURLToPath(new URL('../../acplugin/src/sdk.ts', import.meta.url)),
      },
      {
        find: /^@tokenroll\/acplugin$/,
        replacement: fileURLToPath(new URL('../../acplugin/src/index.ts', import.meta.url)),
      },
      {
        find: /^@acplugin\/core$/,
        replacement: fileURLToPath(new URL('../../core/src/index.ts', import.meta.url)),
      },
    ],
  },
});
