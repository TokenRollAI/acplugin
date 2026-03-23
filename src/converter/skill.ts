import type { Skill, Platform, ConvertedFile } from '../types.js';
import { stringifyFrontmatter } from '../utils/frontmatter.js';

// Claude-specific fields that other platforms don't support
const CLAUDE_ONLY_FIELDS = ['context', 'agent', 'effort', 'model', 'hooks', 'user-invocable'];

function getSkillOutputPath(platform: Platform, dirName: string): string {
  switch (platform) {
    case 'codex':
      return `.agents/skills/${dirName}/SKILL.md`;
    case 'opencode':
      return `.opencode/skills/${dirName}/SKILL.md`;
    case 'cursor':
      return `.cursor/skills/${dirName}/SKILL.md`;
    case 'antigravity':
      return `.agent/skills/${dirName}/SKILL.md`;
  }
}

function convertFrontmatter(skill: Skill, platform: Platform): Record<string, unknown> {
  const fm = { ...skill.frontmatter } as Record<string, unknown>;

  // For Codex: disable-model-invocation maps to a separate openai.yaml
  // For now, keep it in frontmatter as other platforms understand it

  // Remove Claude-only fields and add as comments in body
  for (const field of CLAUDE_ONLY_FIELDS) {
    delete fm[field];
  }

  return fm;
}

function buildBody(skill: Skill): string {
  const claudeFields: string[] = [];
  const fm = skill.frontmatter as Record<string, unknown>;

  for (const field of CLAUDE_ONLY_FIELDS) {
    if (fm[field] !== undefined) {
      claudeFields.push(`- ${field}: ${JSON.stringify(fm[field])}`);
    }
  }

  if (claudeFields.length === 0) return skill.body;

  const comment = `\n<!-- Claude Code specific fields (not supported on this platform):\n${claudeFields.join('\n')}\n-->\n`;
  return skill.body + comment;
}

export function convertSkill(skill: Skill, platform: Platform): ConvertedFile {
  const frontmatter = convertFrontmatter(skill, platform);
  const body = buildBody(skill);
  const content = stringifyFrontmatter(frontmatter, body);
  const outputPath = getSkillOutputPath(platform, skill.dirName);

  return { path: outputPath, content, type: 'skill' };
}

/**
 * Convert all auxiliary files (references/, scripts/, assets/, etc.) for a skill.
 */
export function convertSkillAuxFiles(skill: Skill, platform: Platform): ConvertedFile[] {
  return skill.auxFiles.map(aux => {
    const basePath = getSkillOutputPath(platform, skill.dirName);
    const dir = basePath.replace(/\/SKILL\.md$/, '');
    return {
      path: `${dir}/${aux.relativePath}`,
      content: aux.content,
      type: 'skill' as const,
    };
  });
}

export function convertSkillCodexYaml(skill: Skill): ConvertedFile | null {
  if (!skill.frontmatter['disable-model-invocation']) return null;

  const yaml = `allow_implicit_invocation: false\n`;
  return {
    path: `.agents/skills/${skill.dirName}/agents/openai.yaml`,
    content: yaml,
    type: 'skill',
  };
}
