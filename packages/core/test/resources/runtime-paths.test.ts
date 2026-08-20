import { describe, expect, it } from 'vitest';
import {
  nodeRuntimeArtifactPath,
  nodeRuntimeLicensesArtifactPath,
} from '../../src/resources/runtime/paths.js';

describe('Node Runtime paths', () => {
  it('returns fixed predictable Package paths for valid entry IDs', () => {
    expect(nodeRuntimeArtifactPath('llmdoc')).toBe('runtime/llmdoc/main.mjs');
    expect(nodeRuntimeLicensesArtifactPath('local-tools')).toBe('runtime/local-tools/THIRD_PARTY_LICENSES.txt');
  });

  it('rejects values that are not canonical Runtime entry IDs', () => {
    for (const id of ['', 'Invalid', '../escape', 'nested/entry', 'cafe\u0301']) {
      expect(() => nodeRuntimeArtifactPath(id)).toThrow('lowercase kebab-case');
      expect(() => nodeRuntimeLicensesArtifactPath(id)).toThrow('lowercase kebab-case');
    }
  });
});
