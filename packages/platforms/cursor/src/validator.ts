import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { JsonValue, PlatformValidateContext } from '@tokenroll/acplugin';
import { PLUGIN_MANIFEST_PATH, SEMVER_PATTERN } from './manifest.js';

/** Cursor 官方 Schema 当前允许的根字段。 */
const MANIFEST_FIELDS = new Set([
  'name', 'displayName', 'description', 'version', 'minClientVersions', 'author', 'publisher', 'homepage',
  'repository', 'license', 'logo', 'keywords', 'category', 'tags', 'commands', 'agents', 'skills', 'rules',
  'hooks', 'variables', 'mcpServers',
]);

/** Cursor Plugin 名称的当前官方规则。 */
const PLUGIN_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u;

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
 * 向 Core 提交 Cursor 候选校验错误。
 *
 * @param context Platform validateBundle 生命周期上下文。
 * @param code 稳定诊断码。
 * @param message 不包含宿主绝对路径的错误信息。
 * @param fieldPath 可选的清单字段位置。
 */
function report(
  context: PlatformValidateContext,
  code: string,
  message: string,
  fieldPath?: readonly (string | number)[],
): void {
  context.reportDiagnostic({
    code,
    severity: 'error',
    message,
    ...(fieldPath === undefined ? {} : { fieldPath }),
  });
}

/**
 * 判断 Manifest 路径是否留在 Plugin 根目录内。
 *
 * @param reference Cursor Manifest 中的相对路径或 Glob。
 * @returns 使用 `./` 且没有目录逃逸时返回 true。
 */
function isSafeReference(reference: string): boolean {
  if (!reference.startsWith('./') || reference.includes('\\') || reference.includes('\0'))
    return false;
  /** 去掉 `./` 和 Glob 后用于路径规范化的静态前缀。 */
  const prefix = reference.slice(2).split(/[*?[\]{}]/u, 1)[0] ?? '';
  /** 规范化后的静态前缀。 */
  const normalized = path.posix.normalize(prefix);
  return prefix.length > 0 && normalized !== '..' && !normalized.startsWith('../') && !path.posix.isAbsolute(normalized);
}

/**
 * 判断路径或 Glob 引用是否至少匹配一个已物化 Artifact。
 *
 * @param artifacts 当前交付单元的 Artifact 路径集合。
 * @param reference 已通过安全检查的引用。
 * @returns 精确文件或 Glob 静态目录存在时返回 true。
 */
function referenceExists(artifacts: ReadonlySet<string>, reference: string): boolean {
  /** 移除协议前缀并取得第一个 Glob 之前的稳定前缀。 */
  const relative = reference.slice(2);
  /** 精确文件引用可直接判断。 */
  if (!/[*?[\]{}]/u.test(relative))
    return artifacts.has(relative) || [...artifacts].some(artifact => artifact.startsWith(`${relative.replace(/\/+$/u, '')}/`));
  /** Glob 引用只允许匹配第一个模式字符之前的静态目录前缀。 */
  const patternIndex = relative.search(/[*?[\]{}]/u);
  /** 保留到最后一个完整目录边界，避免把文件名前缀误当目录。 */
  const staticPrefix = relative.slice(0, patternIndex);
  /** 实际参与 Artifact 前缀匹配的完整静态目录。 */
  const directory = staticPrefix.slice(0, staticPrefix.lastIndexOf('/') + 1);
  return directory.length > 0 && [...artifacts].some(artifact => artifact.startsWith(directory));
}

/** Cursor logo 中显式 URL scheme 的稳定识别规则。 */
const URL_SCHEME_PATTERN = /^[A-Za-z][A-Za-z\d+.-]*:/u;

/**
 * 校验 Cursor logo 的远端 URL 分支。
 *
 * @param value 带显式 scheme 的 logo 候选。
 * @returns 仅无凭据 HTTPS 网络 URL 返回 true。
 */
function isSafeLogoUrl(value: string): boolean {
  try {
    /** URL 解析后的协议、主机和凭据共同定义远端资源信任边界。 */
    const url = new URL(value);
    return url.protocol === 'https:'
      && url.hostname.length > 0
      && url.username === ''
      && url.password === '';
  } catch {
    return false;
  }
}

/**
 * 校验 Cursor logo 的 Plugin 根相对路径分支。
 *
 * @param value 不带 URL scheme 的 logo 候选。
 * @returns 安全路径对应的 Artifact lookup key；非法时返回 undefined。
 */
function logoArtifactPath(value: string): string | undefined {
  if (value === ''
    || value.includes('\0')
    || value.includes('\\')
    || path.posix.isAbsolute(value)
    || path.win32.isAbsolute(value)
    || value.split('/').includes('..')) {
    return undefined;
  }
  /** Cursor 接受可选 `./`，Artifact Registry 使用无前缀 POSIX 路径。 */
  const normalized = path.posix.normalize(value).replace(/^\.\//u, '');
  return normalized === '.' || normalized.startsWith('../') ? undefined : normalized;
}

/**
 * 按互斥 URL/Artifact 分支校验 Cursor logo。
 *
 * @param context Platform validateBundle 生命周期上下文。
 * @param artifacts 当前候选交付单元的 Artifact 路径集合。
 * @param value Manifest logo 字段候选。
 */
function validateLogo(
  context: PlatformValidateContext,
  artifacts: ReadonlySet<string>,
  value: JsonValue,
): void {
  if (typeof value !== 'string') {
    report(context, 'CURSOR_LOGO_PATH_INVALID', 'logo must be an HTTPS URL or a safe Plugin-root Artifact path.', ['logo']);
    return;
  }
  /** 本机绝对路径优先归入相对路径边界，避免盘符被误判成 URL scheme。 */
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || value.includes('\\') || value.includes('\0')) {
    report(context, 'CURSOR_LOGO_PATH_INVALID', 'logo path must be a safe POSIX path relative to the Plugin root.', ['logo']);
    return;
  }
  if (URL_SCHEME_PATTERN.test(value)) {
    if (!isSafeLogoUrl(value))
      report(context, 'CURSOR_LOGO_URL_INVALID', 'logo URL must be an absolute HTTPS URL without credentials.', ['logo']);
    return;
  }
  /** 不带 scheme 的输入只能引用当前候选中实际存在的 Artifact。 */
  const artifactPath = logoArtifactPath(value);
  if (artifactPath === undefined)
    report(context, 'CURSOR_LOGO_PATH_INVALID', 'logo path must be a safe POSIX path relative to the Plugin root.', ['logo']);
  else if (!artifacts.has(artifactPath))
    report(context, 'CURSOR_LOGO_ARTIFACT_MISSING', 'logo path must reference a generated Plugin Artifact.', ['logo']);
}

/**
 * 校验 Cursor Manifest 路径字段的安全性和存在性。
 *
 * @param context Platform validateBundle 生命周期上下文。
 * @param artifacts 当前 Artifact 路径集合。
 * @param field Manifest 字段名。
 * @param value 待验证字段值。
 */
function validateReference(
  context: PlatformValidateContext,
  artifacts: ReadonlySet<string>,
  field: string,
  value: JsonValue,
): void {
  if (typeof value !== 'string' || !isSafeReference(value)) {
    report(context, 'CURSOR_MANIFEST_REFERENCE_INVALID', `${field} must be a safe Plugin-root path or glob.`, [field]);
  } else if (!referenceExists(artifacts, value)) {
    report(context, 'CURSOR_MANIFEST_REFERENCE_MISSING', `${field} references no generated Plugin Artifact.`, [field]);
  }
}

/**
 * 校验 Cursor 主 Plugin Manifest 与所有资源引用。
 *
 * @param context Platform 提供的已物化候选交付单元。
 */
export async function validateCursorBundle(context: PlatformValidateContext): Promise<void> {
  /** 当前候选交付单元的规范 Artifact 路径集合。 */
  const artifacts = new Set(context.candidate.unit.artifacts.map(artifact => artifact.path));
  /** 从候选根加载且仍需 Schema 校验的 Manifest。 */
  let manifest: JsonRecord;
  try {
    /** JSON.parse 返回的未知值必须继续验证对象形态。 */
    const value: unknown = JSON.parse(await fs.readFile(path.join(context.candidate.root, PLUGIN_MANIFEST_PATH), 'utf8'));
    if (!isRecord(value))
      throw new TypeError('Manifest is not an object.');
    manifest = value;
  } catch {
    report(context, 'CURSOR_MANIFEST_READ_FAILED', `${PLUGIN_MANIFEST_PATH} must contain a JSON object.`);
    return;
  }
  /** field 表示当前 Manifest 根字段，用于实施官方 additionalProperties: false。 */
  for (const field of Object.keys(manifest)) {
    if (!MANIFEST_FIELDS.has(field))
      report(context, 'CURSOR_MANIFEST_FIELD_UNKNOWN', `Unknown Cursor Plugin field "${field}".`, [field]);
  }
  if (typeof manifest.name !== 'string' || !PLUGIN_NAME_PATTERN.test(manifest.name))
    report(context, 'CURSOR_MANIFEST_NAME_INVALID', 'name must satisfy the official Cursor Plugin name pattern.', ['name']);
  if (manifest.version !== undefined && (typeof manifest.version !== 'string' || !SEMVER_PATTERN.test(manifest.version)))
    report(context, 'CURSOR_MANIFEST_VERSION_INVALID', 'version must be a semantic version.', ['version']);
  /** field 表示当前由 acplugin 始终写入的非空字符串元数据。 */
  for (const field of ['description', 'version'] as const) {
    if (typeof manifest[field] !== 'string' || manifest[field].trim().length === 0)
      report(context, 'CURSOR_MANIFEST_METADATA_INVALID', `${field} must be a non-empty string.`, [field]);
  }
  if (manifest.author !== undefined) {
    /** author 只允许 name 和 email，明确排除统一元数据的 url。 */
    const author = isRecord(manifest.author) ? manifest.author : undefined;
    if (author === undefined || typeof author.name !== 'string' || author.name.trim().length === 0)
      report(context, 'CURSOR_MANIFEST_AUTHOR_INVALID', 'author.name must be a non-empty string.', ['author']);
    else if (Object.keys(author).some(field => field !== 'name' && field !== 'email'))
      report(context, 'CURSOR_MANIFEST_AUTHOR_FIELD_UNKNOWN', 'author accepts only name and email.', ['author']);
  }
  if (manifest.logo !== undefined)
    validateLogo(context, artifacts, manifest.logo);
  /** field 表示当前 acplugin 可能生成的 Component Glob。 */
  for (const field of ['commands', 'skills', 'agents'] as const) {
    if (manifest[field] !== undefined)
      validateReference(context, artifacts, field, manifest[field]);
  }
  /** field 表示当前 Extension 贡献的固定配置文件引用。 */
  for (const field of ['hooks', 'mcpServers'] as const) {
    if (typeof manifest[field] === 'string')
      validateReference(context, artifacts, field, manifest[field]);
    else if (manifest[field] !== undefined && !isRecord(manifest[field]))
      report(context, 'CURSOR_EXTENSION_REFERENCE_INVALID', `${field} must be a path or inline object.`, [field]);
  }
}
