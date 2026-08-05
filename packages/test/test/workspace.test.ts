import { describe, expect, it } from 'vitest';
import { CORE_SCHEMA_VERSION } from '@acplugin/core';

describe('workspace', () => {
  it('resolves private production packages from the test workspace', () => {
    expect(CORE_SCHEMA_VERSION).toBe('1');
  });
});
