import { describe, it, expect } from 'vitest';
import { generatePi } from '../writer/pi.js';
import type { ScanResult } from '../types.js';

function baseScan(overrides: Partial<ScanResult> = {}): ScanResult {
  return {
    skills: [],
    instructions: [],
    mcp: null,
    agents: [],
    commands: [],
    hooks: null,
    pluginFiles: [],
    rootDir: '/tmp/plugin',
    ...overrides,
  };
}

describe('generatePi', () => {
  it('converts skills to .pi/skills/ and instructions to AGENTS.md', () => {
    const scan = baseScan({
      skills: [{
        dirName: 'my-skill',
        frontmatter: { name: 'my-skill', description: 'A skill' },
        body: '# My Skill',
        sourcePath: '/tmp/plugin/skills/my-skill/SKILL.md',
        auxFiles: [],
      }],
      instructions: [{
        fileName: 'CLAUDE.md',
        content: '# Project rules',
        sourcePath: '/tmp/plugin/CLAUDE.md',
        isRule: false,
      }],
    });

    const result = generatePi(scan);
    expect(result.platform).toBe('pi');

    const skillFile = result.files.find(f => f.type === 'skill');
    expect(skillFile?.path).toBe('.pi/skills/my-skill/SKILL.md');

    const instrFile = result.files.find(f => f.type === 'instruction');
    expect(instrFile?.path).toBe('AGENTS.md');
    expect(instrFile?.content).toContain('# Project rules');

    expect(result.warnings).toHaveLength(0);
  });

  it('degrades commands to prompt templates', () => {
    const scan = baseScan({
      commands: [{ name: 'deploy', content: 'Deploy it', sourcePath: '/tmp/plugin/commands/deploy.md' }],
    });

    const result = generatePi(scan);
    const cmdFile = result.files.find(f => f.type === 'command');
    expect(cmdFile?.path).toBe('.pi/prompts/deploy.md');
    expect(cmdFile?.content).toContain('Deploy it');
  });

  it('warns and skips MCP, agents, and hooks (no Pi format)', () => {
    const scan = baseScan({
      mcp: { servers: [{ name: 'fs', command: 'npx' }], sourcePath: '/tmp/plugin/.mcp.json' },
      agents: [{ fileName: 'reviewer', frontmatter: { name: 'reviewer' }, body: 'body', sourcePath: '/tmp/plugin/agents/reviewer.md' }],
      hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] },
    });

    const result = generatePi(scan);

    // None of these produce output files.
    expect(result.files.filter(f => f.type === 'mcp')).toHaveLength(0);
    expect(result.files.filter(f => f.type === 'agent')).toHaveLength(0);
    expect(result.files.filter(f => f.type === 'hook')).toHaveLength(0);

    // Each unsupported type produces a warning.
    expect(result.warnings.some(w => /MCP/.test(w))).toBe(true);
    expect(result.warnings.some(w => /subagent/.test(w))).toBe(true);
    expect(result.warnings.some(w => /hooks/.test(w))).toBe(true);
  });

  it('passes through plugin-level resource files', () => {
    const scan = baseScan({
      pluginFiles: [{ relativePath: 'scripts/start.js', content: 'console.log(1)' }],
    });

    const result = generatePi(scan);
    const resource = result.files.find(f => f.type === 'resource');
    expect(resource?.path).toBe('scripts/start.js');
  });
});
