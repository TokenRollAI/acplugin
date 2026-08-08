import { describe, expect, it } from 'vitest';
import {
  CompatibilityCollector,
  DiagnosticCollector,
  internalPlatformId,
  MetadataDispositionCollector,
} from '../src/index.js';

/** 兼容性和元数据测试共用的 Codex 开放 PlatformId。 */
const CODEX_PLATFORM = internalPlatformId('codex');

describe('compatibility collector', () => {
  it('orders levels and propagates the worst dependency with a complete cause chain', () => {
    /** 以故意打乱的顺序加入原始 Subject 兼容性。 */
    const compatibility = new CompatibilityCollector();
    compatibility.addAll([
      { platform: CODEX_PLATFORM, subject: 'skill:b', capability: 'component', level: 'native', reason: 'Native Skill.' },
      { platform: CODEX_PLATFORM, subject: 'agent:c', capability: 'component', level: 'unsupported', reason: 'Agent unavailable.' },
      { platform: CODEX_PLATFORM, subject: 'command:a', capability: 'component', level: 'native', reason: 'Native Command.' },
      { platform: CODEX_PLATFORM, subject: 'skill:d', capability: 'component', level: 'transform', reason: 'Semantic transform.' },
    ]);
    compatibility.propagateDependencies([
      { subject: 'command:a', dependsOn: ['skill:b'] },
      { subject: 'skill:b', dependsOn: ['agent:c'] },
    ]);

    expect(compatibility.entries.map(entry => entry.level)).toEqual([
      'unsupported', 'native', 'unsupported', 'native', 'unsupported', 'transform',
    ]);
    expect(compatibility.entries).toContainEqual(expect.objectContaining({
      subject: 'command:a', level: 'unsupported', causes: ['skill:b', 'agent:c'],
    }));
    expect(compatibility.entries).toContainEqual(expect.objectContaining({
      subject: 'skill:b', level: 'unsupported', causes: ['agent:c'],
    }));
  });

  it('relaxes only functional compatibility while structural errors still fail', () => {
    /** 同时接收结构错误和 relaxed compatibility warning 的诊断集合。 */
    const diagnostics = new DiagnosticCollector();
    diagnostics.error('SCHEMA_INVALID', 'A required field is invalid.', { phase: 'scan' });
    /** 当前 Platform 的单项降级结论。 */
    const compatibility = new CompatibilityCollector();
    compatibility.add({
      platform: CODEX_PLATFORM,
      subject: 'agent:reviewer',
      capability: 'model',
      level: 'degraded',
      reason: 'The model constraint is not preserved.',
    });
    compatibility.applyStrictness(diagnostics, { id: CODEX_PLATFORM, strict: false });

    expect(diagnostics.hasErrors).toBe(true);
    expect(diagnostics.diagnostics).toContainEqual(expect.objectContaining({ code: 'SCHEMA_INVALID', severity: 'error' }));
    expect(diagnostics.diagnostics).toContainEqual(expect.objectContaining({ code: 'COMPATIBILITY_RELAXED', severity: 'warning' }));
  });

  it('accepts native and transform in strict mode but rejects degraded and unsupported', () => {
    /** 严格模式下接收全部四个兼容性等级的诊断集合。 */
    const diagnostics = new DiagnosticCollector();
    /** 覆盖四个有序等级的兼容性集合。 */
    const compatibility = new CompatibilityCollector();
    compatibility.addAll([
      { platform: CODEX_PLATFORM, subject: 'skill:native', capability: 'component', level: 'native', reason: 'Native.' },
      { platform: CODEX_PLATFORM, subject: 'command:transform', capability: 'component', level: 'transform', reason: 'Transformed.' },
      { platform: CODEX_PLATFORM, subject: 'agent:degraded', capability: 'component', level: 'degraded', reason: 'Degraded.' },
      { platform: CODEX_PLATFORM, subject: 'hook:unsupported', capability: 'component', level: 'unsupported', reason: 'Unsupported.' },
    ]);
    compatibility.applyStrictness(diagnostics, { id: CODEX_PLATFORM, strict: true });

    expect(diagnostics.diagnostics.filter(item => item.code === 'COMPATIBILITY_STRICT')).toHaveLength(2);
  });

  it('applies strictness to generate checkpoints and dependency propagation without duplicating earlier conclusions', () => {
    /** 模拟 prepare/Adapter、generateBundle 和依赖传播共用的兼容性集合。 */
    const compatibility = new CompatibilityCollector();
    /** 严格与宽松 Platform 分别验证 error 和 warning。 */
    const strictDiagnostics = new DiagnosticCollector();
    /** relaxed checkpoint 只应收到新结论对应的 warning。 */
    const relaxedDiagnostics = new DiagnosticCollector();
    compatibility.addAll([
      { platform: CODEX_PLATFORM, subject: 'skill:dependency', capability: 'component', level: 'unsupported', reason: 'Dependency unsupported.' },
      { platform: CODEX_PLATFORM, subject: 'command:consumer', capability: 'component', level: 'native', reason: 'Command supported.' },
    ]);
    compatibility.applyStrictness(strictDiagnostics, { id: CODEX_PLATFORM, strict: true });
    /** generateBundle 开始前的 checkpoint。 */
    const generateStart = compatibility.size;
    compatibility.add({
      platform: CODEX_PLATFORM,
      subject: 'bundle:plugin',
      capability: 'packaging',
      level: 'degraded',
      reason: 'Bundle packaging degraded.',
    });
    compatibility.applyStrictness(strictDiagnostics, { id: CODEX_PLATFORM, strict: true }, generateStart);
    compatibility.applyStrictness(relaxedDiagnostics, { id: CODEX_PLATFORM, strict: false }, generateStart);
    /** 依赖传播开始前的 checkpoint。 */
    const propagationStart = compatibility.size;
    compatibility.propagateDependencies([
      { subject: 'command:consumer', dependsOn: ['skill:dependency'] },
    ]);
    compatibility.applyStrictness(strictDiagnostics, { id: CODEX_PLATFORM, strict: true }, propagationStart);
    compatibility.applyStrictness(relaxedDiagnostics, { id: CODEX_PLATFORM, strict: false }, propagationStart);

    expect(strictDiagnostics.diagnostics.filter(item => item.code === 'COMPATIBILITY_STRICT')).toHaveLength(3);
    expect(strictDiagnostics.diagnostics).toContainEqual(expect.objectContaining({ message: expect.stringContaining('bundle:plugin') }));
    expect(strictDiagnostics.diagnostics).toContainEqual(expect.objectContaining({ message: expect.stringContaining('command:consumer') }));
    expect(relaxedDiagnostics.diagnostics.filter(item => item.code === 'COMPATIBILITY_RELAXED')).toHaveLength(2);
  });
});

describe('metadata disposition collector', () => {
  it('reports omitted fields as warnings without failing strict feature compatibility', () => {
    /** 元数据 warning 和功能 strictness 共用的诊断集合。 */
    const diagnostics = new DiagnosticCollector();
    /** 记录 emitted 与 omitted 字段去向的 Collector。 */
    const metadata = new MetadataDispositionCollector(diagnostics);
    metadata.add({ platform: CODEX_PLATFORM, field: 'name', disposition: 'emitted', output: 'manifest.name', reason: 'Supported.' });
    metadata.add({ platform: CODEX_PLATFORM, field: 'author.url', disposition: 'omitted', reason: 'The platform has no field.' });
    /** 只有完整支持条目的严格功能 Collector。 */
    const compatibility = new CompatibilityCollector();
    compatibility.add({ platform: CODEX_PLATFORM, subject: 'skill:hello', capability: 'component', level: 'native', reason: 'Supported.' });
    compatibility.applyStrictness(diagnostics, { id: CODEX_PLATFORM, strict: true });

    expect(diagnostics.hasErrors).toBe(false);
    expect(diagnostics.diagnostics).toContainEqual(expect.objectContaining({
      code: 'METADATA_OMITTED', severity: 'warning', fieldPath: ['author.url'],
    }));
    expect(metadata.entries.map(entry => entry.field)).toEqual(['author.url', 'name']);
  });
});
