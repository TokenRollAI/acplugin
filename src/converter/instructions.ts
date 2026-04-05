import type { Instruction, Platform, ConvertedFile } from '../types.js';
import { stringifyFrontmatter } from '../utils/frontmatter.js';

export function convertInstruction(instruction: Instruction, platform: Platform): ConvertedFile {
  switch (platform) {
    case 'codex':
      return convertToCodex(instruction);
    case 'opencode':
      return convertToOpenCode(instruction);
    case 'cursor':
      return convertToCursor(instruction);
    case 'antigravity':
      return convertToAntigravity(instruction);
  }
}

function convertToCodex(instruction: Instruction): ConvertedFile {
  // CLAUDE.md → AGENTS.md (content is directly usable)
  const path = instruction.isRule ? `AGENTS.md` : 'AGENTS.md';
  return {
    path,
    content: instruction.content,
    type: 'instruction',
  };
}

function convertToOpenCode(instruction: Instruction): ConvertedFile {
  // CLAUDE.md → AGENTS.md (OpenCode is compatible)
  return {
    path: 'AGENTS.md',
    content: instruction.content,
    type: 'instruction',
  };
}

function convertToCursor(instruction: Instruction): ConvertedFile {
  if (instruction.isRule) {
    // .claude/rules/X.md → .cursor/rules/X.mdc with frontmatter
    const name = instruction.fileName.replace(/\.md$/, '');
    const frontmatter = {
      description: `Imported from Claude Code rule: ${name}`,
      alwaysApply: true,
    };
    return {
      path: `rules/${name}.mdc`,
      content: stringifyFrontmatter(frontmatter, instruction.content),
      type: 'instruction',
    };
  }

  // CLAUDE.md → .cursor/rules/claude-instructions.mdc
  const frontmatter = {
    description: 'Project instructions imported from Claude Code CLAUDE.md',
    alwaysApply: true,
  };
  return {
    path: 'rules/claude-instructions.mdc',
    content: stringifyFrontmatter(frontmatter, instruction.content),
    type: 'instruction',
  };
}

/**
 * Merge multiple instructions into a single file for platforms that use one file.
 * Codex and OpenCode both use a single AGENTS.md.
 */
function convertToAntigravity(instruction: Instruction): ConvertedFile {
  // CLAUDE.md → GEMINI.md
  return {
    path: 'GEMINI.md',
    content: instruction.content,
    type: 'instruction',
  };
}

export function mergeInstructions(instructions: Instruction[], platform: Platform): ConvertedFile[] {
  if (platform === 'cursor') {
    return instructions.map(i => convertInstruction(i, platform));
  }

  if (platform === 'antigravity') {
    // Antigravity: merge into GEMINI.md
    if (instructions.length === 0) return [];
    const sections: string[] = [];
    for (const inst of instructions) {
      if (inst.isRule) {
        const name = inst.fileName.replace(/\.md$/, '');
        sections.push(`\n## Rule: ${name}\n\n${inst.content}`);
      } else {
        sections.push(inst.content);
      }
    }
    return [{ path: 'GEMINI.md', content: sections.join('\n\n---\n'), type: 'instruction' }];
  }

  // Codex / OpenCode: merge all into one AGENTS.md
  if (instructions.length === 0) return [];

  const sections: string[] = [];
  for (const inst of instructions) {
    if (inst.isRule) {
      const name = inst.fileName.replace(/\.md$/, '');
      sections.push(`\n## Rule: ${name}\n\n${inst.content}`);
    } else {
      sections.push(inst.content);
    }
  }

  return [{
    path: 'AGENTS.md',
    content: sections.join('\n\n---\n'),
    type: 'instruction',
  }];
}
