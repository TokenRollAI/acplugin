import { describe, it, expect } from 'vitest';
import { mergeInstructions } from '../converter/instructions.js';
import type { Instruction } from '../types.js';

const claudeMd: Instruction = {
  fileName: 'CLAUDE.md',
  content: '# Instructions\n\nAlways use TypeScript.',
  sourcePath: '/tmp/CLAUDE.md',
  isRule: false,
};

const rule: Instruction = {
  fileName: 'testing.md',
  content: '# Testing\n\nUse vitest.',
  sourcePath: '/tmp/.claude/rules/testing.md',
  isRule: true,
};

describe('mergeInstructions', () => {
  it('merges into single AGENTS.md for codex', () => {
    const result = mergeInstructions([claudeMd, rule], 'codex');
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe('AGENTS.md');
    expect(result[0].content).toContain('Always use TypeScript');
    expect(result[0].content).toContain('Rule: testing');
    expect(result[0].content).toContain('Use vitest');
  });

  it('merges into single AGENTS.md for opencode', () => {
    const result = mergeInstructions([claudeMd, rule], 'opencode');
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe('AGENTS.md');
  });

  it('creates separate .mdc files for cursor', () => {
    const result = mergeInstructions([claudeMd, rule], 'cursor');
    expect(result).toHaveLength(2);
    expect(result[0].path).toBe('.cursor/rules/claude-instructions.mdc');
    expect(result[0].content).toContain('alwaysApply: true');
    expect(result[1].path).toBe('.cursor/rules/testing.mdc');
    expect(result[1].content).toContain('alwaysApply: true');
  });

  it('returns empty array when no instructions', () => {
    const result = mergeInstructions([], 'codex');
    expect(result).toHaveLength(0);
  });
});
