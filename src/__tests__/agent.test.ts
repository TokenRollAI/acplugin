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
    effort: 'high',
  },
  body: '\nYou are a code reviewer.\n1. Check for bugs\n2. Report issues\n',
  sourcePath: '/tmp/.claude/agents/code-reviewer.md',
};

describe('convertAgent', () => {
  it('converts to codex as .toml subagent file', () => {
    const result = convertAgent(sampleAgent, 'codex');
    expect(result.path).toBe('.codex/agents/code-reviewer.toml');
    expect(result.type).toBe('agent');
    expect(result.content).toContain('name = "code-reviewer"');
    expect(result.content).toContain('description = "Reviews code for bugs"');
    expect(result.content).toContain('developer_instructions');
    expect(result.content).toContain('You are a code reviewer');
  });

  it('maps tools to sandbox_mode for codex', () => {
    const result = convertAgent(sampleAgent, 'codex');
    // Has Bash in tools → workspace-write
    expect(result.content).toContain('sandbox_mode = "workspace-write"');
  });

  it('maps read-only tools to read-only sandbox for codex', () => {
    const readOnlyAgent: Agent = {
      ...sampleAgent,
      frontmatter: { ...sampleAgent.frontmatter, tools: 'Read, Grep, Glob' },
    };
    const result = convertAgent(readOnlyAgent, 'codex');
    expect(result.content).toContain('sandbox_mode = "read-only"');
  });

  it('maps effort to model_reasoning_effort for codex', () => {
    const result = convertAgent(sampleAgent, 'codex');
    expect(result.content).toContain('model_reasoning_effort = "high"');
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
