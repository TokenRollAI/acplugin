import type { ScanResult, ConvertedFile, ConvertResult } from '../types.js';
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

  // Instructions — each becomes a separate .mdc file
  files.push(...mergeInstructions(scan.instructions, 'cursor'));

  // MCP
  if (scan.mcp) {
    files.push(convertMCP(scan.mcp, 'cursor'));
  }

  // Agents → degraded to rules
  for (const agent of scan.agents) {
    files.push(convertAgent(agent, 'cursor'));
    warnings.push(`Agent "${agent.fileName}" converted to Cursor rule (Cursor doesn't support custom agents)`);
  }

  // Commands
  for (const cmd of scan.commands) {
    files.push(convertCommand(cmd, 'cursor'));
  }

  // Hooks
  if (scan.hooks) {
    const hookResult = convertHooks(scan.hooks, 'cursor');
    warnings.push(...hookResult.warnings);
    // Cursor hooks are not file-configurable, so we only report warnings
  }

  return {
    platform: 'cursor',
    files,
    warnings,
  };
}
