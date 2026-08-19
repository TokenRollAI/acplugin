import { parseDocument } from 'yaml';
import type {
  AgentCapability,
  AgentComponent,
  AgentModel,
  CanonicalProject,
  CommandComponent,
  ComponentRequires,
  JsonObject,
  JsonValue,
  PluginMetadata,
  SkillComponent,
  SourceDirectoryRef,
  SourceEntry,
} from '../kernel-types.js';
import { AssetRegistry } from '../kernel/asset-registry.js';
import { DiagnosticRegistry } from '../kernel/diagnostic-registry.js';
import { compareCodePoints, safeRelativePath } from '../kernel/path-policy.js';
import { SourceRegistry } from '../kernel/source-registry.js';
import type { CanonicalResourceRoot, ResourceClaims } from './resource-registry.js';

/** Component ID 的规范格式。 */
const COMPONENT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

/** Core 支持的平台中立 Agent model。 */
const AGENT_MODELS = new Set<AgentModel>(['inherit', 'fast', 'capable']);

/** Core 支持的平台中立 Agent capability。 */
const AGENT_CAPABILITIES = new Set<AgentCapability>([
  'filesystem:read', 'filesystem:write', 'search', 'shell', 'network', 'delegate',
]);

/** Markdown 主文件的统一中间形态。 */
interface ParsedMarkdown {
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
function error(
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
async function parseMarkdown(
  sources: ReturnType<SourceRegistry['service']>,
  file: import('../kernel-types.js').SourceFileRef,
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
function fields(data: Readonly<Record<string, unknown>>, allowed: readonly string[], location: string, diagnostics: DiagnosticRegistry): void {
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
function stringField(
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
function strings(
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
function requires(value: unknown, location: string, diagnostics: DiagnosticRegistry): ComponentRequires {
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
function platforms(
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
async function rootEntries(
  root: SourceDirectoryRef | undefined,
  sources: ReturnType<SourceRegistry['service']>,
): Promise<readonly SourceEntry[]> {
  return root === undefined ? Object.freeze([]) : sources.list(root);
}

/** @returns entry 的 Component ID 是否有效，并在失败时报告。 */
function componentId(id: string, location: string, diagnostics: DiagnosticRegistry): boolean {
  if (COMPONENT_ID.test(id))
    return true;
  error(diagnostics, 'COMPONENT_ID_INVALID', `Component ID "${id}" must use lowercase kebab-case.`, location);
  return false;
}

/**
 * 扫描 Command root。
 *
 * @param root 可选 commands root。
 * @param sources canonical Source Service。
 * @param configured 配置 Platform IDs。
 * @param diagnostics 当前诊断集合。
 * @returns 有效 Commands。
 */
async function commands(
  root: SourceDirectoryRef | undefined,
  sources: ReturnType<SourceRegistry['service']>,
  configured: ReadonlySet<string>,
  diagnostics: DiagnosticRegistry,
): Promise<readonly CommandComponent[]> {
  /** 扫描结果在完成后按 ID 排序并冻结。 */
  const result: CommandComponent[] = [];
  for (const entry of await rootEntries(root, sources)) {
    if (entry.type !== 'file' || !entry.name.endsWith('.md')) {
      error(diagnostics, 'COMMAND_ENTRY_INVALID', 'Commands must be one-level .md files.', entry.path);
      continue;
    }
    /** Command ID 来自精确 .md 文件名。 */
    const id = entry.name.slice(0, -3);
    if (!componentId(id, entry.path, diagnostics))
      continue;
    /** Markdown parsing 只使用当前 owner 的 SourceRef。 */
    const markdown = await parseMarkdown(sources, entry.file, diagnostics);
    if (markdown === undefined)
      continue;
    fields(markdown.data, ['description', 'argumentHint', 'requires', 'platforms'], entry.path, diagnostics);
    /** description 是所有 canonical Component 的必填字段。 */
    const description = stringField(markdown.data, 'description', entry.path, diagnostics, true);
    if (description === undefined)
      continue;
    for (const placeholder of markdown.body.match(/\{\{[^{}]*\}\}/gu) ?? []) {
      if (placeholder !== '{{arguments}}')
        error(diagnostics, 'COMMAND_PLACEHOLDER_INVALID', `Unsupported Command placeholder "${placeholder}".`, entry.path);
    }
    /** argumentHint 保持可选且不解释平台语义。 */
    const argumentHint = stringField(markdown.data, 'argumentHint', entry.path, diagnostics);
    result.push(Object.freeze({
      kind: 'command',
      id,
      description,
      ...(argumentHint === undefined ? {} : { argumentHint }),
      body: markdown.body,
      location: Object.freeze({ path: entry.path, bodyLine: markdown.bodyLine }),
      requires: requires(markdown.data.requires, entry.path, diagnostics),
      platforms: platforms(markdown.data.platforms, configured, entry.path, diagnostics),
    }));
  }
  return Object.freeze(result.sort((left, right) => compareCodePoints(left.id, right.id)));
}

/**
 * 扫描 Skill root 和辅助资源。
 *
 * @param root 可选 skills root。
 * @param sources canonical Source Service。
 * @param assets canonical Asset Service。
 * @param configured 配置 Platform IDs。
 * @param diagnostics 当前诊断集合。
 * @returns 有效 Skills。
 */
async function skills(
  root: SourceDirectoryRef | undefined,
  sources: ReturnType<SourceRegistry['service']>,
  assets: ReturnType<AssetRegistry['service']>,
  configured: ReadonlySet<string>,
  diagnostics: DiagnosticRegistry,
): Promise<readonly SkillComponent[]> {
  /** Skill 结果在所有辅助资源完成签发后统一冻结。 */
  const result: SkillComponent[] = [];
  for (const entry of await rootEntries(root, sources)) {
    if (entry.type !== 'directory') {
      error(diagnostics, 'SKILL_ENTRY_INVALID', 'Skills must be one-level directories.', entry.path);
      continue;
    }
    if (!componentId(entry.name, entry.path, diagnostics))
      continue;
    /** 每个 Skill 必须拥有精确名称的主 Markdown 文件。 */
    let skillFile: import('../kernel-types.js').SourceFileRef;
    try {
      skillFile = await sources.file(entry.directory, 'SKILL.md');
    } catch {
      error(diagnostics, 'SKILL_FILE_REQUIRED', 'Skill directory must contain SKILL.md.', entry.path);
      continue;
    }
    /** Skill 主文件沿用 canonical Markdown 解析边界。 */
    const markdown = await parseMarkdown(sources, skillFile, diagnostics);
    if (markdown === undefined)
      continue;
    fields(markdown.data, ['description', 'invocation', 'requires', 'platforms'], skillFile.path, diagnostics);
    /** description 缺失时不能产生不完整 Skill。 */
    const description = stringField(markdown.data, 'description', skillFile.path, diagnostics, true);
    if (description === undefined)
      continue;
    /** Skill 默认允许用户显式调用。 */
    let user = true;
    /** Skill 默认也允许模型自动选择。 */
    let model = true;
    if (markdown.data.invocation !== undefined) {
      /** invocation 保留平台中立的两个布尔维度。 */
      const invocation = markdown.data.invocation;
      if (typeof invocation !== 'object' || invocation === null || Array.isArray(invocation)) {
        error(diagnostics, 'SKILL_INVOCATION_INVALID', 'invocation must be a mapping.', skillFile.path, ['invocation']);
      } else {
        for (const field of Object.keys(invocation)) {
          if (field !== 'user' && field !== 'model')
            error(diagnostics, 'SKILL_INVOCATION_FIELD', `Unknown invocation field "${field}".`, skillFile.path, ['invocation', field]);
        }
        /** invocationUser 只接受显式布尔值。 */
        const invocationUser = (invocation as Record<string, unknown>).user;
        if (typeof invocationUser === 'boolean')
          user = invocationUser;
        else if ((invocation as Record<string, unknown>).user !== undefined)
          error(diagnostics, 'SKILL_INVOCATION_BOOLEAN', 'invocation.user must be boolean.', skillFile.path, ['invocation', 'user']);
        /** invocationModel 使用与 user 相同的严格布尔边界。 */
        const invocationModel = (invocation as Record<string, unknown>).model;
        if (typeof invocationModel === 'boolean')
          model = invocationModel;
        else if ((invocation as Record<string, unknown>).model !== undefined)
          error(diagnostics, 'SKILL_INVOCATION_BOOLEAN', 'invocation.model must be boolean.', skillFile.path, ['invocation', 'model']);
      }
    }
    if (!user && !model)
      error(diagnostics, 'SKILL_INVOCATION_EMPTY', 'invocation.user and invocation.model cannot both be false.', skillFile.path, ['invocation']);
    /** 递归枚举后只把普通辅助文件签发为 SourceAsset。 */
    const auxiliary = [] as { path: string; asset: import('../kernel-types.js').SourceAssetRef }[];
    for (const child of await sources.list(entry.directory, { recursive: true })) {
      if (child.type !== 'file' || child.path === skillFile.path)
        continue;
      /** 辅助资源路径相对 Skill 根而不是项目根。 */
      const relative = child.path.slice(`${entry.path}/`.length);
      auxiliary.push(Object.freeze({ path: safeRelativePath(relative), asset: await assets.fromSource(child.file) }));
    }
    auxiliary.sort((left, right) => compareCodePoints(left.path, right.path));
    result.push(Object.freeze({
      kind: 'skill',
      id: entry.name,
      description,
      invocation: Object.freeze({ user, model }),
      body: markdown.body,
      location: Object.freeze({ path: skillFile.path, bodyLine: markdown.bodyLine }),
      requires: requires(markdown.data.requires, skillFile.path, diagnostics),
      platforms: platforms(markdown.data.platforms, configured, skillFile.path, diagnostics),
      auxiliaryFiles: Object.freeze(auxiliary),
    }));
  }
  return Object.freeze(result.sort((left, right) => compareCodePoints(left.id, right.id)));
}

/**
 * 扫描 Agent root。
 *
 * @param root 可选 agents root。
 * @param sources canonical Source Service。
 * @param configured 配置 Platform IDs。
 * @param diagnostics 当前诊断集合。
 * @returns 有效 Agents。
 */
async function agents(
  root: SourceDirectoryRef | undefined,
  sources: ReturnType<SourceRegistry['service']>,
  configured: ReadonlySet<string>,
  diagnostics: DiagnosticRegistry,
): Promise<readonly AgentComponent[]> {
  /** Agent 结果不携带任何平台物理输出信息。 */
  const result: AgentComponent[] = [];
  for (const entry of await rootEntries(root, sources)) {
    if (entry.type !== 'file' || !entry.name.endsWith('.md')) {
      error(diagnostics, 'AGENT_ENTRY_INVALID', 'Agents must be one-level .md files.', entry.path);
      continue;
    }
    /** Agent ID 来自精确 .md 文件名。 */
    const id = entry.name.slice(0, -3);
    if (!componentId(id, entry.path, diagnostics))
      continue;
    /** Agent 主文件使用相同严格 Frontmatter parser。 */
    const markdown = await parseMarkdown(sources, entry.file, diagnostics);
    if (markdown === undefined)
      continue;
    fields(markdown.data, ['description', 'model', 'capabilities', 'requires', 'platforms'], entry.path, diagnostics);
    /** description 缺失时不创建 Agent。 */
    const description = stringField(markdown.data, 'description', entry.path, diagnostics, true);
    if (description === undefined)
      continue;
    /** 未配置模型时保持跨平台的 inherit 语义。 */
    const rawModel = markdown.data.model ?? 'inherit';
    /** 非法模型回退用于继续收集诊断，但错误会阻止构建。 */
    const model: AgentModel = typeof rawModel === 'string' && AGENT_MODELS.has(rawModel as AgentModel) ? rawModel as AgentModel : 'inherit';
    if (model !== rawModel)
      error(diagnostics, 'AGENT_MODEL_INVALID', 'model must be inherit, fast, or capable.', entry.path, ['model']);
    /** capability 只保留 Core 定义的平台中立集合。 */
    const capabilities = strings(markdown.data.capabilities, ['capabilities'], entry.path, diagnostics)
      .filter((capability): capability is AgentCapability => {
        if (AGENT_CAPABILITIES.has(capability as AgentCapability))
          return true;
        error(diagnostics, 'AGENT_CAPABILITY_INVALID', `Unknown capability "${capability}".`, entry.path, ['capabilities']);
        return false;
      });
    result.push(Object.freeze({
      kind: 'agent',
      id,
      description,
      model,
      capabilities: Object.freeze(capabilities),
      body: markdown.body,
      location: Object.freeze({ path: entry.path, bodyLine: markdown.bodyLine }),
      requires: requires(markdown.data.requires, entry.path, diagnostics),
      platforms: platforms(markdown.data.platforms, configured, entry.path, diagnostics),
    }));
  }
  return Object.freeze(result.sort((left, right) => compareCodePoints(left.id, right.id)));
}

/**
 * 校验跨 Command/Skill/Agent 的依赖图。
 *
 * @param components 完整 canonical Component 集。
 * @param diagnostics 当前诊断集合。
 */
function validateGraph(
  components: readonly (CommandComponent | SkillComponent | AgentComponent)[],
  diagnostics: DiagnosticRegistry,
): void {
  /** kind+id 是允许不同 Component 类型同名的图键。 */
  const key = (kind: string, id: string): string => `${kind}:${id}`;
  /** 完整 Component 索引用于检查引用存在性。 */
  const byKey = new Map(components.map(component => [key(component.kind, component.id), component]));
  /** 只记录通过存在性和自引用检查的有向边。 */
  const edges = new Map<string, string[]>();
  for (const component of components) {
    /** 当前 Component 的唯一图节点键。 */
    const from = key(component.kind, component.id);
    /** Command/Skill/Agent 统一投影为可引用 Skill/Agent 目标。 */
    const targets = [
      ...component.requires.skills.map(id => key('skill', id)),
      ...component.requires.agents.map(id => key('agent', id)),
    ];
    /** 合法边按目标键稳定排序后进入 DFS。 */
    const valid: string[] = [];
    for (const target of targets) {
      if (target === from) {
        diagnostics.report('validate', { code: 'COMPONENT_DEPENDENCY_SELF', severity: 'error', message: `${from} cannot require itself.`, location: { path: component.location.path } }, { owner: 'framework:canonical', component: { kind: component.kind, id: component.id } });
      } else if (!byKey.has(target)) {
        diagnostics.report('validate', { code: 'COMPONENT_DEPENDENCY_MISSING', severity: 'error', message: `${from} requires missing ${target}.`, location: { path: component.location.path } }, { owner: 'framework:canonical', component: { kind: component.kind, id: component.id } });
      } else {
        valid.push(target);
      }
    }
    edges.set(from, valid.sort(compareCodePoints));
  }
  /** visiting 表示当前 DFS 路径上的灰色节点。 */
  const visiting = new Set<string>();
  /** visited 表示已经完成验证的黑色节点。 */
  const visited = new Set<string>();
  /** stack 保留完整循环路径用于稳定诊断。 */
  const stack: string[] = [];
  /** reported 避免同一环路从多个入口重复报告。 */
  const reported = new Set<string>();
  /** 深度优先遍历检测依赖图中的回边。 */
  const visit = (node: string): void => {
    if (visited.has(node))
      return;
    if (visiting.has(node)) {
      /** 回边闭合为包含首尾节点的完整可读路径。 */
      const cycle = [...stack.slice(stack.indexOf(node)), node].join(' -> ');
      if (!reported.has(cycle)) {
        diagnostics.report('validate', { code: 'COMPONENT_DEPENDENCY_CYCLE', severity: 'error', message: `Dependency cycle: ${cycle}.` }, { owner: 'framework:canonical' });
        reported.add(cycle);
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
  for (const node of [...byKey.keys()].sort(compareCodePoints))
    visit(node);
}

/** Canonical Provider 的 Session registries。 */
export interface CanonicalProviderOptions {
  readonly metadata: Readonly<PluginMetadata>;
  readonly platformIds: readonly string[];
  readonly claims: ResourceClaims;
  readonly sources: SourceRegistry;
  readonly assets: AssetRegistry;
  readonly diagnostics: DiagnosticRegistry;
}

/**
 * 发现并验证 Canonical Component graph。
 *
 * Public 和 Runtime 由各自 Provider 合并，因此这里先返回空 publicFiles。
 *
 * @param options 当前 BuildSession registries 与 claims。
 * @returns 不含物理路径的不可变 canonical project。
 */
export async function discoverCanonicalProject(options: CanonicalProviderOptions): Promise<CanonicalProject> {
  /** canonical Source capability 固定绑定 Framework owner。 */
  const sourceService = options.sources.service('framework:canonical');
  /** Skill auxiliary Asset 同样保留 canonical issuer。 */
  const assetService = options.assets.service('framework:canonical');
  /** configured Set 只用于拒绝未安装 Platform namespace。 */
  const configured = new Set(options.platformIds);
  /** 三类互相独立的来源并行扫描，最终诊断由 Registry 排序。 */
  const [discoveredCommands, discoveredSkills, discoveredAgents] = await Promise.all([
    commands(options.claims.canonical.commands, sourceService, configured, options.diagnostics),
    skills(options.claims.canonical.skills, sourceService, assetService, configured, options.diagnostics),
    agents(options.claims.canonical.agents, sourceService, configured, options.diagnostics),
  ]);
  validateGraph([...discoveredCommands, ...discoveredSkills, ...discoveredAgents], options.diagnostics);
  return Object.freeze({
    metadata: options.metadata,
    commands: discoveredCommands,
    skills: discoveredSkills,
    agents: discoveredAgents,
    publicFiles: Object.freeze([]),
  });
}

/** Framework canonical root names的 compile-time exhaustiveness guard。 */
const _canonicalRoots: readonly CanonicalResourceRoot[] = ['commands', 'skills', 'agents'];
void _canonicalRoots;
