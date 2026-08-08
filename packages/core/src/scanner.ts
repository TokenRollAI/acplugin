import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseDocument } from 'yaml';
import { DiagnosticCollector } from './diagnostics.js';
import { compareCodeUnits } from './serialization.js';
import type { AcpluginPlatform, DiagnosticInput, JsonObject, JsonValue } from './contracts.js';
import type {
  AgentCapability,
  AgentComponent,
  AgentModel,
  ArtifactMode,
  CommandComponent,
  Component,
  ComponentKind,
  ComponentPlatformFields,
  ComponentRequires,
  PluginProject,
  PublicFile,
  ResolvedConfig,
  SkillAuxiliaryFile,
  SkillComponent,
} from './types.js';

/** Component ID 的规范格式：小写 kebab-case，且不允许空片段。 */
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Core 可移植 Agent 模型档位集合。 */
const AGENT_MODELS = new Set<AgentModel>(['inherit', 'fast', 'capable']);
/** Core 可移植 Agent 能力集合，平台特有能力应通过 extensions 表达。 */
const AGENT_CAPABILITIES = new Set<AgentCapability>([
  'filesystem:read', 'filesystem:write', 'search', 'shell', 'network', 'delegate',
]);

/** Scanner 完成 YAML 解析后使用的 Markdown 中间表示。 */
interface ParsedMarkdown {
  /** Frontmatter 顶层映射。 */
  data: Record<string, unknown>;
  /** 移除 Frontmatter 并裁剪首尾空白后的正文。 */
  body: string;
}

/**
 * 将文件路径转换为相对于工程根目录的 POSIX 报告路径。
 *
 * @param root 工程根目录。
 * @param file 需要呈现在诊断中的文件路径。
 * @returns 不依赖宿主平台分隔符的相对路径。
 */
function relative(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join('/');
}

/**
 * 判断路径是否可访问；不存在和不可访问均按 false 处理。
 *
 * @param file 待检查路径。
 * @returns fs.access 成功时返回 true。
 */
async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * 把宿主文件权限收敛为 Artifact 支持的普通或可执行模式。
 *
 * @param mode fs.Stat 提供的完整权限位。
 * @returns 任意执行位存在时为 0755，否则为 0644。
 */
function modeFromStat(mode: number): ArtifactMode {
  return mode & 0o111 ? 0o755 : 0o644;
}

/**
 * 验证源码路径是普通且非符号链接文件，并将可预期失败记录为诊断。
 *
 * @param file 待验证文件。
 * @param root 用于生成安全相对诊断路径的工程根目录。
 * @param diagnostics 当前扫描共享的诊断收集器。
 * @param phase 诊断所属 Pipeline 阶段。
 * @returns 有效文件的 lstat 信息，失败时返回 undefined。
 */
async function assertRegularFile(
  file: string,
  root: string,
  diagnostics: DiagnosticCollector,
  phase = 'discover',
): Promise<import('node:fs').Stats | undefined> {
  try {
    /** 候选来源自身的文件类型与符号链接状态。 */
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink()) {
      diagnostics.error('SOURCE_SYMLINK_UNSUPPORTED', 'Symbolic links are not supported.', {
        phase, location: { path: relative(root, file) },
      });
      return undefined;
    }
    if (!stat.isFile()) {
      diagnostics.error('SOURCE_NOT_FILE', 'Expected a regular file.', {
        phase, location: { path: relative(root, file) },
      });
      return undefined;
    }
    return stat;
  } catch {
    diagnostics.error('SOURCE_READ_FAILED', 'Cannot read source file.', {
      phase, location: { path: relative(root, file) },
    });
    return undefined;
  }
}

/**
 * 解析带必需 YAML Frontmatter 的非空 Markdown Component 文件。
 *
 * 该函数只建立通用文档结构；每种 Component 的字段白名单由后续扫描函数验证。
 *
 * @param file Markdown 文件路径。
 * @param root 工程根目录。
 * @param diagnostics 当前扫描共享的诊断收集器。
 * @returns 解析后的元数据与正文，格式无效时返回 undefined。
 */
async function parseMarkdown(
  file: string,
  root: string,
  diagnostics: DiagnosticCollector,
): Promise<ParsedMarkdown | undefined> {
  if (!await assertRegularFile(file, root, diagnostics))
    return undefined;

  /** 从磁盘读取并以 fatal 模式解码的完整 Markdown 源码。 */
  let source: string;
  try {
    /** fatal 解码会拒绝 Node 默认 utf8 字符串读取会静默替换的非法字节。 */
    const bytes = await fs.readFile(file);
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    diagnostics.error('MARKDOWN_UTF8_INVALID', 'Markdown must be readable UTF-8 text.', {
      phase: 'discover', location: { path: relative(root, file) },
    });
    return undefined;
  }

  /** 保留行边界的源码列表，用于定位 Frontmatter 与正文。 */
  const lines = source.split(/\r?\n/);
  if (lines[0] !== '---') {
    diagnostics.error('FRONTMATTER_REQUIRED', 'A YAML Frontmatter block is required.', {
      phase: 'discover', location: { path: relative(root, file), line: 1, column: 1 },
    });
    return undefined;
  }
  /** Frontmatter 结束分隔符所在的零基行号。 */
  const closing = lines.findIndex((line, index) => index > 0 && line === '---');
  if (closing < 0) {
    diagnostics.error('FRONTMATTER_UNTERMINATED', 'YAML Frontmatter is not terminated.', {
      phase: 'discover', location: { path: relative(root, file), line: 1, column: 1 },
    });
    return undefined;
  }

  /** 不含上下分隔符的原始 YAML 文本。 */
  const yamlSource = lines.slice(1, closing).join('\n');
  /** 开启唯一键校验的 YAML 文档，避免后写字段静默覆盖前写字段。 */
  const document = parseDocument(yamlSource, { prettyErrors: false, uniqueKeys: true });
  if (document.errors.length > 0) {
    diagnostics.error('FRONTMATTER_INVALID', 'Invalid YAML Frontmatter.', {
      phase: 'discover', location: { path: relative(root, file), line: 2, column: 1 },
    });
    return undefined;
  }
  /** YAML 文档转换出的未知值，必须进一步验证为顶层映射。 */
  const raw = document.toJS() as unknown;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    diagnostics.error('FRONTMATTER_OBJECT_REQUIRED', 'Frontmatter must be a mapping.', {
      phase: 'discover', location: { path: relative(root, file), line: 2, column: 1 },
    });
    return undefined;
  }
  /** Frontmatter 后的 Markdown 正文。 */
  const body = lines.slice(closing + 1).join('\n').trim();
  if (body === '') {
    diagnostics.error('MARKDOWN_BODY_REQUIRED', 'Markdown body must not be empty.', {
      phase: 'discover', location: { path: relative(root, file), line: closing + 2, column: 1 },
    });
    return undefined;
  }
  return { data: raw as Record<string, unknown>, body };
}

/**
 * 验证 Component ID 是否符合跨平台稳定命名规则。
 *
 * @param id 从文件或目录名称提取的 ID。
 * @param sourcePath 用于诊断定位的工程相对路径。
 * @param diagnostics 当前扫描共享的诊断收集器。
 * @returns ID 有效时返回 true。
 */
function validateId(id: string, sourcePath: string, diagnostics: DiagnosticCollector): boolean {
  if (ID_PATTERN.test(id))
    return true;
  diagnostics.error('COMPONENT_ID_INVALID', `Component ID "${id}" must be lowercase kebab-case.`, {
    phase: 'discover', location: { path: sourcePath },
  });
  return false;
}

/**
 * 拒绝某类 Component Frontmatter 中未声明的字段。
 *
 * @param data Frontmatter 顶层映射。
 * @param allowed 当前 Component 允许的字段名。
 * @param sourcePath 诊断使用的源码路径。
 * @param diagnostics 当前扫描共享的诊断收集器。
 */
function validateFields(
  data: Record<string, unknown>,
  allowed: readonly string[],
  sourcePath: string,
  diagnostics: DiagnosticCollector,
): void {
  /** 供每个字段执行常数时间查询的白名单。 */
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(data)) {
    if (key === 'extensions') {
      diagnostics.error('COMPONENT_LEGACY_EXTENSIONS', 'Component field "extensions" is no longer supported.', {
        phase: 'discover',
        location: { path: sourcePath },
        fieldPath: [key],
        hint: 'Use platforms: { \'claude-code\': {} } for Platform-specific fields.',
      });
      continue;
    }
    if (!allowedSet.has(key)) {
      diagnostics.error('FRONTMATTER_FIELD_UNKNOWN', `Unknown Frontmatter field "${key}".`, {
        phase: 'discover', location: { path: sourcePath }, fieldPath: [key],
      });
    }
  }
}

/**
 * 读取并规范化一个可选或必需的非空字符串字段。
 *
 * @param data Frontmatter 顶层映射。
 * @param key 待读取字段名。
 * @param sourcePath 诊断使用的源码路径。
 * @param diagnostics 当前扫描共享的诊断收集器。
 * @param required 字段缺失时是否也产生错误。
 * @returns 裁剪后的字符串，无效或可选缺失时返回 undefined。
 */
function stringField(
  data: Record<string, unknown>,
  key: string,
  sourcePath: string,
  diagnostics: DiagnosticCollector,
  required = false,
): string | undefined {
  /** Frontmatter 中未经验证的原始字段值。 */
  const value = data[key];
  if (value === undefined && !required)
    return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    diagnostics.error('FRONTMATTER_STRING_REQUIRED', `${key} must be a non-empty string.`, {
      phase: 'discover', location: { path: sourcePath }, fieldPath: [key],
    });
    return undefined;
  }
  return value.trim();
}

/**
 * 验证字符串数组字段，并报告空值与重复 ID。
 *
 * @param value 未知字段值。
 * @param fieldPath 诊断中使用的嵌套字段路径。
 * @param sourcePath 诊断使用的源码路径。
 * @param diagnostics 当前扫描共享的诊断收集器。
 * @param duplicateCode 当前字段发现重复值时使用的稳定诊断码。
 * @returns 有效输入本身；缺失或类型无效时返回空数组。
 */
function stringArray(
  value: unknown,
  fieldPath: readonly string[],
  sourcePath: string,
  diagnostics: DiagnosticCollector,
  duplicateCode = 'FRONTMATTER_ARRAY_DUPLICATE',
): string[] {
  if (value === undefined)
    return [];
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.trim() === '')) {
    diagnostics.error('FRONTMATTER_STRING_ARRAY', `${fieldPath.join('.')} must be an array of non-empty strings.`, {
      phase: 'discover', location: { path: sourcePath }, fieldPath,
    });
    return [];
  }
  /** 已通过元素类型与非空检查的字符串列表。 */
  const result = value as string[];
  if (new Set(result).size !== result.length) {
    diagnostics.error(duplicateCode, `${fieldPath.join('.')} contains duplicate values.`, {
      phase: 'discover', location: { path: sourcePath }, fieldPath,
    });
  }
  return result;
}

/**
 * 解析 Component 对 Skill 和 Agent 的规范依赖声明。
 *
 * @param data requires 字段的未知值。
 * @param sourcePath 诊断使用的源码路径。
 * @param diagnostics 当前扫描共享的诊断收集器。
 * @returns 始终包含 skills 和 agents 数组的依赖结构。
 */
function parseRequires(data: unknown, sourcePath: string, diagnostics: DiagnosticCollector): ComponentRequires {
  if (data === undefined)
    return { skills: [], agents: [] };
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    diagnostics.error('COMPONENT_REQUIRES_INVALID', 'requires must be a mapping.', {
      phase: 'discover', location: { path: sourcePath }, fieldPath: ['requires'],
    });
    return { skills: [], agents: [] };
  }
  /** 已验证为映射的 requires 对象。 */
  const object = data as Record<string, unknown>;
  for (const key of Object.keys(object)) {
    if (key !== 'skills' && key !== 'agents') {
      diagnostics.error('COMPONENT_REQUIRES_KIND', `requires.${key} is not supported.`, {
        phase: 'discover', location: { path: sourcePath }, fieldPath: ['requires', key],
      });
    }
  }
  /** Skill 和 Agent 依赖需要在图构建前完成 ID 语法校验。 */
  const skills = stringArray(object.skills, ['requires', 'skills'], sourcePath, diagnostics, 'COMPONENT_REQUIRES_DUPLICATE');
  /** Agent 依赖与 Skill 依赖使用相同的开放 Component ID 规则。 */
  const agents = stringArray(object.agents, ['requires', 'agents'], sourcePath, diagnostics, 'COMPONENT_REQUIRES_DUPLICATE');
  for (const [kind, ids] of [['skills', skills], ['agents', agents]] as const) {
    for (const [index, id] of ids.entries()) {
      if (!ID_PATTERN.test(id)) {
        diagnostics.error('COMPONENT_REQUIRES_ID_INVALID', `requires.${kind} contains invalid Component ID "${id}".`, {
          phase: 'discover', location: { path: sourcePath }, fieldPath: ['requires', kind, index],
        });
      }
    }
  }
  return { skills, agents };
}

/**
 * 拒绝 Command 正文中的非规范模板占位符。
 *
 * @param body 已移除 Frontmatter 的 Command 正文。
 * @param sourcePath 诊断使用的源码路径。
 * @param diagnostics 当前扫描共享的诊断收集器。
 */
function validateCommandPlaceholders(body: string, sourcePath: string, diagnostics: DiagnosticCollector): void {
  /** acplugin 只解释双花括号占位符，且仅保留 arguments 这一规范名称。 */
  const placeholders = body.match(/\{\{[^{}]*\}\}/g) ?? [];
  for (const placeholder of placeholders) {
    if (placeholder !== '{{arguments}}') {
      diagnostics.error('COMMAND_PLACEHOLDER_INVALID', `Unsupported Command placeholder "${placeholder}".`, {
        phase: 'discover', location: { path: sourcePath },
        hint: 'Use the canonical {{arguments}} placeholder.',
      });
    }
  }
}

/**
 * 递归复制并冻结未知值，同时验证它能无损表示为 JSON。
 *
 * @param value 当前待验证值。
 * @param fieldPath 当前值在 Frontmatter 中的字段路径。
 * @param sourcePath 诊断使用的源码路径。
 * @param diagnostics 当前扫描共享的诊断收集器。
 * @param ancestors 当前递归链，用于拒绝 YAML alias 构造的循环对象。
 * @returns 合法且不可变的 JSON 值；非法时返回 undefined。
 */
function normalizeJsonValue(
  value: unknown,
  fieldPath: readonly string[],
  sourcePath: string,
  diagnostics: DiagnosticCollector,
  ancestors: WeakSet<object> = new WeakSet<object>(),
): JsonValue | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return value;
  if (typeof value === 'number') {
    if (Number.isFinite(value))
      return value;
    diagnostics.error('COMPONENT_PLATFORM_JSON_INVALID', 'Platform fields only support finite JSON numbers.', {
      phase: 'discover', location: { path: sourcePath }, fieldPath,
    });
    return undefined;
  }
  if (typeof value !== 'object') {
    diagnostics.error('COMPONENT_PLATFORM_JSON_INVALID', 'Platform fields must contain JSON-serializable values.', {
      phase: 'discover', location: { path: sourcePath }, fieldPath,
    });
    return undefined;
  }
  if (ancestors.has(value)) {
    diagnostics.error('COMPONENT_PLATFORM_JSON_CYCLE', 'Platform fields cannot contain circular YAML aliases.', {
      phase: 'discover', location: { path: sourcePath }, fieldPath,
    });
    return undefined;
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    /** 保留作者声明顺序的 JSON 数组副本。 */
    const result: JsonValue[] = [];
    for (const [index, item] of value.entries()) {
      /** 任一非法元素都会让所属 Platform 字段整体失效。 */
      const normalized = normalizeJsonValue(item, [...fieldPath, String(index)], sourcePath, diagnostics, ancestors);
      if (normalized === undefined) {
        ancestors.delete(value);
        return undefined;
      }
      result.push(normalized);
    }
    ancestors.delete(value);
    return Object.freeze(result);
  }
  /** YAML 转换结果应为普通对象，拒绝行为对象进入稳定 Component 数据。 */
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    ancestors.delete(value);
    diagnostics.error('COMPONENT_PLATFORM_JSON_INVALID', 'Platform fields must use plain JSON mappings.', {
      phase: 'discover', location: { path: sourcePath }, fieldPath,
    });
    return undefined;
  }
  /** 按键名排序使相同语义的 YAML 字段顺序得到同一工程快照。 */
  const result: Record<string, JsonValue> = {};
  for (const key of Object.keys(value).sort(compareCodeUnits)) {
    /** 当前普通对象字段的未知原始值。 */
    const normalized = normalizeJsonValue((value as Record<string, unknown>)[key], [...fieldPath, key], sourcePath, diagnostics, ancestors);
    if (normalized === undefined) {
      ancestors.delete(value);
      return undefined;
    }
    // defineProperty 可安全保留名为 `__proto__` 的 JSON 字段，不触发对象原型 setter。
    Object.defineProperty(result, key, { value: normalized, enumerable: true, configurable: false, writable: false });
  }
  ancestors.delete(value);
  return Object.freeze(result);
}

/**
 * 将已经规范化的 JSON 值收窄为 Platform 字段要求的对象根节点。
 *
 * @param value Core JSON 规范化结果。
 * @returns 非空、非数组对象返回 true。
 */
function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return value !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 解析 Component 的 Platform 专属字段并调用对应 Platform 校验器。
 *
 * @param data platforms 字段的未知值。
 * @param component 当前 Component 的稳定身份与来源。
 * @param config 已解析工程配置和 Platform 集合。
 * @param diagnostics 当前扫描共享的诊断收集器。
 * @returns 仅包含已配置且通过 JSON 结构验证的 Platform 字段。
 */
async function parsePlatforms(
  data: unknown,
  component: { readonly kind: ComponentKind; readonly id: string; readonly sourcePath: string },
  config: ResolvedConfig,
  diagnostics: DiagnosticCollector,
): Promise<ComponentPlatformFields> {
  if (data === undefined)
    return Object.freeze({});
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    diagnostics.error('COMPONENT_PLATFORMS_INVALID', 'platforms must be a mapping.', {
      phase: 'discover', location: { path: component.sourcePath }, fieldPath: ['platforms'],
    });
    return Object.freeze({});
  }
  /** 按开放 ID 索引当前工程实际配置的品牌化 Platform。 */
  const configured = new Map<string, AcpluginPlatform>(config.platforms.map(item => [item.platform.id, item.platform]));
  /** 仅写入完成 Core 与 Platform 双层校验的专属字段。 */
  const result: Record<string, Readonly<JsonObject>> = {};
  for (const id of Object.keys(data).sort(compareCodeUnits)) {
    /** 当前 ID 对应且能够执行专属字段校验的 Platform。 */
    const platform = configured.get(id);
    if (!platform) {
      diagnostics.error('COMPONENT_PLATFORM_NOT_CONFIGURED', `Component declares fields for unconfigured Platform "${id}".`, {
        phase: 'discover', location: { path: component.sourcePath }, fieldPath: ['platforms', id],
        hint: `Add the ${id} Platform factory to config.platforms.`,
      });
      continue;
    }
    /** Platform 字段根必须是对象，避免 Schema 根形态在平台间漂移。 */
    const raw = (data as Record<string, unknown>)[id];
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      diagnostics.error('COMPONENT_PLATFORM_FIELDS_INVALID', `platforms.${id} must be a JSON mapping.`, {
        phase: 'discover', platform: platform.id, location: { path: component.sourcePath }, fieldPath: ['platforms', id],
      });
      continue;
    }
    /** Core 复制并冻结后的字段，不向 Platform 暴露 YAML 解析器持有的对象。 */
    const normalized = normalizeJsonValue(raw, ['platforms', id], component.sourcePath, diagnostics);
    if (!isJsonObject(normalized))
      continue;
    result[id] = normalized;
    if (!platform.validateComponentFields)
      continue;
    try {
      /** 防止 Platform Validator 在运行时修改其他 Platform 随后观察的 Component 身份。 */
      const componentSnapshot = Object.freeze({ ...component });
      /** 冻结 Context 外壳，但保留其内部受控的诊断提交函数。 */
      const context = Object.freeze({
        command: config.command,
        mode: config.mode,
        component: componentSnapshot,
        fields: normalized,
        /** Platform 只能提交诊断，身份和缺省源码位置由 Core 固定附加。 */
        reportDiagnostic(input: DiagnosticInput): void {
          diagnostics.add({
            ...input,
            phase: input.phase ?? 'validate',
            platform: platform.id,
            component: { kind: component.kind, id: component.id },
            location: input.location ?? { path: component.sourcePath },
          });
        },
      });
      await platform.validateComponentFields(context);
    } catch {
      diagnostics.error('PLATFORM_COMPONENT_VALIDATOR_FAILED', `Platform "${id}" failed while validating Component fields.`, {
        phase: 'validate', platform: platform.id,
        component: { kind: component.kind, id: component.id },
        location: { path: component.sourcePath }, fieldPath: ['platforms', id],
      });
    }
  }
  return Object.freeze(result);
}

/**
 * 按名称稳定读取目录；目录不存在视为没有对应 Component。
 *
 * @param directory 待读取目录。
 * @returns 排序后的目录项，ENOENT 时返回空数组。
 */
async function listDirectory(directory: string): Promise<import('node:fs').Dirent[]> {
  try {
    return (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => compareCodeUnits(a.name, b.name));
  } catch /** error 保存当前操作捕获的异常，供本阶段转换或恢复。 */ (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return [];
    throw error;
  }
}

/**
 * 检查同一源码目录中会在常见文件系统上碰撞的大小写或 Unicode 名称。
 *
 * @param entries 已按名称排序的目录项。
 * @param directory 这些目录项所属的绝对目录。
 * @param root 工程根目录。
 * @param diagnostics 当前扫描共享的诊断收集器。
 */
function validateEntryCollisions(
  entries: readonly import('node:fs').Dirent[],
  directory: string,
  root: string,
  diagnostics: DiagnosticCollector,
): void {
  /** NFC 与小写折叠后的名字映射到首次出现的原始目录项。 */
  const seen = new Map<string, import('node:fs').Dirent>();
  for (const entry of entries) {
    /** 统一 Unicode 组合形式和大小写后的跨文件系统比较键。 */
    const key = entry.name.normalize('NFC').toLocaleLowerCase('en-US');
    /** 此比较键首次对应的目录项。 */
    const previous = seen.get(key);
    if (!previous) {
      seen.set(key, entry);
      continue;
    }
    /** 当前与首次冲突项都使用工程相对路径，避免报告宿主绝对路径。 */
    const currentPath = relative(root, path.join(directory, entry.name));
    /** 首次出现目录项的工程相对报告路径。 */
    const previousPath = relative(root, path.join(directory, previous.name));
    diagnostics.error('SOURCE_PATH_COLLISION', `Source path collides with "${previous.name}" after case and Unicode normalization.`, {
      phase: 'discover', location: { path: currentPath }, related: [{ path: previousPath }],
    });
  }
}

/**
 * 稳定读取源码目录并立即执行跨文件系统名称碰撞检查。
 *
 * @param directory 待读取绝对目录。
 * @param root 工程根目录。
 * @param diagnostics 当前扫描共享的诊断收集器。
 * @returns 已排序目录项；目录不存在时仍为空数组。
 */
async function listSourceDirectory(
  directory: string,
  root: string,
  diagnostics: DiagnosticCollector,
): Promise<import('node:fs').Dirent[]> {
  /** 名称稳定排序后的当前目录项。 */
  let entries: import('node:fs').Dirent[];
  try {
    entries = await listDirectory(directory);
  } catch {
    diagnostics.error('SOURCE_DIRECTORY_READ_FAILED', 'Cannot read source directory.', {
      phase: 'discover', location: { path: relative(root, directory) },
    });
    return [];
  }
  validateEntryCollisions(entries, directory, root, diagnostics);
  return entries;
}

/**
 * 扫描 `src/commands/*.md` 并构造规范 Command Component。
 *
 * @param config 已解析工程配置。
 * @param diagnostics 当前扫描共享的诊断收集器。
 * @returns 按文件名稳定排序的有效 Command 列表。
 */
async function scanCommands(config: ResolvedConfig, diagnostics: DiagnosticCollector): Promise<CommandComponent[]> {
  /** Command 的固定一级源码目录。 */
  const directory = path.join(config.srcDir, 'commands');
  /** 通过结构和 Frontmatter 验证的 Command。 */
  const result: CommandComponent[] = [];
  for (const entry of await listSourceDirectory(directory, config.root, diagnostics)) {
    /** 当前目录项的绝对源码路径。 */
    const file = path.join(directory, entry.name);
    /** 当前目录项用于报告和 Component 的相对路径。 */
    const sourcePath = relative(config.root, file);
    if (entry.isSymbolicLink()) {
      diagnostics.error('SOURCE_SYMLINK_UNSUPPORTED', 'Symbolic links are not supported.', { phase: 'discover', location: { path: sourcePath } });
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.md')) {
      diagnostics.error('COMMAND_ENTRY_INVALID', 'Commands must be one-level .md files.', { phase: 'discover', location: { path: sourcePath } });
      continue;
    }
    /** 从 `.md` 文件名提取的 Command ID。 */
    const id = entry.name.slice(0, -3);
    if (!validateId(id, sourcePath, diagnostics))
      continue;
    /** 当前 Command 的通用 Markdown 解析结果。 */
    const parsed = await parseMarkdown(file, config.root, diagnostics);
    if (!parsed)
      continue;
    validateFields(parsed.data, ['description', 'argumentHint', 'requires', 'platforms'], sourcePath, diagnostics);
    /** Command 必需的非空描述。 */
    const description = stringField(parsed.data, 'description', sourcePath, diagnostics, true);
    if (!description)
      continue;
    /** 可选的命令参数提示。 */
    const argumentHint = stringField(parsed.data, 'argumentHint', sourcePath, diagnostics);
    validateCommandPlaceholders(parsed.body, sourcePath, diagnostics);
    /** 已满足必需字段要求的不可变规范 Command。 */
    const command: CommandComponent = {
      kind: 'command', id, description, body: parsed.body, sourcePath,
      requires: parseRequires(parsed.data.requires, sourcePath, diagnostics),
      platforms: await parsePlatforms(parsed.data.platforms, { kind: 'command', id, sourcePath }, config, diagnostics),
      ...(argumentHint === undefined ? {} : { argumentHint }),
    };
    result.push(command);
  }
  return result;
}

/**
 * 递归收集 Skill 目录中除 `SKILL.md` 外的辅助文件。
 *
 * @param directory 当前 Skill 根目录。
 * @param config 已解析工程配置。
 * @param diagnostics 当前扫描共享的诊断收集器。
 * @param prefix 当前递归位置相对于 Skill 根目录的路径。
 * @returns 带源路径、目标相对路径和权限的辅助文件列表。
 */
async function collectSkillAuxiliary(
  directory: string,
  config: ResolvedConfig,
  diagnostics: DiagnosticCollector,
  prefix = '',
): Promise<SkillAuxiliaryFile[]> {
  /** 当前递归子树累计发现的普通文件。 */
  const result: SkillAuxiliaryFile[] = [];
  for (const entry of await listSourceDirectory(path.join(directory, prefix), config.root, diagnostics)) {
    if (prefix === '' && entry.name === 'SKILL.md')
      continue;
    /** 辅助文件在最终 Skill 目录中的 POSIX 相对路径。 */
    const relativePath = path.posix.join(prefix.split(path.sep).join('/'), entry.name);
    /** 当前辅助目录项的绝对源路径。 */
    const file = path.join(directory, relativePath);
    if (entry.isSymbolicLink()) {
      diagnostics.error('SOURCE_SYMLINK_UNSUPPORTED', 'Symbolic links are not supported.', {
        phase: 'discover', location: { path: relative(config.root, file) },
      });
    } else if (entry.isDirectory()) {
      result.push(...await collectSkillAuxiliary(directory, config, diagnostics, relativePath));
    } else if (entry.isFile()) {
      /** 辅助文件的权限信息，用于保留是否可执行。 */
      const stat = await fs.stat(file);
      result.push({ path: relativePath, sourcePath: file, mode: modeFromStat(stat.mode) });
    } else {
      diagnostics.error('SOURCE_ENTRY_UNSUPPORTED', 'Only regular files and directories are supported.', {
        phase: 'discover', location: { path: relative(config.root, file) },
      });
    }
  }
  return result;
}

/**
 * 扫描 `src/skills/<id>/SKILL.md` 及其辅助文件。
 *
 * @param config 已解析工程配置。
 * @param diagnostics 当前扫描共享的诊断收集器。
 * @returns 按目录名稳定排序的有效 Skill 列表。
 */
async function scanSkills(config: ResolvedConfig, diagnostics: DiagnosticCollector): Promise<SkillComponent[]> {
  /** Skill 的固定一级源码目录。 */
  const directory = path.join(config.srcDir, 'skills');
  /** 通过结构和 Frontmatter 验证的 Skill。 */
  const result: SkillComponent[] = [];
  for (const entry of await listSourceDirectory(directory, config.root, diagnostics)) {
    /** 当前 Skill 的绝对目录。 */
    const skillDirectory = path.join(directory, entry.name);
    /** 当前 Skill 目录的工程相对路径。 */
    const sourcePath = relative(config.root, skillDirectory);
    if (entry.isSymbolicLink()) {
      diagnostics.error('SOURCE_SYMLINK_UNSUPPORTED', 'Symbolic links are not supported.', { phase: 'discover', location: { path: sourcePath } });
      continue;
    }
    if (!entry.isDirectory()) {
      diagnostics.error('SKILL_ENTRY_INVALID', 'Skills must be one-level directories.', { phase: 'discover', location: { path: sourcePath } });
      continue;
    }
    if (!validateId(entry.name, sourcePath, diagnostics))
      continue;
    /** Skill 必需的主 Markdown 文件。 */
    const file = path.join(skillDirectory, 'SKILL.md');
    if (!await exists(file)) {
      diagnostics.error('SKILL_FILE_REQUIRED', 'Skill directory must contain SKILL.md.', { phase: 'discover', location: { path: sourcePath } });
      continue;
    }
    /** 当前 Skill 的通用 Markdown 解析结果。 */
    const parsed = await parseMarkdown(file, config.root, diagnostics);
    if (!parsed)
      continue;
    /** SKILL.md 用于诊断和 Component 来源的相对路径。 */
    const markdownPath = relative(config.root, file);
    validateFields(parsed.data, ['description', 'invocation', 'requires', 'platforms'], markdownPath, diagnostics);
    /** Skill 必需的非空描述。 */
    const description = stringField(parsed.data, 'description', markdownPath, diagnostics, true);
    if (!description)
      continue;
    /** 是否允许用户显式调用 Skill，默认为开启。 */
    let user = true;
    /** 是否允许模型自主调用 Skill，默认为开启。 */
    let model = true;
    if (parsed.data.invocation !== undefined) {
      if (parsed.data.invocation === null || typeof parsed.data.invocation !== 'object' || Array.isArray(parsed.data.invocation)) {
        diagnostics.error('SKILL_INVOCATION_INVALID', 'invocation must be a mapping.', { phase: 'discover', location: { path: markdownPath }, fieldPath: ['invocation'] });
      } else {
        /** 已验证为映射的调用策略。 */
        const invocation = parsed.data.invocation as Record<string, unknown>;
        for (const key of Object.keys(invocation)) {
          if (key !== 'user' && key !== 'model')
            diagnostics.error('SKILL_INVOCATION_FIELD', `Unknown invocation field "${key}".`, { phase: 'discover', location: { path: markdownPath }, fieldPath: ['invocation', key] });
        }
        if (typeof invocation.user === 'boolean')
          user = invocation.user;
        else if (invocation.user !== undefined)
          diagnostics.error('SKILL_INVOCATION_BOOLEAN', 'invocation.user must be boolean.', { phase: 'discover', location: { path: markdownPath }, fieldPath: ['invocation', 'user'] });
        if (typeof invocation.model === 'boolean')
          model = invocation.model;
        else if (invocation.model !== undefined)
          diagnostics.error('SKILL_INVOCATION_BOOLEAN', 'invocation.model must be boolean.', { phase: 'discover', location: { path: markdownPath }, fieldPath: ['invocation', 'model'] });
      }
    }
    if (!user && !model)
      diagnostics.error('SKILL_INVOCATION_EMPTY', 'invocation.user and invocation.model cannot both be false.', { phase: 'discover', location: { path: markdownPath }, fieldPath: ['invocation'] });
    result.push({
      kind: 'skill', id: entry.name, description, invocation: { user, model },
      body: parsed.body, sourcePath: markdownPath,
      requires: parseRequires(parsed.data.requires, markdownPath, diagnostics),
      platforms: await parsePlatforms(parsed.data.platforms, { kind: 'skill', id: entry.name, sourcePath: markdownPath }, config, diagnostics),
      auxiliaryFiles: await collectSkillAuxiliary(skillDirectory, config, diagnostics),
    });
  }
  return result;
}

/**
 * 扫描 `src/agents/*.md` 并构造规范 Agent Component。
 *
 * @param config 已解析工程配置。
 * @param diagnostics 当前扫描共享的诊断收集器。
 * @returns 按文件名稳定排序的有效 Agent 列表。
 */
async function scanAgents(config: ResolvedConfig, diagnostics: DiagnosticCollector): Promise<AgentComponent[]> {
  /** Agent 的固定一级源码目录。 */
  const directory = path.join(config.srcDir, 'agents');
  /** 通过结构和 Frontmatter 验证的 Agent。 */
  const result: AgentComponent[] = [];
  for (const entry of await listSourceDirectory(directory, config.root, diagnostics)) {
    /** 当前 Agent 目录项的绝对源码路径。 */
    const file = path.join(directory, entry.name);
    /** 当前 Agent 用于报告和 Component 的相对路径。 */
    const sourcePath = relative(config.root, file);
    if (entry.isSymbolicLink()) {
      diagnostics.error('SOURCE_SYMLINK_UNSUPPORTED', 'Symbolic links are not supported.', { phase: 'discover', location: { path: sourcePath } });
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.md')) {
      diagnostics.error('AGENT_ENTRY_INVALID', 'Agents must be one-level .md files.', { phase: 'discover', location: { path: sourcePath } });
      continue;
    }
    /** 从 `.md` 文件名提取的 Agent ID。 */
    const id = entry.name.slice(0, -3);
    if (!validateId(id, sourcePath, diagnostics))
      continue;
    /** 当前 Agent 的通用 Markdown 解析结果。 */
    const parsed = await parseMarkdown(file, config.root, diagnostics);
    if (!parsed)
      continue;
    validateFields(parsed.data, ['description', 'model', 'capabilities', 'requires', 'platforms'], sourcePath, diagnostics);
    /** Agent 必需的非空描述。 */
    const description = stringField(parsed.data, 'description', sourcePath, diagnostics, true);
    if (!description)
      continue;
    /** Frontmatter 提供或由 Core 默认的模型档位。 */
    const modelValue = parsed.data.model ?? 'inherit';
    /** 收敛到 Core 可移植枚举后的模型档位。 */
    const model = typeof modelValue === 'string' && AGENT_MODELS.has(modelValue as AgentModel)
      ? modelValue as AgentModel
      : 'inherit';
    if (model !== modelValue)
      diagnostics.error('AGENT_MODEL_INVALID', 'model must be inherit, fast, or capable.', { phase: 'discover', location: { path: sourcePath }, fieldPath: ['model'] });
    /** 通过字符串数组结构验证、但尚未验证枚举取值的能力。 */
    const capabilityValues = stringArray(parsed.data.capabilities, ['capabilities'], sourcePath, diagnostics);
    /** 仅保留 Core 可移植能力的 Agent 能力列表。 */
    const capabilities = capabilityValues.filter((capability): capability is AgentCapability => {
      if (AGENT_CAPABILITIES.has(capability as AgentCapability))
        return true;
      diagnostics.error('AGENT_CAPABILITY_INVALID', `Unknown capability "${capability}".`, { phase: 'discover', location: { path: sourcePath }, fieldPath: ['capabilities'] });
      return false;
    });
    result.push({
      kind: 'agent', id, description, model, capabilities,
      body: parsed.body, sourcePath,
      requires: parseRequires(parsed.data.requires, sourcePath, diagnostics),
      platforms: await parsePlatforms(parsed.data.platforms, { kind: 'agent', id, sourcePath }, config, diagnostics),
    });
  }
  return result;
}

/**
 * 递归展开一条 Public 复制来源，并拒绝符号链接及特殊文件。
 *
 * @param source 当前源文件或目录路径。
 * @param target 当前来源映射到产物中的相对路径。
 * @param config 已解析工程配置。
 * @param diagnostics 当前扫描共享的诊断收集器。
 * @returns 当前子树中的普通 Public 文件列表。
 */
async function collectPublicTree(
  source: string,
  target: string,
  config: ResolvedConfig,
  diagnostics: DiagnosticCollector,
): Promise<PublicFile[]> {
  /** 当前 Public 来源的文件系统元数据。 */
  let stat: import('node:fs').Stats;
  try {
    stat = await fs.lstat(source);
  } catch /** error 保存当前操作捕获的异常，供本阶段转换或恢复。 */ (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      diagnostics.error('PUBLIC_SOURCE_MISSING', 'Public copy source does not exist.', { phase: 'discover', location: { path: relative(config.root, source) } });
      return [];
    }
    throw error;
  }
  if (stat.isSymbolicLink()) {
    diagnostics.error('SOURCE_SYMLINK_UNSUPPORTED', 'Symbolic links are not supported.', { phase: 'discover', location: { path: relative(config.root, source) } });
    return [];
  }
  if (stat.isFile())
    return [{ sourcePath: source, targetPath: target.split(path.sep).join('/'), mode: modeFromStat(stat.mode) }];
  if (!stat.isDirectory()) {
    diagnostics.error('SOURCE_ENTRY_UNSUPPORTED', 'Only regular files and directories are supported.', { phase: 'discover', location: { path: relative(config.root, source) } });
    return [];
  }
  /** 当前目录子树累计展开的 Public 文件。 */
  const result: PublicFile[] = [];
  for (const entry of await listSourceDirectory(source, config.root, diagnostics))
    result.push(...await collectPublicTree(path.join(source, entry.name), path.join(target, entry.name), config, diagnostics));
  return result;
}

/**
 * 校验 Public 展开后的目标路径唯一性并返回稳定排序快照。
 *
 * @param files 默认目录或 copy rule 展开的 Public 文件。
 * @param config 已解析工程配置。
 * @param diagnostics 当前扫描共享的诊断收集器。
 * @returns 按目标路径排序且保留首个冲突来源的 Public 文件。
 */
function finalizePublicFiles(
  files: readonly PublicFile[],
  config: ResolvedConfig,
  diagnostics: DiagnosticCollector,
): PublicFile[] {
  /** 目标路径经过 Unicode 和大小写折叠后的首个来源。 */
  const targets = new Map<string, PublicFile>();
  /** 无目标冲突且可以安全交给 Artifact Registry 的文件。 */
  const result: PublicFile[] = [];
  for (const file of files) {
    /** 先按两种平台语义拒绝绝对输入，避免规范化掩盖 Win32 drive/UNC。 */
    const unsafe = file.targetPath.includes('\0')
      || path.posix.isAbsolute(file.targetPath)
      || path.win32.isAbsolute(file.targetPath)
      || file.targetPath.split(/[\\/]/u).includes('..');
    /** 所有安全目标统一为规范 POSIX 相对路径。 */
    const targetPath = path.posix.normalize(file.targetPath.replaceAll('\\', '/')).replace(/^\.\//u, '');
    if (unsafe || targetPath === '.' || path.posix.isAbsolute(targetPath) || targetPath.split('/').includes('..')) {
      diagnostics.error('PUBLIC_TARGET_INVALID', 'Public target must be a non-empty relative path.', {
        phase: 'discover', location: { path: relative(config.root, file.sourcePath) },
      });
      continue;
    }
    /** 跨文件系统碰撞使用与 Artifact Registry 相同的保守比较方式。 */
    const key = targetPath.normalize('NFC').toLocaleLowerCase('en-US');
    /** 已占用同一规范目标路径的 Public 文件。 */
    const previous = targets.get(key);
    if (previous) {
      diagnostics.error('PUBLIC_TARGET_COLLISION', `Public target "${targetPath}" conflicts with another copy source.`, {
        phase: 'discover',
        location: { path: relative(config.root, file.sourcePath) },
        related: [{ path: relative(config.root, previous.sourcePath) }],
      });
      continue;
    }
    /** 使用规范化目标创建新对象，不修改 collect 阶段的输入。 */
    const normalized = { ...file, targetPath };
    targets.set(key, normalized);
    result.push(normalized);
  }
  return result.sort((left, right) => compareCodeUnits(left.targetPath, right.targetPath));
}

/**
 * 根据默认整目录规则或显式 copy 规则扫描公共资源。
 *
 * @param config 已解析工程配置。
 * @param diagnostics 当前扫描共享的诊断收集器。
 * @returns 将由每个目标共同接收的 Public 文件列表。
 */
async function scanPublic(config: ResolvedConfig, diagnostics: DiagnosticCollector): Promise<PublicFile[]> {
  if (!config.public.enabled || !await exists(config.public.dir))
    return [];
  if (!config.public.copy)
    return finalizePublicFiles(await collectPublicTree(config.public.dir, '', config, diagnostics), config, diagnostics);
  /** 所有显式 copy 规则展开后的 Public 文件。 */
  const result: PublicFile[] = [];
  for (const rule of config.public.copy)
    result.push(...await collectPublicTree(path.join(config.public.dir, rule.from), rule.to, config, diagnostics));
  return finalizePublicFiles(result, config, diagnostics);
}

/**
 * 构造同时包含 Component 类型和 ID 的依赖图唯一键。
 *
 * @param kind Component 类型。
 * @param id Component ID。
 * @returns 不会让不同类型同名 Component 碰撞的键。
 */
function componentKey(kind: ComponentKind, id: string): string {
  return `${kind}:${id}`;
}

/**
 * 验证 Component 依赖是否存在、是否自引用以及是否形成环。
 *
 * @param components Scanner 发现的全部 Core Component。
 * @param diagnostics 当前扫描共享的诊断收集器。
 */
function validateGraph(components: readonly Component[], diagnostics: DiagnosticCollector): void {
  /** 按类型与 ID 唯一索引的 Component。 */
  const byKey = new Map(components.map(component => [componentKey(component.kind, component.id), component]));
  /** 从每个 Component 指向其直接 Skill/Agent 依赖的邻接表。 */
  const edges = new Map<string, string[]>();
  for (const component of components) {
    /** 当前 Component 的图节点键。 */
    const from = componentKey(component.kind, component.id);
    /** 当前 Component 声明的全部规范依赖节点键。 */
    const targets = [
      ...component.requires.skills.map(id => componentKey('skill', id)),
      ...component.requires.agents.map(id => componentKey('agent', id)),
    ];
    /** 只有存在且非自引用的边进入 DFS，结构错误不再额外伪装成环路。 */
    const traversable: string[] = [];
    for (const target of targets) {
      if (target === from) {
        diagnostics.error('COMPONENT_DEPENDENCY_SELF', `${from} cannot require itself.`, { phase: 'validate', component: { kind: component.kind, id: component.id }, location: { path: component.sourcePath } });
      } else if (!byKey.has(target)) {
        diagnostics.error('COMPONENT_DEPENDENCY_MISSING', `${from} requires missing ${target}.`, { phase: 'validate', component: { kind: component.kind, id: component.id }, location: { path: component.sourcePath } });
      } else {
        traversable.push(target);
      }
    }
    edges.set(from, traversable);
  }

  /** 当前深度优先搜索路径上的节点。 */
  const visiting = new Set<string>();
  /** 已完整检查且确认无需再次遍历的节点。 */
  const visited = new Set<string>();
  /** 当前深度优先路径，用于恢复完整环路。 */
  const stack: string[] = [];
  /** 已报告环路签名，防止同一路径重复产生诊断。 */
  const reported = new Set<string>();
  /**
   * 深度优先检查单个依赖节点。
   *
   * @param node 当前 Component 图节点键。
   */
  const visit = (node: string): void => {
    if (visited.has(node))
      return;
    if (visiting.has(node)) {
      /** 当前节点首次出现在 DFS 路径中的位置。 */
      const start = stack.indexOf(node);
      /** 首尾包含同一节点的可读环路。 */
      const cycle = [...stack.slice(start), node];
      /** 用于诊断和去重的稳定环路文本。 */
      const signature = cycle.join(' -> ');
      if (!reported.has(signature)) {
        diagnostics.error('COMPONENT_DEPENDENCY_CYCLE', `Dependency cycle: ${signature}`, { phase: 'validate' });
        reported.add(signature);
      }
      return;
    }
    visiting.add(node);
    stack.push(node);
    for (const target of edges.get(node) ?? [])
      visit(target);
    stack.pop();
    visiting.delete(node);
    visited.add(node);
  };
  for (const key of [...byKey.keys()].sort())
    visit(key);
}

/**
 * 验证配置来源目录从工程根开始的每一级都不是符号链接。
 *
 * @param root 可信工程根目录。
 * @param directory 已通过配置层 lexical boundary 校验的来源目录。
 * @param diagnostics 当前扫描共享的诊断收集器。
 * @returns 目录不存在或为安全普通目录时返回 true。
 */
async function validateSourceDirectoryRoot(
  root: string,
  directory: string,
  diagnostics: DiagnosticCollector,
): Promise<boolean> {
  /** 从工程根到来源目录的逐级相对路径片段。 */
  const segments = path.relative(root, directory).split(path.sep).filter(Boolean);
  /** 当前正在执行 lstat 的绝对路径。 */
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      /** lstat 不跟随当前层符号链接，因此能阻止配置目录通过链接逃逸。 */
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) {
        diagnostics.error('SOURCE_ROOT_SYMLINK', 'Configured source directories cannot contain symbolic links.', {
          phase: 'discover', location: { path: relative(root, current) },
        });
        return false;
      }
      if (!stat.isDirectory()) {
        diagnostics.error('SOURCE_ROOT_NOT_DIRECTORY', 'Configured source path must be a directory.', {
          phase: 'discover', location: { path: relative(root, current) },
        });
        return false;
      }
    } catch /** error 保存当前操作捕获的异常，供本阶段转换或恢复。 */ (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return true;
      diagnostics.error('SOURCE_ROOT_READ_FAILED', 'Cannot inspect configured source directory.', {
        phase: 'discover', location: { path: relative(root, current) },
      });
      return false;
    }
  }
  return true;
}

/**
 * 检查保留源码目录是否已经启用对应的官方 Extension。
 *
 * @param config 已解析工程配置。
 * @param diagnostics 当前扫描共享的诊断收集器。
 */
async function validateExtensionDirectories(config: ResolvedConfig, diagnostics: DiagnosticCollector): Promise<void> {
  /** Core 识别但只允许由官方 Extension 解释的源码目录映射。 */
  const checks = [
    { directory: 'hooks', extension: '@tokenroll/acplugin-extension-hooks' },
    { directory: 'mcp', extension: '@tokenroll/acplugin-extension-mcp' },
  ];
  /** 已配置 Extension 名称集合。 */
  const enabled = new Set(config.extensions.map(extension => extension.name));
  for (const check of checks) {
    /** 当前可选 Extension 对应的约定源码目录。 */
    const directory = path.join(config.srcDir, check.directory);
    if ((await listDirectory(directory)).length > 0 && !enabled.has(check.extension)) {
      diagnostics.error('EXTENSION_REQUIRED', `Source under src/${check.directory} requires ${check.extension}.`, {
        phase: 'discover', location: { path: relative(config.root, directory) }, hint: `Add ${check.extension} to extensions.`,
      });
    }
  }
}

/**
 * 将 Scanner 产出的工程模型递归复制为运行时不可变快照。
 *
 * @param project 已完成结构和依赖图校验的工程数据。
 * @returns Platform 与 Extension 只能只读访问的 PluginProject。
 */
function freezeProject(project: PluginProject): PluginProject {
  /** 为每个 Component 创建独立的不可变依赖声明。 */
  const freezeRequires = (requires: ComponentRequires): ComponentRequires => Object.freeze({
    skills: Object.freeze([...requires.skills]),
    agents: Object.freeze([...requires.agents]),
  });
  /** Command 数组及其对象、依赖和 Platform 映射均不可修改。 */
  const commands = Object.freeze(project.commands.map(command => Object.freeze({
    ...command,
    requires: freezeRequires(command.requires),
    platforms: Object.freeze({ ...command.platforms }),
  })));
  /** Skill 额外冻结 invocation 与辅助文件描述列表。 */
  const skills = Object.freeze(project.skills.map(skill => Object.freeze({
    ...skill,
    invocation: Object.freeze({ ...skill.invocation }),
    requires: freezeRequires(skill.requires),
    platforms: Object.freeze({ ...skill.platforms }),
    auxiliaryFiles: Object.freeze(skill.auxiliaryFiles.map(file => Object.freeze({ ...file }))),
  })));
  /** Agent 额外冻结能力数组，避免生命周期间发生观察差异。 */
  const agents = Object.freeze(project.agents.map(agent => Object.freeze({
    ...agent,
    capabilities: Object.freeze([...agent.capabilities]),
    requires: freezeRequires(agent.requires),
    platforms: Object.freeze({ ...agent.platforms }),
  })));
  /** Public 只保存文件来源和 mode，但描述对象本身同样必须不可变。 */
  const publicFiles = Object.freeze(project.publicFiles.map(file => Object.freeze({ ...file })));
  /** 可选作者和关键词需要和元数据外壳一起冻结。 */
  const metadata = Object.freeze({
    ...project.metadata,
    ...(project.metadata.author === undefined ? {} : { author: Object.freeze({ ...project.metadata.author }) }),
    ...(project.metadata.keywords === undefined ? {} : { keywords: Object.freeze([...project.metadata.keywords]) }),
  });
  return Object.freeze({ ...project, metadata, commands, skills, agents, publicFiles });
}

/**
 * 扫描 acplugin 规范工程并验证 Component 依赖图。
 *
 * Commands、Skills、Agents 和 Public 互不修改，可并行读取；全部完成后再统一验证跨组件依赖。
 *
 * @param config 已解析且完成路径安全检查的工程配置。
 * @param diagnostics 可选的共享诊断收集器。
 * @returns 规范 PluginProject 以及同一个诊断收集器。
 */
export async function scanProject(
  config: ResolvedConfig,
  diagnostics: DiagnosticCollector = new DiagnosticCollector(),
): Promise<{ project: PluginProject; diagnostics: DiagnosticCollector }> {
  /** srcDir 的完整祖先链必须安全，失败时不能继续跟随目录读取。 */
  const sourceSafe = await validateSourceDirectoryRoot(config.root, config.srcDir, diagnostics);
  /** 禁用 Public 时不访问其缺省路径；启用时执行同样的祖先链检查。 */
  const publicSafe = !config.public.enabled
    || await validateSourceDirectoryRoot(config.root, config.public.dir, diagnostics);
  if (sourceSafe)
    await validateExtensionDirectories(config, diagnostics);
  /** 各独立源码区域并行扫描得到的规范资源。 */
  const [commands, skills, agents, publicFiles] = await Promise.all([
    sourceSafe ? scanCommands(config, diagnostics) : [],
    sourceSafe ? scanSkills(config, diagnostics) : [],
    sourceSafe ? scanAgents(config, diagnostics) : [],
    publicSafe ? scanPublic(config, diagnostics) : [],
  ]);
  validateGraph([...commands, ...skills, ...agents], diagnostics);

  /** 交给固定生命周期中 Platform 与 Extension 使用的只含 Core 语义工程快照。 */
  const project = freezeProject({
    root: config.root,
    metadata: config.metadata,
    commands,
    skills,
    agents,
    publicFiles,
  });
  return { project, diagnostics };
}
