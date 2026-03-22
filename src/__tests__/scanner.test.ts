import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { scanClaudeProject } from '../scanner/claude.js';

const fixtureDir = path.resolve(__dirname, '../../test-fixture');

describe('scanClaudeProject', () => {
  it('scans all resource types from test fixture', () => {
    const result = scanClaudeProject(fixtureDir);

    expect(result.skills).toHaveLength(1);
    expect(result.skills[0].dirName).toBe('my-skill');
    expect(result.skills[0].frontmatter.name).toBe('my-skill');

    expect(result.instructions).toHaveLength(2);
    expect(result.instructions.some(i => i.fileName === 'CLAUDE.md')).toBe(true);
    expect(result.instructions.some(i => i.isRule)).toBe(true);

    expect(result.mcp).not.toBeNull();
    expect(result.mcp!.servers).toHaveLength(2);

    expect(result.agents).toHaveLength(1);
    expect(result.agents[0].fileName).toBe('code-reviewer');

    expect(result.commands).toHaveLength(1);
    expect(result.commands[0].name).toBe('deploy');

    expect(result.hooks).not.toBeNull();
    expect(Object.keys(result.hooks!)).toHaveLength(2);
  });

  it('returns empty results for non-existent directory', () => {
    const result = scanClaudeProject('/tmp/nonexistent-dir-xyz');
    expect(result.skills).toHaveLength(0);
    expect(result.instructions).toHaveLength(0);
    expect(result.mcp).toBeNull();
    expect(result.agents).toHaveLength(0);
    expect(result.commands).toHaveLength(0);
    expect(result.hooks).toBeNull();
  });
});
