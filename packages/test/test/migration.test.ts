import { createHash } from 'node:crypto';
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
    /** 正常迁移测试使用的临时工作目录。 */
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-migration-test-'));
    roots.push(root);
    /** 固定旧 Claude 工程 Fixture 的迁移来源。 */
    const source = legacyProjectFixture;
    /** 规范工程和未映射 Sidecar 的迁移报告。 */
    const report = await migrate({
      cwd: root,
      source,
      destination: 'migrated',
      name: 'migrated-plugin',
      description: 'Migrated fixture.',
    });

    expect(report.success).toBe(true);
    expect(report.sourceType).toBe('project');
    expect(report.items).toContainEqual(expect.objectContaining({
      kind: 'instruction',
      outcome: 'unmapped',
      fields: [expect.objectContaining({ field: 'content', outcome: 'unmapped' })],
    }));
    expect(await fs.readFile(path.join(root, 'migrated/src/skills/my-skill/SKILL.md'), 'utf8')).toContain('description:');
    expect(JSON.parse(await fs.readFile(path.join(root, 'migrated/package.json'), 'utf8'))).toMatchObject({
      devDependencies: { typescript: '^7.0.2' },
    });
    expect(JSON.parse(await fs.readFile(path.join(root, 'migrated/.acplugin-migration/report.json'), 'utf8'))).toMatchObject({ schemaVersion: '1' });
  });

  it('strict dry-run fails on preserved unmapped resources and writes no destination', async () => {
    /** 严格 dry-run 使用的临时工作目录。 */
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-migration-test-'));
    roots.push(root);
    /** 包含越界 Instructions 的固定旧工程来源。 */
    const source = legacyProjectFixture;
    /** 严格模式下因 unmapped 资源失败的 dry-run 报告。 */
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
    /** Marketplace 多工程迁移测试使用的工作目录。 */
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-migration-test-'));
    roots.push(root);
    /** 动态创建的旧 Claude Marketplace 根目录。 */
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

    /** 全量迁移两个 Plugin 后的 Workspace 报告。 */
    const report = await migrate({
      cwd: root,
      source: 'marketplace',
      destination: 'nested/migrated',
      all: true,
    });

    expect(report).toMatchObject({ success: true, sourceType: 'marketplace', projects: ['first-plugin', 'second-plugin'] });
    expect(report.items).toContainEqual(expect.objectContaining({
      kind: 'marketplace',
      id: 'fixture-marketplace',
      outcome: 'unmapped',
      fields: expect.arrayContaining([
        expect.objectContaining({ field: 'name', source: '.claude-plugin/marketplace.json', outcome: 'unmapped' }),
        expect.objectContaining({ field: 'plugin-order', destination: '.acplugin-migration/report.json', outcome: 'unmapped' }),
      ]),
    }));
    expect(await fs.readFile(path.join(root, 'nested/migrated/pnpm-workspace.yaml'), 'utf8')).toContain('first-plugin');
    await fs.access(path.join(root, 'nested/migrated/second-plugin/src/skills/hello/SKILL.md'));
  });

  it('writes a selected marketplace plugin directly as one canonical project', async () => {
    /** 单 Plugin Marketplace 迁移测试使用的工作目录。 */
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-migration-test-'));
    roots.push(root);
    /** 仅包含一个可选择条目的旧 Marketplace。 */
    const marketplace = path.join(root, 'marketplace');
    await fs.mkdir(path.join(marketplace, '.claude-plugin'), { recursive: true });
    await fs.mkdir(path.join(marketplace, 'plugins/selected/skills/hello'), { recursive: true });
    await fs.writeFile(path.join(marketplace, '.claude-plugin/marketplace.json'), JSON.stringify({
      name: 'single-fixture',
      plugins: [{ name: 'selected-plugin', description: 'Selected plugin.', source: './plugins/selected' }],
    }));
    await fs.writeFile(path.join(marketplace, 'plugins/selected/skills/hello/SKILL.md'), '---\ndescription: Hello.\n---\nHello.\n');

    /** --plugin 输出根本身就是可安装和构建的规范工程。 */
    const report = await migrate({
      cwd: root,
      source: 'marketplace',
      destination: 'selected-output',
      plugin: 'selected-plugin',
    });

    expect(report).toMatchObject({ success: true, projects: ['.'] });
    await fs.access(path.join(root, 'selected-output/acplugin.config.ts'));
    await fs.access(path.join(root, 'selected-output/src/skills/hello/SKILL.md'));
    await expect(fs.access(path.join(root, 'selected-output/pnpm-workspace.yaml'))).rejects.toThrow();
    await expect(fs.access(path.join(root, 'selected-output/selected-plugin'))).rejects.toThrow();
  });

  it('retains and validates a Marketplace plugin whose only resource is remote MCP', async () => {
    /** MCP-only Marketplace 回归测试使用的临时工作目录。 */
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-migration-test-'));
    roots.push(root);
    /** 只包含一个远程 MCP Plugin 的旧 Marketplace。 */
    const marketplace = path.join(root, 'marketplace');
    await fs.mkdir(path.join(marketplace, '.claude-plugin'), { recursive: true });
    await fs.mkdir(path.join(marketplace, 'plugins/remote'), { recursive: true });
    await fs.writeFile(path.join(marketplace, '.claude-plugin/marketplace.json'), JSON.stringify({
      name: 'mcp-marketplace',
      plugins: [{ name: 'remote-tools', description: 'Remote tools.', source: './plugins/remote' }],
    }));
    await fs.writeFile(path.join(marketplace, 'plugins/remote/.mcp.json'), JSON.stringify({
      mcpServers: { docs: { type: 'http', url: 'https://mcp.example.com/mcp' } },
    }));

    /** --plugin 不能因缺少 Core Component 丢弃 MCP-only 清单条目。 */
    const report = await migrate({
      cwd: root,
      source: 'marketplace',
      destination: 'remote-output',
      plugin: 'remote-tools',
    });

    expect(report).toMatchObject({ success: true, projects: ['.'] });
    expect(report.items).toContainEqual(expect.objectContaining({
      kind: 'metadata',
      id: 'remote-tools',
      fields: expect.arrayContaining([
        expect.objectContaining({ field: 'name', source: '.claude-plugin/marketplace.json', outcome: 'mapped' }),
      ]),
    }));
    expect(report.items).toContainEqual(expect.objectContaining({ kind: 'mcp', id: 'docs', outcome: 'migrated' }));
    await fs.access(path.join(root, 'remote-output/src/mcp/docs/mcp.ts'));
  });

  it('rejects marketplace sources that resolve outside the source tree', async () => {
    /** Marketplace 路径逃逸测试使用的工作目录。 */
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-migration-test-'));
    roots.push(root);
    /** 声明越界 Plugin source 的 Marketplace 根。 */
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
    /** MCP 凭据脱敏测试使用的工作目录。 */
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-migration-test-'));
    roots.push(root);
    /** 动态创建且含明文凭据的旧 Claude 工程。 */
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

    /** 无法安全自动迁移 MCP 后的报告。 */
    const report = await migrate({
      cwd: root, source: 'legacy-project', destination: 'migrated',
      name: 'safe-plugin', description: 'Safe migration.',
    });
    expect(report.success, JSON.stringify(report.diagnostics)).toBe(true);
    /** 未映射 MCP Sidecar 中应完成脱敏的文本。 */
    const output = await fs.readFile(path.join(root, 'migrated/.acplugin-migration/unmapped/mcp/secret.json'), 'utf8');

    expect(report.items).toContainEqual(expect.objectContaining({ kind: 'mcp', id: 'secret', outcome: 'unmapped' }));
    expect(output).not.toContain('top-secret');
    expect(output).not.toContain('password');
    expect(output).toContain('<redacted>');
  });

  it('preserves Hook implementation files without treating them as trusted canonical handlers', async () => {
    /** Hook 引用文件保留测试使用的工作目录。 */
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-migration-test-'));
    roots.push(root);
    /** 动态创建且引用本地脚本的旧 Claude 工程。 */
    const source = path.join(root, 'legacy-project');
    await fs.mkdir(path.join(source, '.claude'), { recursive: true });
    await fs.mkdir(path.join(source, 'scripts'), { recursive: true });
    await fs.writeFile(path.join(source, '.claude/settings.json'), JSON.stringify({
      hooks: {
        PreToolUse: [{ hooks: [{ type: 'command', command: 'bash "${CLAUDE_PROJECT_DIR}/scripts/check.sh"' }] }],
      },
    }));
    await fs.writeFile(path.join(source, 'scripts/check.sh'), '#!/bin/sh\nexit 0\n');

    /** Hook 配置与实现均作为未映射内容保留的报告。 */
    const report = await migrate({
      cwd: root,
      source: 'legacy-project',
      destination: 'migrated',
      name: 'hook-project',
      description: 'Hook migration fixture.',
    });
    expect(report.success, JSON.stringify(report.diagnostics)).toBe(true);

    expect(report.items).toContainEqual(expect.objectContaining({
      kind: 'hook-file',
      outcome: 'unmapped',
      destination: '.acplugin-migration/unmapped/hook-files/scripts/check.sh',
    }));
    expect(await fs.readFile(path.join(root, 'migrated/.acplugin-migration/unmapped/hook-files/scripts/check.sh'), 'utf8')).toContain('exit 0');
    await expect(fs.access(path.join(root, 'migrated/src/hooks'))).rejects.toThrow();
  });

  it('does not create nested destination parents during dry-run', async () => {
    /** 嵌套 dry-run 目标测试使用的工作目录。 */
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-migration-test-'));
    roots.push(root);
    /** 固定旧工程 Fixture 的来源路径。 */
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

  it('preserves Command, Skill, Agent, metadata, and binary fields without overstating lossy resources', async () => {
    /** 字段级保真测试使用的临时工作目录。 */
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-migration-test-'));
    roots.push(root);
    /** 动态创建的完整旧 Claude Code Plugin。 */
    const source = path.join(root, 'legacy-plugin');
    await fs.mkdir(path.join(source, '.claude-plugin'), { recursive: true });
    await fs.mkdir(path.join(source, 'commands'), { recursive: true });
    await fs.mkdir(path.join(source, 'skills/review/assets'), { recursive: true });
    await fs.mkdir(path.join(source, 'agents'), { recursive: true });
    await fs.writeFile(path.join(source, '.claude-plugin/plugin.json'), JSON.stringify({
      name: 'release-tools',
      version: '2.3.4+build.1',
      description: 'Release workflow tools.',
      displayName: 'Release Tools',
      author: { name: 'TokenRoll', email: 'maintainers@example.com', url: 'https://example.com/team' },
      homepage: 'https://example.com/release-tools',
      repository: 'https://github.com/TokenRollAI/release-tools',
      license: 'MIT',
      keywords: ['release', 'review'],
    }));
    await fs.writeFile(path.join(source, 'commands/release.md'), `---
description: Prepare a release.
argument-hint: <version>
argumentHint: <legacy-version>
allowed-tools: Read, Grep
model: sonnet
---
Prepare release $ARGUMENTS.
`);
    await fs.writeFile(path.join(source, 'commands/status.md'), `---
description: Check release status.
argument-hint: <scope>
argumentHint: <scope>
---
Check status for $ARGUMENTS.
`);
    await fs.writeFile(path.join(source, 'skills/review/SKILL.md'), `---
description: Review a change.
user-invocable: false
disable-model-invocation: false
allowed-tools: Read, Grep
context: fork
agent: reviewer
---
Review the change.
`);
    /** 包含无效 UTF-8 和零字节的 Skill 辅助文件。 */
    const binary = Buffer.from([0, 255, 1, 128, 10]);
    await fs.writeFile(path.join(source, 'skills/review/assets/logo.bin'), binary);
    await fs.writeFile(path.join(source, 'agents/reviewer.md'), `---
description: Review code.
tools: Read, NotebookEdit, WebSearch, Bash
disallowedTools: Write
model: sonnet
effort: high
maxTurns: 8
skills:
  - review
memory: project
background: false
isolation: worktree
permissionMode: plan
---
Review code.
`);

    /** 完整 Plugin 迁移和字段级报告。 */
    const report = await migrate({ cwd: root, source: 'legacy-plugin', destination: 'migrated' });
    /** 迁移后顶层元数据配置源码。 */
    const config = await fs.readFile(path.join(root, 'migrated/acplugin.config.ts'), 'utf8');
    /** 迁移后规范 Command。 */
    const command = await fs.readFile(path.join(root, 'migrated/src/commands/release.md'), 'utf8');
    /** 迁移后规范 Agent。 */
    const agent = await fs.readFile(path.join(root, 'migrated/src/agents/reviewer.md'), 'utf8');
    /** 迁移后按字节复制的 Skill 辅助文件。 */
    const migratedBinary = await fs.readFile(path.join(root, 'migrated/src/skills/review/assets/logo.bin'));

    expect(report.success, JSON.stringify(report.diagnostics)).toBe(true);
    expect(config).toContain('version: "2.3.4+build.1"');
    expect(config).toContain('author: {"name":"TokenRoll","email":"maintainers@example.com","url":"https://example.com/team"}');
    expect(command).toContain('argumentHint: <version>');
    expect(command).toContain('allowedTools:');
    expect(command).toContain('Prepare release {{arguments}}.');
    expect(agent).toContain('capabilities:');
    expect(agent).toContain('filesystem:write');
    expect(agent).toContain('search');
    expect(agent).toContain('network');
    expect(agent).toContain('platforms:');
    expect(report.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'agent', id: 'reviewer', outcome: 'unmapped',
        fields: expect.arrayContaining([
          expect.objectContaining({ field: 'description', outcome: 'mapped', destination: 'src/agents/reviewer.md' }),
          expect.objectContaining({ field: 'permissionMode', outcome: 'unmapped' }),
        ]),
      }),
      expect.objectContaining({
        kind: 'command', id: 'release', outcome: 'degraded',
        fields: expect.arrayContaining([
          expect.objectContaining({ field: 'description', outcome: 'mapped' }),
          expect.objectContaining({ field: 'argument-hint', outcome: 'mapped' }),
          expect.objectContaining({ field: 'argumentHint', outcome: 'degraded' }),
        ]),
      }),
      expect.objectContaining({
        kind: 'command', id: 'status', outcome: 'migrated',
        fields: expect.arrayContaining([
          expect.objectContaining({ field: 'argument-hint', outcome: 'mapped' }),
          expect.objectContaining({ field: 'argumentHint', outcome: 'mapped' }),
        ]),
      }),
      expect.objectContaining({
        kind: 'skill', id: 'review', outcome: 'migrated',
        fields: expect.arrayContaining([
          expect.objectContaining({ field: 'user-invocable', outcome: 'mapped' }),
          expect.objectContaining({ field: 'disable-model-invocation', outcome: 'mapped' }),
        ]),
      }),
      expect.objectContaining({
        kind: 'metadata', id: 'release-tools', outcome: 'migrated',
        fields: expect.arrayContaining([
          expect.objectContaining({ field: 'version', outcome: 'mapped' }),
          expect.objectContaining({ field: 'author.email', outcome: 'mapped' }),
          expect.objectContaining({ field: 'license', outcome: 'mapped' }),
        ]),
      }),
    ]));
    expect(createHash('sha256').update(migratedBinary).digest('hex')).toBe(createHash('sha256').update(binary).digest('hex'));
    expect(await fs.readFile(path.join(root, 'migrated/.gitignore'), 'utf8')).toContain('.acplugin-migration/unmapped/');
  });

  it('validates every metadata source field before emitting canonical config', async () => {
    /** 非法、规范化和冗余元数据回归使用的临时工作目录。 */
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-migration-test-'));
    roots.push(root);
    /** 同时包含根元数据和 Marketplace interface 回退字段的旧 Plugin。 */
    const source = path.join(root, 'legacy-plugin');
    await fs.mkdir(path.join(source, '.claude-plugin'), { recursive: true });
    await fs.mkdir(path.join(source, 'skills/hello'), { recursive: true });
    await fs.writeFile(path.join(source, 'skills/hello/SKILL.md'), '---\ndescription: Hello.\n---\nHello.\n');
    await fs.writeFile(path.join(source, '.claude-plugin/plugin.json'), JSON.stringify({
      name: 'metadata-fixture',
      version: '1.0.0+build.1',
      description: 'Primary description.',
      displayName: ' Metadata Fixture ',
      author: { name: ' TokenRoll ', email: 'not-an-email', url: 'not-a-url' },
      homepage: 'not-a-url',
      repository: 'git@example.com:owner/repository.git',
      license: 'NOT A VALID SPDX EXPRESSION',
      keywords: ['release', ' release '],
      interface: {
        displayName: 'Fallback Display',
        shortDescription: 'Fallback short description.',
        longDescription: 'Fallback long description.',
        developerName: 'Fallback Developer',
        websiteURL: 'https://example.com/fallback',
      },
    }));

    /** 非严格模式仍生成只包含合法字段的工程，并把所有损失留在报告。 */
    const report = await migrate({ cwd: root, source: 'legacy-plugin', destination: 'migrated' });
    /** 经过逐字段过滤和规范化的最终配置源码。 */
    const config = await fs.readFile(path.join(root, 'migrated/acplugin.config.ts'), 'utf8');
    /** 元数据资源的字段最差结果。 */
    const metadata = report.items.find(item => item.kind === 'metadata');

    expect(report.success, JSON.stringify(report.diagnostics)).toBe(true);
    expect(report.diagnostics).not.toContainEqual(expect.objectContaining({ code: 'MIGRATION_PROJECT_VALIDATION_FAILED' }));
    expect(config).toContain('version: "1.0.0+build.1"');
    expect(config).toContain('displayName: "Metadata Fixture"');
    expect(config).toContain('author: {"name":"TokenRoll"}');
    expect(config).toContain('homepage: "https://example.com/fallback"');
    expect(config).toContain('keywords: ["release"]');
    expect(config).not.toContain('repository:');
    expect(config).not.toContain('license:');
    expect(metadata).toMatchObject({ kind: 'metadata', outcome: 'unmapped' });
    expect(metadata?.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'version', outcome: 'mapped' }),
      expect.objectContaining({ field: 'displayName', outcome: 'degraded' }),
      expect.objectContaining({ field: 'interface.displayName', outcome: 'unmapped' }),
      expect.objectContaining({ field: 'interface.shortDescription', outcome: 'unmapped' }),
      expect.objectContaining({ field: 'interface.longDescription', outcome: 'unmapped' }),
      expect.objectContaining({ field: 'author.name', outcome: 'degraded' }),
      expect.objectContaining({ field: 'author.email', outcome: 'unmapped' }),
      expect.objectContaining({ field: 'author.url', outcome: 'unmapped' }),
      expect.objectContaining({ field: 'interface.developerName', outcome: 'unmapped' }),
      expect.objectContaining({ field: 'homepage', outcome: 'unmapped' }),
      expect.objectContaining({ field: 'interface.websiteURL', outcome: 'degraded' }),
      expect.objectContaining({ field: 'repository', outcome: 'unmapped' }),
      expect.objectContaining({ field: 'license', outcome: 'unmapped' }),
      expect.objectContaining({ field: 'keywords', outcome: 'degraded' }),
    ]));
  });

  it('migrates only safe remote HTTPS MCP declarations with the official Extension package', async () => {
    /** 安全远程 MCP 测试使用的临时工作目录。 */
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-migration-test-'));
    roots.push(root);
    /** 只包含安全远程 MCP 的旧工程。 */
    const source = path.join(root, 'legacy-project');
    await fs.mkdir(path.join(source, '.claude'), { recursive: true });
    await fs.writeFile(path.join(source, '.mcp.json'), JSON.stringify({
      mcpServers: {
        docs: {
          type: 'http',
          url: 'https://mcp.example.com/mcp',
          headers: {
            'Authorization': 'Bearer ${DOCS_TOKEN}',
            'X-Tenant': '${TENANT_ID}',
          },
        },
      },
    }));

    /** 自动迁移远程声明后的规范工程报告。 */
    const report = await migrate({
      cwd: root,
      source: 'legacy-project',
      destination: 'migrated',
      name: 'remote-mcp',
      description: 'Remote MCP migration.',
    });
    /** 生成的类型化 MCP 描述源码。 */
    const descriptor = await fs.readFile(path.join(root, 'migrated/src/mcp/docs/mcp.ts'), 'utf8');
    /** 新工程依赖映射。 */
    const manifest = JSON.parse(await fs.readFile(path.join(root, 'migrated/package.json'), 'utf8')) as {
      readonly devDependencies: Record<string, string>;
    };

    expect(report.success, JSON.stringify(report.diagnostics)).toBe(true);
    expect(report.items).toContainEqual(expect.objectContaining({
      kind: 'mcp',
      id: 'docs',
      outcome: 'migrated',
      fields: expect.arrayContaining([
        expect.objectContaining({ field: 'url', source: '.mcp.json', destination: 'src/mcp/docs/mcp.ts', outcome: 'mapped' }),
        expect.objectContaining({ field: 'headers.Authorization', outcome: 'mapped' }),
        expect.objectContaining({ field: 'headers.X-Tenant', outcome: 'mapped' }),
      ]),
    }));
    expect(descriptor).toContain('from \'@tokenroll/acplugin-extension-mcp\'');
    expect(descriptor).toContain('"env":"DOCS_TOKEN"');
    expect(descriptor).toContain('"env": "TENANT_ID"');
    expect(manifest.devDependencies['@tokenroll/acplugin-extension-mcp']).toBe('^1.0.0');
    await expect(fs.access(path.join(root, 'migrated/node_modules'))).rejects.toThrow();
  });
});
