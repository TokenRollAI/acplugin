import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { hasMarketplace, isSinglePlugin, scanMarketplace, scanPlugin, scanAllPlugins } from '../scanner/plugin.js';
import { parseSelection } from '../tui.js';

// Create a temporary plugin fixture
let fixtureDir: string;

beforeAll(() => {
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acplugin-test-'));

  // Create marketplace structure
  fs.mkdirSync(path.join(fixtureDir, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(fixtureDir, '.claude-plugin', 'marketplace.json'), JSON.stringify({
    name: 'test-plugins',
    plugins: [
      { name: 'plugin-a', description: 'Plugin A', source: './plugins/plugin-a', category: 'dev' },
      { name: 'plugin-b', description: 'Plugin B', source: './plugins/plugin-b', category: 'prod' },
      { name: 'plugin-empty', description: 'Empty plugin', source: './plugins/plugin-empty' },
    ],
  }));

  // Plugin A: has skills and commands
  const pluginADir = path.join(fixtureDir, 'plugins', 'plugin-a');
  fs.mkdirSync(path.join(pluginADir, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(pluginADir, '.claude-plugin', 'plugin.json'), JSON.stringify({
    name: 'plugin-a', version: '1.0.0', description: 'Plugin A',
  }));
  fs.mkdirSync(path.join(pluginADir, 'skills', 'my-skill'), { recursive: true });
  fs.writeFileSync(path.join(pluginADir, 'skills', 'my-skill', 'SKILL.md'),
    '---\nname: my-skill\ndescription: Test skill\n---\n\nDo stuff.\n');
  fs.mkdirSync(path.join(pluginADir, 'commands'), { recursive: true });
  fs.writeFileSync(path.join(pluginADir, 'commands', 'deploy.md'), 'Deploy instructions');

  // Plugin B: has agents and hooks
  const pluginBDir = path.join(fixtureDir, 'plugins', 'plugin-b');
  fs.mkdirSync(path.join(pluginBDir, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(pluginBDir, '.claude-plugin', 'plugin.json'), JSON.stringify({
    name: 'plugin-b', version: '2.0.0',
  }));
  fs.mkdirSync(path.join(pluginBDir, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(pluginBDir, 'agents', 'reviewer.md'),
    '---\nname: reviewer\ndescription: Code reviewer\n---\n\nReview code.\n');
  fs.mkdirSync(path.join(pluginBDir, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(pluginBDir, 'hooks', 'hooks.json'), JSON.stringify({
    hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'echo check' }] }] },
  }));

  // Plugin Empty: no resources
  const pluginEmptyDir = path.join(fixtureDir, 'plugins', 'plugin-empty');
  fs.mkdirSync(path.join(pluginEmptyDir, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(pluginEmptyDir, '.claude-plugin', 'plugin.json'), JSON.stringify({
    name: 'plugin-empty',
  }));
});

describe('plugin detection', () => {
  it('detects marketplace', () => {
    expect(hasMarketplace(fixtureDir)).toBe(true);
  });

  it('detects single plugin', () => {
    const pluginADir = path.join(fixtureDir, 'plugins', 'plugin-a');
    expect(isSinglePlugin(pluginADir)).toBe(true);
  });

  it('returns false for non-plugin dir', () => {
    expect(hasMarketplace('/tmp/nonexistent')).toBe(false);
    expect(isSinglePlugin('/tmp/nonexistent')).toBe(false);
  });
});

describe('scanMarketplace', () => {
  it('reads all plugin metadata', () => {
    const metas = scanMarketplace(fixtureDir);
    expect(metas).toHaveLength(3);
    expect(metas[0].name).toBe('plugin-a');
    expect(metas[0].category).toBe('dev');
    expect(metas[1].name).toBe('plugin-b');
  });
});

describe('scanPlugin', () => {
  it('scans skills and commands from plugin-a', () => {
    const pluginDir = path.join(fixtureDir, 'plugins', 'plugin-a');
    const result = scanPlugin(pluginDir);
    expect(result.meta.name).toBe('plugin-a');
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0].frontmatter.name).toBe('my-skill');
    expect(result.commands).toHaveLength(1);
    expect(result.commands[0].name).toBe('deploy');
  });

  it('scans agents and hooks from plugin-b', () => {
    const pluginDir = path.join(fixtureDir, 'plugins', 'plugin-b');
    const result = scanPlugin(pluginDir);
    expect(result.meta.name).toBe('plugin-b');
    expect(result.agents).toHaveLength(1);
    expect(result.hooks).not.toBeNull();
    expect(result.hooks!['PreToolUse']).toBeDefined();
  });
});

describe('scanAllPlugins', () => {
  it('scans all plugins and filters empty ones', () => {
    const results = scanAllPlugins(fixtureDir);
    // plugin-empty has no resources, should be filtered out
    expect(results).toHaveLength(2);
    expect(results[0].meta.name).toBe('plugin-a');
    expect(results[1].meta.name).toBe('plugin-b');
  });
});

describe('parseSelection', () => {
  it('parses "all"', () => {
    expect(parseSelection('all', 5)).toEqual([0, 1, 2, 3, 4]);
  });

  it('parses "a"', () => {
    expect(parseSelection('a', 3)).toEqual([0, 1, 2]);
  });

  it('parses "*"', () => {
    expect(parseSelection('*', 3)).toEqual([0, 1, 2]);
  });

  it('parses comma-separated numbers', () => {
    expect(parseSelection('1,3,5', 5)).toEqual([0, 2, 4]);
  });

  it('parses range', () => {
    expect(parseSelection('2-4', 5)).toEqual([1, 2, 3]);
  });

  it('parses mixed', () => {
    expect(parseSelection('1, 3-5', 6)).toEqual([0, 2, 3, 4]);
  });

  it('ignores out of range', () => {
    expect(parseSelection('0, 10', 3)).toEqual([]);
  });
});
