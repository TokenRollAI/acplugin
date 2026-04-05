import type { ScanResult, ConvertedFile, ConvertResult } from '../types.js';
import { convertSkill, convertSkillAuxFiles } from '../converter/skill.js';
import { mergeInstructions } from '../converter/instructions.js';
import { convertMCP } from '../converter/mcp.js';
import { convertAgent } from '../converter/agent.js';
import { convertCommand } from '../converter/command.js';
import { convertHooks } from '../converter/hooks.js';

export function generateAntigravity(scan: ScanResult): ConvertResult {
  const files: ConvertedFile[] = [];
  const warnings: string[] = [];

  // Skills → .agent/skills/
  for (const skill of scan.skills) {
    files.push(convertSkill(skill, 'antigravity'));
    files.push(...convertSkillAuxFiles(skill, 'antigravity'));
  }

  // Instructions → GEMINI.md
  files.push(...mergeInstructions(scan.instructions, 'antigravity'));

  // MCP → .gemini/settings.json
  if (scan.mcp) {
    files.push(convertMCP(scan.mcp, 'antigravity'));
  }

  // Agents → .gemini/agents/
  for (const agent of scan.agents) {
    files.push(convertAgent(agent, 'antigravity'));
  }

  // Commands → Skills
  for (const cmd of scan.commands) {
    files.push(convertCommand(cmd, 'antigravity'));
  }

  // Hooks
  if (scan.hooks) {
    const hookResult = convertHooks(scan.hooks, 'antigravity');
    warnings.push(...hookResult.warnings);
  }

  // Plugin-level resource files (scripts/, etc. referenced by MCP)
  for (const pf of scan.pluginFiles) {
    files.push({ path: pf.relativePath, content: pf.content, type: 'resource' });
  }

  return {
    platform: 'antigravity',
    files,
    warnings,
  };
}
