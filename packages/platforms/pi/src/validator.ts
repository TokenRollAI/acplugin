import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { JsonValue, PlatformValidateContext } from '@tokenroll/acplugin';
import { PACKAGE_MANIFEST_PATH } from './manifest.js';

/** acplugin 允许写入 Pi package.json 的固定根字段。 */
const PACKAGE_FIELDS = new Set([
  'name', 'version', 'description', 'type', 'author', 'homepage', 'repository', 'license', 'keywords', 'pi',
]);

/** Pi discovery 对象允许的固定字段。 */
const PI_FIELDS = new Set(['extensions', 'skills', 'prompts', 'themes', 'image', 'video']);

/** JSON 对象的运行时只读索引类型。 */
type JsonRecord = Record<string, JsonValue>;

/**
 * 判断未知值是否为非数组 JSON 对象。
 *
 * @param value 从候选清单解析的未知值。
 * @returns 可以按字段读取时返回 true。
 */
function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 向 Core 提交 Pi package 候选校验错误。
 *
 * @param context Platform validateBundle 生命周期上下文。
 * @param code 稳定诊断码。
 * @param message 不包含宿主绝对路径的错误信息。
 */
function report(context: PlatformValidateContext, code: string, message: string): void {
  context.reportDiagnostic({ code, severity: 'error', message });
}

/**
 * 校验一个 Pi discovery 路径数组安全且有对应 Artifact。
 *
 * @param context Platform validateBundle 生命周期上下文。
 * @param artifacts 当前 Artifact 路径集合。
 * @param field Pi discovery 字段名。
 * @param value 待验证的数组值。
 */
function validateDiscoveryPaths(
  context: PlatformValidateContext,
  artifacts: ReadonlySet<string>,
  field: string,
  value: JsonValue,
): void {
  if (!Array.isArray(value) || value.length === 0 || value.some(item => typeof item !== 'string' || !item.startsWith('./'))) {
    report(context, 'PI_DISCOVERY_PATH_INVALID', `pi.${field} must contain safe package-root paths.`);
    return;
  }
  /** reference 表示当前 Pi package discovery 根。 */
  for (const reference of value as readonly string[]) {
    /** 去掉 `./` 和尾部斜线后的 Artifact 路径前缀。 */
    const target = reference.slice(2).replace(/\/+$/u, '');
    if (target === '' || target === '..' || target.startsWith('../')
      || ![...artifacts].some(artifact => artifact === target || artifact.startsWith(`${target}/`))) {
      report(context, 'PI_DISCOVERY_PATH_MISSING', `pi.${field} references a missing package resource.`);
    }
  }
}

/**
 * 校验 Pi npm package 不泄漏 workspace/private 字段且能发现全部资源。
 *
 * @param context Platform 提供的已物化候选交付单元。
 */
export async function validatePiBundle(context: PlatformValidateContext): Promise<void> {
  /** 当前候选交付单元的规范 Artifact 路径集合。 */
  const artifacts = new Set(context.candidate.unit.artifacts.map(artifact => artifact.path));
  /** 从候选根加载且仍需严格校验的 package manifest。 */
  let manifest: JsonRecord;
  try {
    /** JSON.parse 返回的未知值必须继续验证对象形态。 */
    const value: unknown = JSON.parse(await fs.readFile(path.join(context.candidate.root, PACKAGE_MANIFEST_PATH), 'utf8'));
    if (!isRecord(value))
      throw new TypeError('Manifest is not an object.');
    manifest = value;
  } catch {
    report(context, 'PI_PACKAGE_READ_FAILED', 'package.json must contain a JSON object.');
    return;
  }
  /** field 表示当前 package.json 根字段，用于阻止 workspace/private 泄漏。 */
  for (const field of Object.keys(manifest)) {
    if (!PACKAGE_FIELDS.has(field))
      report(context, 'PI_PACKAGE_FIELD_UNKNOWN', `Unknown generated Pi package field "${field}".`);
  }
  if (Object.hasOwn(manifest, 'private') || Object.hasOwn(manifest, 'workspaces'))
    report(context, 'PI_PACKAGE_WORKSPACE_LEAK', 'Pi delivery package must not contain private or workspaces.');
  if (typeof manifest.name !== 'string' || manifest.name.trim().length === 0
    || typeof manifest.version !== 'string' || manifest.version.trim().length === 0
    || typeof manifest.description !== 'string' || manifest.description.trim().length === 0) {
    report(context, 'PI_PACKAGE_METADATA_INVALID', 'Pi package requires non-empty name, version, and description.');
  }
  if (!Array.isArray(manifest.keywords) || !manifest.keywords.includes('pi-package'))
    report(context, 'PI_PACKAGE_KEYWORD_MISSING', 'Pi package keywords must include pi-package.');
  if (!isRecord(manifest.pi)) {
    report(context, 'PI_DISCOVERY_CONFIG_INVALID', 'package.json.pi must be an object.');
    return;
  }
  /** field 表示当前 Pi discovery 字段，用于拒绝任意 package loader 配置。 */
  for (const field of Object.keys(manifest.pi)) {
    if (!PI_FIELDS.has(field))
      report(context, 'PI_DISCOVERY_FIELD_UNKNOWN', `Unknown generated Pi discovery field "${field}".`);
  }
  /** field 表示当前可能由 Platform 或 Hooks Extension 生成的资源目录数组。 */
  for (const field of ['skills', 'prompts', 'extensions'] as const) {
    if (manifest.pi[field] !== undefined)
      validateDiscoveryPaths(context, artifacts, field, manifest.pi[field]);
  }
}
