import type { ScanResult, ConvertedFile, ConvertResult, PluginScanResult } from '../types.js';
import { convertSkill, convertSkillAuxFiles } from '../converter/skill.js';
import { mergeInstructions } from '../converter/instructions.js';
import { convertMCP } from '../converter/mcp.js';
import { convertAgent } from '../converter/agent.js';
import { convertCommand } from '../converter/command.js';
import { convertHooks } from '../converter/hooks.js';
// TODO: re-enable after Cursor plugin manifest test validation
// import { convertPluginManifestForCursor } from '../converter/pluginManifest.js';

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

  // TODO: Cursor plugin manifest generation — pending test validation
  // const meta = (scan as PluginScanResult).meta;
  // files.push(convertPluginManifestForCursor(scan, meta));

  // Remap paths: .cursor/xxx → plugin format (skills/, agents/, etc.)
  for (const file of files) {
    file.path = remapToPluginPath(file.path);
  }

  return { platform: 'cursor', files, warnings };
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
