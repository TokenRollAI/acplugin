import * as path from 'path';
import { readFile, fileExists, listDirs, listFilesRecursive } from '../utils/fs.js';
import { scanSkillsDir, scanAgentsDir, scanCommandsDir, scanHooksJson, scanMCPJson } from './claude.js';
import type { PluginMeta, PluginScanResult, MarketplaceMeta, MarketplaceScanResult, MCPConfig, PluginResourceFile } from '../types.js';

/**
 * Check if a directory contains a Claude Code plugin marketplace.
 */
export function hasMarketplace(rootDir: string): boolean {
  return fileExists(path.join(rootDir, '.claude-plugin', 'marketplace.json'));
}

/**
 * Check if a directory is a single plugin (has .claude-plugin/plugin.json).
 */
export function isSinglePlugin(rootDir: string): boolean {
  return fileExists(path.join(rootDir, '.claude-plugin', 'plugin.json'));
}

/**
 * Scan marketplace.json and return full marketplace metadata.
 */
export function scanMarketplaceMeta(rootDir: string): MarketplaceMeta | null {
  const marketplacePath = path.join(rootDir, '.claude-plugin', 'marketplace.json');
  const content = readFile(marketplacePath);
  if (!content) return null;

  try {
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
 * Scan marketplace.json and return plugin metadata with resolved paths.
 */
export function scanMarketplace(rootDir: string): PluginMeta[] {
  const marketplace = scanMarketplaceMeta(rootDir);
  if (!marketplace) return [];

  return marketplace.plugins.map((p) => ({
    name: p.name,
    description: p.description,
    version: p.version,
    source: p.source,
    category: p.category,
  }));
}

/**
 * Resolve the actual directory path for a plugin from its marketplace source field.
 * When pluginRoot is set (e.g. "plugins"), source is a short name (e.g. "my-plugin")
 * and resolves to rootDir/plugins/my-plugin.
 */
export function resolvePluginDir(rootDir: string, source: string, pluginRoot?: string): string {
  if (pluginRoot) {
    return path.resolve(rootDir, pluginRoot, source);
  }
  // source is like "./plugins/code-review" or "./skills"
  return path.resolve(rootDir, source);
}

/**
 * Scan a single plugin directory.
 * Plugin structure has skills/agents/commands/hooks directly in root (not under .claude/).
 * Respects custom resource paths from plugin.json when available.
 */
export function scanPlugin(pluginDir: string, meta?: PluginMeta): PluginScanResult {
  // Read plugin.json for metadata if not provided
  const resolvedMeta = meta || readPluginMeta(pluginDir);

  // Resolve resource paths: use custom paths from meta if available, fallback to defaults
  const skillsDir = resolvedMeta.skills
    ? path.resolve(pluginDir, resolvedMeta.skills)
    : path.join(pluginDir, 'skills');

  const agentsDir = resolvedMeta.agents
    ? path.resolve(pluginDir, resolvedMeta.agents as string)
    : path.join(pluginDir, 'agents');

  const commandsPath = resolvedMeta.commands;
  const commandsDir = typeof commandsPath === 'string' && !commandsPath.endsWith('.md')
    ? path.resolve(pluginDir, commandsPath)
    : path.join(pluginDir, 'commands');

  const hooksPath = resolvedMeta.hooks
    ? path.resolve(pluginDir, resolvedMeta.hooks)
    : path.join(pluginDir, 'hooks', 'hooks.json');

  // MCP: use custom path from meta, fallback to .mcp.json in plugin root
  const mcpPath = resolvedMeta.mcpServers
    ? path.resolve(pluginDir, resolvedMeta.mcpServers)
    : path.join(pluginDir, '.mcp.json');
  const mcpConfig = scanMCPJson(mcpPath);

  // Scan plugin-level resource files referenced by MCP config (e.g. scripts/)
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
 * Read plugin.json metadata from a plugin directory.
 * Extracts both metadata fields and resource path overrides.
 */
export function readPluginMeta(pluginDir: string): PluginMeta {
  const pluginJsonPath = path.join(pluginDir, '.claude-plugin', 'plugin.json');
  const content = readFile(pluginJsonPath);
  if (!content) {
    return { name: path.basename(pluginDir) };
  }

  try {
    const data = JSON.parse(content);
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

    // Resource path overrides
    if (data.skills) meta.skills = data.skills;
    if (data.agents) meta.agents = data.agents;
    if (data.commands) meta.commands = data.commands;
    if (data.hooks) meta.hooks = data.hooks;
    if (data.mcpServers) meta.mcpServers = data.mcpServers;
    if (data.apps) meta.apps = data.apps;

    // Marketplace display metadata
    if (data.interface) meta.interface = data.interface;

    return meta;
  } catch {
    return { name: path.basename(pluginDir) };
  }
}

/**
 * Extract file/directory paths referenced by ${CLAUDE_PLUGIN_ROOT} in MCP config,
 * then scan those paths recursively and return as PluginResourceFile[].
 */
function scanMCPReferencedFiles(pluginDir: string, mcp: MCPConfig | null): PluginResourceFile[] {
  if (!mcp) return [];
  const referencedDirs = new Set<string>();

  for (const server of mcp.servers) {
    // Extract from args
    for (const arg of server.args || []) {
      const matches = arg.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^\s"]+)/g);
      for (const m of matches) {
        referencedDirs.add(m[1].split('/')[0]);
      }
    }
    // Extract from env values
    for (const val of Object.values(server.env || {})) {
      const matches = val.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^\s"]+)/g);
      for (const m of matches) {
        referencedDirs.add(m[1].split('/')[0]);
      }
    }
  }

  const files: PluginResourceFile[] = [];
  for (const dirName of referencedDirs) {
    const dirPath = path.join(pluginDir, dirName);
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
 * Analyze what a marketplace source directory contains.
 *
 * Priority:
 * 1. Has .claude-plugin/plugin.json → plugin root (most explicit)
 * 2. Has skills/ or agents/ subdirectory → plugin root (standard layout)
 * 3. Directory name matches "skills"/"agents"/"commands" → direct resource dir
 * 4. Subdirectories contain SKILL.md → skills directory (content detection)
 * 5. None of the above → unknown, treat as plugin root
 */
type SourceTargetType = 'plugin-root' | 'skills-dir' | 'agents-dir' | 'commands-dir' | 'unknown';

export function analyzeSourceTarget(dir: string): SourceTargetType {
  // Has .claude-plugin/plugin.json → explicit plugin root
  if (fileExists(path.join(dir, '.claude-plugin', 'plugin.json'))) return 'plugin-root';

  // Has skills/ or agents/ subdirectory → standard plugin root layout
  if (fileExists(path.join(dir, 'skills')) || fileExists(path.join(dir, 'agents'))) return 'plugin-root';

  // Infer resource type from directory name
  const dirName = path.basename(dir).toLowerCase();
  if (dirName === 'skills') return 'skills-dir';
  if (dirName === 'agents') return 'agents-dir';
  if (dirName === 'commands') return 'commands-dir';

  // Content detection: subdirectories contain SKILL.md → skills directory
  const subdirs = listDirs(dir);
  for (const sub of subdirs) {
    if (fileExists(path.join(sub, 'SKILL.md'))) return 'skills-dir';
  }

  return 'unknown';
}

/**
 * Scan all plugins in a marketplace repo.
 * Analyzes each source target to determine if it's a plugin root or a direct
 * resource directory, then routes to the appropriate scanning strategy.
 */
export function scanAllPlugins(rootDir: string): PluginScanResult[] {
  const marketplace = scanMarketplaceMeta(rootDir);
  if (!marketplace) return [];

  const pluginRoot = marketplace.metadata?.pluginRoot;
  const results: PluginScanResult[] = [];

  for (const entry of marketplace.plugins) {
    if (!entry.source) continue;
    const pluginDir = resolvePluginDir(rootDir, entry.source, pluginRoot);
    if (!fileExists(pluginDir)) continue;

    const meta: PluginMeta = {
      name: entry.name,
      description: entry.description,
      version: entry.version,
      source: entry.source,
      category: entry.category,
    };

    const targetType = analyzeSourceTarget(pluginDir);
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
      default: // 'plugin-root' | 'unknown'
        result = scanPlugin(pluginDir, meta);
    }

    // Only include plugins that have actual resources
    const resourceCount = result.skills.length + result.agents.length +
      result.commands.length + (result.hooks ? Object.keys(result.hooks).length : 0);
    if (resourceCount > 0) {
      results.push(result);
    }
  }

  return results;
}

/**
 * Scan marketplace and return full MarketplaceScanResult with metadata.
 */
export function scanMarketplaceFull(rootDir: string): MarketplaceScanResult | null {
  const marketplace = scanMarketplaceMeta(rootDir);
  if (!marketplace) return null;

  const plugins = scanAllPlugins(rootDir);
  return { marketplace, plugins };
}

/**
 * Count total resources in a PluginScanResult.
 */
export function countResources(scan: PluginScanResult): number {
  return scan.skills.length + scan.agents.length +
    scan.commands.length + (scan.hooks ? Object.keys(scan.hooks).length : 0) +
    scan.instructions.length + (scan.mcp ? scan.mcp.servers.length : 0);
}
