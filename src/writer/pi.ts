import type { ScanResult, ConvertedFile, ConvertResult } from '../types.js';
import { convertSkill, convertSkillAuxFiles } from '../converter/skill.js';
import { mergeInstructions } from '../converter/instructions.js';
import { convertCommand } from '../converter/command.js';

/**
 * Generate output for Pi (pi-coding-agent, earendil-works/pi).
 *
 * Pi is a minimal terminal harness whose only file-based extension formats are
 * Claude-style Agent Skills (SKILL.md) and instruction files (AGENTS.md). It
 * has no subagent, hooks, or MCP format by design — those are handled by
 * writing TypeScript extensions, which we cannot generate. Commands have no
 * native format either, so we degrade them to prompt templates.
 */
export function generatePi(scan: ScanResult): ConvertResult {
  const files: ConvertedFile[] = [];
  const warnings: string[] = [];

  // Skills → .pi/skills/<name>/SKILL.md (Claude-style, near-identical format)
  for (const skill of scan.skills) {
    files.push(convertSkill(skill, 'pi'));
    files.push(...convertSkillAuxFiles(skill, 'pi'));
  }

  // Instructions → AGENTS.md
  files.push(...mergeInstructions(scan.instructions, 'pi'));

  // Commands → prompt templates (.pi/prompts/<name>.md), exposed as /name
  for (const cmd of scan.commands) {
    files.push(convertCommand(cmd, 'pi'));
  }

  // MCP: Pi does not support MCP (and states it never will).
  if (scan.mcp && scan.mcp.servers.length > 0) {
    warnings.push(
      `Pi does not support MCP — ${scan.mcp.servers.length} server(s) skipped. ` +
      `Wrap them as a CLI tool or a Pi TypeScript extension instead.`,
    );
  }

  // Agents: Pi intentionally has no subagent format.
  if (scan.agents.length > 0) {
    warnings.push(
      `Pi has no subagent format — ${scan.agents.length} agent(s) skipped. ` +
      `Pi expects agents to be composed via bash/tmux or a TypeScript extension.`,
    );
  }

  // Hooks: Pi handles lifecycle events only through TypeScript extensions.
  if (scan.hooks && Object.keys(scan.hooks).length > 0) {
    warnings.push(
      `Pi has no file-based hooks format — ${Object.keys(scan.hooks).length} hook event(s) skipped. ` +
      `Reimplement them as a Pi TypeScript extension (pi.on(...)).`,
    );
  }

  // Plugin-level resource files (scripts/, etc.) are still copied through.
  for (const pf of scan.pluginFiles) {
    files.push({ path: pf.relativePath, content: pf.content, type: 'resource' });
  }

  return { platform: 'pi', files, warnings };
}
