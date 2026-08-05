import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseDocument } from 'yaml';
import { DiagnosticCollector } from './diagnostics.js';
import { extensionIssues } from './extensions.js';
import type {
  AgentCapability,
  AgentComponent,
  AgentModel,
  ArtifactMode,
  CommandComponent,
  Component,
  ComponentKind,
  ComponentRequires,
  PlatformExtensions,
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

  /** 从磁盘读取的完整 Markdown 源码。 */
  let source: string;
  try {
    source = await fs.readFile(file, 'utf8');
  } catch {
    diagnostics.error('MARKDOWN_READ_FAILED', 'Cannot read Markdown.', {
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
 * @returns 有效输入本身；缺失或类型无效时返回空数组。
 */
function stringArray(
  value: unknown,
  fieldPath: readonly string[],
  sourcePath: string,
  diagnostics: DiagnosticCollector,
): string[] {
  if (value === undefined)
    return [];
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item === '')) {
    diagnostics.error('FRONTMATTER_STRING_ARRAY', `${fieldPath.join('.')} must be an array of non-empty strings.`, {
      phase: 'discover', location: { path: sourcePath }, fieldPath,
    });
    return [];
  }
  /** 已通过元素类型与非空检查的字符串列表。 */
  const result = value as string[];
  if (new Set(result).size !== result.length) {
    diagnostics.error('COMPONENT_REQUIRES_DUPLICATE', `${fieldPath.join('.')} contains duplicate IDs.`, {
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
  return {
    skills: stringArray(object.skills, ['requires', 'skills'], sourcePath, diagnostics),
    agents: stringArray(object.agents, ['requires', 'agents'], sourcePath, diagnostics),
  };
}

/**
 * 解析平台扩展映射，并阻止扩展覆盖 Core 的标准 Plugin 语义。
 *
 * @param data extensions 字段的未知值。
 * @param sourcePath 诊断使用的源码路径。
 * @param diagnostics 当前扫描共享的诊断收集器。
 * @returns 已通过结构验证的平台扩展映射。
 */
function parseExtensions(data: unknown, sourcePath: string, diagnostics: DiagnosticCollector): PlatformExtensions {
  if (data === undefined)
    return {};
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    diagnostics.error('EXTENSIONS_INVALID', 'extensions must be a mapping.', {
      phase: 'discover', location: { path: sourcePath }, fieldPath: ['extensions'],
    });
    return {};
  }
  /** 已验证为顶层映射的扩展对象。 */
  const object = data as Record<string, unknown>;
  for (const [key, value] of Object.entries(object)) {
    if (key !== 'claude-code' && key !== 'codex') {
      diagnostics.error('EXTENSION_TARGET_UNKNOWN', `Unknown extension target "${key}".`, {
        phase: 'discover', location: { path: sourcePath }, fieldPath: ['extensions', key],
      });
      continue;
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      diagnostics.error('EXTENSION_VALUE_INVALID', `Extension target "${key}" must be a mapping.`, {
        phase: 'discover', location: { path: sourcePath }, fieldPath: ['extensions', key],
      });
      continue;
    }
    for (const issue of extensionIssues(value, ['extensions', key])) {
      diagnostics.error('EXTENSION_SEMANTICS_INVALID', issue.message, {
        phase: 'discover', location: { path: sourcePath }, fieldPath: issue.path,
      });
    }
  }
  return object as PlatformExtensions;
}

/**
 * 按名称稳定读取目录；目录不存在视为没有对应 Component。
 *
 * @param directory 待读取目录。
 * @returns 排序后的目录项，ENOENT 时返回空数组。
 */
async function listDirectory(directory: string): Promise<import('node:fs').Dirent[]> {
  try {
    return (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return [];
    throw error;
  }
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
  for (const entry of await listDirectory(directory)) {
    /** 当前目录项的绝对源码路径。 */
    const file = path.join(directory, entry.name);
    /** 当前目录项用于报告和 Component 的相对路径。 */
    const sourcePath = relative(config.root, file);
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
    validateFields(parsed.data, ['description', 'argumentHint', 'requires', 'extensions'], sourcePath, diagnostics);
    /** Command 必需的非空描述。 */
    const description = stringField(parsed.data, 'description', sourcePath, diagnostics, true);
    if (!description)
      continue;
    /** 已满足必需字段要求的规范 Command。 */
    const command: CommandComponent = {
      kind: 'command', id, description, body: parsed.body, sourcePath,
      requires: parseRequires(parsed.data.requires, sourcePath, diagnostics),
      extensions: parseExtensions(parsed.data.extensions, sourcePath, diagnostics),
    };
    /** 可选的命令参数提示。 */
    const argumentHint = stringField(parsed.data, 'argumentHint', sourcePath, diagnostics);
    if (argumentHint !== undefined)
      command.argumentHint = argumentHint;
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
  for (const entry of await listDirectory(path.join(directory, prefix))) {
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
  for (const entry of await listDirectory(directory)) {
    /** 当前 Skill 的绝对目录。 */
    const skillDirectory = path.join(directory, entry.name);
    /** 当前 Skill 目录的工程相对路径。 */
    const sourcePath = relative(config.root, skillDirectory);
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
    validateFields(parsed.data, ['description', 'invocation', 'requires', 'extensions'], markdownPath, diagnostics);
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
      extensions: parseExtensions(parsed.data.extensions, markdownPath, diagnostics),
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
  for (const entry of await listDirectory(directory)) {
    /** 当前 Agent 目录项的绝对源码路径。 */
    const file = path.join(directory, entry.name);
    /** 当前 Agent 用于报告和 Component 的相对路径。 */
    const sourcePath = relative(config.root, file);
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
    validateFields(parsed.data, ['description', 'model', 'capabilities', 'requires', 'extensions'], sourcePath, diagnostics);
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
      extensions: parseExtensions(parsed.data.extensions, sourcePath, diagnostics),
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
  } catch (error) {
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
  for (const entry of await listDirectory(source))
    result.push(...await collectPublicTree(path.join(source, entry.name), path.join(target, entry.name), config, diagnostics));
  return result;
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
    return collectPublicTree(config.public.dir, '', config, diagnostics);
  /** 所有显式 copy 规则展开后的 Public 文件。 */
  const result: PublicFile[] = [];
  for (const rule of config.public.copy)
    result.push(...await collectPublicTree(path.join(config.public.dir, rule.from), rule.to, config, diagnostics));
  return result;
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
    edges.set(from, targets);
    for (const target of targets) {
      if (target === from) {
        diagnostics.error('COMPONENT_DEPENDENCY_SELF', `${from} cannot require itself.`, { phase: 'validate', component: { kind: component.kind, id: component.id }, location: { path: component.sourcePath } });
      } else if (!byKey.has(target)) {
        diagnostics.error('COMPONENT_DEPENDENCY_MISSING', `${from} requires missing ${target}.`, { phase: 'validate', component: { kind: component.kind, id: component.id }, location: { path: component.sourcePath } });
      }
    }
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
    for (const target of edges.get(node) ?? []) {
      if (byKey.has(target))
        visit(target);
    }
    stack.pop();
    visiting.delete(node);
    visited.add(node);
  };
  for (const key of [...byKey.keys()].sort())
    visit(key);
}

/**
 * 检查保留源码目录是否已经启用对应的官方 Module。
 *
 * @param config 已解析工程配置。
 * @param diagnostics 当前扫描共享的诊断收集器。
 */
async function validateModuleDirectories(config: ResolvedConfig, diagnostics: DiagnosticCollector): Promise<void> {
  /** Core 识别但只允许由官方 Module 解释的源码目录映射。 */
  const checks = [
    { directory: 'hooks', module: '@tokenroll/acplugin-module-hooks' },
    { directory: 'mcp', module: '@tokenroll/acplugin-module-mcp' },
  ];
  /** 已配置 Module 名称集合。 */
  const enabled = new Set(config.modules.map(module => module.name));
  for (const check of checks) {
    const directory = path.join(config.srcDir, check.directory);
    if ((await listDirectory(directory)).length > 0 && !enabled.has(check.module)) {
      diagnostics.error('MODULE_REQUIRED', `Source under src/${check.directory} requires ${check.module}.`, {
        phase: 'discover', location: { path: relative(config.root, directory) }, hint: `Add ${check.module} to modules.`,
      });
    }
  }
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
  await validateModuleDirectories(config, diagnostics);
  /** 各独立源码区域并行扫描得到的规范资源。 */
  const [commands, skills, agents, publicFiles] = await Promise.all([
    scanCommands(config, diagnostics),
    scanSkills(config, diagnostics),
    scanAgents(config, diagnostics),
    scanPublic(config, diagnostics),
  ]);
  validateGraph([...commands, ...skills, ...agents], diagnostics);

  /** 交给 Module 与 Compiler 使用的只含 Core 语义的工程快照。 */
  const project: PluginProject = {
    root: config.root,
    name: config.name,
    version: config.version,
    description: config.description,
    commands,
    skills,
    agents,
    publicFiles,
  };
  if (config.displayName !== undefined)
    project.displayName = config.displayName;
  return { project, diagnostics };
}
