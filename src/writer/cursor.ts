import type { ScanResult, ConvertedFile, ConvertResult, PluginScanResult } from '../types.js';
import { convertSkill } from '../converter/skill.js';
import { mergeInstructions } from '../converter/instructions.js';
import { convertMCP } from '../converter/mcp.js';
import { convertAgent } from '../converter/agent.js';
import { convertCommand } from '../converter/command.js';
import { convertHooks } from '../converter/hooks.js';

export function generateCursor(scan: ScanResult): ConvertResult {
  const files: ConvertedFile[] = [];
  const warnings: string[] = [];

  // Skills
  for (const skill of scan.skills) {
    files.push(convertSkill(skill, 'cursor'));
  }

  // Instructions
  files.push(...mergeInstructions(scan.instructions, 'cursor'));

  // MCP
  if (scan.mcp) {
    files.push(convertMCP(scan.mcp, 'cursor'));
  }

  // Agents
  for (const agent of scan.agents) {
    files.push(convertAgent(agent, 'cursor'));
  }

  // Commands
  for (const cmd of scan.commands) {
    files.push(convertCommand(cmd, 'cursor'));
  }

  // Hooks — generate Cursor-format hooks JSON
  if (scan.hooks) {
    const hookResult = convertHooks(scan.hooks, 'cursor');
    files.push(...hookResult.converted);
    warnings.push(...hookResult.warnings);
  }

  // Generate .cursor-plugin/plugin.json
  const pluginJson = generatePluginJson(scan);
  files.push(pluginJson);

  // Remap paths: .cursor/xxx → plugin format (skills/, agents/, etc.)
  for (const file of files) {
    file.path = remapToPluginPath(file.path);
  }

  return { platform: 'cursor', files, warnings };
}

/**
 * Generate .cursor-plugin/plugin.json manifest.
 */
function generatePluginJson(scan: ScanResult): ConvertedFile {
  const meta = (scan as PluginScanResult).meta;
  const manifest: Record<string, unknown> = {
    name: meta?.name || 'converted-plugin',
  };

  if (meta?.displayName) manifest.displayName = meta.displayName;

  manifest.description = meta?.description || 'Converted from Claude Code plugin via acplugin';
  manifest.version = meta?.version || '1.0.0';

  if (meta?.author) manifest.author = meta.author;
  if (meta?.homepage) manifest.homepage = meta.homepage;
  if (meta?.repository) manifest.repository = meta.repository;
  if (meta?.license) manifest.license = meta.license;
  if (meta?.keywords) manifest.keywords = meta.keywords;

  // Only include paths for components that exist
  if (scan.skills.length > 0) manifest.skills = './skills/';
  if (scan.agents.length > 0) manifest.agents = './agents/';
  if (scan.commands.length > 0) manifest.commands = './commands/';
  if (scan.instructions.length > 0) manifest.rules = './rules/';
  if (scan.mcp) manifest.mcpServers = './mcp.json';
  if (scan.hooks) manifest.hooks = './hooks/hooks-cursor.json';

  return {
    path: '.cursor-plugin/plugin.json',
    content: JSON.stringify(manifest, null, 2),
    type: 'instruction',
  };
}

/**
 * Remap .cursor/ paths to plugin directory layout.
 * .cursor/skills/X/SKILL.md → skills/X/SKILL.md
 * .cursor/agents/X.md → agents/X.md
 * .cursor/commands/X.md → commands/X.md
 * .cursor/rules/X.mdc → rules/X.mdc
 * .cursor/mcp.json → mcp.json
 */
function remapToPluginPath(filePath: string): string {
  if (filePath.startsWith('.cursor/')) {
    return filePath.slice('.cursor/'.length);
  }
  return filePath;
}
