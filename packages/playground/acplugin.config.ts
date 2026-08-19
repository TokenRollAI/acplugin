import { defineConfig } from '@tokenroll/acplugin';
import hooks from '@tokenroll/acplugin-extension-hooks';
import mcp from '@tokenroll/acplugin-extension-mcp';
import antigravity from '@tokenroll/acplugin-platform-antigravity';
import claudeCode from '@tokenroll/acplugin-platform-claude-code';
import codex from '@tokenroll/acplugin-platform-codex';
import cursor from '@tokenroll/acplugin-platform-cursor';
import openCode from '@tokenroll/acplugin-platform-opencode';
import pi from '@tokenroll/acplugin-platform-pi';

/** 覆盖全部官方集成能力的 ACPlugin 模板配置。 */
export default defineConfig({
  name: 'acplugin-playground',
  version: '0.1.0',
  description: 'Complete ACPlugin capability template for integration exercises.',
  displayName: 'ACPlugin Capability Playground',
  author: {
    name: 'TokenRoll',
    email: 'maintainers@tokenroll.ai',
    url: 'https://github.com/TokenRollAI',
  },
  homepage: 'https://github.com/TokenRollAI/acplugin',
  repository: 'https://github.com/TokenRollAI/acplugin',
  license: 'MIT',
  keywords: ['acplugin', 'plugin-template', 'agent-skills', 'mcp'],
  platforms: [
    claudeCode({
      defaultEnabled: false,
      marketplace: {
        name: 'acplugin-capability-playground-marketplace',
        owner: { name: 'TokenRoll', email: 'maintainers@tokenroll.ai' },
        category: 'Developer Tools',
        tags: ['acplugin', 'plugin-template'],
      },
    }),
    codex({
      interface: {
        shortDescription: 'Explore a complete ACPlugin authoring template.',
        longDescription: 'A repository-local template that exercises canonical resources, Hooks, MCP, Public files, and all six official Platform deliveries.',
        developerName: 'TokenRoll',
        category: 'Developer Tools',
        capabilities: ['Command workflows', 'Lifecycle hooks', 'MCP tools'],
        websiteURL: 'https://github.com/TokenRollAI/acplugin',
        supportURL: 'https://github.com/TokenRollAI/acplugin/issues',
        defaultPrompt: [
          'Initialize the ACPlugin capability template for this repository.',
          'Review the generated Platform outputs for this template.',
        ],
        brandColor: '#FACC15',
        brandColorDark: '#EAB308',
        composerIcon: './assets/acplugin.svg',
        logo: './assets/acplugin.svg',
      },
      marketplace: {
        name: 'acplugin-capability-playground-marketplace',
        displayName: 'ACPlugin Capability Playground Marketplace',
        category: 'Developer Tools',
        policy: { installation: 'AVAILABLE' },
      },
    }),
    cursor({
      publisher: 'TokenRoll',
      logo: './assets/acplugin.svg',
      category: 'Developer Tools',
      tags: ['acplugin', 'plugin-template'],
      minClientVersions: { cursor: '1.0.0' },
    }),
    antigravity(),
    openCode({ workspace: { schema: true } }),
    pi({
      package: {
        image: './assets/acplugin.svg',
        video: 'https://example.com/acplugin-playground.mp4',
      },
    }),
  ],
  runtime: {
    entries: {
      playground: { entry: 'main.ts' },
    },
  },
  extensions: [hooks(), mcp()],
  build: { strict: false },
});
