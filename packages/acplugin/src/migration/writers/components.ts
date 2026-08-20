/** Canonical Skill、Command 与 Agent 的 Migration writer。 */
import path from 'node:path';
import type { AgentCapability } from '@acplugin/core';
import matter from 'gray-matter';
import type { Agent, Command, Skill } from '../legacy/types.js';
import { compareCodeUnits, ID_PATTERN, relative } from '../ids.js';
import type { MigrationFieldDraft, MigrationItem } from '../types.js';
import {
  copyBytes,
  copyText,
  markdownWithFrontmatter,
  migrationItem,
  reportField,
} from './shared.js';

/**
 * 把旧 Skill 及全部辅助文件迁移为规范 Skill 目录。
 *
 * @param skill Legacy Scanner 读取的 Skill。
 * @param id 已在 Skill namespace 中完成冲突消歧的最终 ID。
 * @param projectRoot 旧工程根目录。
 * @param outputRoot 新规范工程的阶段目录。
 * @param items 共享迁移报告条目数组。
 * @returns 可与其他资源并行等待的文件写入任务。
 */
export function migrateSkill(skill: Skill, id: string, projectRoot: string, outputRoot: string, items: MigrationItem[]): Promise<void>[] {
  /** 当前 Skill 报告使用的稳定来源路径。 */
  const source = relative(projectRoot, skill.sourcePath);
  /** 当前 Skill 全部已发现字段的保真记录。 */
  const fields: MigrationFieldDraft[] = [];
  reportField(fields, 'name', source, ID_PATTERN.test(skill.dirName) && skill.dirName === id ? 'mapped' : 'degraded', ID_PATTERN.test(skill.dirName) && skill.dirName === id
    ? 'Directory identity maps directly to the canonical Skill ID.'
    : 'Skill identity required lowercase kebab-case normalization or a deterministic collision suffix.');
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
  for (const field of Object.keys(data).sort(compareCodeUnits)) {
    if (!allowed.has(field))
      reportField(fields, field, source, 'unmapped', 'The legacy field has no canonical or verified Platform mapping.');
  }
}

/**
 * 把旧 Command Markdown 迁移为规范 Command，并转换参数占位符。
 *
 * @param command Legacy Scanner 读取的 Command。
 * @param id 已在 Command namespace 中完成冲突消歧的最终 ID。
 * @param projectRoot 旧工程根目录。
 * @param outputRoot 新规范工程的阶段目录。
 * @param items 共享迁移报告条目数组。
 * @returns Command 文件写入任务。
 */
export function migrateCommand(command: Command, id: string, projectRoot: string, outputRoot: string, items: MigrationItem[]): Promise<void> {
  /** 当前 Command 报告使用的稳定来源路径。 */
  const source = relative(projectRoot, command.sourcePath);
  /** 当前 Command 全部已发现字段的保真记录。 */
  const fields: MigrationFieldDraft[] = [];
  reportField(fields, 'name', source, ID_PATTERN.test(command.name) && command.name === id ? 'mapped' : 'degraded', ID_PATTERN.test(command.name) && command.name === id
    ? 'Filename identity maps directly to the canonical Command ID.'
    : 'Command identity required lowercase kebab-case normalization or a deterministic collision suffix.');
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
 * @param id 已在 Agent namespace 中完成冲突消歧的最终 ID。
 * @param projectRoot 旧工程根目录。
 * @param outputRoot 新规范工程的阶段目录。
 * @param items 共享迁移报告条目数组。
 * @returns Agent 文件写入任务。
 */
export function migrateAgent(agent: Agent, id: string, projectRoot: string, outputRoot: string, items: MigrationItem[]): Promise<void> {
  /** 当前 Agent 报告使用的稳定来源路径。 */
  const source = relative(projectRoot, agent.sourcePath);
  /** 当前 Agent 全部已发现字段的保真记录。 */
  const fields: MigrationFieldDraft[] = [];
  reportField(fields, 'name', source, ID_PATTERN.test(agent.fileName) && agent.fileName === id ? 'mapped' : 'degraded', ID_PATTERN.test(agent.fileName) && agent.fileName === id
    ? 'Filename identity maps directly to the canonical Agent ID.'
    : 'Agent identity required lowercase kebab-case normalization or a deterministic collision suffix.');
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
