import { describe, it, expect } from 'vitest';
import { convertSkill, convertSkillCodexYaml } from '../converter/skill.js';
import type { Skill } from '../types.js';

const sampleSkill: Skill = {
  dirName: 'test-skill',
  frontmatter: {
    name: 'test-skill',
    description: 'A test skill',
    'disable-model-invocation': true,
    'allowed-tools': 'Read, Grep',
    model: 'sonnet',
    effort: 'high',
    context: 'fork',
    agent: 'Explore',
  },
  body: '\n# Test Skill\n\nDo something useful.\n',
  sourcePath: '/tmp/.claude/skills/test-skill/SKILL.md',
  auxFiles: [],
};

describe('convertSkill', () => {
  it('converts to codex path', () => {
    const result = convertSkill(sampleSkill, 'codex');
    expect(result.path).toBe('.agents/skills/test-skill/SKILL.md');
    expect(result.type).toBe('skill');
  });

  it('converts to opencode path', () => {
    const result = convertSkill(sampleSkill, 'opencode');
    expect(result.path).toBe('.opencode/skills/test-skill/SKILL.md');
  });

  it('converts to cursor path', () => {
    const result = convertSkill(sampleSkill, 'cursor');
    expect(result.path).toBe('skills/test-skill/SKILL.md');
  });

  it('preserves name and description in frontmatter', () => {
    const result = convertSkill(sampleSkill, 'codex');
    expect(result.content).toContain('name: test-skill');
    expect(result.content).toContain('description: A test skill');
  });

  it('removes Claude-specific fields from frontmatter', () => {
    const result = convertSkill(sampleSkill, 'codex');
    expect(result.content).not.toMatch(/^context:/m);
    expect(result.content).not.toMatch(/^agent:/m);
    expect(result.content).not.toMatch(/^effort:/m);
    expect(result.content).not.toMatch(/^model:/m);
  });

  it('adds Claude-specific fields as HTML comment', () => {
    const result = convertSkill(sampleSkill, 'codex');
    expect(result.content).toContain('<!-- Claude Code specific fields');
    expect(result.content).toContain('context: "fork"');
    expect(result.content).toContain('agent: "Explore"');
  });
});

describe('convertSkillCodexYaml', () => {
  it('generates openai.yaml when disable-model-invocation is true', () => {
    const result = convertSkillCodexYaml(sampleSkill);
    expect(result).not.toBeNull();
    expect(result!.path).toBe('.agents/skills/test-skill/agents/openai.yaml');
    expect(result!.content).toContain('allow_implicit_invocation: false');
  });

  it('returns null when disable-model-invocation is not set', () => {
    const skill: Skill = { ...sampleSkill, frontmatter: { name: 'x' } };
    const result = convertSkillCodexYaml(skill);
    expect(result).toBeNull();
  });
});
