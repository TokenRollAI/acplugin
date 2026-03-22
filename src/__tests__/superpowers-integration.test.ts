/**
 * Integration tests using the real superpowers plugin (https://github.com/obra/superpowers).
 * Tests the full scan → convert → write pipeline with real-world data.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import { hasMarketplace, isSinglePlugin, scanMarketplace, scanPlugin, scanAllPlugins, countResources } from '../scanner/plugin.js';
import { generateCodex } from '../writer/codex.js';
import { generateOpenCode } from '../writer/opencode.js';
import { generateCursor } from '../writer/cursor.js';
import { generateAntigravity } from '../writer/antigravity.js';
import type { PluginScanResult, ConvertResult } from '../types.js';

const SUPERPOWERS_DIR = '/tmp/superpowers-test';

// Skip all tests if the superpowers repo is not cloned
const repoExists = fs.existsSync(SUPERPOWERS_DIR);

describe.skipIf(!repoExists)('superpowers plugin integration', () => {
  // --- Phase 1: Detection ---
  describe('1. plugin format detection', () => {
    it('detects marketplace format', () => {
      expect(hasMarketplace(SUPERPOWERS_DIR)).toBe(true);
    });

    it('also detects as single plugin (has plugin.json)', () => {
      expect(isSinglePlugin(SUPERPOWERS_DIR)).toBe(true);
    });

    it('plugin root is NOT a standard Claude project (.claude/ dir)', () => {
      expect(fs.existsSync(path.join(SUPERPOWERS_DIR, '.claude'))).toBe(false);
    });
  });

  // --- Phase 2: Marketplace scanning ---
  describe('2. marketplace scanning', () => {
    it('reads marketplace.json with correct metadata', () => {
      const metas = scanMarketplace(SUPERPOWERS_DIR);
      expect(metas).toHaveLength(1);
      expect(metas[0].name).toBe('superpowers');
      expect(metas[0].version).toBe('5.0.5');
      expect(metas[0].source).toBe('./');
      expect(metas[0].author).toEqual({ name: 'Jesse Vincent', email: 'jesse@fsck.com' });
    });
  });

  // --- Phase 3: Single plugin scanning ---
  describe('3. plugin scanning', () => {
    let result: PluginScanResult;

    beforeAll(() => {
      result = scanPlugin(SUPERPOWERS_DIR) as PluginScanResult;
    });

    it('reads plugin metadata from plugin.json', () => {
      expect(result.meta.name).toBe('superpowers');
      expect(result.meta.version).toBe('5.0.5');
    });

    // --- Skills ---
    describe('skills', () => {
      it('scans all 14 skills', () => {
        expect(result.skills.length).toBe(14);
      });

      it('each skill has dirName and sourcePath', () => {
        for (const skill of result.skills) {
          expect(skill.dirName).toBeTruthy();
          expect(skill.sourcePath).toContain('skills/');
          expect(skill.sourcePath).toContain('SKILL.md');
        }
      });

      it('parses frontmatter correctly for brainstorming skill', () => {
        const brainstorm = result.skills.find(s => s.dirName === 'brainstorming');
        expect(brainstorm).toBeDefined();
        expect(brainstorm!.frontmatter.name).toBe('brainstorming');
        expect(brainstorm!.frontmatter.description).toBeTruthy();
      });

      it('has body content for all skills', () => {
        for (const skill of result.skills) {
          expect(skill.body.length).toBeGreaterThan(0);
        }
      });

      it('handles skill names with hyphens', () => {
        const tdd = result.skills.find(s => s.dirName === 'test-driven-development');
        expect(tdd).toBeDefined();
        expect(tdd!.frontmatter.name).toBe('test-driven-development');
      });

      it('scans using-superpowers skill (the core session-start skill)', () => {
        const core = result.skills.find(s => s.dirName === 'using-superpowers');
        expect(core).toBeDefined();
        expect(core!.body).toContain('Skill');
      });
    });

    // --- Agents ---
    describe('agents', () => {
      it('scans 1 agent', () => {
        expect(result.agents).toHaveLength(1);
      });

      it('parses code-reviewer agent', () => {
        const agent = result.agents[0];
        expect(agent.fileName).toBe('code-reviewer');
        expect(agent.frontmatter.name).toBe('code-reviewer');
        expect(agent.frontmatter.model).toBe('inherit');
      });

      it('handles complex YAML block scalar description with XML tags', () => {
        const agent = result.agents[0];
        // The description uses YAML | block scalar and contains <example> XML tags
        // gray-matter should parse this without crashing
        expect(agent.frontmatter.description).toBeTruthy();
        expect(typeof agent.frontmatter.description).toBe('string');
        expect(agent.frontmatter.description).toContain('example');
      });

      it('preserves agent body content', () => {
        const agent = result.agents[0];
        expect(agent.body).toContain('Senior Code Reviewer');
        expect(agent.body).toContain('Plan Alignment Analysis');
      });
    });

    // --- Commands ---
    describe('commands', () => {
      it('scans 3 deprecated commands', () => {
        expect(result.commands).toHaveLength(3);
      });

      it('has correct command names', () => {
        const names = result.commands.map(c => c.name).sort();
        expect(names).toEqual(['brainstorm', 'execute-plan', 'write-plan']);
      });

      it('preserves command content including deprecation notice', () => {
        const brainstorm = result.commands.find(c => c.name === 'brainstorm');
        expect(brainstorm).toBeDefined();
        expect(brainstorm!.content).toContain('deprecated');
      });
    });

    // --- Hooks ---
    describe('hooks', () => {
      it('scans hooks from hooks.json', () => {
        expect(result.hooks).not.toBeNull();
      });

      it('has SessionStart event', () => {
        expect(result.hooks!['SessionStart']).toBeDefined();
        expect(result.hooks!['SessionStart']).toHaveLength(1);
      });

      it('has correct matcher pattern', () => {
        const sessionStart = result.hooks!['SessionStart'][0];
        expect(sessionStart.matcher).toBe('startup|clear|compact');
      });

      it('has command hook with plugin root variable', () => {
        const hook = result.hooks!['SessionStart'][0].hooks[0];
        expect(hook.type).toBe('command');
        expect(hook.command).toContain('${CLAUDE_PLUGIN_ROOT}');
        expect(hook.command).toContain('session-start');
      });
    });

    // --- No MCP / Instructions ---
    describe('absent resources', () => {
      it('has no MCP config', () => {
        expect(result.mcp).toBeNull();
      });

      it('has no instructions (plugins have no CLAUDE.md)', () => {
        expect(result.instructions).toHaveLength(0);
      });
    });

    // --- Resource count ---
    it('countResources returns correct total', () => {
      const count = countResources(result);
      // 14 skills + 1 agent + 3 commands + 1 hook event = 19
      expect(count).toBe(14 + 1 + 3 + 1);
    });
  });

  // --- Phase 4: scanAllPlugins ---
  describe('4. scanAllPlugins', () => {
    it('returns single plugin with resources', () => {
      const results = scanAllPlugins(SUPERPOWERS_DIR);
      expect(results).toHaveLength(1);
      expect(results[0].meta.name).toBe('superpowers');
    });

    it('inherits marketplace metadata', () => {
      const results = scanAllPlugins(SUPERPOWERS_DIR);
      expect(results[0].meta.version).toBe('5.0.5');
      expect(results[0].meta.author).toEqual({ name: 'Jesse Vincent', email: 'jesse@fsck.com' });
    });
  });

  // --- Phase 5: Full conversion pipeline ---
  describe('5. Codex conversion', () => {
    let result: ConvertResult;
    let scanResult: PluginScanResult;

    beforeAll(() => {
      scanResult = scanPlugin(SUPERPOWERS_DIR) as PluginScanResult;
      result = generateCodex(scanResult);
    });

    it('generates correct platform', () => {
      expect(result.platform).toBe('codex');
    });

    it('converts all 14 skills to .agents/skills/', () => {
      const skillFiles = result.files.filter(f => f.type === 'skill');
      expect(skillFiles.length).toBeGreaterThanOrEqual(14);
      for (const f of skillFiles) {
        expect(f.path).toMatch(/^\.agents\/skills\//);
      }
    });

    it('converts agent to .codex/agents/*.toml', () => {
      const agentFiles = result.files.filter(f => f.type === 'agent');
      expect(agentFiles).toHaveLength(1);
      expect(agentFiles[0].path).toBe('.codex/agents/code-reviewer.toml');
      expect(agentFiles[0].content).toContain('name');
      expect(agentFiles[0].content).toContain('Senior Code Reviewer');
    });

    it('converts commands to skills', () => {
      const cmdFiles = result.files.filter(f => f.type === 'command');
      expect(cmdFiles).toHaveLength(3);
      for (const f of cmdFiles) {
        expect(f.path).toMatch(/^\.agents\/skills\/cmd-/);
      }
    });

    it('generates hook warnings for SessionStart', () => {
      // SessionStart is portable, but command hooks go into AGENTS.md notes
      const agentsMd = result.files.find(f => f.path === 'AGENTS.md');
      // May or may not have AGENTS.md depending on whether hooks generated content
      // At minimum, there should be no crash
      expect(result.warnings).toBeDefined();
    });
  });

  describe('6. OpenCode conversion', () => {
    let result: ConvertResult;

    beforeAll(() => {
      const scanResult = scanPlugin(SUPERPOWERS_DIR) as PluginScanResult;
      result = generateOpenCode(scanResult);
    });

    it('generates correct platform', () => {
      expect(result.platform).toBe('opencode');
    });

    it('converts skills to .opencode/skills/', () => {
      const skillFiles = result.files.filter(f => f.type === 'skill');
      expect(skillFiles.length).toBeGreaterThanOrEqual(14);
      for (const f of skillFiles) {
        expect(f.path).toMatch(/^\.opencode\/skills\//);
      }
    });

    it('converts agent to .opencode/agents/*.md with mode: subagent', () => {
      const agentFiles = result.files.filter(f => f.type === 'agent');
      expect(agentFiles).toHaveLength(1);
      expect(agentFiles[0].path).toBe('.opencode/agents/code-reviewer.md');
      expect(agentFiles[0].content).toContain('mode: subagent');
    });

    it('converts commands to .opencode/commands/', () => {
      const cmdFiles = result.files.filter(f => f.type === 'command');
      expect(cmdFiles).toHaveLength(3);
      for (const f of cmdFiles) {
        expect(f.path).toMatch(/^\.opencode\/commands\//);
      }
    });
  });

  describe('7. Cursor conversion', () => {
    let result: ConvertResult;

    beforeAll(() => {
      const scanResult = scanPlugin(SUPERPOWERS_DIR) as PluginScanResult;
      result = generateCursor(scanResult);
    });

    it('generates correct platform', () => {
      expect(result.platform).toBe('cursor');
    });

    it('generates .cursor-plugin/plugin.json manifest with full metadata', () => {
      const pluginJson = result.files.find(f => f.path === '.cursor-plugin/plugin.json');
      expect(pluginJson).toBeDefined();
      const manifest = JSON.parse(pluginJson!.content);
      expect(manifest.name).toBe('superpowers');
      expect(manifest.version).toBe('5.0.5');
      expect(manifest.skills).toBe('./skills/');
      expect(manifest.agents).toBe('./agents/');
      expect(manifest.commands).toBe('./commands/');
      // New fields from plugin.json passthrough
      expect(manifest.hooks).toBe('./hooks/hooks-cursor.json');
      expect(manifest.author).toEqual({ name: 'Jesse Vincent', email: 'jesse@fsck.com' });
    });

    it('remaps skill paths from .cursor/ to plugin root', () => {
      const skillFiles = result.files.filter(f => f.type === 'skill');
      for (const f of skillFiles) {
        expect(f.path).toMatch(/^skills\//);
        expect(f.path).not.toMatch(/^\.cursor\//);
      }
    });

    it('remaps agent paths', () => {
      const agentFiles = result.files.filter(f => f.type === 'agent');
      expect(agentFiles).toHaveLength(1);
      expect(agentFiles[0].path).toBe('agents/code-reviewer.md');
    });

    it('remaps command paths', () => {
      const cmdFiles = result.files.filter(f => f.type === 'command');
      expect(cmdFiles).toHaveLength(3);
      for (const f of cmdFiles) {
        expect(f.path).toMatch(/^commands\//);
      }
    });

    it('generates hooks/hooks-cursor.json with camelCase events', () => {
      const hooksFile = result.files.find(f => f.path === 'hooks/hooks-cursor.json');
      expect(hooksFile).toBeDefined();
      const hooksData = JSON.parse(hooksFile!.content);
      expect(hooksData.version).toBe(1);
      expect(hooksData.hooks.sessionStart).toBeDefined();
      // camelCase, not PascalCase
      expect(hooksData.hooks.SessionStart).toBeUndefined();
    });

    it('cursor hooks use relative paths (no ${CLAUDE_PLUGIN_ROOT})', () => {
      const hooksFile = result.files.find(f => f.path === 'hooks/hooks-cursor.json');
      expect(hooksFile).toBeDefined();
      expect(hooksFile!.content).not.toContain('CLAUDE_PLUGIN_ROOT');
      expect(hooksFile!.content).toContain('./hooks/');
    });
  });

  describe('8. Antigravity conversion', () => {
    let result: ConvertResult;

    beforeAll(() => {
      const scanResult = scanPlugin(SUPERPOWERS_DIR) as PluginScanResult;
      result = generateAntigravity(scanResult);
    });

    it('generates correct platform', () => {
      expect(result.platform).toBe('antigravity');
    });

    it('converts skills to .agent/skills/', () => {
      const skillFiles = result.files.filter(f => f.type === 'skill');
      expect(skillFiles.length).toBeGreaterThanOrEqual(14);
      for (const f of skillFiles) {
        expect(f.path).toMatch(/^\.agent\/skills\//);
      }
    });

    it('converts agent to .gemini/agents/*.md', () => {
      const agentFiles = result.files.filter(f => f.type === 'agent');
      expect(agentFiles).toHaveLength(1);
      expect(agentFiles[0].path).toBe('.gemini/agents/code-reviewer.md');
    });

    it('converts commands to skills (.agent/skills/cmd-*)', () => {
      const cmdFiles = result.files.filter(f => f.type === 'command');
      expect(cmdFiles).toHaveLength(3);
      for (const f of cmdFiles) {
        expect(f.path).toMatch(/^\.agent\/skills\/cmd-/);
      }
    });
  });

  // --- Phase 6: Edge cases and robustness ---
  describe('9. frontmatter robustness', () => {
    it('all skills parse without throwing', () => {
      const scanResult = scanPlugin(SUPERPOWERS_DIR);
      // If we got here, all 14 skills parsed without crash
      expect(scanResult.skills.length).toBe(14);
    });

    it('agent with YAML block scalar and XML content parses', () => {
      const scanResult = scanPlugin(SUPERPOWERS_DIR);
      const agent = scanResult.agents[0];
      // Should not have fallen back to empty frontmatter
      expect(agent.frontmatter.name).toBe('code-reviewer');
      expect(agent.frontmatter.model).toBe('inherit');
    });

    it('skill descriptions with quoted strings parse correctly', () => {
      const scanResult = scanPlugin(SUPERPOWERS_DIR);
      const brainstorm = scanResult.skills.find(s => s.dirName === 'brainstorming');
      // description has quoted value in YAML
      expect(brainstorm!.frontmatter.description).toContain('MUST');
    });
  });

  // --- Phase 7: Content integrity ---
  describe('10. content integrity across platforms', () => {
    it('agent body is preserved identically across all platforms', () => {
      const scanResult = scanPlugin(SUPERPOWERS_DIR) as PluginScanResult;
      const codex = generateCodex(scanResult);
      const opencode = generateOpenCode(scanResult);
      const cursor = generateCursor(scanResult);
      const antigravity = generateAntigravity(scanResult);

      // The body text should appear in all platform outputs
      const bodySnippet = 'Plan Alignment Analysis';
      for (const result of [codex, opencode, cursor, antigravity]) {
        const agentFile = result.files.find(f => f.type === 'agent');
        expect(agentFile).toBeDefined();
        expect(agentFile!.content).toContain(bodySnippet);
      }
    });

    it('skill count is consistent across platforms', () => {
      const scanResult = scanPlugin(SUPERPOWERS_DIR) as PluginScanResult;
      const codex = generateCodex(scanResult);
      const opencode = generateOpenCode(scanResult);
      const cursor = generateCursor(scanResult);
      const antigravity = generateAntigravity(scanResult);

      const codexSkills = codex.files.filter(f => f.type === 'skill').length;
      const opencodeSkills = opencode.files.filter(f => f.type === 'skill').length;
      const cursorSkills = cursor.files.filter(f => f.type === 'skill').length;
      const antigravitySkills = antigravity.files.filter(f => f.type === 'skill').length;

      expect(codexSkills).toBe(opencodeSkills);
      expect(opencodeSkills).toBe(cursorSkills);
      expect(cursorSkills).toBe(antigravitySkills);
    });
  });
});
