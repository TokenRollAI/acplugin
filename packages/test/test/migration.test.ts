import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrate } from '../../acplugin/src/migration/index.js';
import { parseGitHubSource } from '../../acplugin/src/migration/legacy/github.js';

/** 当前测试创建并在 afterEach 中统一删除的临时目录。 */
const roots: string[] = [];
/** 仓库内用于验证旧 Claude 工程迁移的固定 Fixture。 */
const legacyProjectFixture = path.resolve(import.meta.dirname, '../fixtures/migration/claude-project');

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe('legacy Migration', () => {
  it('rejects GitHub command/path injection before download', () => {
    expect(() => parseGitHubSource('github:owner/repo#main\ntouch injected')).toThrow('branch is invalid');
    expect(() => parseGitHubSource('github:owner/repo#../../../../user')).toThrow('branch is invalid');
    expect(() => parseGitHubSource('https://github.com/owner/repo/tree/main/../../outside')).toThrow('must stay inside');
  });

  it('creates a canonical project and preserves unmapped resources in a sidecar', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-migration-test-'));
    roots.push(root);
    const source = legacyProjectFixture;
    const report = await migrate({
      cwd: root,
      source,
      destination: 'migrated',
      name: 'migrated-plugin',
      description: 'Migrated fixture.',
    });

    expect(report.success).toBe(true);
    expect(report.sourceType).toBe('project');
    expect(report.items).toContainEqual(expect.objectContaining({ kind: 'instruction', outcome: 'unmapped' }));
    expect(await fs.readFile(path.join(root, 'migrated/src/skills/my-skill/SKILL.md'), 'utf8')).toContain('description:');
    expect(JSON.parse(await fs.readFile(path.join(root, 'migrated/package.json'), 'utf8'))).toMatchObject({
      devDependencies: { typescript: '^7.0.2' },
    });
    expect(JSON.parse(await fs.readFile(path.join(root, 'migrated/.acplugin-migration/report.json'), 'utf8'))).toMatchObject({ schemaVersion: '1' });
  });

  it('strict dry-run fails on preserved unmapped resources and writes no destination', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-migration-test-'));
    roots.push(root);
    const source = legacyProjectFixture;
    const report = await migrate({
      cwd: root,
      source,
      destination: 'migrated',
      name: 'migrated-plugin',
      description: 'Migrated fixture.',
      strict: true,
      dryRun: true,
    });

    expect(report.success).toBe(false);
    await expect(fs.access(path.join(root, 'migrated'))).rejects.toThrow();
  });

  it('migrates all marketplace plugins into a pnpm workspace at a nested destination', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-migration-test-'));
    roots.push(root);
    const marketplace = path.join(root, 'marketplace');
    await fs.mkdir(path.join(marketplace, '.claude-plugin'), { recursive: true });
    await fs.writeFile(path.join(marketplace, '.claude-plugin/marketplace.json'), JSON.stringify({
      name: 'fixture-marketplace',
      plugins: [
        { name: 'first-plugin', description: 'First plugin.', version: '1.0.0', source: './plugins/first' },
        { name: 'second-plugin', description: 'Second plugin.', version: '1.0.0', source: './plugins/second' },
      ],
    }));
    for (const plugin of ['first', 'second']) {
      await fs.mkdir(path.join(marketplace, 'plugins', plugin, 'skills', 'hello'), { recursive: true });
      await fs.writeFile(path.join(marketplace, 'plugins', plugin, 'skills/hello/SKILL.md'), `---
description: Hello from ${plugin}.
---
Run the ${plugin} workflow.
`);
    }

    const report = await migrate({
      cwd: root,
      source: 'marketplace',
      destination: 'nested/migrated',
      all: true,
    });

    expect(report).toMatchObject({ success: true, sourceType: 'marketplace', projects: ['first-plugin', 'second-plugin'] });
    expect(await fs.readFile(path.join(root, 'nested/migrated/pnpm-workspace.yaml'), 'utf8')).toContain('first-plugin');
    await fs.access(path.join(root, 'nested/migrated/second-plugin/src/skills/hello/SKILL.md'));
  });

  it('rejects marketplace sources that resolve outside the source tree', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-migration-test-'));
    roots.push(root);
    const marketplace = path.join(root, 'marketplace');
    await fs.mkdir(path.join(marketplace, '.claude-plugin'), { recursive: true });
    await fs.mkdir(path.join(root, 'outside', 'skills', 'escape'), { recursive: true });
    await fs.writeFile(path.join(root, 'outside/skills/escape/SKILL.md'), '---\ndescription: Escape.\n---\nEscape.\n');
    await fs.writeFile(path.join(marketplace, '.claude-plugin/marketplace.json'), JSON.stringify({
      name: 'unsafe-marketplace',
      plugins: [{ name: 'escape', description: 'Escape.', source: '../outside' }],
    }));

    await expect(migrate({ cwd: root, source: 'marketplace', destination: 'migrated', all: true })).rejects.toThrow('must stay inside');
    await expect(fs.access(path.join(root, 'migrated'))).rejects.toThrow();
  });

  it('never copies literal MCP credentials into canonical or unmapped output', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-migration-test-'));
    roots.push(root);
    const source = path.join(root, 'legacy-project');
    await fs.mkdir(path.join(source, '.claude'), { recursive: true });
    await fs.writeFile(path.join(source, '.mcp.json'), JSON.stringify({
      mcpServers: {
        secret: {
          type: 'http',
          url: 'https://user:password@example.com/mcp?token=top-secret',
          headers: { Authorization: 'Bearer top-secret' },
        },
      },
    }));

    const report = await migrate({
      cwd: root, source: 'legacy-project', destination: 'migrated',
      name: 'safe-plugin', description: 'Safe migration.',
    });
    const output = await fs.readFile(path.join(root, 'migrated/.acplugin-migration/unmapped/mcp/secret.json'), 'utf8');

    expect(report.items).toContainEqual(expect.objectContaining({ kind: 'mcp', id: 'secret', outcome: 'unmapped' }));
    expect(output).not.toContain('top-secret');
    expect(output).not.toContain('password');
    expect(output).toContain('<redacted>');
  });

  it('preserves Hook implementation files without treating them as trusted canonical handlers', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-migration-test-'));
    roots.push(root);
    const source = path.join(root, 'legacy-project');
    await fs.mkdir(path.join(source, '.claude'), { recursive: true });
    await fs.mkdir(path.join(source, 'scripts'), { recursive: true });
    await fs.writeFile(path.join(source, '.claude/settings.json'), JSON.stringify({
      hooks: {
        PreToolUse: [{ hooks: [{ type: 'command', command: 'bash "${CLAUDE_PROJECT_DIR}/scripts/check.sh"' }] }],
      },
    }));
    await fs.writeFile(path.join(source, 'scripts/check.sh'), '#!/bin/sh\nexit 0\n');

    const report = await migrate({
      cwd: root,
      source: 'legacy-project',
      destination: 'migrated',
      name: 'hook-project',
      description: 'Hook migration fixture.',
    });

    expect(report.items).toContainEqual(expect.objectContaining({
      kind: 'hook-file',
      outcome: 'unmapped',
      destination: '.acplugin-migration/unmapped/hook-files/scripts/check.sh',
    }));
    expect(await fs.readFile(path.join(root, 'migrated/.acplugin-migration/unmapped/hook-files/scripts/check.sh'), 'utf8')).toContain('exit 0');
    await expect(fs.access(path.join(root, 'migrated/src/hooks'))).rejects.toThrow();
  });

  it('does not create nested destination parents during dry-run', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-migration-test-'));
    roots.push(root);
    const source = legacyProjectFixture;
    await migrate({
      cwd: root,
      source,
      destination: 'not-created/nested/migrated',
      name: 'migrated-plugin',
      description: 'Dry migration fixture.',
      dryRun: true,
    });

    await expect(fs.access(path.join(root, 'not-created'))).rejects.toThrow();
  });
});
