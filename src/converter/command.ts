import type { Command, Platform, ConvertedFile } from '../types.js';
import { stringifyFrontmatter } from '../utils/frontmatter.js';

export function convertCommand(command: Command, platform: Platform): ConvertedFile {
  switch (platform) {
    case 'codex':
      return convertToCodex(command);
    case 'opencode':
      return convertToOpenCode(command);
    case 'cursor':
      return convertToCursor(command);
    case 'antigravity':
      return convertToAntigravity(command);
  }
}

function convertToCodex(command: Command): ConvertedFile {
  // Codex exposes commands as skills
  const fm = {
    name: `cmd-${command.name}`,
    description: `Command: ${command.name} (imported from Claude Code)`,
  };
  const content = stringifyFrontmatter(fm, command.content);

  return {
    path: `.agents/skills/cmd-${command.name}/SKILL.md`,
    content,
    type: 'command',
  };
}

function convertToOpenCode(command: Command): ConvertedFile {
  // OpenCode uses .opencode/commands/*.md (same format)
  return {
    path: `.opencode/commands/${command.name}.md`,
    content: command.content,
    type: 'command',
  };
}

function convertToCursor(command: Command): ConvertedFile {
  return {
    path: `.cursor/commands/${command.name}.md`,
    content: command.content,
    type: 'command',
  };
}

function convertToAntigravity(command: Command): ConvertedFile {
  // Antigravity: convert commands to skills (no separate commands dir)
  const fm = {
    name: command.name,
    description: `Command: ${command.name} (imported from Claude Code)`,
  };
  const content = stringifyFrontmatter(fm, command.content);
  return {
    path: `.agent/skills/cmd-${command.name}/SKILL.md`,
    content,
    type: 'command',
  };
}
