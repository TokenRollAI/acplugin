import * as path from 'path';
import { readFile, fileExists } from '../utils/fs.js';
import { scanSkillsDir, scanAgentsDir, scanCommandsDir, scanHooksJson } from './claude.js';
import type { PluginMeta, PluginScanResult } from '../types.js';

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
 * Scan marketplace.json and return plugin metadata with resolved paths.
 */
export function scanMarketplace(rootDir: string): PluginMeta[] {
  const marketplacePath = path.join(rootDir, '.claude-plugin', 'marketplace.json');
  const content = readFile(marketplacePath);
  if (!content) return [];

  try {
    const data = JSON.parse(content);
    const plugins: PluginMeta[] = (data.plugins || []).map((p: any) => ({
      name: p.name,
      description: p.description,
      version: p.version,
      author: p.author,
      source: p.source,
      category: p.category,
    }));
    return plugins;
  } catch {
    return [];
  }
}

/**
 * Resolve the actual directory path for a plugin from its marketplace source field.
 */
export function resolvePluginDir(rootDir: string, source: string): string {
  // source is like "./plugins/code-review"
  return path.resolve(rootDir, source);
}

/**
 * Scan a single plugin directory.
 * Plugin structure has skills/agents/commands/hooks directly in root (not under .claude/).
 */
export function scanPlugin(pluginDir: string, meta?: PluginMeta): PluginScanResult {
  // Read plugin.json for metadata if not provided
  const resolvedMeta = meta || readPluginMeta(pluginDir);

  return {
    meta: resolvedMeta,
    skills: scanSkillsDir(path.join(pluginDir, 'skills')),
    instructions: [], // Plugins don't have CLAUDE.md
    mcp: null, // Plugins don't have .mcp.json
    agents: scanAgentsDir(path.join(pluginDir, 'agents')),
    commands: scanCommandsDir(path.join(pluginDir, 'commands')),
    hooks: scanHooksJson(path.join(pluginDir, 'hooks', 'hooks.json')),
    rootDir: pluginDir,
  };
}

/**
 * Read plugin.json metadata from a plugin directory.
 */
function readPluginMeta(pluginDir: string): PluginMeta {
  const pluginJsonPath = path.join(pluginDir, '.claude-plugin', 'plugin.json');
  const content = readFile(pluginJsonPath);
  if (!content) {
    return { name: path.basename(pluginDir) };
  }

  try {
    const data = JSON.parse(content);
    return {
      name: data.name || path.basename(pluginDir),
      description: data.description,
      version: data.version,
      author: data.author,
    };
  } catch {
    return { name: path.basename(pluginDir) };
  }
}

/**
 * Scan all plugins in a marketplace repo.
 * Returns an array of PluginScanResult, one per plugin.
 */
export function scanAllPlugins(rootDir: string): PluginScanResult[] {
  const metas = scanMarketplace(rootDir);
  const results: PluginScanResult[] = [];

  for (const meta of metas) {
    if (!meta.source) continue;
    const pluginDir = resolvePluginDir(rootDir, meta.source);
    if (!fileExists(pluginDir)) continue;
    const result = scanPlugin(pluginDir, meta);

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
 * Count total resources in a PluginScanResult.
 */
export function countResources(scan: PluginScanResult): number {
  return scan.skills.length + scan.agents.length +
    scan.commands.length + (scan.hooks ? Object.keys(scan.hooks).length : 0) +
    scan.instructions.length + (scan.mcp ? scan.mcp.servers.length : 0);
}
