import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  convertPluginManifestForCodex,
  convertPluginManifestForCursor,
  convertMarketplaceForCodex,
  convertMarketplaceForCursor,
} from '../converter/pluginManifest.js';
import { scanPlugin, scanMarketplaceMeta, readPluginMeta, analyzeSourceTarget, scanAllPlugins } from '../scanner/plugin.js';
import { convertMCP } from '../converter/mcp.js';
import type { PluginMeta, ScanResult, PluginScanResult, MarketplaceMeta } from '../types.js';

// --- Fixtures ---

let fixtureDir: string;
let pluginWithInterface: string;
let pluginWithCustomPaths: string;
let marketplaceWithPluginRoot: string;
let marketplaceWithSkillsSource: string;
let pluginWithMCP: string;

beforeAll(() => {
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acplugin-manifest-test-'));

  // Plugin with full interface metadata
  pluginWithInterface = path.join(fixtureDir, 'plugin-interface');
  fs.mkdirSync(path.join(pluginWithInterface, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(pluginWithInterface, '.claude-plugin', 'plugin.json'), JSON.stringify({
    name: 'my-plugin',
    version: '0.1.0',
    description: 'A test plugin',
    author: { name: 'Test Author', email: 'test@example.com', url: 'https://example.com' },
    homepage: 'https://example.com/plugin',
    repository: 'https://github.com/test/plugin',
    license: 'MIT',
    keywords: ['test', 'plugin'],
    skills: './skills/',
    mcpServers: './.mcp.json',
    apps: './.app.json',
    interface: {
      displayName: 'My Plugin',
      shortDescription: 'Short desc',
      longDescription: 'Long description here',
      developerName: 'Test Team',
      category: 'Productivity',
      capabilities: ['Read', 'Write'],
      websiteURL: 'https://example.com',
      brandColor: '#10A37F',
      logo: './assets/logo.png',
      screenshots: ['./assets/screenshot.png'],
    },
  }));
  fs.mkdirSync(path.join(pluginWithInterface, 'skills', 'hello'), { recursive: true });
  fs.writeFileSync(path.join(pluginWithInterface, 'skills', 'hello', 'SKILL.md'),
    '---\nname: hello\ndescription: Hello skill\n---\nHello!');

  // Plugin with custom resource paths
  pluginWithCustomPaths = path.join(fixtureDir, 'plugin-custom');
  fs.mkdirSync(path.join(pluginWithCustomPaths, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(pluginWithCustomPaths, '.claude-plugin', 'plugin.json'), JSON.stringify({
    name: 'custom-paths',
    version: '1.0.0',
    skills: './custom/skills/',
    agents: './custom/agents/',
    hooks: './config/hooks.json',
  }));
  fs.mkdirSync(path.join(pluginWithCustomPaths, 'custom', 'skills', 'my-skill'), { recursive: true });
  fs.writeFileSync(path.join(pluginWithCustomPaths, 'custom', 'skills', 'my-skill', 'SKILL.md'),
    '---\nname: custom-skill\ndescription: Custom path skill\n---\nCustom!');
  fs.mkdirSync(path.join(pluginWithCustomPaths, 'custom', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(pluginWithCustomPaths, 'custom', 'agents', 'reviewer.md'),
    '---\nname: reviewer\ndescription: Reviewer agent\n---\nReview code.');

  // Marketplace with pluginRoot
  marketplaceWithPluginRoot = path.join(fixtureDir, 'marketplace-root');
  fs.mkdirSync(path.join(marketplaceWithPluginRoot, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(marketplaceWithPluginRoot, '.claude-plugin', 'marketplace.json'), JSON.stringify({
    name: 'my-org-marketplace',
    owner: { name: 'Test Org', email: 'org@test.com' },
    metadata: {
      description: 'Organization marketplace',
      version: '0.1.0',
      pluginRoot: 'plugins',
    },
    plugins: [
      { name: 'devtools', source: 'devtools', description: 'Dev tools plugin' },
      { name: 'empty-plugin', source: 'empty-plugin', description: 'No resources' },
    ],
  }));

  // devtools plugin under plugins/ directory
  const devtoolsDir = path.join(marketplaceWithPluginRoot, 'plugins', 'devtools');
  fs.mkdirSync(path.join(devtoolsDir, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(devtoolsDir, '.claude-plugin', 'plugin.json'), JSON.stringify({
    name: 'devtools', version: '1.0.0', description: 'Developer tools',
  }));
  fs.mkdirSync(path.join(devtoolsDir, 'skills', 'lint'), { recursive: true });
  fs.writeFileSync(path.join(devtoolsDir, 'skills', 'lint', 'SKILL.md'),
    '---\nname: lint\ndescription: Lint code\n---\nLint!');

  // empty plugin (no resources)
  const emptyDir = path.join(marketplaceWithPluginRoot, 'plugins', 'empty-plugin');
  fs.mkdirSync(path.join(emptyDir, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(emptyDir, '.claude-plugin', 'plugin.json'), JSON.stringify({
    name: 'empty-plugin',
  }));

  // Marketplace where source points directly to skills dir (flat layout like chrome-devtools-capturer-repo)
  marketplaceWithSkillsSource = path.join(fixtureDir, 'marketplace-flat');
  fs.mkdirSync(path.join(marketplaceWithSkillsSource, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(marketplaceWithSkillsSource, '.claude-plugin', 'marketplace.json'), JSON.stringify({
    name: 'flat-plugin',
    owner: { name: 'TestOwner' },
    plugins: [
      { name: 'my-capturer', version: '1.0.0', source: './skills', description: 'Flat skills plugin' },
    ],
  }));
  fs.mkdirSync(path.join(marketplaceWithSkillsSource, 'skills', 'capture'), { recursive: true });
  fs.writeFileSync(path.join(marketplaceWithSkillsSource, 'skills', 'capture', 'SKILL.md'),
    '---\nname: capture\ndescription: Capture data\n---\nCapture!');
  fs.mkdirSync(path.join(marketplaceWithSkillsSource, 'skills', 'analyze'), { recursive: true });
  fs.writeFileSync(path.join(marketplaceWithSkillsSource, 'skills', 'analyze', 'SKILL.md'),
    '---\nname: analyze\ndescription: Analyze data\n---\nAnalyze!');

  // Plugin with .mcp.json referencing ${CLAUDE_PLUGIN_ROOT}/scripts/
  pluginWithMCP = path.join(fixtureDir, 'plugin-mcp');
  fs.mkdirSync(path.join(pluginWithMCP, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(pluginWithMCP, '.claude-plugin', 'plugin.json'), JSON.stringify({
    name: 'mcp-plugin',
    version: '1.0.0',
  }));
  fs.writeFileSync(path.join(pluginWithMCP, '.mcp.json'), JSON.stringify({
    mcpServers: {
      'my-server': {
        command: 'node',
        args: ['${CLAUDE_PLUGIN_ROOT}/scripts/server/start.js'],
        env: { CONFIG: '${CLAUDE_PLUGIN_ROOT}/config/settings.json' },
      },
    },
  }));
  fs.mkdirSync(path.join(pluginWithMCP, 'scripts', 'server'), { recursive: true });
  fs.writeFileSync(path.join(pluginWithMCP, 'scripts', 'server', 'start.js'), 'console.log("hello");');
  fs.mkdirSync(path.join(pluginWithMCP, 'skills', 'test-skill'), { recursive: true });
  fs.writeFileSync(path.join(pluginWithMCP, 'skills', 'test-skill', 'SKILL.md'),
    '---\nname: test-skill\ndescription: Test\n---\nTest!');
});

// --- Tests ---

describe('readPluginMeta - resource paths', () => {
  it('extracts resource path fields from plugin.json', () => {
    const meta = readPluginMeta(pluginWithInterface);
    expect(meta.skills).toBe('./skills/');
    expect(meta.mcpServers).toBe('./.mcp.json');
    expect(meta.apps).toBe('./.app.json');
  });

  it('extracts interface metadata', () => {
    const meta = readPluginMeta(pluginWithInterface);
    expect(meta.interface).toBeDefined();
    expect(meta.interface!.displayName).toBe('My Plugin');
    expect(meta.interface!.category).toBe('Productivity');
    expect(meta.interface!.brandColor).toBe('#10A37F');
    expect(meta.interface!.capabilities).toEqual(['Read', 'Write']);
  });

  it('extracts custom paths', () => {
    const meta = readPluginMeta(pluginWithCustomPaths);
    expect(meta.skills).toBe('./custom/skills/');
    expect(meta.agents).toBe('./custom/agents/');
    expect(meta.hooks).toBe('./config/hooks.json');
  });
});

describe('scanPlugin - custom paths', () => {
  it('scans skills from custom directory', () => {
    const result = scanPlugin(pluginWithCustomPaths);
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0].frontmatter.name).toBe('custom-skill');
  });

  it('scans agents from custom directory', () => {
    const result = scanPlugin(pluginWithCustomPaths);
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0].frontmatter.name).toBe('reviewer');
  });
});

describe('scanMarketplaceMeta - pluginRoot', () => {
  it('returns full marketplace metadata with pluginRoot', () => {
    const meta = scanMarketplaceMeta(marketplaceWithPluginRoot);
    expect(meta).not.toBeNull();
    expect(meta!.name).toBe('my-org-marketplace');
    expect(meta!.metadata?.pluginRoot).toBe('plugins');
    expect(meta!.owner?.name).toBe('Test Org');
    expect(meta!.plugins).toHaveLength(2);
  });
});

describe('convertPluginManifestForCodex', () => {
  it('generates .codex-plugin/plugin.json with full metadata', () => {
    const scan = scanPlugin(pluginWithInterface);
    const result = convertPluginManifestForCodex(scan, scan.meta);

    expect(result.path).toBe('.codex-plugin/plugin.json');
    expect(result.type).toBe('manifest');

    const manifest = JSON.parse(result.content);
    expect(manifest.name).toBe('my-plugin');
    expect(manifest.version).toBe('0.1.0');
    expect(manifest.author.name).toBe('Test Author');
    expect(manifest.skills).toBe('./.agents/skills/');
    expect(manifest.interface.displayName).toBe('My Plugin');
    expect(manifest.interface.category).toBe('Productivity');
    expect(manifest.interface.brandColor).toBe('#10A37F');
  });

  it('includes apps path when present in meta', () => {
    const scan = scanPlugin(pluginWithInterface);
    const result = convertPluginManifestForCodex(scan, scan.meta);
    const manifest = JSON.parse(result.content);
    expect(manifest.apps).toBe('./.app.json');
  });
});

describe('convertPluginManifestForCursor', () => {
  it('generates .cursor-plugin/plugin.json with interface fields', () => {
    const scan = scanPlugin(pluginWithInterface);
    const result = convertPluginManifestForCursor(scan, scan.meta);

    expect(result.path).toBe('.cursor-plugin/plugin.json');

    const manifest = JSON.parse(result.content);
    expect(manifest.name).toBe('my-plugin');
    expect(manifest.displayName).toBe('My Plugin');
    expect(manifest.logo).toBe('./assets/logo.png');
    expect(manifest.skills).toBe('./.cursor/skills/');
  });

  it('falls back to interface.displayName when no top-level displayName', () => {
    const scan: ScanResult = {
      skills: [], instructions: [], mcp: null, agents: [], commands: [], hooks: null, pluginFiles: [],
      rootDir: '/tmp',
    };
    const meta: PluginMeta = {
      name: 'test',
      interface: { displayName: 'From Interface' },
    };
    const result = convertPluginManifestForCursor(scan, meta);
    const manifest = JSON.parse(result.content);
    expect(manifest.displayName).toBe('From Interface');
  });
});

describe('convertMarketplaceForCodex', () => {
  it('generates Codex marketplace.json with policy defaults', () => {
    const marketplace: MarketplaceMeta = {
      name: 'test-marketplace',
      metadata: { description: 'Test marketplace' },
      plugins: [
        { name: 'plugin-a', source: './plugins/plugin-a', description: 'Plugin A' },
      ],
    };
    const pluginScans: PluginScanResult[] = [{
      meta: { name: 'plugin-a', description: 'Plugin A', category: 'Productivity' },
      skills: [{ dirName: 'skill', frontmatter: { name: 'skill' }, body: '', sourcePath: '', auxFiles: [] }],
      instructions: [], mcp: null, agents: [], commands: [], hooks: null, pluginFiles: [], rootDir: '/tmp',
    }];

    const result = convertMarketplaceForCodex(marketplace, pluginScans);
    expect(result.path).toBe('.agents/plugins/marketplace.json');

    const output = JSON.parse(result.content);
    expect(output.name).toBe('test-marketplace');
    expect(output.plugins).toHaveLength(1);
    expect(output.plugins[0].source).toEqual({ source: 'local', path: './plugins/plugin-a' });
    expect(output.plugins[0].policy).toEqual({
      installation: 'AVAILABLE',
      authentication: 'ON_INSTALL',
    });
    expect(output.plugins[0].category).toBe('Productivity');
  });
});

describe('convertMarketplaceForCursor', () => {
  it('generates Cursor marketplace.json with pluginRoot', () => {
    const marketplace: MarketplaceMeta = {
      name: 'my-org',
      owner: { name: 'Test Org', email: 'org@test.com' },
      metadata: { description: 'Org marketplace', version: '0.1.0', pluginRoot: 'plugins' },
      plugins: [
        { name: 'devtools', source: 'devtools', description: 'Dev tools' },
      ],
    };
    const pluginScans: PluginScanResult[] = [{
      meta: { name: 'devtools', description: 'Dev tools' },
      skills: [{ dirName: 'skill', frontmatter: { name: 'skill' }, body: '', sourcePath: '', auxFiles: [] }],
      instructions: [], mcp: null, agents: [], commands: [], hooks: null, pluginFiles: [], rootDir: '/tmp',
    }];

    const result = convertMarketplaceForCursor(marketplace, pluginScans);
    expect(result.path).toBe('.cursor-plugin/marketplace.json');

    const output = JSON.parse(result.content);
    expect(output.name).toBe('my-org');
    expect(output.owner.name).toBe('Test Org');
    expect(output.metadata.pluginRoot).toBe('plugins');
    expect(output.plugins[0].source).toBe('devtools');
  });
});

// --- Source target analysis ---

describe('analyzeSourceTarget', () => {
  it('detects plugin root by .claude-plugin/plugin.json', () => {
    expect(analyzeSourceTarget(pluginWithInterface)).toBe('plugin-root');
  });

  it('detects plugin root by skills/ subdirectory', () => {
    // marketplaceWithPluginRoot/plugins/devtools has skills/ subdir
    const devtoolsDir = path.join(marketplaceWithPluginRoot, 'plugins', 'devtools');
    expect(analyzeSourceTarget(devtoolsDir)).toBe('plugin-root');
  });

  it('detects skills directory by name', () => {
    const skillsDir = path.join(marketplaceWithSkillsSource, 'skills');
    expect(analyzeSourceTarget(skillsDir)).toBe('skills-dir');
  });

  it('returns unknown for empty directory', () => {
    const emptyDir = path.join(fixtureDir, 'empty-dir');
    fs.mkdirSync(emptyDir, { recursive: true });
    expect(analyzeSourceTarget(emptyDir)).toBe('unknown');
  });
});

describe('scanAllPlugins - flat layout (source: "./skills")', () => {
  it('scans skills when source points directly to skills dir', () => {
    const results = scanAllPlugins(marketplaceWithSkillsSource);
    expect(results).toHaveLength(1);
    expect(results[0].meta.name).toBe('my-capturer');
    expect(results[0].skills).toHaveLength(2);
    expect(results[0].skills.map(s => s.frontmatter.name).sort()).toEqual(['analyze', 'capture']);
  });

  it('preserves metadata from marketplace entry', () => {
    const results = scanAllPlugins(marketplaceWithSkillsSource);
    expect(results[0].meta.description).toBe('Flat skills plugin');
    expect(results[0].meta.version).toBe('1.0.0');
  });
});

// --- MCP scanning and plugin-level files ---

describe('scanPlugin - MCP support', () => {
  it('scans .mcp.json from plugin directory', () => {
    const result = scanPlugin(pluginWithMCP);
    expect(result.mcp).not.toBeNull();
    expect(result.mcp!.servers).toHaveLength(1);
    expect(result.mcp!.servers[0].name).toBe('my-server');
    expect(result.mcp!.servers[0].command).toBe('node');
    expect(result.mcp!.servers[0].args![0]).toContain('${CLAUDE_PLUGIN_ROOT}');
  });

  it('scans plugin-level resource files referenced by MCP', () => {
    const result = scanPlugin(pluginWithMCP);
    expect(result.pluginFiles.length).toBeGreaterThan(0);
    const scriptFile = result.pluginFiles.find(f => f.relativePath.includes('start.js'));
    expect(scriptFile).toBeDefined();
    expect(scriptFile!.content).toBe('console.log("hello");');
  });

  it('still scans skills alongside MCP', () => {
    const result = scanPlugin(pluginWithMCP);
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0].frontmatter.name).toBe('test-skill');
  });
});

describe('MCP converter - ${CLAUDE_PLUGIN_ROOT} transformation', () => {
  it('transforms args for Codex', () => {
    const mcp = {
      servers: [{
        name: 'test',
        command: 'node',
        args: ['${CLAUDE_PLUGIN_ROOT}/scripts/server/start.js'],
      }],
      sourcePath: '/tmp/.mcp.json',
    };
    const result = convertMCP(mcp, 'codex');
    expect(result.content).not.toContain('CLAUDE_PLUGIN_ROOT');
    expect(result.content).toContain('./scripts/server/start.js');
  });

  it('transforms env values for Cursor', () => {
    const mcp = {
      servers: [{
        name: 'test',
        command: 'node',
        args: ['${CLAUDE_PLUGIN_ROOT}/scripts/start.js'],
        env: { CONFIG: '${CLAUDE_PLUGIN_ROOT}/config/settings.json' },
      }],
      sourcePath: '/tmp/.mcp.json',
    };
    const result = convertMCP(mcp, 'cursor');
    const parsed = JSON.parse(result.content);
    const server = parsed.mcpServers.test;
    expect(server.args[0]).toBe('./scripts/start.js');
    expect(server.env.CONFIG).toBe('./config/settings.json');
  });

  it('transforms for OpenCode', () => {
    const mcp = {
      servers: [{
        name: 'test',
        command: 'node',
        args: ['${CLAUDE_PLUGIN_ROOT}/scripts/start.js'],
      }],
      sourcePath: '/tmp/.mcp.json',
    };
    const result = convertMCP(mcp, 'opencode');
    const parsed = JSON.parse(result.content);
    expect(parsed.mcp.test.args[0]).toBe('./scripts/start.js');
  });

  it('handles bare ${CLAUDE_PLUGIN_ROOT} without trailing path', () => {
    const mcp = {
      servers: [{
        name: 'test',
        command: 'node',
        args: ['${CLAUDE_PLUGIN_ROOT}'],
        env: { ROOT: '${CLAUDE_PLUGIN_ROOT}' },
      }],
      sourcePath: '/tmp/.mcp.json',
    };
    const result = convertMCP(mcp, 'cursor');
    const parsed = JSON.parse(result.content);
    expect(parsed.mcpServers.test.args[0]).toBe('.');
    expect(parsed.mcpServers.test.env.ROOT).toBe('.');
  });
});
