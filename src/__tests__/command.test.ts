import { describe, it, expect } from 'vitest';
import { convertCommand } from '../converter/command.js';
import type { Command } from '../types.js';

const sampleCommand: Command = {
  name: 'deploy',
  content: 'Deploy to $1 environment.\n\n1. Build\n2. Test\n3. Deploy',
  sourcePath: '/tmp/.claude/commands/deploy.md',
};

describe('convertCommand', () => {
  it('converts to codex as skill', () => {
    const result = convertCommand(sampleCommand, 'codex');
    expect(result.path).toBe('.agents/skills/cmd-deploy/SKILL.md');
    expect(result.content).toContain('name: cmd-deploy');
    expect(result.content).toContain('Deploy to $1');
  });

  it('converts to opencode as command file', () => {
    const result = convertCommand(sampleCommand, 'opencode');
    expect(result.path).toBe('.opencode/commands/deploy.md');
    expect(result.content).toContain('Deploy to $1');
  });

  it('converts to cursor as command file', () => {
    const result = convertCommand(sampleCommand, 'cursor');
    expect(result.path).toBe('.cursor/commands/deploy.md');
    expect(result.content).toContain('Deploy to $1');
  });
});
