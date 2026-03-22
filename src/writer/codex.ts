import * as path from 'path';
import type { ScanResult, ConvertedFile, ConvertResult } from '../types.js';
import { convertSkill, convertSkillCodexYaml } from '../converter/skill.js';
import { mergeInstructions } from '../converter/instructions.js';
import { convertMCP } from '../converter/mcp.js';
import { convertAgent } from '../converter/agent.js';
import { convertCommand } from '../converter/command.js';
import { convertHooks } from '../converter/hooks.js';

export function generateCodex(scan: ScanResult): ConvertResult {
  const files: ConvertedFile[] = [];
  const warnings: string[] = [];

  // Skills
  for (const skill of scan.skills) {
    files.push(convertSkill(skill, 'codex'));
    const yaml = convertSkillCodexYaml(skill);
    if (yaml) files.push(yaml);
  }

  // Instructions — merge all into one AGENTS.md
  const instrFiles = mergeInstructions(scan.instructions, 'codex');
  files.push(...instrFiles);

  // MCP
  if (scan.mcp) {
    files.push(convertMCP(scan.mcp, 'codex'));
  }

  // Agents — now generates .codex/agents/*.toml files
  for (const agent of scan.agents) {
    files.push(convertAgent(agent, 'codex'));
  }

  // Commands → Skills
  for (const cmd of scan.commands) {
    files.push(convertCommand(cmd, 'codex'));
  }

  // Hooks
  if (scan.hooks) {
    const hookResult = convertHooks(scan.hooks, 'codex');
    warnings.push(...hookResult.warnings);

    // Merge hook notes into AGENTS.md
    if (hookResult.converted.length > 0) {
      const hookContent = '\n\n---\n\n# Hooks (from Claude Code)\n\n' +
        hookResult.converted.map(f => f.content).join('\n\n');
      const existingAgentsMd = files.find(f => f.path === 'AGENTS.md');
      if (existingAgentsMd) {
        existingAgentsMd.content += hookContent;
      } else {
        files.push({ path: 'AGENTS.md', content: hookContent.trim(), type: 'hook' });
      }
    }
  }

  return {
    platform: 'codex',
    files: files.filter(f => !f.path.includes('.hook-')),
    warnings,
  };
}
