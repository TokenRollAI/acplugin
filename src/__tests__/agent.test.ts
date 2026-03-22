import { describe, it, expect } from 'vitest';
import { convertAgent } from '../converter/agent.js';
import type { Agent } from '../types.js';

const sampleAgent: Agent = {
  fileName: 'code-reviewer',
  frontmatter: {
    name: 'code-reviewer',
    description: 'Reviews code for bugs',
    tools: 'Read, Grep, Bash',
    model: 'sonnet',
    maxTurns: 20,
  },
  body: '\nYou are a code reviewer.\n1. Check for bugs\n2. Report issues\n',
  sourcePath: '/tmp/.claude/agents/code-reviewer.md',
};

describe('convertAgent', () => {
  it('converts to codex as AGENTS.md section', () => {
    const result = convertAgent(sampleAgent, 'codex');
    expect(result.path).toContain('AGENTS.md');
    expect(result.content).toContain('## Agent: code-reviewer');
    expect(result.content).toContain('Reviews code for bugs');
  });

  it('converts to opencode as agent file', () => {
    const result = convertAgent(sampleAgent, 'opencode');
    expect(result.path).toBe('.opencode/agents/code-reviewer.md');
    expect(result.content).toContain('name: code-reviewer');
    expect(result.content).toContain('description: Reviews code for bugs');
  });

  it('converts to cursor as rule file', () => {
    const result = convertAgent(sampleAgent, 'cursor');
    expect(result.path).toBe('.cursor/rules/agent-code-reviewer.mdc');
    expect(result.content).toContain('alwaysApply: false');
    expect(result.content).toContain('# Agent: code-reviewer');
  });
});
