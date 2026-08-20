import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { JsonValue, ValidatePackageContext } from '@tokenroll/acplugin/sdk';
import { PLUGIN_MANIFEST_PATH, SEMVER_PATTERN } from './manifest.js';

/** Cursor validator 只消费 SDK 的最终 Package candidate Context。 */
type PlatformValidateContext = ValidatePackageContext;

/** Cursor 官方 Schema 当前允许的根字段。 */
const MANIFEST_FIELDS = new Set([
  'name', 'displayName', 'description', 'version', 'minClientVersions', 'author', 'publisher', 'homepage',
  'repository', 'license', 'logo', 'keywords', 'category', 'tags', 'commands', 'agents', 'skills', 'rules',
  'hooks', 'variables', 'mcpServers',
]);

/** Cursor Plugin 名称的当前官方规则。 */
const PLUGIN_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u;

/** Cursor Hook 配置文件唯一允许的根字段。 */
const HOOK_CONFIG_FIELDS = new Set(['version', 'hooks']);

/** Cursor 当前验证过的 Plugin Hook 事件。 */
const HOOK_EVENTS = new Set([
  'sessionStart', 'sessionEnd', 'beforeSubmitPrompt', 'preToolUse', 'postToolUse', 'preCompact',
  'subagentStart', 'subagentStop', 'stop',
]);

/** Cursor 远程 MCP descriptor 允许的完整字段。 */
const MCP_SERVER_FIELDS = new Set(['url', 'headers']);

/** MCP Server key 继续使用框架统一的稳定 ID。 */
const MCP_SERVER_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

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
 * @param context Platform validatePackage 生命周期上下文。
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
  context.diagnostics.report({
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
 * 判断路径或 Glob 引用是否至少匹配一个已物化 Asset。
 *
 * @param assets 当前 Package 的 Asset 路径集合。
 * @param reference 已通过安全检查的引用。
 * @returns 精确文件或 Glob 静态目录存在时返回 true。
 */
function referenceExists(assets: ReadonlySet<string>, reference: string): boolean {
  /** 移除协议前缀并取得第一个 Glob 之前的稳定前缀。 */
  const relative = reference.slice(2);
  /** 精确文件引用可直接判断。 */
  if (!/[*?[\]{}]/u.test(relative))
    return assets.has(relative) || [...assets].some(asset => asset.startsWith(`${relative.replace(/\/+$/u, '')}/`));
  /** Glob 引用只允许匹配第一个模式字符之前的静态目录前缀。 */
  const patternIndex = relative.search(/[*?[\]{}]/u);
  /** 保留到最后一个完整目录边界，避免把文件名前缀误当目录。 */
  const staticPrefix = relative.slice(0, patternIndex);
  /** 实际参与 Asset 前缀匹配的完整静态目录。 */
  const directory = staticPrefix.slice(0, staticPrefix.lastIndexOf('/') + 1);
  return directory.length > 0 && [...assets].some(asset => asset.startsWith(directory));
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
 * @returns 安全路径对应的 Asset lookup key；非法时返回 undefined。
 */
function logoAssetPath(value: string): string | undefined {
  if (value === ''
    || value.includes('\0')
    || value.includes('\\')
    || path.posix.isAbsolute(value)
    || path.win32.isAbsolute(value)
    || value.split('/').includes('..')) {
    return undefined;
  }
  /** Cursor 接受可选 `./`，Package Asset 路径使用无前缀 POSIX 形式。 */
  const normalized = path.posix.normalize(value).replace(/^\.\//u, '');
  return normalized === '.' || normalized.startsWith('../') ? undefined : normalized;
}

/**
 * 按互斥 URL/Asset 分支校验 Cursor logo。
 *
 * @param context Platform validatePackage 生命周期上下文。
 * @param assets 当前候选 Package 的 Asset 路径集合。
 * @param value Manifest logo 字段候选。
 */
function validateLogo(
  context: PlatformValidateContext,
  assets: ReadonlySet<string>,
  value: JsonValue,
): void {
  if (typeof value !== 'string') {
    report(context, 'CURSOR_LOGO_PATH_INVALID', 'logo must be an HTTPS URL or a safe Plugin-root Asset path.', ['logo']);
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
  /** 不带 scheme 的输入只能引用当前候选中实际存在的 Asset。 */
  const assetPath = logoAssetPath(value);
  if (assetPath === undefined)
    report(context, 'CURSOR_LOGO_PATH_INVALID', 'logo path must be a safe POSIX path relative to the Plugin root.', ['logo']);
  else if (!assets.has(assetPath))
    report(context, 'CURSOR_LOGO_ASSET_MISSING', 'logo path must reference a generated Plugin Asset.', ['logo']);
}

/**
 * 校验 Cursor Manifest 路径字段的安全性和存在性。
 *
 * @param context Platform validatePackage 生命周期上下文。
 * @param assets 当前 Asset 路径集合。
 * @param field Manifest 字段名。
 * @param value 待验证字段值。
 */
function validateReference(
  context: PlatformValidateContext,
  assets: ReadonlySet<string>,
  field: string,
  value: JsonValue,
): void {
  if (typeof value !== 'string' || !isSafeReference(value)) {
    report(context, 'CURSOR_MANIFEST_REFERENCE_INVALID', `${field} must be a safe Plugin-root path or glob.`, [field]);
  } else if (!referenceExists(assets, value)) {
    report(context, 'CURSOR_MANIFEST_REFERENCE_MISSING', `${field} references no generated Plugin Asset.`, [field]);
  }
}

/** 校验 Cursor version 1 Hook 配置的完整事件/命令结构。 */
function validateHookConfig(context: PlatformValidateContext, value: JsonValue, fieldPath: readonly (string | number)[]): void {
  if (!isRecord(value)) {
    report(context, 'CURSOR_HOOK_CONFIG_INVALID', 'Cursor Hook config must be a JSON object.', fieldPath);
    return;
  }
  for (const field of Object.keys(value)) {
    if (!HOOK_CONFIG_FIELDS.has(field))
      report(context, 'CURSOR_HOOK_CONFIG_FIELD_UNKNOWN', `Unknown Cursor Hook config field "${field}".`, [...fieldPath, field]);
  }
  if (value.version !== 1)
    report(context, 'CURSOR_HOOK_VERSION_INVALID', 'Cursor Hook config version must be 1.', [...fieldPath, 'version']);
  if (!isRecord(value.hooks)) {
    report(context, 'CURSOR_HOOK_EVENTS_INVALID', 'Cursor Hook config must contain an event mapping.', [...fieldPath, 'hooks']);
    return;
  }
  for (const [event, handlers] of Object.entries(value.hooks)) {
    /** 当前事件在最终 Hook 配置中的字段路径。 */
    const eventPath = [...fieldPath, 'hooks', event];
    if (!HOOK_EVENTS.has(event)) {
      report(context, 'CURSOR_HOOK_EVENT_UNKNOWN', `Unknown Cursor Hook event "${event}".`, eventPath);
      continue;
    }
    if (!Array.isArray(handlers) || handlers.length === 0) {
      report(context, 'CURSOR_HOOK_HANDLERS_INVALID', 'Each Cursor Hook event must contain command handlers.', eventPath);
      continue;
    }
    for (const [index, handler] of handlers.entries()) {
      /** 单个 command Handler 的最终字段路径。 */
      const handlerPath = [...eventPath, index];
      if (!isRecord(handler)) {
        report(context, 'CURSOR_HOOK_HANDLER_INVALID', 'Cursor Hook handlers must be objects.', handlerPath);
        continue;
      }
      for (const field of Object.keys(handler)) {
        if (field !== 'command')
          report(context, 'CURSOR_HOOK_HANDLER_FIELD_UNKNOWN', `Unknown Cursor Hook handler field "${field}".`, [...handlerPath, field]);
      }
      if (typeof handler.command !== 'string' || handler.command.trim().length === 0)
        report(context, 'CURSOR_HOOK_COMMAND_INVALID', 'Cursor Hook command must be a non-empty string.', [...handlerPath, 'command']);
    }
  }
}

/** 校验 Cursor remote-only MCP Server 映射。 */
function validateMcpServers(context: PlatformValidateContext, value: JsonValue, fieldPath: readonly (string | number)[]): void {
  if (!isRecord(value)) {
    report(context, 'CURSOR_MCP_SERVERS_INVALID', 'Cursor mcpServers must contain a Server object mapping.', fieldPath);
    return;
  }
  for (const [id, candidate] of Object.entries(value)) {
    /** 当前 Server 在最终配置中的字段路径。 */
    const serverPath = [...fieldPath, id];
    if (!MCP_SERVER_ID_PATTERN.test(id) || !isRecord(candidate)) {
      report(context, 'CURSOR_MCP_SERVER_INVALID', 'MCP Server ids must use lowercase kebab-case and map to objects.', serverPath);
      continue;
    }
    for (const field of Object.keys(candidate)) {
      if (!MCP_SERVER_FIELDS.has(field))
        report(context, 'CURSOR_MCP_FIELD_UNKNOWN', `Unknown Cursor MCP field "${field}".`, [...serverPath, field]);
    }
    if (typeof candidate.url !== 'string') {
      report(context, 'CURSOR_MCP_URL_INVALID', 'Cursor MCP url must be an HTTP(S) URL without credentials.', [...serverPath, 'url']);
    } else {
      try {
        /** Cursor remote MCP 不接受 URL 内联凭据。 */
        const url = new URL(candidate.url);
        if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username !== '' || url.password !== '')
          throw new TypeError('unsafe');
      } catch {
        report(context, 'CURSOR_MCP_URL_INVALID', 'Cursor MCP url must be an HTTP(S) URL without credentials.', [...serverPath, 'url']);
      }
    }
    if (candidate.headers !== undefined
      && (!isRecord(candidate.headers)
        || Object.entries(candidate.headers).some(([key, header]) => key.trim().length === 0 || typeof header !== 'string'))) {
      report(context, 'CURSOR_MCP_HEADERS_INVALID', 'Cursor MCP headers must map non-empty names to string values.', [...serverPath, 'headers']);
    }
  }
}

/** 读取并校验 Cursor Extension 字段引用的最终 JSON 配置。 */
async function validateExtensionFile(
  context: PlatformValidateContext,
  reference: string,
  field: 'hooks' | 'mcpServers',
): Promise<void> {
  try {
    /** Extension 配置引用相对于 Plugin candidate 根解析。 */
    const value: unknown = JSON.parse(await fs.readFile(path.join(context.candidate.root, reference.slice(2)), 'utf8'));
    if (field === 'hooks') {
      validateHookConfig(context, value as JsonValue, [field]);
      return;
    }
    if (!isRecord(value) || Object.keys(value).some(key => key !== 'mcpServers') || value.mcpServers === undefined) {
      report(context, 'CURSOR_MCP_CONFIG_INVALID', 'Cursor MCP config must contain only mcpServers.', [field]);
      return;
    }
    validateMcpServers(context, value.mcpServers, [field, 'mcpServers']);
  } catch {
    report(context, 'CURSOR_EXTENSION_CONFIG_READ_FAILED', `${field} reference must contain valid JSON.`, [field]);
  }
}

/**
 * 校验 Cursor 主 Plugin Manifest 与所有资源引用。
 *
 * @param context Platform 提供的已物化候选交付单元。
 */
export async function validateCursorPackage(context: PlatformValidateContext): Promise<void> {
  /** 当前候选 Package 的规范 Asset 路径集合。 */
  const assets = new Set(context.candidate.unit.assets.map(asset => asset.path));
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
    validateLogo(context, assets, manifest.logo);
  /** field 表示当前 acplugin 可能生成的 Component Glob。 */
  for (const field of ['commands', 'skills', 'agents'] as const) {
    if (manifest[field] !== undefined)
      validateReference(context, assets, field, manifest[field]);
  }
  /** field 表示当前 Extension 贡献的固定配置文件引用。 */
  for (const field of ['hooks', 'mcpServers'] as const) {
    if (typeof manifest[field] === 'string') {
      validateReference(context, assets, field, manifest[field]);
      if (isSafeReference(manifest[field]) && referenceExists(assets, manifest[field]))
        await validateExtensionFile(context, manifest[field], field);
    } else if (manifest[field] !== undefined && !isRecord(manifest[field])) {
      report(context, 'CURSOR_EXTENSION_REFERENCE_INVALID', `${field} must be a path or inline object.`, [field]);
    } else if (field === 'hooks' && manifest[field] !== undefined) {
      validateHookConfig(context, manifest[field], [field]);
    } else if (manifest[field] !== undefined) {
      validateMcpServers(context, manifest[field], [field]);
    }
  }
}
