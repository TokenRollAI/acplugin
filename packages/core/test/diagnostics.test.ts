import { describe, expect, it } from 'vitest';
import {
  compareCodeUnits,
  createBuildResult,
  DiagnosticCollector,
  internalPlatformId,
  redactReportValue,
  serializeBuildResult,
  stableJson,
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
  it('uses fixed UTF-16 code-unit order for Unicode strings and stable integer-shaped keys', () => {
    /** 覆盖 ASCII、组合字符、预组合字符与代理对的乱序字符串。 */
    const values = ['😀', 'é', 'z', 'e\u0301'];
    expect(values.sort(compareCodeUnits)).toEqual(['e\u0301', 'z', 'é', '😀']);

    /** 插入顺序不同但语义相同的对象；整数形 key 最终遵循 ECMAScript 固定顺序。 */
    const first = { '😀': 6, '10': 2, 'é': 5, '2': 1, 'z': 4, 'e\u0301': 3 };
    /** 与第一个对象字段相同但插入顺序不同的对照输入。 */
    const second = { 'e\u0301': 3, 'z': 4, '2': 1, 'é': 5, '10': 2, '😀': 6 };
    expect(stableJson(first)).toBe(stableJson(second));
    expect(Object.keys(JSON.parse(stableJson(first)) as object)).toEqual(['2', '10', 'e\u0301', 'z', 'é', '😀']);
  });

  it('produces byte-identical single-document JSON for different discovery orders', () => {
    /** 正向发现顺序产生的 JSON。 */
    const first = serializeBuildResult(createBuildResult(reportInput(false)));
    /** 反向发现顺序产生的 JSON。 */
    const second = serializeBuildResult(createBuildResult(reportInput(true)));

    expect(first).toBe(second);
    expect(first.endsWith('\n')).toBe(true);
    expect(JSON.parse(first)).toMatchObject({ schemaVersion: '1', command: 'inspect', success: true });
  });

  it('contains no timestamp, absolute path, credential, or Artifact bytes', () => {
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
    /** 执行结构化凭据与路径脱敏后的 JSON。 */
    const json = serializeBuildResult(result);

    expect(json).not.toContain('/Users/example');
    expect(json).not.toContain('report-secret');
    expect(json).not.toContain('timestamp');
    expect(json).not.toContain('Uint8Array');
    expect(json).toContain('<path>');
  });

  it('preserves protocol identities and ordinary text that match environment values', () => {
    /** REDACT-1 使用且需要在 finally 中恢复的环境变量。 */
    const environment = {
      ACPLUGIN_REDACT_PLATFORM: process.env.ACPLUGIN_REDACT_PLATFORM,
      ACPLUGIN_REDACT_UNIT: process.env.ACPLUGIN_REDACT_UNIT,
      ACPLUGIN_REDACT_VERSION: process.env.ACPLUGIN_REDACT_VERSION,
    };
    try {
      process.env.ACPLUGIN_REDACT_PLATFORM = 'claude';
      process.env.ACPLUGIN_REDACT_UNIT = 'plugin';
      process.env.ACPLUGIN_REDACT_VERSION = '1.0.0';
      /** 包含所有环境同字子串的公开程序化构建结果。 */
      const result = createBuildResult({
        ...reportInput(false),
        diagnostics: [{
          code: 'VERSION_NOTE',
          severity: 'warning',
          message: 'Version 1.0.0 builds the claude-code plugin.',
          phase: 'validate',
        }],
      });
      /** 最终 JSON 不得读取环境并改写合法协议字段。 */
      const json = serializeBuildResult(result);

      expect(json).toContain('claude-code');
      expect(json).toContain('plugin');
      expect(json).toContain('1.0.0');
      expect(json).not.toContain('<redacted-env>');
    } finally {
      for (const [name, value] of Object.entries(environment)) {
        if (value === undefined)
          delete process.env[name];
        else
          process.env[name] = value;
      }
    }
  });
});

describe('arbitrary value redaction', () => {
  it('preserves safe relative Artifact paths while redacting absolute paths', () => {
    expect(redactReportValue('extensions/bridge.txt')).toBe('extensions/bridge.txt');
    expect(redactReportValue('/private/project/extensions/bridge.txt')).toBe('<path>');
  });

  it('removes secret fields, functions, bytes, cycles, and temporary roots without guessing environment values', () => {
    /** 带循环、函数、字节和 Secret 的不可信任意对象。 */
    const unsafe: Record<string, unknown> = {
      apiToken: 'top-secret',
      /** callback 提供当前对象协议要求的回调实现。 */ callback: () => 'unsafe',
      bytes: new Uint8Array([1, 2, 3]),
      message: 'value env-secret at /private/root/.acplugin-work-123/cache',
    };
    unsafe.self = unsafe;
    /** 递归脱敏后的普通对象快照。 */
    const safe = redactReportValue(unsafe, { roots: ['/private/root'] });
    /** 稳定字符串形式便于断言原始敏感数据全部消失。 */
    const json = JSON.stringify(safe);

    expect(json).not.toContain('top-secret');
    expect(json).toContain('env-secret');
    expect(json).not.toContain('/private/root');
    expect(json).toContain('<redacted-credential>');
    expect(json).toContain('<redacted-bytes>');
    expect(json).toContain('<redacted-circular>');
  });
});
