import * as path from 'path';
import * as fs from 'fs';
import { readFile, fileExists, listDirs, listFilesRecursive } from '../utils/fs.js';
import { scanSkillsDir, scanAgentsDir, scanCommandsDir, scanHooksJson, scanMCPJson } from './claude.js';
import type { PluginMeta, PluginScanResult, MarketplaceMeta, MarketplaceScanResult, MCPConfig, PluginResourceFile } from '../types.js';

/**
 * 判断候选路径是否位于旧 Plugin 根目录内。
 *
 * @param root 可信 Plugin 根目录。
 * @param candidate 待检查路径。
 * @returns 候选路径未逃逸时返回 true。
 */
function isInside(root: string, candidate: string): boolean {
  /** 基于路径层级计算的相对关系。 */
  const relation = path.relative(root, candidate);
  return relation === '' || (!path.isAbsolute(relation) && relation !== '..' && !relation.startsWith(`..${path.sep}`));
}

/**
 * 在旧 Plugin 根目录内解析资源路径，并对已存在路径检查符号链接真实位置。
 *
 * @param root 可信 Plugin 根目录。
 * @param value 旧清单声明的相对路径。
 * @param label 错误消息使用的字段名称。
 * @returns 留在 Plugin 边界内的绝对路径。
 */
function resolveInside(root: string, value: string, label: string): string {
  if (value.includes('\0') || path.isAbsolute(value))
    throw new Error(`${label} must be a relative path inside the plugin.`);
  /** 尚未解析符号链接的候选绝对路径。 */
  const resolved = path.resolve(root, value);
  if (!isInside(path.resolve(root), resolved))
    throw new Error(`${label} must stay inside the plugin.`);
  if (fs.existsSync(resolved)) {
    /** Plugin 根目录解析符号链接后的真实路径。 */
    const realRoot = fs.realpathSync(root);
    /** 资源路径解析符号链接后的真实路径。 */
    const realResolved = fs.realpathSync(resolved);
    if (!isInside(realRoot, realResolved))
      throw new Error(`${label} resolves outside the plugin.`);
    return realResolved;
  }
  return resolved;
}

/**
 * 判断目录是否包含旧 Claude Code Marketplace 清单。
 *
 * @param rootDir 待识别来源根目录。
 * @returns 存在 marketplace.json 时返回 true。
 */
export function hasMarketplace(rootDir: string): boolean {
  return fileExists(path.join(rootDir, '.claude-plugin', 'marketplace.json'));
}

/**
 * 判断目录是否是带 plugin.json 的单个旧 Plugin。
 *
 * @param rootDir 待识别来源根目录。
 * @returns 存在 plugin.json 时返回 true。
 */
export function isSinglePlugin(rootDir: string): boolean {
  return fileExists(path.join(rootDir, '.claude-plugin', 'plugin.json'));
}

/**
 * 容错读取 Marketplace 清单和其中的 Plugin 条目。
 *
 * @param rootDir Marketplace 仓库根目录。
 * @returns 可解析的宽松元数据，否则返回 null。
 */
export function scanMarketplaceMeta(rootDir: string): MarketplaceMeta | null {
  /** Marketplace 清单固定路径。 */
  const marketplacePath = path.join(rootDir, '.claude-plugin', 'marketplace.json');
  /** Marketplace JSON 原文。 */
  const content = readFile(marketplacePath);
  if (!content) return null;

  try {
    /** 未经 Schema 验证的旧 Marketplace JSON。 */
    const data = JSON.parse(content);
    return {
      name: data.name || 'marketplace',
      version: data.version,
      description: data.description,
      owner: data.owner,
      metadata: data.metadata,
      plugins: (data.plugins || []).map((p: any) => ({
        name: p.name,
        source: p.source,
        description: p.description,
        version: p.version,
        category: p.category,
      })),
    };
  } catch {
    return null;
  }
}

/**
 * 把 Marketplace 条目投影为 PluginMeta 列表。
 *
 * @param rootDir Marketplace 仓库根目录。
 * @returns 清单有效时的 Plugin 元数据，否则返回空数组。
 */
export function scanMarketplace(rootDir: string): PluginMeta[] {
  /** 容错读取的 Marketplace 清单。 */
  const marketplace = scanMarketplaceMeta(rootDir);
  if (!marketplace) return [];

  return marketplace.plugins.map(p => ({
    name: p.name,
    description: p.description,
    version: p.version,
    source: p.source,
    category: p.category,
  }));
}

/**
 * 根据 Marketplace source 和可选 pluginRoot 解析实际 Plugin 目录。
 *
 * @param rootDir Marketplace 仓库根目录。
 * @param source Plugin 条目的相对来源。
 * @param pluginRoot Marketplace 统一声明的可选 Plugin 根目录。
 * @returns 经过目录边界检查的 Plugin 绝对路径。
 */
export function resolvePluginDir(rootDir: string, source: string, pluginRoot?: string): string {
  if (pluginRoot)
    return resolveInside(rootDir, path.join(pluginRoot, source), 'Marketplace plugin source');
  // 未配置 pluginRoot 时 source 自身就是相对于仓库根目录的路径。
  return resolveInside(rootDir, source, 'Marketplace plugin source');
}

/**
 * 扫描单个旧 Plugin，并遵守 plugin.json 的资源路径覆盖。
 *
 * @param pluginDir 旧 Plugin 根目录。
 * @param meta Marketplace 已提供的可选元数据。
 * @returns 资源路径已经解析的完整 PluginScanResult。
 */
export function scanPlugin(pluginDir: string, meta?: PluginMeta): PluginScanResult {
  // Marketplace 未提供元数据时回退到 Plugin 自己的清单。
  /** 当前 Plugin 最终使用的旧元数据。 */
  const resolvedMeta = meta || readPluginMeta(pluginDir);

  // 每种资源优先采用旧清单覆盖，否则使用 Plugin 根目录下的默认位置。
  /** 旧 Skills 实际扫描目录。 */
  const skillsDir = resolvedMeta.skills
    ? resolveInside(pluginDir, resolvedMeta.skills, 'Plugin skills path')
    : path.join(pluginDir, 'skills');

  /** 旧 Agents 实际扫描目录。 */
  const agentsDir = resolvedMeta.agents
    ? resolveInside(pluginDir, resolvedMeta.agents as string, 'Plugin agents path')
    : path.join(pluginDir, 'agents');

  /** 旧 Commands 可能是目录或文件数组的宽松路径字段。 */
  const commandsPath = resolvedMeta.commands;
  /** 当前 Scanner 能够处理的 Commands 目录。 */
  const commandsDir = typeof commandsPath === 'string' && !commandsPath.endsWith('.md')
    ? resolveInside(pluginDir, commandsPath, 'Plugin commands path')
    : path.join(pluginDir, 'commands');

  /** 旧 Hooks 清单实际路径。 */
  const hooksPath = resolvedMeta.hooks
    ? resolveInside(pluginDir, resolvedMeta.hooks, 'Plugin Hooks path')
    : path.join(pluginDir, 'hooks', 'hooks.json');

  // MCP 优先采用清单覆盖，否则读取 Plugin 根级 `.mcp.json`。
  /** 旧 MCP 配置实际路径。 */
  const mcpPath = resolvedMeta.mcpServers
    ? resolveInside(pluginDir, resolvedMeta.mcpServers, 'Plugin MCP path')
    : path.join(pluginDir, '.mcp.json');
  /** 容错解析后的旧 MCP 配置。 */
  const mcpConfig = scanMCPJson(mcpPath);

  // 保存 MCP 命令显式引用的 scripts 等 Plugin 级文件，避免迁移时静默丢失。
  /** 旧 MCP 引用的未分类 Plugin 文件。 */
  const pluginFiles = scanMCPReferencedFiles(pluginDir, mcpConfig);

  return {
    meta: resolvedMeta,
    skills: scanSkillsDir(skillsDir),
    instructions: [],
    mcp: mcpConfig,
    agents: scanAgentsDir(agentsDir),
    commands: scanCommandsDir(commandsDir),
    hooks: scanHooksJson(hooksPath),
    pluginFiles,
    rootDir: pluginDir,
  };
}

/**
 * 容错读取旧 plugin.json 的元数据和资源路径覆盖。
 *
 * @param pluginDir 旧 Plugin 根目录。
 * @returns 清单无效时至少包含目录回退名称的 PluginMeta。
 */
export function readPluginMeta(pluginDir: string): PluginMeta {
  /** 旧 Plugin 清单固定路径。 */
  const pluginJsonPath = path.join(pluginDir, '.claude-plugin', 'plugin.json');
  /** 旧 Plugin JSON 原文。 */
  const content = readFile(pluginJsonPath);
  if (!content) {
    return { name: path.basename(pluginDir) };
  }

  try {
    /** 未经 Schema 验证的旧 Plugin JSON。 */
    const data = JSON.parse(content);
    /** 逐步附加资源路径和展示元数据的宽松 PluginMeta。 */
    const meta: PluginMeta = {
      name: data.name || path.basename(pluginDir),
      description: data.description,
      version: data.version,
      author: data.author,
      displayName: data.displayName,
      homepage: data.homepage,
      repository: data.repository,
      license: data.license,
      keywords: data.keywords,
    };

    // 保留旧清单声明的资源路径覆盖，稍后统一执行目录边界检查。
    if (data.skills) meta.skills = data.skills;
    if (data.agents) meta.agents = data.agents;
    if (data.commands) meta.commands = data.commands;
    if (data.hooks) meta.hooks = data.hooks;
    if (data.mcpServers) meta.mcpServers = data.mcpServers;
    if (data.apps) meta.apps = data.apps;

    // Marketplace 展示信息只用于元数据保留，不改变 Core Component。
    if (data.interface) meta.interface = data.interface;

    return meta;
  } catch {
    return { name: path.basename(pluginDir) };
  }
}

/**
 * 提取旧 MCP 中 `${CLAUDE_PLUGIN_ROOT}` 引用的一级路径并递归保留其文本文件。
 *
 * @param pluginDir 旧 Plugin 根目录和路径信任边界。
 * @param mcp 容错读取的旧 MCP 配置。
 * @returns MCP 命令显式引用的 Plugin 级文件。
 */
function scanMCPReferencedFiles(pluginDir: string, mcp: MCPConfig | null): PluginResourceFile[] {
  if (!mcp) return [];
  /** 从命令参数和环境值提取的一级目录集合。 */
  const referencedDirs = new Set<string>();

  for (const server of mcp.servers) {
    // 从命令参数提取 Plugin 根变量后的第一级目录。
    for (const arg of server.args || []) {
      const matches = arg.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^\s"]+)/g);
      for (const m of matches) {
        referencedDirs.add(m[1].split('/')[0]);
      }
    }
    // 从环境值提取 Plugin 根变量后的第一级目录。
    for (const val of Object.values(server.env || {})) {
      const matches = val.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^\s"]+)/g);
      for (const m of matches) {
        referencedDirs.add(m[1].split('/')[0]);
      }
    }
  }

  /** 引用目录中成功读取的全部文本文件。 */
  const files: PluginResourceFile[] = [];
  for (const dirName of referencedDirs) {
    /** 经过 Plugin 边界和真实路径检查的引用目录。 */
    const dirPath = resolveInside(pluginDir, dirName, 'MCP referenced path');
    if (!fileExists(dirPath)) continue;
    for (const file of listFilesRecursive(dirPath)) {
      const content = readFile(file);
      if (content !== null) {
        files.push({
          relativePath: path.relative(pluginDir, file).replace(/\\/g, '/'),
          content,
        });
      }
    }
  }

  return files;
}

/**
 * Marketplace 来源目录的推断类型。
 *
 * 推断优先级为显式 plugin.json、标准资源子目录、目录名、SKILL.md 内容识别，最后为 unknown。
 */
type SourceTargetType = 'plugin-root' | 'skills-dir' | 'agents-dir' | 'commands-dir' | 'unknown';

/**
 * 推断 Marketplace source 指向完整 Plugin 还是单类资源目录。
 *
 * @param dir 已完成仓库边界解析的来源目录。
 * @returns 后续选择扫描策略使用的来源类型。
 */
export function analyzeSourceTarget(dir: string): SourceTargetType {
  // plugin.json 是最明确的完整 Plugin 标志。
  if (fileExists(path.join(dir, '.claude-plugin', 'plugin.json'))) return 'plugin-root';

  // 标准资源子目录也表明来源是完整 Plugin 根目录。
  if (fileExists(path.join(dir, 'skills')) || fileExists(path.join(dir, 'agents'))) return 'plugin-root';

  // 目录名可识别直接指向某类资源的 Marketplace source。
  /** 当前来源目录的小写名称。 */
  const dirName = path.basename(dir).toLowerCase();
  if (dirName === 'skills') return 'skills-dir';
  if (dirName === 'agents') return 'agents-dir';
  if (dirName === 'commands') return 'commands-dir';

  // 子目录存在 SKILL.md 时把来源识别为直接 Skills 目录。
  /** 用于内容识别的一级子目录。 */
  const subdirs = listDirs(dir);
  for (const sub of subdirs) {
    if (fileExists(path.join(sub, 'SKILL.md'))) return 'skills-dir';
  }

  return 'unknown';
}

/**
 * 扫描 Marketplace 中的全部可解析 Plugin，并按来源类型选择扫描策略。
 *
 * @param rootDir Marketplace 仓库根目录。
 * @returns 至少包含一个实际资源的 Plugin 扫描结果。
 */
export function scanAllPlugins(rootDir: string): PluginScanResult[] {
  /** 容错读取的 Marketplace 清单。 */
  const marketplace = scanMarketplaceMeta(rootDir);
  if (!marketplace) return [];

  /** Marketplace 可选的统一 Plugin 根路径。 */
  const pluginRoot = marketplace.metadata?.pluginRoot;
  /** 成功扫描且包含资源的 Plugin。 */
  const results: PluginScanResult[] = [];

  for (const entry of marketplace.plugins) {
    if (!entry.source) continue;
    /** 当前条目完成仓库边界检查的来源目录。 */
    const pluginDir = resolvePluginDir(rootDir, entry.source, pluginRoot);
    if (!fileExists(pluginDir)) continue;

    /** 从 Marketplace 条目构造的 Plugin 元数据。 */
    const meta: PluginMeta = {
      name: entry.name,
      description: entry.description,
      version: entry.version,
      source: entry.source,
      category: entry.category,
    };

    /** 当前来源目录推断出的扫描策略。 */
    const targetType = analyzeSourceTarget(pluginDir);
    /** 当前条目最终得到的统一 Plugin 扫描结果。 */
    let result: PluginScanResult;

    switch (targetType) {
      case 'skills-dir':
        result = {
          meta, skills: scanSkillsDir(pluginDir),
          instructions: [], mcp: null, agents: [], commands: [], hooks: null, pluginFiles: [], rootDir: pluginDir,
        };
        break;
      case 'agents-dir':
        result = {
          meta, agents: scanAgentsDir(pluginDir),
          skills: [], instructions: [], mcp: null, commands: [], hooks: null, pluginFiles: [], rootDir: pluginDir,
        };
        break;
      case 'commands-dir':
        result = {
          meta, commands: scanCommandsDir(pluginDir),
          skills: [], instructions: [], mcp: null, agents: [], hooks: null, pluginFiles: [], rootDir: pluginDir,
        };
        break;
      default: // plugin-root 与 unknown 都按完整 Plugin 尝试扫描。
        result = scanPlugin(pluginDir, meta);
    }

    // 空条目不会生成没有意义的规范工程成员。
    /** 当前扫描结果中可迁移资源的数量。 */
    const resourceCount = result.skills.length + result.agents.length
      + result.commands.length + (result.hooks ? Object.keys(result.hooks).length : 0);
    if (resourceCount > 0) {
      results.push(result);
    }
  }

  return results;
}

/**
 * 同时返回 Marketplace 元数据和全部 Plugin 扫描结果。
 *
 * @param rootDir Marketplace 仓库根目录。
 * @returns 完整扫描结果，清单无效时返回 null。
 */
export function scanMarketplaceFull(rootDir: string): MarketplaceScanResult | null {
  /** 容错读取的 Marketplace 清单。 */
  const marketplace = scanMarketplaceMeta(rootDir);
  if (!marketplace) return null;

  /** Marketplace 中全部非空 Plugin 扫描结果。 */
  const plugins = scanAllPlugins(rootDir);
  return { marketplace, plugins };
}

/**
 * 统计旧 Plugin 扫描结果中全部已识别资源。
 *
 * @param scan 单个 Plugin 扫描结果。
 * @returns Skills、Agents、Commands、Hooks、Instructions 和 MCP Server 总数。
 */
export function countResources(scan: PluginScanResult): number {
  return scan.skills.length + scan.agents.length
    + scan.commands.length + (scan.hooks ? Object.keys(scan.hooks).length : 0)
    + scan.instructions.length + (scan.mcp ? scan.mcp.servers.length : 0);
}
