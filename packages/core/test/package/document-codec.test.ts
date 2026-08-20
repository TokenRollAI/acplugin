import { describe, expect, it } from 'vitest';
import type { PackageDocumentSnapshot } from '../../src/contracts/index.js';
import { encodePackageDocument } from '../../src/package/documents.js';

/** @returns 指定格式和值的最小冻结 Document snapshot。 */
function document(format: PackageDocumentSnapshot['format'], value: PackageDocumentSnapshot['value']): PackageDocumentSnapshot {
  return Object.freeze({
    id: 'manifest',
    path: `manifest.${format}`,
    format,
    value,
    emission: 'required',
    extensionPoints: Object.freeze([]),
  });
}

/** @returns codec 字节的 UTF-8 文本。 */
function text(snapshot: PackageDocumentSnapshot): string {
  return new TextDecoder().decode(encodePackageDocument(snapshot));
}

describe('Core Package Document codec', () => {
  it('produces stable JSON, YAML, TOML and frontmatter golden bytes', () => {
    const value = { z: 2, a: { enabled: true } };
    expect(text(document('json', value))).toBe(`{
  "a": {
    "enabled": true
  },
  "z": 2
}
`);
    expect(text(document('yaml', value))).toBe('a:\n  enabled: true\nz: 2\n');
    expect(text(document('toml', value))).toBe('z = 2\n\n[a]\nenabled = true\n');
    expect(text(document('frontmatter', {
      frontmatter: { z: 2, a: 'value' },
      body: '  Body.  ',
    }))).toBe('---\na: value\nz: 2\n---\nBody.\n');
  });

  it('rejects unsupported roots and malformed frontmatter without lossy coercion', () => {
    expect(() => text(document('toml', ['not', 'an', 'object']))).toThrow('TOML Document root');
    expect(() => text(document('frontmatter', { frontmatter: {}, body: 'Body.', extra: true }))).toThrow('exactly');
    expect(() => text(document('frontmatter', { frontmatter: [], body: 'Body.' }))).toThrow('JSON object');
  });
});
