import type { ScanResult, ConvertedFile, ConvertResult } from '../types.js';
import { convertSkill, convertSkillAuxFiles } from '../converter/skill.js';
import { mergeInstructions } from '../converter/instructions.js';
import { convertMCP } from '../converter/mcp.js';
import { convertAgent } from '../converter/agent.js';
import { convertCommand } from '../converter/command.js';
import { convertHooks } from '../converter/hooks.js';

export function generateOpenCode(scan: ScanResult): ConvertResult {
  const files: ConvertedFile[] = [];
  const warnings: string[] = [];

  // Skills
  for (const skill of scan.skills) {
    files.push(convertSkill(skill, 'opencode'));
    files.push(...convertSkillAuxFiles(skill, 'opencode'));
  }

  // Instructions
  files.push(...mergeInstructions(scan.instructions, 'opencode'));

  // MCP
  if (scan.mcp) {
    files.push(convertMCP(scan.mcp, 'opencode'));
  }

  // Agents
  for (const agent of scan.agents) {
    files.push(convertAgent(agent, 'opencode'));
  }

  // Commands
  for (const cmd of scan.commands) {
    files.push(convertCommand(cmd, 'opencode'));
  }

  // Hooks
  if (scan.hooks) {
    const hookResult = convertHooks(scan.hooks, 'opencode');
    warnings.push(...hookResult.warnings);

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

  // Plugin-level resource files (scripts/, etc. referenced by MCP)
  for (const pf of scan.pluginFiles) {
    files.push({ path: pf.relativePath, content: pf.content, type: 'resource' });
  }

  return {
    platform: 'opencode',
    files: files.filter(f => !f.path.includes('.hook-')),
    warnings,
  };
}
