import { describe, expect, it } from 'vitest';
import { LIFECYCLE_API_VERSION } from '@acplugin/core';

describe('workspace', () => {
  it('resolves private production packages from the test workspace', () => {
    expect(LIFECYCLE_API_VERSION).toBe('1');
  });
});
