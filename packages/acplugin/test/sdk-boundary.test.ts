import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** 当前主包源码根。 */
const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url));

describe('author and SDK package boundary', () => {
  it('keeps integration factories out of the root author facade', async () => {
    /** root 源码用于精确断言公开边界。 */
    const root = await readFile(new URL('index.ts', new URL('../src/', import.meta.url)), 'utf8');

    expect(root).not.toMatch(/\bdefinePlatform\b/);
    expect(root).not.toMatch(/\bdefineExtension\b/);
    expect(root).not.toMatch(/\bPlatformSession\b/);
    expect(root).not.toMatch(/\bExtensionSession\b/);
    expect(root).not.toMatch(/\bDeliveryUnit\b/);
    expect(root).not.toMatch(/\bArtifactInput\b/);
  });

  it('uses the single private Core SDK entry from the public sdk subpath', async () => {
    /** sdk 源码必须保持单一 re-export，以便 root/SDK/CLI 共享品牌实现。 */
    const sdk = await readFile(`${sourceRoot}sdk.ts`, 'utf8');

    expect(sdk).toContain('export * from \'@acplugin/core/integration\'');
    expect(sdk).not.toContain('@tokenroll/acplugin-platform-');
    expect(sdk).not.toContain('@tokenroll/acplugin-extension-');
  });
});
