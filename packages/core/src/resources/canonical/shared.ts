import { parseDocument } from 'yaml';
import type { ComponentRequires } from '../../contracts/components.js';
import type { JsonObject, JsonValue } from '../../contracts/common.js';
import type { SourceDirectoryRef, SourceEntry, SourceFileRef } from '../../contracts/services.js';
import { DiagnosticRegistry } from '../../services/diagnostics.js';
import { SourceRegistry } from '../../services/sources.js';

/** Component ID 的规范格式。 */
const COMPONENT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

/** Markdown 主文件的统一中间形态。 */
export interface ParsedMarkdown {
  readonly data: Readonly<Record<string, unknown>>;
  readonly body: string;
  readonly bodyLine: number;
}

/**
 * 提交绑定 canonical owner 的诊断。
 *
 * @param diagnostics 当前 Session Registry。
 * @param code 稳定诊断码。
 * @param message 稳定信息。
 * @param location 工程相对路径。
 * @param fieldPath 可选字段路径。
 */
export function error(
  diagnostics: DiagnosticRegistry,
  code: string,
  message: string,
  location?: string,
  fieldPath?: readonly (string | number)[],
): void {
  diagnostics.report('discover', {
    code,
    severity: 'error',
    message,
    ...(location === undefined ? {} : { location: { path: location } }),
    ...(fieldPath === undefined ? {} : { fieldPath }),
  }, { owner: 'framework:canonical' });
}

/**
 * 解析严格 UTF-8 + YAML Frontmatter Markdown。
 *
 * @param sources canonical owner Source Service。
 * @param file Markdown SourceRef。
 * @param diagnostics 当前诊断集合。
 * @returns 合法 Frontmatter、正文和正文行。
 */
export async function parseMarkdown(
  sources: ReturnType<SourceRegistry['service']>,
  file: SourceFileRef,
  diagnostics: DiagnosticRegistry,
): Promise<ParsedMarkdown | undefined> {
  /** 文本读取失败统一转换为稳定 UTF-8 诊断。 */
  let source: string;
  try {
    source = await sources.readText(file);
  } catch {
    error(diagnostics, 'MARKDOWN_UTF8_INVALID', 'Markdown must be stable UTF-8 text.', file.path);
    return undefined;
  }
  /** 保留行边界用于定位正文。 */
  const lines = source.split(/\r?\n/u);
  if (lines[0] !== '---') {
    error(diagnostics, 'FRONTMATTER_REQUIRED', 'Markdown requires a YAML Frontmatter block.', file.path);
    return undefined;
  }
  /** closing 是 Frontmatter 结束分隔符的零基行索引。 */
  const closing = lines.findIndex((line, index) => index > 0 && line === '---');
  if (closing < 0) {
    error(diagnostics, 'FRONTMATTER_UNTERMINATED', 'YAML Frontmatter is not terminated.', file.path);
    return undefined;
  }
  /** YAML parser 必须拒绝重复键和非法语法。 */
  const document = parseDocument(lines.slice(1, closing).join('\n'), { prettyErrors: false, uniqueKeys: true });
  if (document.errors.length > 0) {
    error(diagnostics, 'FRONTMATTER_INVALID', 'YAML Frontmatter is invalid.', file.path);
    return undefined;
  }
  /** YAML AST 只在无 parser errors 后投影为普通值。 */
  const value = document.toJS() as unknown;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    error(diagnostics, 'FRONTMATTER_OBJECT_REQUIRED', 'Frontmatter must be a mapping.', file.path);
    return undefined;
  }
  /** 正文统一换行为 LF 并去除首尾空白。 */
  const body = lines.slice(closing + 1).join('\n').trim();
  if (body.length === 0) {
    error(diagnostics, 'MARKDOWN_BODY_REQUIRED', 'Markdown body must not be empty.', file.path);
    return undefined;
  }
  return Object.freeze({ data: value as Record<string, unknown>, body, bodyLine: closing + 2 });
}

/**
 * 拒绝 Frontmatter unknown/legacy fields。
 *
 * @param data Frontmatter mapping。
 * @param allowed 当前 Component 白名单。
 * @param location Markdown 路径。
 * @param diagnostics 当前诊断集合。
 */
export function fields(data: Readonly<Record<string, unknown>>, allowed: readonly string[], location: string, diagnostics: DiagnosticRegistry): void {
  /** Set 使每个 Frontmatter 字段只需常量时间查找。 */
  const accepted = new Set(allowed);
  for (const field of Object.keys(data).sort()) {
    if (field === 'extensions') {
      error(diagnostics, 'COMPONENT_LEGACY_EXTENSIONS', 'Frontmatter extensions is not supported; use platforms.', location, [field]);
    } else if (!accepted.has(field)) {
      error(diagnostics, 'FRONTMATTER_FIELD_UNKNOWN', `Unknown Frontmatter field "${field}".`, location, [field]);
    }
  }
}

/**
 * 读取非空 string 字段。
 *
 * @param data Frontmatter mapping。
 * @param field 字段名。
 * @param location 文件路径。
 * @param diagnostics 当前诊断集合。
 * @param required 缺失时是否失败。
 * @returns 规范化 string 或 undefined。
 */
export function stringField(
  data: Readonly<Record<string, unknown>>,
  field: string,
  location: string,
  diagnostics: DiagnosticRegistry,
  required = false,
): string | undefined {
  /** 字段读取不执行额外 coercion。 */
  const value = data[field];
  if (value === undefined && !required)
    return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    error(diagnostics, 'FRONTMATTER_STRING_REQUIRED', `${field} must be a non-empty string.`, location, [field]);
    return undefined;
  }
  return value.trim();
}

/**
 * 复制严格 string array。
 *
 * @param value 未知数组值。
 * @param fieldPath 字段路径。
 * @param location 文件路径。
 * @param diagnostics 当前诊断集合。
 * @returns 排除非 string 后的稳定数组。
 */
export function strings(
  value: unknown,
  fieldPath: readonly string[],
  location: string,
  diagnostics: DiagnosticRegistry,
): readonly string[] {
  if (value === undefined)
    return Object.freeze([]);
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.trim() === '')) {
    error(diagnostics, 'FRONTMATTER_STRING_ARRAY', `${fieldPath.join('.')} must be an array of non-empty strings.`, location, fieldPath);
    return Object.freeze([]);
  }
  /** 复制数组，避免 YAML 容器身份进入 Project Graph。 */
  const result = [...value] as string[];
  if (new Set(result).size !== result.length)
    error(diagnostics, 'FRONTMATTER_ARRAY_DUPLICATE', `${fieldPath.join('.')} must not contain duplicates.`, location, fieldPath);
  return Object.freeze(result);
}

/**
 * 解析 canonical dependency 声明。
 *
 * @param value requires Frontmatter 值。
 * @param location 文件路径。
 * @param diagnostics 当前诊断集合。
 * @returns 始终包含 skills/agents 的不可变依赖。
 */
export function requires(value: unknown, location: string, diagnostics: DiagnosticRegistry): ComponentRequires {
  if (value === undefined)
    return Object.freeze({ skills: Object.freeze([]), agents: Object.freeze([]) });
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    error(diagnostics, 'COMPONENT_REQUIRES_INVALID', 'requires must be a mapping.', location, ['requires']);
    return Object.freeze({ skills: Object.freeze([]), agents: Object.freeze([]) });
  }
  /** YAML 映射的普通字段。 */
  const object = value as Record<string, unknown>;
  for (const field of Object.keys(object)) {
    if (field !== 'skills' && field !== 'agents')
      error(diagnostics, 'COMPONENT_REQUIRES_KIND', `requires.${field} is not supported.`, location, ['requires', field]);
  }
  /** 两种可引用 Component 类型分别解析并保留声明顺序。 */
  const skills = strings(object.skills, ['requires', 'skills'], location, diagnostics);
  /** Agent dependencies 与 Skill dependencies 使用相同 ID 规则。 */
  const agents = strings(object.agents, ['requires', 'agents'], location, diagnostics);
  for (const [kind, ids] of [['skills', skills], ['agents', agents]] as const) {
    for (const [index, id] of ids.entries()) {
      if (!COMPONENT_ID.test(id))
        error(diagnostics, 'COMPONENT_REQUIRES_ID_INVALID', `requires.${kind} contains an invalid Component ID.`, location, ['requires', kind, index]);
    }
  }
  return Object.freeze({ skills, agents });
}

/**
 * 递归复制 YAML value 为严格 JSON。
 *
 * @param value 当前值。
 * @param path 字段路径。
 * @param location 文件路径。
 * @param diagnostics 当前诊断集合。
 * @param ancestors 当前递归祖先。
 * @returns JSON snapshot 或 undefined。
 */
function jsonValue(
  value: unknown,
  path: readonly string[],
  location: string,
  diagnostics: DiagnosticRegistry,
  ancestors = new Set<object>(),
): JsonValue | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return value;
  if (typeof value === 'number') {
    if (Number.isFinite(value))
      return value;
    error(diagnostics, 'COMPONENT_PLATFORM_JSON_INVALID', 'Platform metadata must contain finite JSON values.', location, path);
    return undefined;
  }
  if (typeof value !== 'object') {
    error(diagnostics, 'COMPONENT_PLATFORM_JSON_INVALID', 'Platform metadata must contain JSON values.', location, path);
    return undefined;
  }
  if (ancestors.has(value)) {
    error(diagnostics, 'COMPONENT_PLATFORM_JSON_CYCLE', 'Platform metadata must not contain cycles.', location, path);
    return undefined;
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      /** JSON array 使用新容器逐项规范化。 */
      const result: JsonValue[] = [];
      for (const [index, item] of value.entries()) {
        /** index 加入字段路径以生成精确诊断。 */
        const normalized = jsonValue(item, [...path, String(index)], location, diagnostics, ancestors);
        if (normalized === undefined)
          return undefined;
        result.push(normalized);
      }
      return Object.freeze(result);
    }
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      error(diagnostics, 'COMPONENT_PLATFORM_JSON_INVALID', 'Platform metadata must use plain mappings.', location, path);
      return undefined;
    }
    /** JSON object 使用冻结的新 data-property 容器。 */
    const result: Record<string, JsonValue> = {};
    for (const field of Object.keys(value).sort()) {
      /** 字段按稳定键序递归复制。 */
      const normalized = jsonValue((value as Record<string, unknown>)[field], [...path, field], location, diagnostics, ancestors);
      if (normalized === undefined)
        return undefined;
      Object.defineProperty(result, field, { value: normalized, enumerable: true, configurable: false, writable: false });
    }
    return Object.freeze(result);
  } finally {
    ancestors.delete(value);
  }
}

/**
 * 解析 Component 的 configured Platform 专属 JSON。
 *
 * @param value platforms Frontmatter 值。
 * @param configured 已配置 Platform ID。
 * @param location 文件路径。
 * @param diagnostics 当前诊断集合。
 * @returns 仅保留已配置平台的冻结 JSON object map。
 */
export function platforms(
  value: unknown,
  configured: ReadonlySet<string>,
  location: string,
  diagnostics: DiagnosticRegistry,
): Readonly<Record<string, Readonly<JsonObject>>> {
  if (value === undefined)
    return Object.freeze({});
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    error(diagnostics, 'COMPONENT_PLATFORMS_INVALID', 'platforms must be a mapping.', location, ['platforms']);
    return Object.freeze({});
  }
  /** 只保留当前配置中实际存在的 Platform namespace。 */
  const result: Record<string, Readonly<JsonObject>> = {};
  for (const id of Object.keys(value).sort()) {
    if (!configured.has(id)) {
      error(diagnostics, 'COMPONENT_PLATFORM_NOT_CONFIGURED', `Component declares unconfigured Platform "${id}".`, location, ['platforms', id]);
      continue;
    }
    /** Platform fields 只能是严格 JSON mapping。 */
    const normalized = jsonValue((value as Record<string, unknown>)[id], ['platforms', id], location, diagnostics);
    if (normalized === undefined || normalized === null || typeof normalized !== 'object' || Array.isArray(normalized)) {
      error(diagnostics, 'COMPONENT_PLATFORM_FIELDS_INVALID', `platforms.${id} must be a JSON mapping.`, location, ['platforms', id]);
      continue;
    }
    result[id] = normalized as Readonly<JsonObject>;
  }
  return Object.freeze(result);
}

/** @returns Resource root 的直接 entries；缺失 root 返回空集合。 */
export async function rootEntries(
  root: SourceDirectoryRef | undefined,
  sources: ReturnType<SourceRegistry['service']>,
): Promise<readonly SourceEntry[]> {
  return root === undefined ? Object.freeze([]) : sources.list(root);
}

/** @returns entry 的 Component ID 是否有效，并在失败时报告。 */
export function componentId(id: string, location: string, diagnostics: DiagnosticRegistry): boolean {
  if (COMPONENT_ID.test(id))
    return true;
  error(diagnostics, 'COMPONENT_ID_INVALID', `Component ID "${id}" must use lowercase kebab-case.`, location);
  return false;
}
