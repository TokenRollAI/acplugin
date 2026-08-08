import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { JsonValue, PlatformValidateContext } from '@acplugin/core';
import { WORKSPACE_CONFIG_PATH } from './config-document.js';

/** OpenCode workspace 配置由 Platform/Extension 允许生成的根字段。 */
const CONFIG_FIELDS = new Set(['$schema', 'mcp']);

/** JSON 对象的运行时只读索引类型。 */
type JsonRecord = Record<string, JsonValue>;

/**
 * 判断未知值是否为非数组 JSON 对象。
 *
 * @param value 从候选配置解析的未知值。
 * @returns 可以按字段读取时返回 true。
 */
function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 向 Core 提交 OpenCode 候选校验错误。
 *
 * @param context Platform validateBundle 生命周期上下文。
 * @param code 稳定诊断码。
 * @param message 不包含宿主绝对路径的错误信息。
 */
function report(context: PlatformValidateContext, code: string, message: string): void {
  context.reportDiagnostic({ code, severity: 'error', message });
}

/**
 * 校验 OpenCode workspace 只包含受控资源和按需配置。
 *
 * @param context Platform 提供的已物化候选交付单元。
 */
export async function validateOpenCodeBundle(context: PlatformValidateContext): Promise<void> {
  /** 当前候选交付单元的规范 Artifact 路径集合。 */
  const artifacts = new Set(context.candidate.unit.artifacts.map(artifact => artifact.path));
  if (artifacts.has('package.json'))
    report(context, 'OPENCODE_PACKAGE_JSON_FORBIDDEN', 'OpenCode workspace delivery must not generate a generic package.json.');
  if (!artifacts.has(WORKSPACE_CONFIG_PATH))
    return;
  try {
    /** 按需配置必须是只包含 Platform/Extension 所有字段的 JSON 对象。 */
    const value: unknown = JSON.parse(await fs.readFile(path.join(context.candidate.root, WORKSPACE_CONFIG_PATH), 'utf8'));
    if (!isRecord(value))
      throw new TypeError('Config is not an object.');
    /** field 表示当前配置根字段，用于阻止任意消费工程配置注入。 */
    for (const field of Object.keys(value)) {
      if (!CONFIG_FIELDS.has(field))
        report(context, 'OPENCODE_CONFIG_FIELD_UNKNOWN', `Unknown generated OpenCode config field "${field}".`);
    }
    if (value.mcp !== undefined && !isRecord(value.mcp))
      report(context, 'OPENCODE_MCP_CONFIG_INVALID', 'opencode.json.mcp must be an object.');
  } catch {
    report(context, 'OPENCODE_CONFIG_READ_FAILED', 'opencode.json must contain a valid JSON object.');
  }
}
