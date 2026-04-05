import { describe, it, expect } from 'vitest';
import { generateCursor } from '../writer/cursor.js';
import type { ScanResult } from '../types.js';

function makeScan(overrides: Partial<ScanResult> = {}): ScanResult {
  return {
    skills: [],
    instructions: [],
    agents: [],
    commands: [],
    mcp: null,
    hooks: null,
    pluginFiles: [],
    ...overrides,
  } as ScanResult;
}

describe('generateCursor — addCursorPrefix', () => {
  it('adds .cursor/ prefix to skill paths', () => {
    const result = generateCursor(makeScan({
      skills: [{
        dirName: 'my-skill',
        frontmatter: { name: 'my-skill' },
        body: 'Do stuff',
        sourcePath: '/fake/skills/my-skill/SKILL.md',
        auxFiles: [],
      }],
    }));
    const skill = result.files.find(f => f.type === 'skill');
    expect(skill?.path).toBe('.cursor/skills/my-skill/SKILL.md');
  });

  it('adds .cursor/ prefix to agent paths', () => {
    const result = generateCursor(makeScan({
      agents: [{
        fileName: 'helper',
        frontmatter: { name: 'helper', description: 'A helper' },
        body: 'Help the user',
        sourcePath: '/fake/agents/helper.md',
      }],
    }));
    const agent = result.files.find(f => f.type === 'agent');
    expect(agent?.path).toBe('.cursor/agents/helper.md');
  });

  it('adds .cursor/ prefix to command paths', () => {
    const result = generateCursor(makeScan({
      commands: [{ name: 'deploy', content: 'Deploy it', sourcePath: '/fake/commands/deploy.md' }],
    }));
    const cmd = result.files.find(f => f.type === 'command');
    expect(cmd?.path).toBe('.cursor/commands/deploy.md');
  });

  it('adds .cursor/ prefix to instruction paths', () => {
    const result = generateCursor(makeScan({
      instructions: [{
        fileName: 'testing.md',
        content: 'Always test',
        isRule: true,
        sourcePath: '/fake/rules/testing.md',
      }],
    }));
    const rule = result.files.find(f => f.type === 'instruction');
    expect(rule?.path).toBe('.cursor/rules/testing.mdc');
  });

  it('adds .cursor/ prefix to mcp.json', () => {
    const result = generateCursor(makeScan({
      mcp: {
        servers: [{ name: 'fs', command: 'npx', args: ['-y', 'fs-server'] }],
        sourcePath: '/fake/.mcp.json',
      },
    }));
    const mcp = result.files.find(f => f.type === 'mcp');
    expect(mcp?.path).toBe('.cursor/mcp.json');
  });

  it('adds .cursor/ prefix to hooks.json', () => {
    const result = generateCursor(makeScan({
      hooks: {
        SessionStart: [{
          matcher: '',
          hooks: [{ type: 'command', command: 'echo hello' }],
        }],
      },
    }));
    const hook = result.files.find(f => f.type === 'hook');
    expect(hook?.path).toBe('.cursor/hooks.json');
  });

  it('adds .cursor/ prefix to pluginFiles (scripts/)', () => {
    const result = generateCursor(makeScan({
      pluginFiles: [{ relativePath: 'scripts/setup.sh', content: '#!/bin/bash' }],
    }));
    const script = result.files.find(f => f.type === 'resource');
    expect(script?.path).toBe('.cursor/scripts/setup.sh');
  });

  it('does NOT add prefix to .cursor-plugin/ manifest paths', () => {
    const result = generateCursor(makeScan());
    const manifest = result.files.find(f => f.path === '.cursor-plugin/plugin.json');
    expect(manifest).toBeDefined();
    expect(manifest?.path).toBe('.cursor-plugin/plugin.json');
  });
});
