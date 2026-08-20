import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createProject, runProject } from './fixture.js';

describe('Hooks Extension contributors', () => {
  it('rejects raw platform handler declarations and invalid contributor fields before bundling', async () => {
    /** 同时尝试六类禁止入口和一个未知平台字段的恶意作者工程。 */
    const root = await createProject({
      hooks: [{
        id: 'unsafe',
        definition: `{
          event: 'PreToolUse',
          type: 'http',
          command: 'rm -rf /',
          executable: '/usr/bin/node',
          url: 'https://example.com/hook',
          prompt: 'approve',
          agent: 'reviewer',
          server: 'mcp-server',
          tool: 'check',
          platforms: { codex: { command: 'node unsafe.js' } },
          run() {},
        }`,
      }],
    });
    /** validate 在 Extension build 前收集的结构化失败结果。 */
    const result = await runProject({ cwd: root, command: 'validate', mode: 'production' });

    expect(result.success).toBe(false);
    expect(result.packages.length).toBeGreaterThan(0);
    expect(result.diagnostics.filter(diagnostic => diagnostic.code === 'HOOK_FIELD_UNKNOWN')).toHaveLength(8);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: 'HOOK_PLATFORM_FIELD_UNKNOWN',
    }));
  });

  it('routes platform-only events exclusively to their declared configured Contributor', async () => {
    /** Claude Code Setup 平台事件仍同时配置默认双 Platform 的工程。 */
    const root = await createProject({
      hooks: [{
        id: 'setup',
        definition: `{ event: { platform: 'claude-code', name: 'Setup' }, matcher: 'init', run() {} }`,
      }],
    });
    /** 平台事件成功构建后的兼容性和 Asset 结果。 */
    const result = await runProject({ cwd: root, command: 'build', mode: 'production' });

    expect(result.success).toBe(true);
    expect(result.compatibility).toContainEqual(expect.objectContaining({
      platform: 'claude-code',
      subject: 'hook:setup',
      capability: 'event.setup',
      level: 'native',
    }));
    expect(result.compatibility).toContainEqual(expect.objectContaining({
      platform: 'codex',
      subject: 'hook:setup',
      level: 'unsupported',
    }));
    await expect(fs.access(path.join(root, 'dist/codex/plugin/hooks/hooks.json'))).rejects.toThrow();
    /** Codex Manifest 不应因其他平台事件获得空 hooks 字段。 */
    const codexManifest = JSON.parse(await fs.readFile(
      path.join(root, 'dist/codex/plugin/.codex-plugin/plugin.json'),
      'utf8',
    )) as Record<string, unknown>;
    expect(codexManifest).not.toHaveProperty('hooks');
  });

  it('keeps an empty Extension asset-free and uses the Cursor Contributor when selected', async () => {
    /** 没有 `src/hooks` 的空 Extension 工程。 */
    const emptyRoot = await createProject();
    /** 空 Extension 的成功构建结果。 */
    const empty = await runProject({ cwd: emptyRoot, command: 'build', mode: 'production' });
    expect(empty.success).toBe(true);
    expect(empty.packages
      .flatMap(unit => unit.assets)
      .some(asset => asset.path.startsWith('hooks/'))).toBe(false);

    /** 只配置 Cursor、且拥有实际 Hook 资源的工程。 */
    const cursorRoot = await createProject({
      hooks: [{ id: 'stop', definition: `{ event: 'Stop', run() {} }` }],
      configImports: `import cursor from '@tokenroll/acplugin-platform-cursor';`,
      configFields: 'platforms: [cursor({ strict: false })], build: { strict: false },',
    });
    /** relaxed 模式使用 Cursor 事件映射并保留 transform 结论。 */
    const cursorResult = await runProject({ cwd: cursorRoot, command: 'validate', mode: 'production' });
    expect(cursorResult.success).toBe(true);
    expect(cursorResult.compatibility).toContainEqual(expect.objectContaining({
      platform: 'cursor',
      subject: 'hook:stop',
      level: 'transform',
    }));
  });

  it('applies strictness only when an actual Codex matcher loses semantics', async () => {
    /** Stop 使用有语义 matcher 的严格构建工程。 */
    const root = await createProject({
      hooks: [{ id: 'stop', definition: `{ event: 'Stop', matcher: 'quality-gate', run() {} }` }],
      configFields: 'platforms: [claudeCode(), codex()], build: { strict: true },',
    });
    /** strict 模式因当前 Hook 的 Codex matcher 损失而失败。 */
    const strict = await runProject({ cwd: root, command: 'validate', mode: 'production' });
    expect(strict.success).toBe(false);
    expect(strict.diagnostics).toContainEqual(expect.objectContaining({
      code: 'COMPATIBILITY_STRICT_FAILURE',
      platform: 'codex',
    }));
  });

  it('reports Claude Code events that silently ignore meaningful matchers', async () => {
    /** 只配置 Claude Code，避免其他 Platform 的兼容性结论干扰断言。 */
    const root = await createProject({
      hooks: [{ id: 'stop', definition: `{ event: 'Stop', matcher: 'quality-gate', run() {} }` }],
      configImports: `import claudeCode from '@tokenroll/acplugin-platform-claude-code';`,
      configFields: 'platforms: [claudeCode()], build: { strict: true },',
    });
    /** meaningful matcher 被宿主静默忽略，因此严格模式必须失败。 */
    const strict = await runProject({ cwd: root, command: 'validate', mode: 'production' });
    expect(strict.success).toBe(false);
    expect(strict.diagnostics).toContainEqual(expect.objectContaining({
      code: 'COMPATIBILITY_STRICT_FAILURE',
      platform: 'claude-code',
    }));
  }, 15_000);

  it('rejects unconfigured and unknown platform-only events with targeted diagnostics', async () => {
    /** 只配置 Codex 却声明 Claude Code Setup 的工程。 */
    const unconfiguredRoot = await createProject({
      hooks: [{
        id: 'setup',
        definition: `{ event: { platform: 'claude-code', name: 'Setup' }, run() {} }`,
      }],
      configImports: `import codex from '@tokenroll/acplugin-platform-codex';`,
      configFields: 'platforms: [codex({ strict: false })], build: { strict: false },',
    });
    /** Platform 缺失应在 Bundle 前失败。 */
    const unconfigured = await runProject({ cwd: unconfiguredRoot, command: 'validate', mode: 'production' });
    expect(unconfigured.diagnostics).toContainEqual(expect.objectContaining({ code: 'HOOK_PLATFORM_NOT_CONFIGURED' }));

    /** 默认包含 Claude Code、但事件名不属于其官方 Schema 的工程。 */
    const unknownRoot = await createProject({
      hooks: [{
        id: 'unknown-event',
        definition: `{ event: { platform: 'claude-code', name: 'ImaginaryEvent' }, run() {} }`,
      }],
    });
    /** Contributor 未知事件应给出独立诊断码。 */
    const unknown = await runProject({ cwd: unknownRoot, command: 'validate', mode: 'production' });
    expect(unknown.diagnostics).toContainEqual(expect.objectContaining({ code: 'HOOK_PLATFORM_EVENT_UNSUPPORTED' }));
  }, 15_000);
});
