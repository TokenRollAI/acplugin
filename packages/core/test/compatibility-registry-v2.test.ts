import { describe, expect, it } from 'vitest';
import type { CanonicalProject } from '../src/kernel-types.js';
import { DiagnosticRegistry } from '../src/kernel/diagnostic-registry.js';
import { CompatibilityRegistry, compatibilityTupleKey } from '../src/package/compatibility-registry.js';

/** @returns 带 Command → Skill 依赖和可选 metadata 的 Project。 */
function project(): CanonicalProject {
  const requires = (skills: readonly string[] = []) => Object.freeze({ skills: Object.freeze(skills), agents: Object.freeze([]) });
  return Object.freeze({
    metadata: Object.freeze({
      name: 'compatibility', version: '1.0.0', description: 'Compatibility.', displayName: 'Compatibility',
      author: Object.freeze({ name: 'TokenRoll' }), keywords: Object.freeze([]),
    }),
    commands: Object.freeze([{
      kind: 'command' as const, id: 'check', description: 'Check.', body: 'Check.', location: { path: 'src/commands/check.md', bodyLine: 4 },
      requires: requires(['review']), platforms: Object.freeze({}),
    }]),
    skills: Object.freeze([{
      kind: 'skill' as const, id: 'review', description: 'Review.', body: 'Review.', invocation: { user: true, model: true },
      location: { path: 'src/skills/review/SKILL.md', bodyLine: 4 }, requires: requires(), platforms: Object.freeze({}), auxiliaryFiles: Object.freeze([]),
    }]),
    agents: Object.freeze([]),
    publicFiles: Object.freeze([]),
  });
}

/** @returns 覆盖当前 Project 实际 metadata 字段的输入。 */
function metadata() {
  return ['name', 'version', 'description', 'displayName', 'author.name'].map(field => ({
    field, disposition: 'emitted' as const, output: `manifest.${field}`, reason: 'Emitted.',
  }));
}

describe('Compatibility Registry v2', () => {
  it('propagates dependency degradation and enforces strictness once on the final graph', () => {
    const diagnostics = new DiagnosticRegistry();
    const registry = new CompatibilityRegistry({ project: project(), diagnostics });
    registry.addCompatibility('target', [
      { subject: 'command:check', capability: 'component', level: 'native', reason: 'Native.' },
      { subject: 'skill:review', capability: 'component', level: 'unsupported', reason: 'Unavailable.' },
    ]);
    registry.addMetadata('target', metadata());
    const result = registry.finalize([{ id: 'target', strict: true }]);

    expect(result.compatibility.find(entry => entry.subject === 'command:check')).toMatchObject({
      level: 'unsupported', causes: [compatibilityTupleKey('skill:review', 'component')],
    });
    expect(diagnostics.diagnostics.filter(item => item.code === 'COMPATIBILITY_STRICT_FAILURE')).toHaveLength(2);
  });

  it('reports exact Component/metadata coverage and relaxed warnings', () => {
    const diagnostics = new DiagnosticRegistry();
    const registry = new CompatibilityRegistry({ project: project(), diagnostics });
    registry.addCompatibility('target', [
      { subject: 'command:check', capability: 'component', level: 'degraded', reason: 'UI discoverability differs.' },
    ]);
    registry.addMetadata('target', [
      { field: 'name', disposition: 'emitted', output: 'manifest.name', reason: 'Emitted.' },
      { field: 'homepage', disposition: 'omitted', reason: 'Absent.' },
    ]);
    registry.finalize([{ id: 'target', strict: false }]);

    expect(diagnostics.diagnostics.map(item => item.code)).toEqual(expect.arrayContaining([
      'COMPATIBILITY_COMPONENT_MISSING', 'METADATA_DISPOSITION_MISSING',
      'METADATA_DISPOSITION_UNUSED', 'COMPATIBILITY_RELAXED',
    ]));
    expect(diagnostics.diagnostics.find(item => item.code === 'COMPATIBILITY_RELAXED')?.severity).toBe('warning');
  });

  it('rejects duplicate tuples and missing, self or cyclic causes', () => {
    const diagnostics = new DiagnosticRegistry();
    const duplicate = new CompatibilityRegistry({ project: project(), diagnostics });
    duplicate.addCompatibility('target', [{ subject: 'skill:review', capability: 'component', level: 'native', reason: 'Native.' }]);
    expect(() => duplicate.addCompatibility('target', [{ subject: 'skill:review', capability: 'component', level: 'native', reason: 'Native.' }])).toThrow('duplicated');

    const missing = new CompatibilityRegistry({ project: project(), diagnostics: new DiagnosticRegistry() });
    missing.addCompatibility('target', [
      { subject: 'skill:review', capability: 'component', level: 'native', reason: 'Native.', causes: ['agent:missing#component'] },
      { subject: 'command:check', capability: 'component', level: 'native', reason: 'Native.' },
    ]);
    missing.addMetadata('target', metadata());
    expect(() => missing.finalize([{ id: 'target', strict: true }])).toThrow('missing or self');

    const cyclic = new CompatibilityRegistry({ project: project(), diagnostics: new DiagnosticRegistry() });
    cyclic.addCompatibility('target', [
      { subject: 'skill:review', capability: 'component', level: 'native', reason: 'Native.', causes: ['command:check#component'] },
      { subject: 'command:check', capability: 'component', level: 'native', reason: 'Native.', causes: ['skill:review#component'] },
    ]);
    cyclic.addMetadata('target', metadata());
    expect(() => cyclic.finalize([{ id: 'target', strict: true }])).toThrow('cycle');
  });

  it('rejects compatibility and metadata accessors, classes, Symbols and mutable nested inputs', () => {
    const diagnostics = new DiagnosticRegistry();
    const registry = new CompatibilityRegistry({ project: project(), diagnostics });
    class Entry {}
    const accessor = Object.defineProperty({}, 'subject', { get: () => 'skill:review', enumerable: true });
    expect(() => registry.addCompatibility('target', [new Entry() as never])).toThrow('plain object');
    expect(() => registry.addCompatibility('target', [accessor as never])).toThrow('data property');
    expect(() => registry.addCompatibility('target', [{
      subject: 'skill:review', capability: 'component', level: 'native', reason: 'Native.', [Symbol('hidden')]: true,
    } as never])).toThrow('Symbol');
    expect(() => registry.addMetadata('target', [Object.defineProperty({}, 'field', {
      get: () => 'name', enumerable: true,
    }) as never])).toThrow('data property');

    const causes = ['command:check#component'];
    registry.addCompatibility('target', [{
      subject: 'skill:review', capability: 'component', level: 'native', reason: 'Native.', causes,
    }]);
    causes[0] = 'agent:mutated#component';
    registry.addCompatibility('target', [{ subject: 'command:check', capability: 'component', level: 'native', reason: 'Native.' }]);
    registry.addMetadata('target', metadata());
    expect(registry.finalize([{ id: 'target', strict: true }]).compatibility[1]?.causes).toEqual(['command:check#component']);
  });

  it('sanitizes compatibility and diagnostic free text without reading environment values', () => {
    const diagnostics = new DiagnosticRegistry();
    diagnostics.report('package', {
      code: 'UNSAFE_TEXT', severity: 'error', message: 'Bearer top-secret failed at /Users/example/private/file.ts\nnext',
    });
    expect(diagnostics.diagnostics[0]?.message).toBe('<redacted-credential> failed at <path> next');
  });
});
