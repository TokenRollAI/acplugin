import type { ScanResult, ConvertedFile, ConvertResult, PluginScanResult } from '../types.js';
import { convertSkill, convertSkillAuxFiles } from '../converter/skill.js';
import { mergeInstructions } from '../converter/instructions.js';
import { convertMCP } from '../converter/mcp.js';
import { convertAgent } from '../converter/agent.js';
import { convertCommand } from '../converter/command.js';
import { convertHooks } from '../converter/hooks.js';
import { convertPluginManifestForCursor } from '../converter/pluginManifest.js';

export function generateCursor(scan: ScanResult): ConvertResult {
  const files: ConvertedFile[] = [];
  const warnings: string[] = [];

  // Skills
  for (const skill of scan.skills) {
    files.push(convertSkill(skill, 'cursor'));
    files.push(...convertSkillAuxFiles(skill, 'cursor'));
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

  // Plugin-level resource files (scripts/, etc. referenced by MCP)
  for (const pf of scan.pluginFiles) {
    files.push({ path: pf.relativePath, content: pf.content, type: 'resource' });
  }

  // Cursor plugin manifest generation
  if ('meta' in scan) {
    const meta = (scan as PluginScanResult).meta;
    files.push(convertPluginManifestForCursor(scan, meta));
  }

  // Add .cursor/ prefix to resource paths (skip .cursor-plugin/ manifest files)
  for (const file of files) {
    file.path = addCursorPrefix(file.path);
  }

  return { platform: 'cursor', files, warnings };
}

/**
 * Add .cursor/ prefix to resource paths.
 * Converters output clean paths (skills/, agents/, rules/, mcp.json, etc.)
 * and this function adds the .cursor/ directory prefix.
 * Paths that already have a dot-prefix (.cursor-plugin/) are left unchanged.
 */
function addCursorPrefix(filePath: string): string {
  if (filePath.startsWith('.cursor-plugin/')) {
    return filePath;
  }
  return `.cursor/${filePath}`;
}
