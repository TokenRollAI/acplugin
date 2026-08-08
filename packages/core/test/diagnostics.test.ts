import { describe, expect, it } from 'vitest';
import {
  createBuildResult,
  DiagnosticCollector,
  internalPlatformId,
  redactReportValue,
  serializeBuildResult,
  type BuildResultInput,
} from '../src/index.js';

/** 确定性报告测试共用的 Codex PlatformId。 */
const CODEX_PLATFORM = internalPlatformId('codex');
/** 确定性报告测试共用的 Claude Code PlatformId。 */
const CLAUDE_PLATFORM = internalPlatformId('claude-code');

/**
 * 使用指定发现顺序创建语义相同的 BuildResult 输入。
 *
 * @param reversed 是否反转全部无业务顺序的集合。
 * @returns 可验证稳定 serializer 的报告输入。
 */
function reportInput(reversed: boolean): BuildResultInput {
  /** 进入报告前已经过 Collector 清理的诊断。 */
  const diagnostics = new DiagnosticCollector();
  /** 两条诊断使用相反加入顺序验证最终排序。 */
  const diagnosticItems = [
    { code: 'Z_WARNING', severity: 'warning' as const, message: 'Later.', phase: 'validate', platform: CODEX_PLATFORM },
    { code: 'A_WARNING', severity: 'warning' as const, message: 'Earlier.', phase: 'validate', platform: CLAUDE_PLATFORM },
  ];
  for (const diagnostic of reversed ? [...diagnosticItems].reverse() : diagnosticItems)
    diagnostics.add(diagnostic);
  /** 两个交付单元故意按可变发现顺序提供。 */
  const deliveryUnits: BuildResultInput['deliveryUnits'] = [
    {
      platform: CODEX_PLATFORM,
      id: 'plugin',
      role: 'primary',
      type: 'plugin',
      artifacts: [
        { path: 'skills/z/SKILL.md', owner: 'platform:codex', mode: 0o644, size: 2, sha256: 'b'.repeat(64) },
        { path: 'manifest.json', owner: 'platform:codex', mode: 0o644, size: 1, sha256: 'a'.repeat(64) },
      ],
    },
    {
      platform: CLAUDE_PLATFORM,
      id: 'plugin',
      role: 'primary',
      type: 'plugin',
      artifacts: [],
    },
  ];
  /** Platform 详情使用相反顺序验证报告排序。 */
  const platformDetails: BuildResultInput['platformDetails'] = [
    { id: CODEX_PLATFORM, apiVersion: '1', deliveryType: 'plugin', strict: true },
    { id: CLAUDE_PLATFORM, apiVersion: '1', deliveryType: 'plugin', strict: true },
  ];
  /** Component 摘要使用相反顺序验证种类与 ID 排序。 */
  const components: BuildResultInput['components'] = [
    { kind: 'skill', id: 'z' },
    { kind: 'command', id: 'a' },
  ];
  /** Extension 摘要使用相反顺序验证名称排序。 */
  const extensions: BuildResultInput['extensions'] = [
    { name: 'z-extension', apiVersion: '1', hasResources: true },
    { name: 'a-extension', apiVersion: '1', hasResources: false },
  ];
  /** Document 摘要使用相反顺序验证 Platform 与逻辑 ID 排序。 */
  const documents: BuildResultInput['documents'] = [
    { platform: CODEX_PLATFORM, id: 'z', path: 'z.json', format: 'json', owner: 'platform:codex' },
    { platform: CLAUDE_PLATFORM, id: 'a', path: 'a.json', format: 'json', owner: 'platform:claude-code' },
  ];
  /** 两条兼容性结论用于验证 Platform 与 Subject 排序。 */
  const compatibility: BuildResultInput['compatibility'] = [
    { platform: CODEX_PLATFORM, subject: 'skill:z', capability: 'component', level: 'native', reason: 'Supported.' },
    { platform: CLAUDE_PLATFORM, subject: 'skill:a', capability: 'component', level: 'native', reason: 'Supported.' },
  ];
  /** 两条元数据去向用于验证字段排序。 */
  const metadata: BuildResultInput['metadata'] = [
    { platform: CODEX_PLATFORM, field: 'version', disposition: 'emitted', output: 'manifest.version', reason: 'Supported.' },
    { platform: CLAUDE_PLATFORM, field: 'name', disposition: 'emitted', output: 'manifest.name', reason: 'Supported.' },
  ];
  return {
    command: 'inspect',
    success: true,
    committed: false,
    platforms: reversed ? [CODEX_PLATFORM, CLAUDE_PLATFORM] : [CLAUDE_PLATFORM, CODEX_PLATFORM],
    platformDetails: reversed ? [...platformDetails].reverse() : platformDetails,
    components: reversed ? [...components].reverse() : components,
    extensions: reversed ? [...extensions].reverse() : extensions,
    documents: reversed ? [...documents].reverse() : documents,
    deliveryUnits: reversed ? [...deliveryUnits].reverse() : deliveryUnits,
    diagnostics: diagnostics.diagnostics,
    compatibility: reversed ? [...compatibility].reverse() : compatibility,
    metadata: reversed ? [...metadata].reverse() : metadata,
  };
}

describe('stable BuildResult report', () => {
  it('produces byte-identical single-document JSON for different discovery orders', () => {
    /** 正向发现顺序产生的 JSON。 */
    const first = serializeBuildResult(createBuildResult(reportInput(false)), { environment: {} });
    /** 反向发现顺序产生的 JSON。 */
    const second = serializeBuildResult(createBuildResult(reportInput(true)), { environment: {} });

    expect(first).toBe(second);
    expect(first.endsWith('\n')).toBe(true);
    expect(JSON.parse(first)).toMatchObject({ schemaVersion: '1', command: 'inspect', success: true });
  });

  it('contains no timestamp, absolute path, credential, environment value, or Artifact bytes', () => {
    /** 以可疑 owner 和路径验证最终 serializer 的恶意报告。 */
    const result = createBuildResult({
      command: 'build',
      success: false,
      committed: false,
      platforms: [CODEX_PLATFORM],
      platformDetails: [],
      components: [],
      extensions: [],
      documents: [],
      deliveryUnits: [{
        platform: CODEX_PLATFORM,
        id: 'plugin',
        role: 'primary',
        type: 'plugin',
        artifacts: [{
          path: '/Users/example/private/artifact.json',
          owner: 'Bearer report-secret',
          mode: 0o644,
          size: 4,
          sha256: 'a'.repeat(64),
        }],
      }],
      diagnostics: [],
      compatibility: [],
      metadata: [],
    });
    /** 使用显式环境值执行深度脱敏后的 JSON。 */
    const json = serializeBuildResult(result, { environment: { REPORT_TOKEN: 'report-secret' } });

    expect(json).not.toContain('/Users/example');
    expect(json).not.toContain('report-secret');
    expect(json).not.toContain('timestamp');
    expect(json).not.toContain('Uint8Array');
    expect(json).toContain('<path>');
  });

  it('redacts custom environment secrets from the programmatic BuildResult itself', () => {
    /** 进入所有自由文本报告字段的自定义环境 Secret。 */
    const secret = 'programmatic-secret-value';
    /** 尚未经过 JSON serializer 的公开程序化构建结果。 */
    const result = createBuildResult({
      ...reportInput(false),
      diagnostics: [{
        code: 'SECRET_WARNING',
        severity: 'warning',
        message: `Diagnostic contains ${secret}.`,
        phase: 'validate',
        hint: `Do not expose ${secret}.`,
      }],
      compatibility: [{
        platform: CODEX_PLATFORM,
        subject: 'skill:secret',
        capability: 'component',
        level: 'degraded',
        reason: `Compatibility contains ${secret}.`,
      }],
      metadata: [{
        platform: CODEX_PLATFORM,
        field: 'description',
        disposition: 'omitted',
        reason: `Metadata contains ${secret}.`,
      }],
    }, { environment: { CUSTOM_SECRET: secret } });
    /** 直接 stringify 用于证明调用方无需经过 serializeBuildResult 才获得安全结果。 */
    const programmaticJson = JSON.stringify(result);

    expect(programmaticJson).not.toContain(secret);
    expect(programmaticJson).toContain('<redacted-env>');
  });
});

describe('arbitrary value redaction', () => {
  it('preserves safe relative Artifact paths while redacting absolute paths', () => {
    expect(redactReportValue('extensions/bridge.txt')).toBe('extensions/bridge.txt');
    expect(redactReportValue('/private/project/extensions/bridge.txt')).toBe('<path>');
  });

  it('removes secret fields, functions, bytes, cycles, temporary roots, and environment values', () => {
    /** 带循环、函数、字节和 Secret 的不可信任意对象。 */
    const unsafe: Record<string, unknown> = {
      apiToken: 'top-secret',
      /** callback 提供当前对象协议要求的回调实现。 */ callback: () => 'unsafe',
      bytes: new Uint8Array([1, 2, 3]),
      message: 'value env-secret at /private/root/.acplugin-work-123/cache',
    };
    unsafe.self = unsafe;
    /** 递归脱敏后的普通对象快照。 */
    const safe = redactReportValue(unsafe, {
      roots: ['/private/root'],
      environment: { FIXTURE_SECRET: 'env-secret' },
    });
    /** 稳定字符串形式便于断言原始敏感数据全部消失。 */
    const json = JSON.stringify(safe);

    expect(json).not.toContain('top-secret');
    expect(json).not.toContain('env-secret');
    expect(json).not.toContain('/private/root');
    expect(json).toContain('<redacted-credential>');
    expect(json).toContain('<redacted-bytes>');
    expect(json).toContain('<redacted-circular>');
  });
});
