import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import matter from 'gray-matter';
import { input } from '@inquirer/prompts';
import { markdownWithFrontmatter, resolveConfig, scanProject, stableJson, type Diagnostic } from '@acplugin/core';
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
  /** 优先保留旧描述，否则生成明确的迁移回退描述。 */
  const description = skill.frontmatter.description || skill.frontmatter.when_to_use || `Migrated Skill ${id}.`;
  /** 旧 Skill 的用户调用策略，默认保持可调用。 */
  let user = skill.frontmatter['user-invocable'] ?? true;
  /** 旧 Skill 的模型调用策略。 */
  const model = !(skill.frontmatter['disable-model-invocation'] ?? false);
  /** 名称、描述和调用策略是否能够无损映射。 */
  let outcome: MigrationOutcome = ID_PATTERN.test(skill.dirName) && skill.frontmatter.description ? 'migrated' : 'degraded';
  if (!user && !model) {
    user = true;
    outcome = 'degraded';
  }
  /** 规范 Skill 主文件的工程相对路径。 */
  const destination = `src/skills/${id}/SKILL.md`;
  items.push({
    kind: 'skill', id, outcome,
    source: relative(projectRoot, skill.sourcePath), destination,
    ...(outcome === 'degraded' ? { message: 'Identity, description, or invocation required a canonical fallback.' } : {}),
  });
  /** 主文件及后续辅助文件的并行写入任务。 */
  const writes = [copyText(path.join(outputRoot, destination), markdownWithFrontmatter({
    description,
    invocation: { user, model },
  }, skill.body))];
  for (const auxiliary of skill.auxFiles) {
    writes.push(copyText(path.join(outputRoot, 'src/skills', id, auxiliary.relativePath), auxiliary.content));
  }
  return writes;
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
  /** 解析 Frontmatter 后保留的 Command 正文。 */
  let body = command.content;
  /** 优先读取旧描述，否则使用明确的迁移回退值。 */
  let description = `Migrated Command ${id}.`;
  /** 名称和描述是否能够无损映射。 */
  let outcome: MigrationOutcome = ID_PATTERN.test(command.name) ? 'migrated' : 'degraded';
  try {
    const parsed = matter(command.content);
    body = parsed.content.trim();
    if (typeof parsed.data.description === 'string' && parsed.data.description.trim())
      description = parsed.data.description.trim();
    else
      outcome = 'degraded';
  } catch {
    outcome = 'degraded';
  }
  body = body.replaceAll('$ARGUMENTS', '{{arguments}}');
  /** 规范 Command 文件的工程相对路径。 */
  const destination = `src/commands/${id}.md`;
  items.push({
    kind: 'command', id, outcome,
    source: relative(projectRoot, command.sourcePath), destination,
    ...(outcome === 'degraded' ? { message: 'A canonical description or identity fallback was required.' } : {}),
  });
  return copyText(path.join(outputRoot, destination), markdownWithFrontmatter({ description }, body));
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
  /** 旧描述或明确的迁移回退描述。 */
  const description = agent.frontmatter.description || `Migrated Agent ${id}.`;
  /** 旧模型是否属于可映射的已知集合。 */
  const knownModel = agent.frontmatter.model === undefined || ['inherit', 'haiku', 'sonnet', 'opus'].includes(agent.frontmatter.model);
  /** 身份、描述和模型是否能够无损映射。 */
  const outcome: MigrationOutcome = ID_PATTERN.test(agent.fileName) && agent.frontmatter.description && knownModel ? 'migrated' : 'degraded';
  /** 规范 Agent 文件的工程相对路径。 */
  const destination = `src/agents/${id}.md`;
  items.push({
    kind: 'agent', id, outcome,
    source: relative(projectRoot, agent.sourcePath), destination,
    ...(outcome === 'degraded' ? { message: 'Unsupported legacy model/tool metadata was omitted or generalized.' } : {}),
  });
  return copyText(path.join(outputRoot, destination), markdownWithFrontmatter({
    description,
    model: mappedModel(agent.frontmatter.model),
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
    const bearer = name.toLowerCase() === 'authorization' && value.match(/^Bearer \$\{([A-Za-z_][A-Za-z0-9_]*)\}$/);
    if (bearer) {
      auth = { type: 'bearer', env: bearer[1]! };
      continue;
    }
    const env = environmentReference(value);
    if (!env)
      return undefined;
    headers[name] = { env };
  }
  /** 按稳定格式组装的类型化 MCP 描述源码行。 */
  const descriptor = [
    `import { defineMcpServer } from '@tokenroll/acplugin-module-mcp';`,
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
    items.push({
      kind: 'hook-file', id: relativePath, outcome: 'unmapped',
      message: 'Referenced Hook file escapes the source project and was not copied.',
    });
    return;
  }
  /** 引用文件的 lstat 元数据，用于拒绝符号链接。 */
  let stat: import('node:fs').Stats;
  try {
    stat = await fs.lstat(source);
  } catch {
    items.push({
      kind: 'hook-file', id: relativePath, outcome: 'unmapped',
      source: relation.split(path.sep).join('/'),
      message: 'Referenced Hook file does not exist and requires manual recovery.',
    });
    return;
  }
  if (stat.isSymbolicLink()) {
    items.push({
      kind: 'hook-file', id: relativePath, outcome: 'unmapped',
      source: relation.split(path.sep).join('/'),
      message: 'Referenced Hook symlinks are not copied.',
    });
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
  items.push({
    kind: 'hook-file', id: normalized, outcome: 'unmapped',
    source: normalized, destination,
    message: 'Referenced Hook implementation was preserved for manual typed migration.',
  });
}

/**
 * 从旧 Plugin 元数据、CLI 参数或交互提示中确定规范工程元数据。
 *
 * @param scan Legacy Scanner 结果。
 * @param options 迁移 CLI 选项。
 * @returns 已验证名称、版本、描述和可选展示名称。
 */
async function metadataFor(scan: ScanResult, options: MigrationOptions): Promise<{ name: string; version: string; description: string; displayName?: string }> {
  /** 仅 Plugin/Marketplace 扫描结果携带的旧 Plugin 元数据。 */
  const plugin = 'meta' in scan ? scan as PluginScanResult : undefined;
  /** CLI 或旧元数据提供的候选规范名称。 */
  let name = options.name ?? plugin?.meta.name;
  /** CLI 或旧元数据提供的候选描述。 */
  let description = options.description ?? plugin?.meta.description;
  if (!name && process.stdin.isTTY)
    name = await input({ message: 'Plugin name', default: safeId(path.basename(scan.rootDir)) });
  if (!description && process.stdin.isTTY)
    description = await input({ message: 'Plugin description' });
  if (!name || !description)
    throw new Error('Migration requires plugin name and description; pass --name and --description in non-interactive mode.');
  if (!ID_PATTERN.test(name))
    throw new Error('Migration plugin name must be lowercase kebab-case.');
  return {
    name,
    version: plugin?.meta.version && /^\d+\.\d+\.\d+/.test(plugin.meta.version) ? plugin.meta.version : '0.1.0',
    description,
    ...(plugin?.meta.displayName ? { displayName: plugin.meta.displayName } : {}),
  };
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
  /** 新工程最终使用的规范元数据。 */
  const metadata = await metadataFor(scan, options);
  /** 当前工程累计的资源迁移结论。 */
  const items: MigrationItem[] = [];
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
    const destination = await unmapped(outputRoot, 'instructions', `${index}-${instruction.fileName}`, instruction.content);
    items.push({ kind: 'instruction', id: instruction.fileName, outcome: 'unmapped', source: relative(scan.rootDir, instruction.sourcePath), destination, message: 'Instructions are outside the installable plugin boundary.' });
  }

  /** 是否至少自动迁移了一个安全远程 MCP，并需要启用官方 Module。 */
  let usesMcp = false;
  for (const server of scan.mcp?.servers ?? []) {
    /** 由旧 Server 名称转换出的规范 MCP ID。 */
    const id = safeId(server.name);
    /** 满足安全自动迁移条件时生成的类型化描述源码。 */
    const source = remoteMcpSource(server);
    if (source) {
      const destination = `src/mcp/${id}/mcp.ts`;
      await copyText(path.join(outputRoot, destination), source);
      items.push({ kind: 'mcp', id, outcome: 'migrated', source: relative(scan.rootDir, scan.mcp!.sourcePath), destination });
      usesMcp = true;
    } else {
      const destination = await unmapped(outputRoot, 'mcp', `${id}.json`, stableJson({ [server.name]: redactedMcpServer(server) }));
      items.push({ kind: 'mcp', id, outcome: 'unmapped', source: relative(scan.rootDir, scan.mcp!.sourcePath), destination, message: 'Local command or unsupported transport MCP requires a complete canonical implementation.' });
    }
  }

  if (scan.hooks) {
    const destination = await unmapped(outputRoot, 'hooks', 'hooks.json', stableJson({ hooks: scan.hooks }));
    items.push({ kind: 'hooks', id: 'hooks', outcome: 'unmapped', destination, message: 'Raw legacy Hooks require manual typed handler migration.' });
    for (const reference of hookReferenceCandidates(scan.hooks))
      await copyHookReference(scan.rootDir, reference, outputRoot, items);
  }

  for (const file of scan.pluginFiles) {
    const destination = await unmapped(outputRoot, 'plugin-files', file.relativePath, file.content);
    items.push({ kind: 'plugin-file', id: file.relativePath, outcome: 'unmapped', destination, message: 'Unclassified plugin files are not published automatically.' });
  }

  /** 规范配置入口及按需追加的官方 Module 导入。 */
  const imports = [`import { defineConfig } from '@tokenroll/acplugin';`];
  if (usesMcp)
    imports.push(`import mcp from '@tokenroll/acplugin-module-mcp';`);
  await copyText(path.join(outputRoot, 'acplugin.config.ts'), `${imports.join('\n')}

export default defineConfig({
  name: ${JSON.stringify(metadata.name)},
  version: ${JSON.stringify(metadata.version)},
  description: ${JSON.stringify(metadata.description)},${metadata.displayName
    ? `
  displayName: ${JSON.stringify(metadata.displayName)},`
    : ''}${usesMcp
    ? `
  modules: [mcp()],`
    : ''}
});
`);
  /** 新工程基础开发依赖及按需追加的官方 MCP Module。 */
  const devDependencies: Record<string, string> = { '@tokenroll/acplugin': '^1.0.0', 'typescript': '^7.0.2', '@types/node': '^20.19.0' };
  if (usesMcp)
    devDependencies['@tokenroll/acplugin-module-mcp'] = '^1.0.0';
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
  await copyText(path.join(outputRoot, '.gitignore'), 'node_modules\ndist\n');

  // 迁移结果必须重新经过当前 Core 配置与 Scanner 契约，避免只生成“看似正确”的目录。
  const resolved = resolveConfig({
    ...metadata,
    ...(usesMcp ? { modules: [{ name: '@tokenroll/acplugin-module-mcp' }] } : {}),
  }, path.join(outputRoot, 'acplugin.config.ts'), 'validate', 'production');
  if (!resolved.config)
    return { items, diagnostics: resolved.diagnostics };
  /** 对生成工程执行的当前版本 Scanner 结果。 */
  const scanned = await scanProject(resolved.config);
  return { items, diagnostics: scanned.diagnostics.diagnostics };
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
        /** Marketplace 中成功扫描的全部 Plugin。 */
        const plugins = scanAllPlugins(sourceRoot);
        /** CLI --all 或 --plugin 选择的迁移对象。 */
        const selected = options.all ? plugins : plugins.filter(plugin => plugin.meta.name === options.plugin);
        if (selected.length === 0)
          throw new Error('Marketplace migration requires --plugin <name> or --all.');
        for (const plugin of selected) {
          /** Marketplace 工作区成员使用的规范目录 ID。 */
          const id = safeId(plugin.meta.name);
          /** 当前成员在迁移阶段目录中的根路径。 */
          const projectRoot = path.join(stage, id);
          /** 当前成员生成和重新扫描的结果。 */
          const result = await writeCanonicalProject(plugin, projectRoot, options);
          items.push(...result.items.map(item => ({ ...item, destination: item.destination ? `${id}/${item.destination}` : undefined })));
          diagnostics.push(...result.diagnostics);
          projects.push(id);
        }
        await copyText(path.join(stage, 'pnpm-workspace.yaml'), `packages:\n${projects.map(project => `  - ${project}`).join('\n')}\n`);
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
    } catch (error) {
      await fs.rm(stage, { recursive: true, force: true });
      throw error;
    }
  } finally {
    cleanup?.();
  }
}
