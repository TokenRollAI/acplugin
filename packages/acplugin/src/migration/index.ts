import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import matter from 'gray-matter';
import semver from 'semver';
import parseSpdxExpression from 'spdx-expression-parse';
import { input } from '@inquirer/prompts';
import mcp, { defineMcpServer } from '@tokenroll/acplugin-extension-mcp';
import {
  claudeCode,
  defineConfig,
  runProject,
  stableJson,
  type AgentCapability,
  type Diagnostic,
  type PluginMetadata,
} from '../index.js';
import {
  cleanupTempDir,
  downloadGitHubRepo,
  getTempRoot,
  parseGitHubSource,
} from './legacy/github.js';
import { scanClaudeProject } from './legacy/scanner/claude.js';
import {
  hasMarketplace,
  isSinglePlugin,
  scanAllPlugins,
  scanMarketplaceMeta,
  scanPlugin,
} from './legacy/scanner/plugin.js';
import type {
  Agent,
  Command,
  MCPServer,
  PluginScanResult,
  ScanResult,
  Skill,
} from './legacy/types.js';
import type { Hooks } from './legacy/types.js';

/** Plugin 作者邮件与 Core 配置保持一致的保守结构规则。 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** 只在生成工程验证期间向临时 ESM 代理暴露真实公开 API 的全局键。 */
const MIGRATION_VALIDATION_API = Symbol.for('tokenroll.acplugin.migration-validation-api');

/** 并发 Migration 共享同一组不可变公开 API 时用于延迟删除全局桥接。 */
let activeValidationProxies = 0;

/** 临时代理读取的正式主包与 MCP Extension 公开 API。 */
interface MigrationValidationApi {
  /** 生成配置使用的公开恒等辅助函数。 */
  readonly defineConfig: typeof defineConfig;
  /** 空 Component 工程显式选择 Claude Code 时使用的公开 Platform 工厂。 */
  readonly claudeCode: typeof claudeCode;
  /** 安全远程 MCP 描述使用的公开 Extension 工厂。 */
  readonly mcp: typeof mcp;
  /** 每个迁移后 mcp.ts 必须实际调用的品牌化定义工厂。 */
  readonly defineMcpServer: typeof defineMcpServer;
}

/** 控制旧 Claude 工程、Plugin 或 Marketplace 到规范工程的迁移。 */
export interface MigrationOptions {
  /** 解析本地来源与目标路径的工作目录。 */
  cwd?: string;
  /** 本地路径或受支持的 GitHub 来源。 */
  source: string;
  /** 不得已存在且必须位于来源树外的目标目录。 */
  destination?: string;
  /** GitHub 仓库内需要迁移的子路径。 */
  subPath?: string;
  /** Marketplace 中需要选择的单个 Plugin 名称。 */
  plugin?: string;
  /** 是否迁移 Marketplace 中的全部 Plugin。 */
  all?: boolean;
  /** 无法从旧元数据推导时使用的规范 Plugin 名称。 */
  name?: string;
  /** 无法从旧元数据推导时使用的规范描述。 */
  description?: string;
  /** 是否只在临时目录生成和验证，不提交目标目录。 */
  dryRun?: boolean;
  /** 是否把任何降级或未映射资源视为迁移失败。 */
  strict?: boolean;
}

/** 单项旧资源的无损迁移、降级、未映射或跳过结论。 */
export type MigrationOutcome = 'migrated' | 'degraded' | 'unmapped' | 'skipped';

/** 单个旧字段到规范字段的精确保真结论。 */
export type MigrationFieldOutcome = 'mapped' | 'degraded' | 'unmapped';

/** 迁移报告中一个字段的来源、去向和脱敏结论。 */
export interface MigrationField {
  /** 旧资源中的字段名或内容角色。 */
  field: string;
  /** 旧工程内包含该字段的相对来源路径。 */
  source: string;
  /** 新工程内承载映射结果或人工记录的相对路径。 */
  destination: string;
  /** 字段是否完整映射、发生语义降级或无法自动映射。 */
  outcome: MigrationFieldOutcome;
  /** 不包含原始值、凭据或绝对路径的稳定原因。 */
  reason: string;
}

/** 迁移报告中一项旧资源的处理结果与路径映射。 */
export interface MigrationItem {
  /** 旧资源类别。 */
  kind: string;
  /** 规范化后的资源 ID 或来源标识。 */
  id: string;
  /** 该资源的迁移保真度结论。 */
  outcome: MigrationOutcome;
  /** 旧工程内的相对来源路径。 */
  source?: string;
  /** 新工程内的相对目标路径。 */
  destination?: string;
  /** 降级、未映射或跳过的原因。 */
  message?: string;
  /** 该资源全部已发现字段的逐项保真报告。 */
  fields: readonly MigrationField[];
}

/** `acplugin migrate` 返回并持久化的稳定机器可读报告。 */
export interface MigrationReport {
  /** 迁移报告协议版本。 */
  schemaVersion: '1';
  /** 自动识别的旧来源结构。 */
  sourceType: 'project' | 'plugin' | 'marketplace';
  /** 生成的单工程路径；Marketplace 可包含多个工作区成员。 */
  projects: readonly string[];
  /** 所有已识别旧资源的处理结果。 */
  items: readonly MigrationItem[];
  /** 对生成规范工程重新执行 Core 校验得到的诊断。 */
  diagnostics: readonly Diagnostic[];
  /** 是否满足 Core 校验和可选 strict 无损要求。 */
  success: boolean;
  /** 是否未向最终目标目录提交任何文件。 */
  dryRun: boolean;
}

/** 规范 Component ID 接受的小写 kebab-case 格式。 */
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** 写入资源前暂存的字段结论；省略目标时才继承资源目标。 */
type MigrationFieldDraft = Omit<MigrationField, 'destination'> & { readonly destination?: string };

/** 字段结论从完整保真到无法映射的严重度顺序。 */
const FIELD_OUTCOME_RANK: Readonly<Record<MigrationFieldOutcome, number>> = {
  mapped: 0,
  degraded: 1,
  unmapped: 2,
};

/**
 * 记录一个已发现字段的脱敏迁移结论。
 *
 * @param fields 当前资源累计的字段结论。
 * @param field 旧字段名或内容角色。
 * @param source 包含字段的旧工程相对路径。
 * @param outcome 字段保真度。
 * @param reason 不复述原始值的稳定原因。
 * @param destination 字段写入不同文件时使用的精确工程相对路径。
 */
function reportField(
  fields: MigrationFieldDraft[],
  field: string,
  source: string,
  outcome: MigrationFieldOutcome,
  reason: string,
  destination?: string,
): void {
  fields.push({ field, source, outcome, reason, ...(destination === undefined ? {} : { destination }) });
}

/**
 * 按字段最差结论创建唯一的资源级迁移记录。
 *
 * @param resource 不含 outcome/fields 的资源路径与身份。
 * @param fields 已覆盖该资源全部已发现字段的结论。
 * @returns 字段已补齐目标路径且总体 outcome 可审计的资源项。
 */
function migrationItem(
  resource: Omit<MigrationItem, 'outcome' | 'fields'>,
  fields: readonly MigrationFieldDraft[],
): MigrationItem {
  /** 未输出文件的聚合记录统一指向人工可审查的迁移报告。 */
  const destination = resource.destination ?? '.acplugin-migration/report.json';
  /** 字段最差结果决定资源总体，不允许 unmapped 被压低成 degraded。 */
  const worst = fields.reduce<MigrationFieldOutcome>(
    (current, field) => FIELD_OUTCOME_RANK[field.outcome] > FIELD_OUTCOME_RANK[current] ? field.outcome : current,
    'mapped',
  );
  /** 字段 mapped 对应资源 migrated，其余名称在两个协议中一致。 */
  const outcome: MigrationOutcome = worst === 'mapped' ? 'migrated' : worst;
  return {
    ...resource,
    outcome,
    fields: Object.freeze(fields.map(field => Object.freeze({ ...field, destination: field.destination ?? destination }))),
  };
}

/**
 * 生成旧工程内用于报告的 POSIX 相对路径。
 *
 * @param root 旧工程根目录。
 * @param file 旧资源文件路径。
 * @returns 跨平台稳定的相对路径。
 */
function relative(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join('/');
}

/**
 * 把任意旧资源名称收敛为规范 Component ID。
 *
 * @param value 旧名称。
 * @returns 小写 kebab-case ID；无法提取字符时使用稳定回退值。
 */
function safeId(value: string): string {
  /** 移除不支持字符并压缩分隔符后的候选 ID。 */
  const id = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return id || 'migrated-item';
}

/**
 * 判断来源文本是否采用支持的 GitHub URL、前缀或 owner/repo 简写。
 *
 * @param source 用户传入的来源字符串。
 * @returns 符合 GitHub 来源语法时返回 true。
 */
function isGitHubSource(source: string): boolean {
  return source.startsWith('github:')
    || /^https?:\/\/github\.com\//.test(source)
    || (/^[A-Za-z0-9_-]+\/[A-Za-z0-9._-]+(?:#.+)?$/.test(source) && !path.isAbsolute(source));
}

/**
 * 判断路径是否可访问。
 *
 * @param file 待检查路径。
 * @returns 可访问时返回 true，否则返回 false。
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
 * 确保父目录存在后写入迁移文本文件。
 *
 * @param destination 目标文件路径。
 * @param content 文件内容。
 */
async function copyText(destination: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, content);
}

/**
 * 为 Migration 自己生成的 Frontmatter 递归固定对象键顺序。
 *
 * Migration 不依赖 Core 序列化实现，避免隔离子系统重新进入私有 Core 边界。
 *
 * @param value 即将交给 gray-matter 的可序列化值。
 * @returns 保留数组顺序、按英文键名排序对象的副本。
 */
function sortFrontmatter(value: unknown): unknown {
  if (Array.isArray(value))
    return value.map(sortFrontmatter);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(entry => entry[1] !== undefined)
      .sort(([left], [right]) => left.localeCompare(right, 'en'))
      .map(([key, child]) => [key, sortFrontmatter(child)]));
  }
  return value;
}

/**
 * 组合确定性 YAML Frontmatter 与规范 Markdown 正文。
 *
 * @param frontmatter Migration 已完成字段映射的头部数据。
 * @param body 不含 Frontmatter 的 Markdown 正文。
 * @returns 以单个换行结尾的规范 Markdown。
 */
function markdownWithFrontmatter(frontmatter: Record<string, unknown>, body: string): string {
  return matter.stringify(body.trim(), sortFrontmatter(frontmatter) as Record<string, unknown>);
}

/**
 * 创建父目录后按原始字节复制可信来源文件。
 *
 * @param source 已由 Legacy Scanner 限定在来源树内的普通文件。
 * @param destination 新规范工程中的目标文件。
 */
async function copyBytes(source: string, destination: string): Promise<void> {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(source, destination);
}

/**
 * 把旧 Skill 及全部辅助文件迁移为规范 Skill 目录。
 *
 * @param skill Legacy Scanner 读取的 Skill。
 * @param projectRoot 旧工程根目录。
 * @param outputRoot 新规范工程的阶段目录。
 * @param items 共享迁移报告条目数组。
 * @returns 可与其他资源并行等待的文件写入任务。
 */
function migrateSkill(skill: Skill, projectRoot: string, outputRoot: string, items: MigrationItem[]): Promise<void>[] {
  /** 由旧目录名转换出的规范 Skill ID。 */
  const id = safeId(skill.dirName);
  /** 当前 Skill 报告使用的稳定来源路径。 */
  const source = relative(projectRoot, skill.sourcePath);
  /** 当前 Skill 全部已发现字段的保真记录。 */
  const fields: MigrationFieldDraft[] = [];
  reportField(fields, 'name', source, ID_PATTERN.test(skill.dirName) ? 'mapped' : 'degraded', ID_PATTERN.test(skill.dirName)
    ? 'Directory identity maps directly to the canonical Skill ID.'
    : 'Skill identity required lowercase kebab-case normalization.');
  if (skill.frontmatter.name !== undefined) {
    reportField(fields, 'frontmatter.name', source, skill.frontmatter.name === id ? 'mapped' : 'degraded', skill.frontmatter.name === id
      ? 'Frontmatter identity agrees with the canonical directory identity.'
      : 'Frontmatter name differs from the canonical directory identity.');
  }
  /** 优先保留旧描述，否则生成明确的迁移回退描述。 */
  const description = skill.frontmatter.description || skill.frontmatter.when_to_use || `Migrated Skill ${id}.`;
  if (skill.frontmatter.description) {
    reportField(fields, 'description', source, 'mapped', 'Description maps directly to canonical Skill frontmatter.');
  } else if (skill.frontmatter.when_to_use) {
    reportField(fields, 'when_to_use', source, 'mapped', 'when_to_use maps to the canonical Skill description.');
  } else {
    reportField(fields, 'description', source, 'degraded', 'Description required a generated fallback.');
  }
  /** 旧 Skill 未经 Schema 校验的用户调用开关。 */
  const rawUserInvocation = skill.frontmatter['user-invocable'];
  /** 旧 Skill 未经 Schema 校验的模型禁用开关。 */
  const rawModelDisabled = skill.frontmatter['disable-model-invocation'];
  /** 无效或缺失的用户开关回退到旧平台默认 true。 */
  let user = typeof rawUserInvocation === 'boolean' ? rawUserInvocation : true;
  /** 无效或缺失的模型开关回退到旧平台默认可调用。 */
  const model = typeof rawModelDisabled === 'boolean' ? !rawModelDisabled : true;
  if (rawUserInvocation !== undefined) {
    if (typeof rawUserInvocation !== 'boolean') {
      reportField(fields, 'user-invocable', source, 'unmapped', 'user-invocable was not boolean.');
    } else if (!user && !model) {
      user = true;
      reportField(fields, 'user-invocable', source, 'degraded', 'Both invocation paths were disabled; canonical format required enabling user invocation.');
    } else {
      reportField(fields, 'user-invocable', source, 'mapped', 'user-invocable maps to canonical invocation.user.');
    }
  }
  if (rawModelDisabled !== undefined) {
    reportField(fields, 'disable-model-invocation', source, typeof rawModelDisabled === 'boolean' ? 'mapped' : 'unmapped',
      typeof rawModelDisabled === 'boolean'
        ? 'disable-model-invocation maps inversely to canonical invocation.model.'
        : 'disable-model-invocation was not boolean.');
  }
  if (rawUserInvocation === undefined && rawModelDisabled === undefined)
    reportField(fields, 'invocation', source, 'mapped', 'Legacy invocation defaults map to canonical user/model policy.');
  /** Claude Code 专属字段在规范 Skill 中的精确保留映射。 */
  const claudeFields: Record<string, unknown> = {};
  /** 旧 allowed-tools 的稳定数组表示。 */
  const allowedTools = legacyStringList(skill.frontmatter['allowed-tools']);
  if (skill.frontmatter['allowed-tools'] !== undefined) {
    if (allowedTools) {
      claudeFields.allowedTools = allowedTools;
      reportField(fields, 'allowed-tools', source, 'mapped', 'Tool restrictions map to the Claude Code Platform field.');
    } else {
      reportField(fields, 'allowed-tools', source, 'unmapped', 'allowed-tools was not a valid non-empty tool list.');
    }
  }
  /** field 表示当前可精确进入 Claude Code Platform 字段的普通字符串。 */
  for (const field of ['model', 'agent'] as const) {
    /** 旧 Frontmatter 中当前字符串字段。 */
    const value = skill.frontmatter[field];
    if (value !== undefined) {
      if (typeof value === 'string' && value.trim()) {
        claudeFields[field] = value.trim();
        reportField(fields, field, source, 'mapped', `${field} maps to the Claude Code Platform field.`);
      } else {
        reportField(fields, field, source, 'unmapped', `${field} was not a non-empty string.`);
      }
    }
  }
  if (skill.frontmatter.context !== undefined) {
    if (skill.frontmatter.context === 'fork') {
      claudeFields.context = 'fork';
      reportField(fields, 'context', source, 'mapped', 'fork maps to the verified Claude Code context field.');
    } else {
      reportField(fields, 'context', source, 'unmapped', 'Only the verified Claude Code fork context can be preserved.');
    }
  }
  reportUnknownFields(fields, source, skill.frontmatter as unknown as Readonly<Record<string, unknown>>, new Set([
    'name', 'description', 'when_to_use', 'user-invocable', 'disable-model-invocation', 'allowed-tools', 'model', 'context', 'agent',
  ]));
  /** 规范 Skill 主文件的工程相对路径。 */
  const destination = `src/skills/${id}/SKILL.md`;
  reportField(fields, 'body', source, 'mapped', 'Markdown body maps without model-visible annotations.');
  for (const auxiliary of skill.auxFiles) {
    reportField(
      fields,
      `auxiliary:${auxiliary.relativePath}`,
      relative(projectRoot, auxiliary.sourcePath),
      'mapped',
      'Auxiliary file is copied byte-for-byte with the Skill.',
      `src/skills/${id}/${auxiliary.relativePath.split(path.sep).join('/')}`,
    );
  }
  items.push(migrationItem({ kind: 'skill', id, source, destination }, fields));
  /** 主文件及后续辅助文件的并行写入任务。 */
  const writes = [copyText(path.join(outputRoot, destination), markdownWithFrontmatter({
    description,
    invocation: { user, model },
    ...(Object.keys(claudeFields).length === 0 ? {} : { platforms: { 'claude-code': claudeFields } }),
  }, skill.body))];
  for (const auxiliary of skill.auxFiles)
    writes.push(copyBytes(auxiliary.sourcePath, path.join(outputRoot, 'src/skills', id, auxiliary.relativePath)));
  return writes;
}

/**
 * 把逗号分隔字符串或字符串数组转换为去重的非空字段列表。
 *
 * @param value Legacy Frontmatter 中未经验证的工具或 Skill 列表。
 * @returns 有效列表；字段缺失或无效时返回 undefined。
 */
function legacyStringList(value: unknown): string[] | undefined {
  if (value === undefined)
    return undefined;
  /** 字符串使用 Claude 旧格式的逗号分隔规则，数组保持原声明顺序。 */
  const values = typeof value === 'string'
    ? value.split(',').map(item => item.trim()).filter(Boolean)
    : Array.isArray(value) ? value : [];
  if (values.length === 0 || values.some(item => typeof item !== 'string' || item.trim() === ''))
    return undefined;
  /** 去重后的列表，避免生成的新 Platform 字段无法通过严格 Schema。 */
  return [...new Set(values as string[])];
}

/**
 * 把未列入迁移白名单且实际存在的旧 Frontmatter 字段逐项报告为 unmapped。
 *
 * @param fields 当前资源累计的字段级结论。
 * @param source 旧资源相对路径。
 * @param data Legacy Scanner 的宽松 Frontmatter。
 * @param allowed 当前资源可以自动迁移的字段集合。
 */
function reportUnknownFields(
  fields: MigrationFieldDraft[],
  source: string,
  data: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
): void {
  /** field 表示当前需要进入人工迁移流程的旧字段。 */
  for (const field of Object.keys(data).sort((left, right) => left.localeCompare(right, 'en'))) {
    if (!allowed.has(field))
      reportField(fields, field, source, 'unmapped', 'The legacy field has no canonical or verified Platform mapping.');
  }
}

/**
 * 把旧 Command Markdown 迁移为规范 Command，并转换参数占位符。
 *
 * @param command Legacy Scanner 读取的 Command。
 * @param projectRoot 旧工程根目录。
 * @param outputRoot 新规范工程的阶段目录。
 * @param items 共享迁移报告条目数组。
 * @returns Command 文件写入任务。
 */
function migrateCommand(command: Command, projectRoot: string, outputRoot: string, items: MigrationItem[]): Promise<void> {
  /** 由旧文件名转换出的规范 Command ID。 */
  const id = safeId(command.name);
  /** 当前 Command 报告使用的稳定来源路径。 */
  const source = relative(projectRoot, command.sourcePath);
  /** 当前 Command 全部已发现字段的保真记录。 */
  const fields: MigrationFieldDraft[] = [];
  reportField(fields, 'name', source, ID_PATTERN.test(command.name) ? 'mapped' : 'degraded', ID_PATTERN.test(command.name)
    ? 'Filename identity maps directly to the canonical Command ID.'
    : 'Command identity required lowercase kebab-case normalization.');
  /** 解析 Frontmatter 后保留的 Command 正文。 */
  let body = command.content;
  /** 优先读取旧描述，否则使用明确的迁移回退值。 */
  let description = `Migrated Command ${id}.`;
  /** 迁移后写入规范 Frontmatter 的字段集合。 */
  const frontmatter: Record<string, unknown> = {};
  try {
    /** 旧 Command 的 Frontmatter 与正文解析结果。 */
    const parsed = matter(command.content);
    body = parsed.content.trim();
    if (typeof parsed.data.description === 'string' && parsed.data.description.trim()) {
      description = parsed.data.description.trim();
      reportField(fields, 'description', source, 'mapped', 'Description maps directly to canonical Command frontmatter.');
    } else {
      reportField(fields, 'description', source, 'degraded', 'Description required a generated fallback.');
    }
    /** Claude 原生拼写优先于旧工具曾使用的 camelCase 拼写。 */
    const nativeHint = parsed.data['argument-hint'];
    /** camelCase 拼写仍是需要保真的合法 Legacy 输入。 */
    const camelHint = parsed.data.argumentHint;
    /** 两种来源分别规范化，避免 truthy 非字符串绕过字段报告。 */
    const normalizedNative = typeof nativeHint === 'string' && nativeHint.trim() ? nativeHint.trim() : undefined;
    /** camelCase 来源的非空字符串值。 */
    const normalizedCamel = typeof camelHint === 'string' && camelHint.trim() ? camelHint.trim() : undefined;
    if (normalizedNative !== undefined) {
      frontmatter.argumentHint = normalizedNative;
      reportField(fields, 'argument-hint', source, normalizedNative === nativeHint ? 'mapped' : 'degraded', normalizedNative === nativeHint
        ? 'Claude-native argument-hint maps to canonical argumentHint.'
        : 'Claude-native argument-hint required whitespace normalization.');
    } else if (nativeHint !== undefined) {
      reportField(fields, 'argument-hint', source, 'unmapped', 'argument-hint was not a non-empty string.');
    }
    if (normalizedCamel !== undefined && normalizedNative === undefined) {
      frontmatter.argumentHint = normalizedCamel;
      reportField(fields, 'argumentHint', source, normalizedCamel === camelHint ? 'mapped' : 'degraded', normalizedCamel === camelHint
        ? 'Legacy camelCase argumentHint maps directly to canonical argumentHint.'
        : 'Legacy camelCase argumentHint required whitespace normalization.');
    } else if (normalizedCamel !== undefined && normalizedNative !== undefined) {
      reportField(fields, 'argumentHint', source, normalizedCamel === normalizedNative ? 'mapped' : 'degraded', normalizedCamel === normalizedNative
        ? 'Both legacy argument hint spellings agree with the canonical value.'
        : 'Conflicting argument hints were degraded to the Claude-native argument-hint value.');
    } else if (camelHint !== undefined) {
      reportField(fields, 'argumentHint', source, 'unmapped', 'argumentHint was not a non-empty string.');
    }
    /** Claude Code 专属 Command 字段。 */
    const claudeFields: Record<string, unknown> = {};
    /** 旧 allowed-tools 的稳定数组表示。 */
    const allowedTools = legacyStringList(parsed.data['allowed-tools']);
    if (parsed.data['allowed-tools'] !== undefined) {
      if (allowedTools) {
        claudeFields.allowedTools = allowedTools;
        reportField(fields, 'allowed-tools', source, 'mapped', 'Tool restrictions map to the Claude Code Platform field.');
      } else {
        reportField(fields, 'allowed-tools', source, 'unmapped', 'allowed-tools was not a valid non-empty tool list.');
      }
    }
    if (parsed.data.model !== undefined) {
      if (typeof parsed.data.model === 'string' && parsed.data.model.trim()) {
        claudeFields.model = parsed.data.model.trim();
        reportField(fields, 'model', source, 'mapped', 'Model maps to the Claude Code Platform field.');
      } else {
        reportField(fields, 'model', source, 'unmapped', 'model was not a non-empty string.');
      }
    }
    if (Object.keys(claudeFields).length > 0)
      frontmatter.platforms = { 'claude-code': claudeFields };
    reportUnknownFields(fields, source, parsed.data, new Set(['description', 'argument-hint', 'argumentHint', 'allowed-tools', 'model']));
  } catch {
    reportField(fields, 'frontmatter', source, 'unmapped', 'Frontmatter could not be parsed and requires manual recovery.');
  }
  frontmatter.description = description;
  body = body.replaceAll('$ARGUMENTS', '{{arguments}}');
  /** 规范 Command 文件的工程相对路径。 */
  const destination = `src/commands/${id}.md`;
  reportField(fields, 'body', source, 'mapped', 'Markdown body and argument placeholder map to canonical Command content.');
  items.push(migrationItem({ kind: 'command', id, source, destination }, fields));
  return copyText(path.join(outputRoot, destination), markdownWithFrontmatter(frontmatter, body));
}

/**
 * 把旧 Claude 模型名称收敛为 Core 可移植模型档位。
 *
 * @param value 旧 Agent model 字段。
 * @returns fast、capable 或 inherit。
 */
function mappedModel(value: string | undefined): 'inherit' | 'fast' | 'capable' {
  if (value === 'haiku')
    return 'fast';
  if (value === 'sonnet' || value === 'opus')
    return 'capable';
  return 'inherit';
}

/**
 * 从 Claude Code 工具名推导跨平台保守能力集合。
 *
 * 精确工具白名单仍保存在 Claude Code Platform 字段中；这里只为其他 Platform 提供可移植近似。
 *
 * @param tools 已验证的旧 Claude Code 工具名。
 * @returns 按 Core 固定顺序去重的规范能力。
 */
function capabilitiesFromTools(tools: readonly string[]): AgentCapability[] {
  /** 每个稳定工具对应的最小规范能力。 */
  const mapping: Readonly<Record<string, AgentCapability>> = {
    Read: 'filesystem:read',
    Write: 'filesystem:write',
    Edit: 'filesystem:write',
    NotebookEdit: 'filesystem:write',
    Glob: 'search',
    Grep: 'search',
    Bash: 'shell',
    WebFetch: 'network',
    Agent: 'delegate',
    Task: 'delegate',
  };
  /** 工具列表映射得到的能力集合。 */
  const found = new Set<AgentCapability>();
  for (const tool of tools) {
    // WebSearch 同时依赖发现能力和远程访问，不能压缩成单一 capability。
    if (tool === 'WebSearch') {
      found.add('search');
      found.add('network');
      continue;
    }
    /** 当前 Claude 工具可保守映射出的单一规范能力。 */
    const capability = mapping[tool];
    if (capability !== undefined)
      found.add(capability);
  }
  /** Core 对外采用的固定能力顺序。 */
  const order: readonly AgentCapability[] = ['filesystem:read', 'filesystem:write', 'search', 'shell', 'network', 'delegate'];
  return order.filter(capability => found.has(capability));
}

/**
 * 把旧 Agent Markdown 迁移为规范 Agent，并泛化平台模型名称。
 *
 * @param agent Legacy Scanner 读取的 Agent。
 * @param projectRoot 旧工程根目录。
 * @param outputRoot 新规范工程的阶段目录。
 * @param items 共享迁移报告条目数组。
 * @returns Agent 文件写入任务。
 */
function migrateAgent(agent: Agent, projectRoot: string, outputRoot: string, items: MigrationItem[]): Promise<void> {
  /** 由旧文件名转换出的规范 Agent ID。 */
  const id = safeId(agent.fileName);
  /** 当前 Agent 报告使用的稳定来源路径。 */
  const source = relative(projectRoot, agent.sourcePath);
  /** 当前 Agent 全部已发现字段的保真记录。 */
  const fields: MigrationFieldDraft[] = [];
  reportField(fields, 'name', source, ID_PATTERN.test(agent.fileName) ? 'mapped' : 'degraded', ID_PATTERN.test(agent.fileName)
    ? 'Filename identity maps directly to the canonical Agent ID.'
    : 'Agent identity required lowercase kebab-case normalization.');
  if (agent.frontmatter.name !== undefined) {
    reportField(fields, 'frontmatter.name', source, agent.frontmatter.name === id ? 'mapped' : 'degraded', agent.frontmatter.name === id
      ? 'Frontmatter identity agrees with the canonical filename identity.'
      : 'Frontmatter name differs from the canonical filename identity.');
  }
  /** 旧描述或明确的迁移回退描述。 */
  const description = agent.frontmatter.description || `Migrated Agent ${id}.`;
  reportField(fields, 'description', source, agent.frontmatter.description ? 'mapped' : 'degraded', agent.frontmatter.description
    ? 'Description maps directly to canonical Agent frontmatter.'
    : 'Description required a generated fallback.');
  /** 旧模型是否属于可映射的已知集合。 */
  const knownModel = agent.frontmatter.model === undefined || ['inherit', 'haiku', 'sonnet', 'opus'].includes(agent.frontmatter.model);
  if (agent.frontmatter.model !== undefined) {
    reportField(fields, 'model', source, knownModel ? 'mapped' : 'degraded', knownModel
      ? 'Known Claude model maps to the canonical model class.'
      : 'Unknown model was generalized to inherit.');
  }
  /** 可以由 Claude Code Platform 精确保留的 Agent 字段。 */
  const claudeFields: Record<string, unknown> = {};
  /** 旧工具白名单及其跨平台保守能力映射。 */
  const tools = legacyStringList(agent.frontmatter.tools);
  if (agent.frontmatter.tools !== undefined) {
    if (tools) {
      claudeFields.tools = tools;
      /** 无法推导跨平台 capability 的工具仍会在 Claude Code 字段中精确保留。 */
      const hasPlatformOnlyTool = tools.some(tool => capabilitiesFromTools([tool]).length === 0);
      reportField(fields, 'tools', source, hasPlatformOnlyTool ? 'degraded' : 'mapped', hasPlatformOnlyTool
        ? 'Tool restrictions are preserved for Claude Code, but at least one tool has no portable capability mapping.'
        : 'Tool restrictions map to Claude Code and portable capabilities.');
    } else {
      reportField(fields, 'tools', source, 'unmapped', 'tools was not a valid non-empty tool list.');
    }
  }
  /** 旧工具黑名单仅在 Claude Code Platform 中精确保留。 */
  const disallowedTools = legacyStringList(agent.frontmatter.disallowedTools);
  if (agent.frontmatter.disallowedTools !== undefined) {
    if (disallowedTools) {
      claudeFields.disallowedTools = disallowedTools;
      reportField(fields, 'disallowedTools', source, 'mapped', 'Denied tools map to the Claude Code Platform field.');
    } else {
      reportField(fields, 'disallowedTools', source, 'unmapped', 'disallowedTools was not a valid non-empty tool list.');
    }
  }
  /** 字段及其允许值谓词组成的 Claude Code 精确映射表。 */
  const exactFields: readonly [string, unknown, (value: unknown) => boolean][] = [
    ['effort', agent.frontmatter.effort, value => typeof value === 'string' && ['low', 'medium', 'high', 'xhigh', 'max'].includes(value)],
    ['maxTurns', agent.frontmatter.maxTurns, value => Number.isInteger(value) && Number(value) > 0],
    ['skills', agent.frontmatter.skills, value => legacyStringList(value) !== undefined],
    ['memory', agent.frontmatter.memory, value => typeof value === 'string' && ['user', 'project', 'local'].includes(value)],
    ['background', agent.frontmatter.background, value => typeof value === 'boolean'],
    ['isolation', agent.frontmatter.isolation, value => value === 'worktree'],
  ];
  /** [field, value, valid] 表示当前可进入 Claude Code Agent Platform 字段的候选。 */
  for (const [field, value, valid] of exactFields) {
    if (value === undefined)
      continue;
    if (valid(value)) {
      claudeFields[field] = field === 'skills' ? legacyStringList(value)! : value;
      reportField(fields, field, source, 'mapped', `${field} maps to the verified Claude Code Platform field.`);
    } else {
      reportField(fields, field, source, 'unmapped', `${field} did not satisfy the current Claude Code field contract.`);
    }
  }
  reportUnknownFields(fields, source, agent.frontmatter as unknown as Readonly<Record<string, unknown>>, new Set([
    'name', 'description', 'tools', 'disallowedTools', 'model', 'effort', 'maxTurns', 'skills', 'memory', 'background', 'isolation',
  ]));
  /** 规范 Agent 文件的工程相对路径。 */
  const destination = `src/agents/${id}.md`;
  reportField(fields, 'body', source, 'mapped', 'Markdown body maps without model-visible migration annotations.');
  items.push(migrationItem({ kind: 'agent', id, source, destination }, fields));
  return copyText(path.join(outputRoot, destination), markdownWithFrontmatter({
    description,
    model: mappedModel(agent.frontmatter.model),
    capabilities: capabilitiesFromTools(tools ?? []),
    ...(Object.keys(claudeFields).length === 0 ? {} : { platforms: { 'claude-code': claudeFields } }),
  }, agent.body));
}

/**
 * 识别仅包含 `${ENV_NAME}` 的安全环境变量引用。
 *
 * @param value 旧配置中的字符串值。
 * @returns 环境变量名称；包含字面量或无效语法时返回 undefined。
 */
function environmentReference(value: string): string | undefined {
  /** 完整匹配环境变量插值的捕获结果。 */
  const match = value.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/);
  return match?.[1];
}

/**
 * 尝试把无凭据、HTTPS 且只引用环境变量的旧远程 MCP 转为类型化定义源码。
 *
 * @param server Legacy Scanner 读取的 MCP Server。
 * @returns 可安全自动迁移的 `mcp.ts` 源码，否则返回 undefined 并转入未映射区。
 */
function remoteMcpSource(server: MCPServer): string | undefined {
  if (!server.url || !['http', 'streamable-http', undefined].includes(server.type))
    return undefined;
  /** 完成语法与敏感 URL 组件检查的远程端点。 */
  let endpoint: URL;
  try {
    endpoint = new URL(server.url);
  } catch {
    return undefined;
  }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
    return undefined;
  /** 仅保留环境变量引用的非认证 Header。 */
  const headers: Record<string, unknown> = {};
  /** 从 Authorization Header 提取的可选 Bearer 环境变量策略。 */
  let auth: Record<string, string> | undefined;
  for (const [name, value] of Object.entries(server.headers ?? {})) {
    /** Authorization Header 是否是可安全迁移的 Bearer 环境变量引用。 */
    const bearer = name.toLowerCase() === 'authorization' && value.match(/^Bearer \$\{([A-Za-z_][A-Za-z0-9_]*)\}$/);
    if (bearer) {
      auth = { type: 'bearer', env: bearer[1]! };
      continue;
    }
    /** 普通 Header 值中唯一允许保留的环境变量名。 */
    const env = environmentReference(value);
    if (!env)
      return undefined;
    headers[name] = { env };
  }
  /** 按稳定格式组装的类型化 MCP 描述源码行。 */
  const descriptor = [
    `import { defineMcpServer } from '@tokenroll/acplugin-extension-mcp';`,
    '',
    'export default defineMcpServer({',
    `  transport: 'http',`,
    `  url: ${JSON.stringify(endpoint.href)},`,
    ...(auth ? [`  auth: ${JSON.stringify(auth)},`] : []),
    ...(Object.keys(headers).length ? [`  headers: ${JSON.stringify(headers, null, 2).replaceAll('\n', '\n  ')},`] : []),
    '});',
    '',
  ];
  return descriptor.join('\n');
}

/**
 * 创建可供人工恢复的旧 MCP 摘要，同时移除参数、环境值、Header 值和 URL 凭据。
 *
 * @param server 无法自动迁移的旧 MCP Server。
 * @returns 不包含已知敏感值的结构化摘要。
 */
function redactedMcpServer(server: MCPServer): Record<string, unknown> {
  /** 清除凭据、查询和片段后的可选 URL。 */
  let url = server.url;
  if (url) {
    try {
      /** 用于移除用户信息、查询和片段的 URL 副本。 */
      const parsed = new URL(url);
      parsed.username = '';
      parsed.password = '';
      parsed.search = '';
      parsed.hash = '';
      url = parsed.href;
    } catch {
      url = '<redacted-invalid-url>';
    }
  }
  return {
    name: server.name,
    ...(server.type === undefined ? {} : { type: server.type }),
    ...(server.command === undefined ? {} : { command: server.command }),
    ...(server.args === undefined ? {} : { args: server.args.map(() => '<redacted>') }),
    ...(server.env === undefined ? {} : { env: Object.fromEntries(Object.keys(server.env).sort().map(name => [name, '<redacted>'])) }),
    ...(url === undefined ? {} : { url }),
    ...(server.headers === undefined ? {} : { headers: Object.fromEntries(Object.keys(server.headers).sort().map(name => [name, '<redacted>'])) }),
  };
}

/**
 * 把无法安全自动迁移的文本保存在专用未映射目录。
 *
 * @param outputRoot 新规范工程的阶段目录。
 * @param category 未映射资源类别。
 * @param filename 保留内容使用的相对文件名。
 * @param content 已脱敏或本就不含凭据的内容。
 * @returns 新工程内的未映射文件路径。
 */
async function unmapped(
  outputRoot: string,
  category: string,
  filename: string,
  content: string,
): Promise<string> {
  /** 与可发布源码隔离的未映射目标路径。 */
  const destination = `.acplugin-migration/unmapped/${category}/${filename}`;
  await copyText(path.join(outputRoot, destination), content);
  return destination;
}

/**
 * 从旧 Hook 命令中提取相对于 Plugin/Project 根目录的文件引用候选。
 *
 * @param hooks Legacy Scanner 读取的原始 Hook 配置。
 * @returns 去重并稳定排序的相对路径。
 */
function hookReferenceCandidates(hooks: Hooks): string[] {
  /** 从环境变量根路径和 `./` 语法提取的引用集合。 */
  const references = new Set<string>();
  for (const matchers of Object.values(hooks)) {
    for (const matcher of matchers) {
      for (const hook of matcher.hooks) {
        if (!hook.command)
          continue;
        for (const match of hook.command.matchAll(/(?:\$\{(?:CLAUDE_PLUGIN_ROOT|CLAUDE_PROJECT_DIR)\}|\$(?:CLAUDE_PLUGIN_ROOT|CLAUDE_PROJECT_DIR))\/([^\s"'`;|&]+)/g))
          references.add(match[1]!);
        for (const match of hook.command.matchAll(/(?:^|[\s"'=])\.\/([^\s"'`;|&]+)/g))
          references.add(match[1]!);
      }
    }
  }
  return [...references].sort((a, b) => a.localeCompare(b, 'en'));
}

/**
 * 递归保留旧 Hook 引用文件，但不把未经类型化迁移的代码加入可发布源码。
 *
 * @param sourceRoot 旧工程根目录和路径信任边界。
 * @param relativePath Hook 命令提取出的相对路径。
 * @param outputRoot 新规范工程的阶段目录。
 * @param items 共享迁移报告条目数组。
 */
async function copyHookReference(
  sourceRoot: string,
  relativePath: string,
  outputRoot: string,
  items: MigrationItem[],
): Promise<void> {
  /** 解析后的 Hook 引用绝对路径。 */
  const source = path.resolve(sourceRoot, relativePath);
  /** 用于阻止目录逃逸并生成报告的来源相对路径。 */
  const relation = path.relative(sourceRoot, source);
  if (relation === '..' || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) {
    /** 越界引用只保留脱敏字段结论，不把绝对解析路径写入报告。 */
    const safeSource = relativePath.split(path.sep).join('/');
    items.push(migrationItem({ kind: 'hook-file', id: safeSource }, [{
      field: 'content', source: safeSource, outcome: 'unmapped',
      reason: 'Referenced Hook file escapes the source project and was not copied.',
    }]));
    return;
  }
  /** 引用文件的 lstat 元数据，用于拒绝符号链接。 */
  let stat: import('node:fs').Stats;
  try {
    stat = await fs.lstat(source);
  } catch {
    /** 不存在的引用仍用工程相对路径进入字段报告。 */
    const normalized = relation.split(path.sep).join('/');
    items.push(migrationItem({ kind: 'hook-file', id: relativePath, source: normalized }, [{
      field: 'content', source: normalized, outcome: 'unmapped',
      reason: 'Referenced Hook file does not exist and requires manual recovery.',
    }]));
    return;
  }
  if (stat.isSymbolicLink()) {
    /** 符号链接不解引用，只报告链接自身的相对位置。 */
    const normalized = relation.split(path.sep).join('/');
    items.push(migrationItem({ kind: 'hook-file', id: relativePath, source: normalized }, [{
      field: 'content', source: normalized, outcome: 'unmapped',
      reason: 'Referenced Hook symlinks are not copied.',
    }]));
    return;
  }
  if (stat.isDirectory()) {
    /** 按名称稳定递归的目录项。 */
    const entries = await fs.readdir(source, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'en')))
      await copyHookReference(sourceRoot, path.join(relativePath, entry.name), outputRoot, items);
    return;
  }
  if (!stat.isFile())
    return;
  /** 报告和未映射目录使用的 POSIX 相对路径。 */
  const normalized = relation.split(path.sep).join('/');
  /** 与可发布源码隔离的 Hook 文件目标路径。 */
  const destination = `.acplugin-migration/unmapped/hook-files/${normalized}`;
  /** 未映射文件的绝对写入路径。 */
  const output = path.join(outputRoot, destination);
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.copyFile(source, output);
  items.push(migrationItem({ kind: 'hook-file', id: normalized, source: normalized, destination }, [{
    field: 'content', source: normalized, destination, outcome: 'unmapped',
    reason: 'Referenced Hook implementation was preserved for manual typed migration.',
  }]));
}

/** 旧 JSON 中可枚举且不是数组的对象形态。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 按 Core 规则把非空字符串去除首尾空白。
 *
 * @param value 未经 Schema 验证的旧字段值。
 * @returns 可进入规范配置的字符串；类型或内容无效时返回 undefined。
 */
function normalizedText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * 使用与 Core 一致的绝对 HTTP(S) URL 边界。
 *
 * @param value 已去除首尾空白的 URL 候选。
 * @returns URL 具有 HTTP(S) 协议和主机名时返回 true。
 */
function isHttpUrl(value: string): boolean {
  try {
    /** 标准 URL 解析结果用于拒绝相对路径和不完整主机名。 */
    const parsed = new URL(value);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname.length > 0;
  } catch {
    return false;
  }
}

/**
 * 判断字符串是否为 Core 接受的 SPDX 许可表达式。
 *
 * @param value 已去除首尾空白的许可候选。
 * @returns SPDX Parser 接受该完整表达式时返回 true。
 */
function isSpdxExpression(value: string): boolean {
  try {
    parseSpdxExpression(value);
    return true;
  } catch {
    return false;
  }
}

/** 统一元数据字段及其旧 interface 回退来源。 */
interface MetadataCandidate {
  /** 报告中保留的精确旧字段路径。 */
  readonly field: string;
  /** 未经旧 Schema 校验的字段值。 */
  readonly value: unknown;
  /** 该字段是否只能作为统一字段的回退来源。 */
  readonly fallback: boolean;
}

/**
 * 从一组优先级候选选择首个合法文本，并逐项报告所有实际来源。
 *
 * @param fields 当前元数据资源的字段报告。
 * @param source 旧元数据清单相对路径。
 * @param candidates 主字段和 interface 回退字段的优先级列表。
 * @param label 不包含原始值的字段说明。
 * @param validate 对规范化文本执行的可选 Core 等价校验。
 * @returns 首个合法候选的规范化值。
 */
function selectMetadataText(
  fields: MigrationFieldDraft[],
  source: string,
  candidates: readonly MetadataCandidate[],
  label: string,
  validate: (value: string) => boolean = () => true,
): string | undefined {
  /** 每个实际来源的规范化结果；undefined 表示无法自动映射。 */
  const normalized = candidates.map(candidate => candidate.value === undefined
    ? undefined
    : normalizedText(candidate.value));
  /** 首个同时满足文本和字段专属契约的来源索引。 */
  const selectedIndex = normalized.findIndex(value => value !== undefined && validate(value));
  /** 最终进入规范配置的字段值。 */
  const selected = selectedIndex < 0 ? undefined : normalized[selectedIndex];
  for (const [index, candidate] of candidates.entries()) {
    if (candidate.value === undefined)
      continue;
    /** 当前来源去空白后的候选文本。 */
    const value = normalized[index];
    if (value === undefined || !validate(value)) {
      reportField(fields, candidate.field, source, 'unmapped', `${label} did not satisfy the canonical metadata contract.`);
    } else if (index === selectedIndex) {
      /** 回退选择或字符串规范化都必须在总体报告中保持 degraded。 */
      const normalizedOrFallback = candidate.fallback || value !== candidate.value;
      reportField(fields, candidate.field, source, normalizedOrFallback ? 'degraded' : 'mapped', normalizedOrFallback
        ? `${label} required fallback selection or whitespace normalization.`
        : `${label} maps directly to the corresponding top-level config field.`);
    } else if (value === selected) {
      reportField(fields, candidate.field, source, 'degraded', `${label} duplicates the selected source and was collapsed into one canonical field.`);
    } else {
      reportField(fields, candidate.field, source, 'unmapped', `${label} conflicts with the higher-priority source and cannot be represented separately.`);
    }
  }
  return selected;
}

/**
 * 从旧 Plugin 元数据、CLI 参数或交互提示中确定规范工程元数据。
 *
 * @param scan Legacy Scanner 结果。
 * @param options 迁移 CLI 选项。
 * @returns 已验证名称、版本、描述和可选展示名称。
 */
async function metadataFor(scan: ScanResult, options: MigrationOptions, items: MigrationItem[]): Promise<PluginMetadata> {
  /** 仅 Plugin/Marketplace 扫描结果携带的旧 Plugin 元数据。 */
  const plugin = 'meta' in scan ? scan as PluginScanResult : undefined;
  /** Plugin 元数据来自清单；Project 的必填值来自 CLI 并以来源根表示。 */
  const source = plugin?.metadataSource ?? '.';
  /** 顶层元数据全部已发现字段的保真记录。 */
  const fields: MigrationFieldDraft[] = [];
  /** 只有普通对象形态的 Marketplace interface 才能安全枚举回退字段。 */
  const pluginInterface = isRecord(plugin?.meta.interface) ? plugin.meta.interface : undefined;
  if (plugin?.meta.interface !== undefined && pluginInterface === undefined)
    reportField(fields, 'interface', source, 'unmapped', 'Marketplace interface was not an object.');

  /** CLI 或旧元数据提供的原始名称候选。 */
  let rawName: unknown = options.name ?? plugin?.meta.name;
  if (rawName === undefined && process.stdin.isTTY)
    rawName = await input({ message: 'Plugin name', default: safeId(path.basename(scan.rootDir)) });
  if (rawName === undefined)
    throw new Error('Migration requires plugin name and description; pass --name and --description in non-interactive mode.');
  if (options.name !== undefined && !ID_PATTERN.test(options.name))
    throw new Error('Migration plugin name must be lowercase kebab-case.');
  /** 最终名称；旧名称可以安全规范化，显式 CLI 名称仍保持严格输入边界。 */
  const name = typeof rawName === 'string' && ID_PATTERN.test(rawName)
    ? rawName
    : safeId(typeof rawName === 'string' ? rawName : path.basename(scan.rootDir));
  reportField(fields, 'name', source,
    typeof rawName === 'string' && ID_PATTERN.test(rawName) && (options.name === undefined || plugin?.meta.name === undefined || plugin.meta.name === rawName)
      ? 'mapped'
      : typeof rawName === 'string' ? 'degraded' : 'unmapped',
    typeof rawName === 'string' && ID_PATTERN.test(rawName)
      ? options.name !== undefined && plugin?.meta.name !== undefined && plugin.meta.name !== rawName
        ? 'Explicit migration name overrides a different legacy identity.'
        : 'Plugin identity maps to top-level config name.'
      : typeof rawName === 'string'
        ? 'Legacy identity required lowercase kebab-case normalization.'
        : 'Invalid legacy identity required a directory-name fallback.');

  /** 旧根描述及两个 Marketplace interface 回退字段。 */
  const descriptionCandidates: readonly MetadataCandidate[] = [
    { field: 'description', value: plugin?.meta.description, fallback: false },
    { field: 'interface.shortDescription', value: pluginInterface?.shortDescription, fallback: true },
    { field: 'interface.longDescription', value: pluginInterface?.longDescription, fallback: true },
  ];
  /** 未提供 CLI 覆盖时由旧字段优先级选出的描述。 */
  const legacyDescription = options.description === undefined
    ? selectMetadataText(fields, source, descriptionCandidates, 'Description')
    : undefined;
  /** CLI 描述也按 Core 规则规范化，不允许空白字符串绕过。 */
  let description = normalizedText(options.description) ?? legacyDescription;
  if (options.description !== undefined) {
    if (description === undefined)
      throw new Error('Migration description must be a non-empty string.');
    /** candidate 表示被显式 CLI 描述取代、但仍必须报告的旧来源字段。 */
    for (const candidate of descriptionCandidates) {
      if (candidate.value === undefined)
        continue;
      /** 旧描述的规范化文本，用于区分无效输入与有意覆盖。 */
      const value = normalizedText(candidate.value);
      reportField(fields, candidate.field, source, value === undefined ? 'unmapped' : 'degraded', value === undefined
        ? 'Description did not satisfy the canonical metadata contract.'
        : 'Explicit migration description superseded this legacy description source.');
    }
    if (!plugin)
      reportField(fields, 'description', source, description === options.description ? 'mapped' : 'degraded', description === options.description
        ? 'Explicit description maps to top-level config description.'
        : 'Explicit description required whitespace normalization.');
  }
  if (description === undefined && process.stdin.isTTY)
    description = normalizedText(await input({ message: 'Plugin description' }));
  if (description === undefined)
    throw new Error('Migration requires plugin name and description; pass --name and --description in non-interactive mode.');

  /** npm SemVer 解析器与 Core 使用同一完整版本规则，包括 build metadata。 */
  const rawVersion = plugin?.meta.version as unknown;
  /** 合法旧版本或明确记录降级后的稳定迁移默认版本。 */
  const version = typeof rawVersion === 'string' && semver.valid(rawVersion) ? rawVersion : '0.1.0';
  if (rawVersion !== undefined) {
    reportField(fields, 'version', source, version === rawVersion ? 'mapped' : 'degraded', version === rawVersion
      ? 'Semantic version maps directly to top-level config version.'
      : 'Invalid legacy version required the 0.1.0 fallback.');
  } else {
    reportField(fields, 'version', source, 'degraded', 'Missing legacy version required the 0.1.0 migration default.');
  }

  /** 展示名称优先保留根字段，Marketplace interface 只提供显式降级回退。 */
  const displayName = selectMetadataText(fields, source, [
    { field: 'displayName', value: plugin?.meta.displayName, fallback: false },
    { field: 'interface.displayName', value: pluginInterface?.displayName, fallback: true },
  ], 'Display name');

  /** 旧 author 可能来自未经 Schema 校验的任意 JSON 值。 */
  const rawAuthor = plugin?.meta.author as unknown;
  /** 只有根 author.name 合法时才允许组合其 email/url。 */
  const authorRecord = isRecord(rawAuthor) ? rawAuthor : undefined;
  /** 根作者名称去空白后的候选。 */
  const rootAuthorName = normalizedText(authorRecord?.name);
  /** Marketplace 展示层开发者名称只作为作者回退。 */
  const developerName = normalizedText(pluginInterface?.developerName);
  /** 最终统一作者元数据。 */
  let author: PluginMetadata['author'];
  if (rawAuthor !== undefined && authorRecord === undefined)
    reportField(fields, 'author', source, 'unmapped', 'Author was not an object.');
  if (authorRecord !== undefined) {
    if (authorRecord.name === undefined || rootAuthorName === undefined) {
      reportField(fields, 'author.name', source, 'unmapped', 'Author name was not a non-empty string.');
    } else {
      reportField(fields, 'author.name', source, rootAuthorName === authorRecord.name ? 'mapped' : 'degraded', rootAuthorName === authorRecord.name
        ? 'Author name maps to top-level config author.name.'
        : 'Author name required whitespace normalization.');
    }
    /** 合法根身份下可以独立恢复的 email 与 URL。 */
    const authorDetails: { email?: string; url?: string } = {};
    for (const field of ['email', 'url'] as const) {
      /** 当前作者详情字段未经验证的原始值。 */
      const rawValue = authorRecord[field];
      if (rawValue === undefined)
        continue;
      /** 去空白后的 email 或 URL。 */
      const value = normalizedText(rawValue);
      /** 字段自身合法且具有可组合的作者身份时才写入。 */
      const valid = rootAuthorName !== undefined && value !== undefined
        && (field === 'email' ? EMAIL_PATTERN.test(value) : isHttpUrl(value));
      if (valid) {
        authorDetails[field] = value;
        reportField(fields, `author.${field}`, source, value === rawValue ? 'mapped' : 'degraded', value === rawValue
          ? `Author ${field} maps to top-level config author.${field}.`
          : `Author ${field} required whitespace normalization.`);
      } else {
        reportField(fields, `author.${field}`, source, 'unmapped', `Author ${field} did not satisfy the canonical metadata contract.`);
      }
    }
    /** key 表示旧 author 中当前无法识别的额外字段。 */
    for (const key of Object.keys(authorRecord).sort((left, right) => left.localeCompare(right, 'en'))) {
      if (!['name', 'email', 'url'].includes(key))
        reportField(fields, `author.${key}`, source, 'unmapped', 'Unknown author field has no canonical mapping.');
    }
    if (rootAuthorName !== undefined)
      author = { name: rootAuthorName, ...authorDetails };
  }
  if (pluginInterface?.developerName !== undefined) {
    if (developerName === undefined) {
      reportField(fields, 'interface.developerName', source, 'unmapped', 'Developer name was not a non-empty string.');
    } else if (author === undefined) {
      author = { name: developerName };
      reportField(fields, 'interface.developerName', source, 'degraded', 'Developer name was used as the fallback canonical author.');
    } else if (author.name === developerName) {
      reportField(fields, 'interface.developerName', source, 'degraded', 'Developer name duplicates author.name and was collapsed.');
    } else {
      reportField(fields, 'interface.developerName', source, 'unmapped', 'Developer name conflicts with author.name and cannot be represented separately.');
    }
  }

  /** URL 字段均按绝对 HTTP(S) 规则验证，interface website 只能降级回退。 */
  const homepage = selectMetadataText(fields, source, [
    { field: 'homepage', value: plugin?.meta.homepage, fallback: false },
    { field: 'interface.websiteURL', value: pluginInterface?.websiteURL, fallback: true },
  ], 'Homepage', isHttpUrl);
  /** Repository 没有 interface 回退来源。 */
  const repository = selectMetadataText(fields, source, [
    { field: 'repository', value: plugin?.meta.repository, fallback: false },
  ], 'Repository', isHttpUrl);
  /** License 使用真实 SPDX Parser，不以非空字符串冒充合法表达式。 */
  const license = selectMetadataText(fields, source, [
    { field: 'license', value: plugin?.meta.license, fallback: false },
  ], 'License', isSpdxExpression);

  /** Keywords 允许去空白和去重，但任何这种规范化都必须 degraded。 */
  const rawKeywords = plugin?.meta.keywords as unknown;
  /** 只有结构有效时才写入配置的规范 keyword 列表。 */
  let keywords: readonly string[] | undefined;
  if (rawKeywords !== undefined) {
    if (!Array.isArray(rawKeywords) || rawKeywords.some(keyword => normalizedText(keyword) === undefined)) {
      reportField(fields, 'keywords', source, 'unmapped', 'Keywords must be an array of non-empty strings.');
    } else {
      /** 保持首次出现顺序的规范 keyword。 */
      const normalizedKeywords = rawKeywords.map(keyword => normalizedText(keyword)!);
      /** 去重后的规范 keyword 数组。 */
      const uniqueKeywords = [...new Set(normalizedKeywords)];
      /** 去空白或重复折叠都会改变旧字段表示。 */
      const changed = uniqueKeywords.length !== normalizedKeywords.length
        || normalizedKeywords.some((keyword, index) => keyword !== rawKeywords[index]);
      keywords = uniqueKeywords;
      reportField(fields, 'keywords', source, changed ? 'degraded' : 'mapped', changed
        ? 'Keywords required whitespace normalization or duplicate removal.'
        : 'Keywords map directly to the top-level config field.');
    }
  }

  if (plugin?.meta.category !== undefined)
    reportField(fields, 'category', source, 'unmapped', 'Platform-neutral metadata has no category field; configure it on a Platform factory.');
  if (plugin?.meta.apps !== undefined)
    reportField(fields, 'apps', source, 'unmapped', 'Legacy apps are outside the acplugin 1.0 component contract.');
  /** field 表示当前没有统一元数据或安全自动映射的旧 interface 字段。 */
  for (const field of Object.keys(pluginInterface ?? {}).sort((left, right) => left.localeCompare(right, 'en'))) {
    if (!['displayName', 'shortDescription', 'longDescription', 'developerName', 'websiteURL'].includes(field))
      reportField(fields, `interface.${field}`, source, 'unmapped', 'The Marketplace interface field requires explicit Platform configuration.');
  }
  /** 只写入通过逐字段校验的元数据，避免最终 Pipeline 退化为无字段信息的通用失败。 */
  const metadata: PluginMetadata = {
    name,
    version,
    description,
    ...(displayName === undefined ? {} : { displayName }),
    ...(author === undefined ? {} : { author }),
    ...(homepage === undefined ? {} : { homepage }),
    ...(repository === undefined ? {} : { repository }),
    ...(license === undefined ? {} : { license }),
    ...(keywords === undefined ? {} : { keywords }),
  };
  items.push(migrationItem({ kind: 'metadata', id: name, source, destination: 'acplugin.config.ts' }, fields));
  return metadata;
}

/**
 * 用正式公开 API 加载并验证刚生成、尚未提交的规范工程。
 *
 * 生成工程尚未安装 package.json 依赖，因此验证期间创建只存在于 stage 的 ESM 代理。
 * 代理不实现任何规则，只把配置和 descriptor 导向当前进程已经加载的真实主包与 MCP
 * Extension；验证后整个 node_modules 会在提交前删除。
 *
 * @param outputRoot 单个迁移后规范工程的阶段目录。
 * @param usesMcp 工程是否需要正式 MCP Extension 参与 discover/validate。
 * @returns 公开 runProject() 返回的完整结构化诊断。
 */
async function validateCanonicalProject(
  outputRoot: string,
  usesMcp: boolean,
): Promise<readonly Diagnostic[]> {
  /** 只供本次配置加载解析两个正式包名的临时依赖根。 */
  const nodeModules = path.join(outputRoot, 'node_modules');
  /** 全局桥接只包含公开工厂，不暴露 Core Registry 或生命周期入口。 */
  const api: MigrationValidationApi = Object.freeze({ defineConfig, claudeCode, mcp, defineMcpServer });
  Reflect.set(globalThis, MIGRATION_VALIDATION_API, api);
  activeValidationProxies += 1;
  try {
    /** 临时主包代理由生成的 acplugin.config.ts 正常按包名导入。 */
    const acpluginPackage = path.join(nodeModules, '@tokenroll/acplugin');
    await copyText(path.join(acpluginPackage, 'package.json'), stableJson({
      name: '@tokenroll/acplugin',
      version: '1.0.0',
      type: 'module',
      exports: './index.mjs',
    }));
    await copyText(path.join(acpluginPackage, 'index.mjs'), `
const api = globalThis[Symbol.for('tokenroll.acplugin.migration-validation-api')];
if (!api) throw new Error('Migration validation API is unavailable.');
export const defineConfig = api.defineConfig;
export const claudeCode = api.claudeCode;
`);
    if (usesMcp) {
      /** 临时 Extension 代理同时服务配置工厂和每个 mcp.ts 的定义工厂导入。 */
      const extensionPackage = path.join(nodeModules, '@tokenroll/acplugin-extension-mcp');
      await copyText(path.join(extensionPackage, 'package.json'), stableJson({
        name: '@tokenroll/acplugin-extension-mcp',
        version: '1.0.0',
        type: 'module',
        exports: './index.mjs',
      }));
      await copyText(path.join(extensionPackage, 'index.mjs'), `
const api = globalThis[Symbol.for('tokenroll.acplugin.migration-validation-api')];
if (!api) throw new Error('Migration validation API is unavailable.');
export const defineMcpServer = api.defineMcpServer;
export default api.mcp;
`);
    }
    /** 正式配置加载、Scanner、Extension 和全部配置 Platform validate 的公开结果。 */
    const result = await runProject({
      cwd: outputRoot,
      command: 'validate',
      mode: 'production',
      commit: false,
    });
    return result.diagnostics;
  } catch {
    /** 配置执行异常统一收敛为不携带路径、导出值或堆栈的迁移诊断。 */
    const diagnostics: readonly Diagnostic[] = Object.freeze([{
      code: 'MIGRATION_PROJECT_VALIDATION_FAILED',
      severity: 'error',
      phase: 'migration',
      message: 'The generated project could not be loaded and validated through the public API.',
    }]);
    return diagnostics;
  } finally {
    await fs.rm(nodeModules, { recursive: true, force: true });
    activeValidationProxies -= 1;
    if (activeValidationProxies === 0)
      Reflect.deleteProperty(globalThis, MIGRATION_VALIDATION_API);
  }
}

/**
 * 把单个 Legacy ScanResult 写成完整规范工程，并用 Core Scanner 重新验证。
 *
 * Instructions、原始 Hooks、不安全 MCP 和未分类文件只进入 `.acplugin-migration/unmapped`，
 * 不会静默进入可发布 Plugin 内容。
 *
 * @param scan 旧工程或单个旧 Plugin 的扫描结果。
 * @param outputRoot 新规范工程的阶段目录。
 * @param options 迁移元数据和严格度选项。
 * @returns 资源迁移条目与规范工程重新扫描诊断。
 */
async function writeCanonicalProject(
  scan: ScanResult,
  outputRoot: string,
  options: MigrationOptions,
): Promise<{ items: MigrationItem[]; diagnostics: readonly Diagnostic[] }> {
  /** 当前工程累计的资源迁移结论。 */
  const items: MigrationItem[] = [];
  /** 新工程最终使用的规范元数据。 */
  const metadata = await metadataFor(scan, options, items);
  // 即使旧来源只有未映射资源，也要保留合法的空 src 根以通过最终 Core 空状态校验。
  await fs.mkdir(path.join(outputRoot, 'src'), { recursive: true });
  /** Skills、Commands 与 Agents 的并行写入任务。 */
  const writes: Promise<void>[] = [];
  for (const skill of scan.skills)
    writes.push(...migrateSkill(skill, scan.rootDir, outputRoot, items));
  for (const command of scan.commands)
    writes.push(migrateCommand(command, scan.rootDir, outputRoot, items));
  for (const agent of scan.agents)
    writes.push(migrateAgent(agent, scan.rootDir, outputRoot, items));
  await Promise.all(writes);

  for (const [index, instruction] of scan.instructions.entries()) {
    /** 当前越界 Instruction 的安全未映射保留路径。 */
    const destination = await unmapped(outputRoot, 'instructions', `${index}-${instruction.fileName}`, instruction.content);
    /** Instruction 原文所在的旧工程相对路径。 */
    const source = relative(scan.rootDir, instruction.sourcePath);
    items.push(migrationItem({ kind: 'instruction', id: instruction.fileName, source, destination }, [{
      field: 'content', source, destination, outcome: 'unmapped',
      reason: 'Instructions are outside the installable plugin boundary.',
    }]));
  }

  /** 是否至少自动迁移了一个安全远程 MCP，并需要启用官方 Extension。 */
  let usesMcp = false;
  for (const server of scan.mcp?.servers ?? []) {
    /** 由旧 Server 名称转换出的规范 MCP ID。 */
    const id = safeId(server.name);
    /** 满足安全自动迁移条件时生成的类型化描述源码。 */
    const source = remoteMcpSource(server);
    /** MCP 字段报告共同使用的旧配置相对路径。 */
    const sourcePath = relative(scan.rootDir, scan.mcp!.sourcePath);
    if (source) {
      /** 自动迁移的远程 MCP 类型化描述文件路径。 */
      const destination = `src/mcp/${id}/mcp.ts`;
      await copyText(path.join(outputRoot, destination), source);
      /** 安全远程 MCP 的全部声明字段。 */
      const fields: MigrationFieldDraft[] = [];
      reportField(fields, 'name', sourcePath, ID_PATTERN.test(server.name) ? 'mapped' : 'degraded', ID_PATTERN.test(server.name)
        ? 'Server key maps directly to the canonical MCP ID.'
        : 'Server identity required lowercase kebab-case normalization.');
      reportField(fields, 'transport', sourcePath, 'mapped', 'Remote HTTP transport maps to the canonical MCP descriptor.');
      reportField(fields, 'url', sourcePath, 'mapped', 'Credential-free HTTPS URL maps to the canonical MCP descriptor.');
      for (const name of Object.keys(server.headers ?? {}).sort((left, right) => left.localeCompare(right, 'en'))) {
        reportField(fields, `headers.${name}`, sourcePath, 'mapped', name.toLowerCase() === 'authorization'
          ? 'Environment-only Authorization maps to canonical bearer auth without reading the secret.'
          : 'Environment-only header maps without reading the secret value.');
      }
      items.push(migrationItem({ kind: 'mcp', id, source: sourcePath, destination }, fields));
      usesMcp = true;
    } else {
      /** 无法自动迁移 MCP 的脱敏未映射记录路径。 */
      const destination = await unmapped(outputRoot, 'mcp', `${id}.json`, stableJson({ [server.name]: redactedMcpServer(server) }));
      /** 无法自动迁移的 MCP 仍逐个报告实际存在字段，且不复制任何值。 */
      const fields: MigrationFieldDraft[] = [];
      reportField(fields, 'name', sourcePath, ID_PATTERN.test(server.name) ? 'mapped' : 'degraded', ID_PATTERN.test(server.name)
        ? 'Server key maps to the migration record identity.'
        : 'Server identity required lowercase kebab-case normalization.');
      for (const field of ['command', 'args', 'type', 'url'] as const) {
        if (server[field] !== undefined) {
          reportField(fields, field, sourcePath, 'unmapped', 'This MCP field requires a complete canonical implementation or a supported safe remote declaration.');
        }
      }
      for (const name of Object.keys(server.env ?? {}).sort((left, right) => left.localeCompare(right, 'en')))
        reportField(fields, `env.${name}`, sourcePath, 'unmapped', 'Local MCP environment mapping is preserved only in the redacted sidecar.');
      for (const name of Object.keys(server.headers ?? {}).sort((left, right) => left.localeCompare(right, 'en')))
        reportField(fields, `headers.${name}`, sourcePath, 'unmapped', 'Unsafe or literal MCP header is preserved only as a redacted field name.');
      items.push(migrationItem({ kind: 'mcp', id, source: sourcePath, destination }, fields));
    }
  }

  if (scan.hooks) {
    /** 原始 Hooks 配置的未映射保留路径。 */
    const destination = await unmapped(outputRoot, 'hooks', 'hooks.json', stableJson({ hooks: scan.hooks }));
    /** Legacy Scanner 保留的 Hooks 配置精确来源路径。 */
    const source = scan.hooksSourcePath === undefined ? '.' : relative(scan.rootDir, scan.hooksSourcePath);
    /** 每个旧事件分别进入字段报告，避免聚合配置掩盖丢失范围。 */
    const fields = Object.keys(scan.hooks).sort((left, right) => left.localeCompare(right, 'en')).map<MigrationFieldDraft>(event => ({
      field: `event:${event}`, source, destination, outcome: 'unmapped',
      reason: 'Raw legacy Hook event requires manual typed handler migration.',
    }));
    items.push(migrationItem({ kind: 'hooks', id: 'hooks', source, destination }, fields));
    for (const reference of hookReferenceCandidates(scan.hooks))
      await copyHookReference(scan.rootDir, reference, outputRoot, items);
  }

  for (const file of scan.pluginFiles) {
    /** 当前未分类 Plugin 文件的隔离保留路径。 */
    const destination = await unmapped(outputRoot, 'plugin-files', file.relativePath, file.content);
    items.push(migrationItem({ kind: 'plugin-file', id: file.relativePath, source: file.relativePath, destination }, [{
      field: 'content', source: file.relativePath, destination, outcome: 'unmapped',
      reason: 'Unclassified plugin files are not published automatically.',
    }]));
  }

  /** 是否没有任何能够生成 Codex Skill 或 fallback Skill 的规范 Component。 */
  const hasCanonicalComponents = scan.skills.length + scan.commands.length + scan.agents.length > 0;
  /** 规范配置入口及按需追加的 Platform/Extension 导入。 */
  const imports = [`import { defineConfig${hasCanonicalComponents ? '' : ', claudeCode'} } from '@tokenroll/acplugin';`];
  if (usesMcp)
    imports.push(`import mcp from '@tokenroll/acplugin-extension-mcp';`);
  /** 按稳定顺序组成且只包含已知字段的最终配置行。 */
  const configLines = [
    'export default defineConfig({',
    `  name: ${JSON.stringify(metadata.name)},`,
    `  version: ${JSON.stringify(metadata.version)},`,
    `  description: ${JSON.stringify(metadata.description)},`,
  ];
  if (metadata.displayName !== undefined)
    configLines.push(`  displayName: ${JSON.stringify(metadata.displayName)},`);
  if (metadata.author !== undefined)
    configLines.push(`  author: ${JSON.stringify(metadata.author)},`);
  if (metadata.homepage !== undefined)
    configLines.push(`  homepage: ${JSON.stringify(metadata.homepage)},`);
  if (metadata.repository !== undefined)
    configLines.push(`  repository: ${JSON.stringify(metadata.repository)},`);
  if (metadata.license !== undefined)
    configLines.push(`  license: ${JSON.stringify(metadata.license)},`);
  if (metadata.keywords !== undefined)
    configLines.push(`  keywords: ${JSON.stringify(metadata.keywords)},`);
  if (usesMcp)
    configLines.push('  extensions: [mcp()],');
  if (!hasCanonicalComponents)
    configLines.push('  platforms: [claudeCode()],');
  configLines.push('  build: { strict: false },', '});');
  await copyText(path.join(outputRoot, 'acplugin.config.ts'), `${imports.join('\n')}\n\n${configLines.join('\n')}\n`);
  /** 新工程基础开发依赖及按需追加的官方 MCP Extension。 */
  const devDependencies: Record<string, string> = { '@tokenroll/acplugin': '^1.0.0', 'typescript': '^7.0.2', '@types/node': '^20.19.0' };
  if (usesMcp)
    devDependencies['@tokenroll/acplugin-extension-mcp'] = '^1.0.0';
  await copyText(path.join(outputRoot, 'package.json'), stableJson({
    name: metadata.name,
    version: metadata.version,
    private: true,
    type: 'module',
    packageManager: 'pnpm@10.34.5',
    scripts: { validate: 'acplugin validate', inspect: 'acplugin inspect', build: 'acplugin build', typecheck: 'tsc --noEmit' },
    devDependencies,
  }));
  await copyText(path.join(outputRoot, 'tsconfig.json'), stableJson({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noEmit: true, types: ['node'], skipLibCheck: true }, include: ['acplugin.config.ts', 'src/**/*.ts'] }));
  await copyText(path.join(outputRoot, '.gitignore'), 'node_modules\ndist\n.acplugin-migration/unmapped/\n');

  // 只有正式公开 Pipeline 能证明生成配置与实际 Extension/Platform 契约共同成立。
  return { items, diagnostics: await validateCanonicalProject(outputRoot, usesMcp) };
}

/**
 * 验证最终目标尚不存在且位于旧来源树外。
 *
 * @param sourceRoot 旧来源根目录。
 * @param destination 计划提交的新工程目录。
 */
async function assertDestination(sourceRoot: string, destination: string): Promise<void> {
  if (await exists(destination))
    throw new Error('Migration destination must not exist.');
  /** 目标相对于来源的路径，用于阻止覆盖或嵌套写入旧工程。 */
  const relation = path.relative(sourceRoot, destination);
  if (relation === '' || (!path.isAbsolute(relation) && relation !== '..' && !relation.startsWith(`..${path.sep}`)))
    throw new Error('Migration destination must be outside the source tree.');
}

/**
 * 执行 Legacy 来源识别、阶段生成、Core 验证和最终目录提交。
 *
 * 所有内容先写入隔离阶段目录；只有报告成功且非 dry-run 时才通过 rename 提交。
 * GitHub 下载目录和迁移阶段目录都会在成功或失败后清理。
 *
 * @param options 来源、目标、Marketplace 选择和保真度策略。
 * @returns 不包含旧配置敏感值的稳定迁移报告。
 */
export async function migrate(options: MigrationOptions): Promise<MigrationReport> {
  /** 解析本地相对路径使用的绝对工作目录。 */
  const cwd = path.resolve(options.cwd ?? process.cwd());
  /** 本地来源或下载后仓库子目录的绝对根路径。 */
  let sourceRoot: string;
  /** GitHub 来源使用的临时下载目录清理函数。 */
  let cleanup: (() => void) | undefined;
  if (isGitHubSource(options.source) && !await exists(path.resolve(cwd, options.source))) {
    /** 完成格式和字段验证的 GitHub 来源。 */
    const source = parseGitHubSource(options.source);
    if (options.subPath)
      source.subPath = options.subPath;
    sourceRoot = await downloadGitHubRepo(source);
    /** 下载仓库对应的临时根目录。 */
    const temporaryRoot = getTempRoot(sourceRoot);
    cleanup = () => cleanupTempDir(temporaryRoot);
  } else {
    sourceRoot = path.resolve(cwd, options.source);
  }

  try {
    if (await exists(path.join(sourceRoot, 'acplugin.config.ts')))
      throw new Error('Source is already a canonical acplugin project.');
    /** 验证成功后才会出现的最终目标绝对路径。 */
    const destination = path.resolve(cwd, options.destination ?? `${path.basename(sourceRoot)}-acplugin`);
    await assertDestination(sourceRoot, destination);
    /** dry-run 使用系统临时目录，真实迁移使用目标同级目录以支持 rename 提交。 */
    const stageParent = options.dryRun ? os.tmpdir() : path.dirname(destination);
    if (!options.dryRun)
      await fs.mkdir(stageParent, { recursive: true });
    /** 当前迁移独占且失败时完整删除的阶段目录。 */
    const stage = await fs.mkdtemp(path.join(stageParent, `.${path.basename(destination)}.migration-`));
    /** 自动识别的旧来源结构类型。 */
    let sourceType: MigrationReport['sourceType'];
    /** 阶段目录内生成的规范项目路径。 */
    const projects: string[] = [];
    /** 全部资源迁移结论。 */
    const items: MigrationItem[] = [];
    /** 对全部生成工程执行 Core 校验得到的诊断。 */
    const diagnostics: Diagnostic[] = [];
    try {
      if (hasMarketplace(sourceRoot)) {
        sourceType = 'marketplace';
        /** Marketplace 聚合元数据只进入迁移记录，不复制到各单 Plugin 配置。 */
        const marketplace = scanMarketplaceMeta(sourceRoot);
        if (marketplace) {
          /** 聚合字段统一来自 Marketplace 清单，并只指向迁移报告。 */
          const source = '.claude-plugin/marketplace.json';
          /** 不会自动重建的 Marketplace 聚合字段。 */
          const fields: MigrationFieldDraft[] = [{
            field: 'name', source, outcome: 'unmapped',
            reason: 'Marketplace aggregation is recorded but not rebuilt automatically.',
          }];
          if (marketplace.owner) {
            fields.push({
              field: 'owner', source, outcome: 'unmapped',
              reason: 'Marketplace owner remains aggregation metadata for manual publishing.',
            });
          }
          fields.push({
            field: 'plugin-order', source, outcome: 'unmapped',
            reason: 'Original Plugin order remains available in the source Marketplace manifest for manual publishing.',
          });
          items.push(migrationItem({ kind: 'marketplace', id: marketplace.name, source }, fields));
        }
        /** Marketplace 中成功扫描的全部 Plugin。 */
        const plugins = scanAllPlugins(sourceRoot);
        if (options.all && options.plugin !== undefined)
          throw new Error('Marketplace migration accepts either --plugin <name> or --all, not both.');
        /** CLI --all 或 --plugin 选择的迁移对象。 */
        const selected = options.all ? plugins : plugins.filter(plugin => plugin.meta.name === options.plugin);
        if (selected.length === 0)
          throw new Error('Marketplace migration requires --plugin <name> or --all.');
        if (options.all) {
          // 只有批量迁移创建 workspace；每个成员仍是带独立配置的单 Plugin 工程。
          for (const plugin of selected) {
            /** Marketplace 工作区成员使用的规范目录 ID。 */
            const id = safeId(plugin.meta.name);
            /** 当前成员在迁移阶段目录中的根路径。 */
            const projectRoot = path.join(stage, id);
            /** 当前成员生成和重新扫描的结果。 */
            const result = await writeCanonicalProject(plugin, projectRoot, options);
            items.push(...result.items.map((item) => {
              /** Workspace 成员前缀必须同时应用到资源与每个字段的目标路径。 */
              const destination = item.destination ? `${id}/${item.destination}` : undefined;
              return {
                ...item,
                ...(destination === undefined ? {} : { destination }),
                fields: item.fields.map(field => ({ ...field, destination: `${id}/${field.destination}` })),
              };
            }));
            diagnostics.push(...result.diagnostics);
            projects.push(id);
          }
          await copyText(path.join(stage, 'pnpm-workspace.yaml'), `packages:\n${projects.map(project => `  - ${project}`).join('\n')}\n`);
        } else {
          /** 单项选择直接写到 destination 根，不保留多余的 Marketplace 成员层级。 */
          const result = await writeCanonicalProject(selected[0]!, stage, options);
          items.push(...result.items);
          diagnostics.push(...result.diagnostics);
          projects.push('.');
        }
      } else {
        sourceType = isSinglePlugin(sourceRoot) ? 'plugin' : 'project';
        /** 根据来源类型调用对应 Legacy Scanner 的结果。 */
        const scan = sourceType === 'plugin' ? scanPlugin(sourceRoot) : scanClaudeProject(sourceRoot);
        /** 单工程生成和重新扫描的结果。 */
        const result = await writeCanonicalProject(scan, stage, options);
        items.push(...result.items);
        diagnostics.push(...result.diagnostics);
        projects.push('.');
      }
      /** 是否存在语义降级或需要人工处理的资源。 */
      const hasLoss = items.some(item => item.outcome === 'degraded' || item.outcome === 'unmapped');
      /** Core 无错误且满足可选 strict 无损条件时才允许提交。 */
      const success = !diagnostics.some(diagnostic => diagnostic.severity === 'error') && !(options.strict && hasLoss);
      /** 在阶段目录中先写入、提交后随工程一同保留的最终报告。 */
      const report: MigrationReport = {
        schemaVersion: '1', sourceType, projects, items, diagnostics,
        success, dryRun: options.dryRun ?? false,
      };
      await copyText(path.join(stage, '.acplugin-migration/report.json'), stableJson(report));
      if (success && !options.dryRun)
        await fs.rename(stage, destination);
      else
        await fs.rm(stage, { recursive: true, force: true });
      return report;
    } catch /** error 保存当前操作捕获的异常，供本阶段转换或恢复。 */ (error) {
      await fs.rm(stage, { recursive: true, force: true });
      throw error;
    }
  } finally {
    cleanup?.();
  }
}
