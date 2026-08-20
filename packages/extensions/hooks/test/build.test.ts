import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HOOK_EVENTS } from '../src/index.js';
import { canonicalHooks, createProject, runHandler, runProject } from './fixture.js';

describe('Hooks Extension build', () => {
  it('builds all canonical events once and adapts them to Claude Code and Codex', async () => {
    /** 覆盖完整事件矩阵和本地第三方依赖的真实工程。 */
    const root = await createProject({ hooks: canonicalHooks(), dependency: true });
    /** 完整提交双 Platform 产物的构建结果。 */
    const result = await runProject({ cwd: root, command: 'build', mode: 'production' });

    expect(result.success).toBe(true);
    /** event 表示当前规范事件，用于验证两个 Contributor 都报告原生触发能力。 */
    for (const event of HOOK_EVENTS) {
      expect(result.compatibility).toContainEqual(expect.objectContaining({
        platform: 'claude-code',
        capability: `event.${event.replace(/([a-z0-9])([A-Z])/gu, '$1-$2').toLowerCase()}`,
        level: 'native',
      }));
      expect(result.compatibility).toContainEqual(expect.objectContaining({
        platform: 'codex',
        capability: `event.${event.replace(/([a-z0-9])([A-Z])/gu, '$1-$2').toLowerCase()}`,
        level: 'native',
      }));
    }
    expect(result.compatibility).toContainEqual(expect.objectContaining({
      platform: 'codex',
      subject: 'hook:stop',
      capability: 'matcher',
      level: 'degraded',
    }));

    /** Claude Code 最终 Plugin Manifest。 */
    const claudeManifest = JSON.parse(await fs.readFile(
      path.join(root, 'dist/claude-code/plugin/.claude-plugin/plugin.json'),
      'utf8',
    )) as Record<string, unknown>;
    /** Codex 最终 Plugin Manifest。 */
    const codexManifest = JSON.parse(await fs.readFile(
      path.join(root, 'dist/codex/plugin/.codex-plugin/plugin.json'),
      'utf8',
    )) as Record<string, unknown>;
    expect(claudeManifest.hooks).toBe('./hooks/hooks.json');
    expect(codexManifest.hooks).toBe('./hooks/hooks.json');

    /** Claude Code Contributor 生成的 Hook 配置。 */
    const claudeHooks = JSON.parse(await fs.readFile(
      path.join(root, 'dist/claude-code/plugin/hooks/hooks.json'),
      'utf8',
    )) as { hooks: Record<string, { hooks: Record<string, unknown>[] }[]> };
    /** Codex Contributor 生成的 Hook 配置。 */
    const codexHooks = JSON.parse(await fs.readFile(
      path.join(root, 'dist/codex/plugin/hooks/hooks.json'),
      'utf8',
    )) as { hooks: Record<string, { hooks: Record<string, unknown>[] }[]> };
    expect(Object.keys(claudeHooks.hooks).sort()).toEqual([...HOOK_EVENTS].sort());
    expect(Object.keys(codexHooks.hooks).sort()).toEqual([...HOOK_EVENTS].sort());
    expect(claudeHooks.hooks.PreToolUse![0]!.hooks[0]).toMatchObject({
      type: 'command',
      command: 'node',
      args: ['${CLAUDE_PLUGIN_ROOT}/hooks/pre-tool-use/handler.mjs', 'claude-code'],
      timeout: 5,
    });
    expect(codexHooks.hooks.PreToolUse![0]!.hooks[0]).toMatchObject({
      type: 'command',
      command: 'node "${PLUGIN_ROOT}/hooks/pre-tool-use/handler.mjs" codex',
      timeout: 5,
      additionalContextLimit: 1200,
    });
    expect(codexHooks.hooks.PreToolUse![0]!.hooks[0]).not.toHaveProperty('args');

    /** 两个平台复用同一平台中立 Handler 的 Claude Code 文件。 */
    const claudeHandler = path.join(root, 'dist/claude-code/plugin/hooks/pre-tool-use/handler.mjs');
    /** 两个平台复用同一平台中立 Handler 的 Codex 文件。 */
    const codexHandler = path.join(root, 'dist/codex/plugin/hooks/pre-tool-use/handler.mjs');
    expect(await fs.readFile(claudeHandler)).toEqual(await fs.readFile(codexHandler));
    await expect(fs.access(path.join(root, 'dist/claude-code/plugin/hooks/pre-tool-use/wire.mjs'))).rejects.toThrow();
    expect((await fs.readFile(claudeHandler, 'utf8'))).not.toContain('./wire.mjs');
    expect(await fs.readFile(
      path.join(root, 'dist/claude-code/plugin/hooks/pre-tool-use/THIRD_PARTY_LICENSES.txt'),
      'utf8',
    )).toContain('fixture-dependency@2.3.4');
  });

  it('keeps Handler bytes and report hashes stable across isolated work directories', async () => {
    /** 单个 Hook 足以暴露随机 Extension workDir 曾进入 Rolldown region 注释的问题。 */
    const root = await createProject({
      hooks: [{ id: 'session-start', definition: `{ event: 'SessionStart', run() {} }` }],
    });
    /** 第一次完整构建的稳定报告。 */
    const first = await runProject({ cwd: root, command: 'build', mode: 'production' });
    /** 第一次事务提交后的 Handler 原始字节。 */
    const firstHandler = await fs.readFile(path.join(root, 'dist/claude-code/plugin/hooks/session-start/handler.mjs'));
    /** 相同输入下由新 workDir 完成的第二次构建报告。 */
    const second = await runProject({ cwd: root, command: 'build', mode: 'production' });
    /** 第二次事务提交后的 Handler 原始字节。 */
    const secondHandler = await fs.readFile(path.join(root, 'dist/claude-code/plugin/hooks/session-start/handler.mjs'));

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(secondHandler).toEqual(firstHandler);
    expect(secondHandler.toString('utf8')).not.toMatch(/^\/\/#(?:end)?region/mu);
    expect(secondHandler.toString('utf8')).not.toContain(root);
    expect(secondHandler.toString('utf8')).not.toContain('src/hooks/session-start/hook.ts');
    expect(second.packages).toEqual(first.packages);
    /** 删除 Canonical 源码后，自包含安装产物仍必须可独立执行。 */
    await fs.rm(path.join(root, 'src/hooks'), { recursive: true });
    /** 删除源码后执行已安装 Handler 的进程结果。 */
    const execution = await runHandler(
      path.join(root, 'dist/claude-code/plugin/hooks/session-start/handler.mjs'),
      'claude-code',
      JSON.stringify({ session_id: 'session-1', cwd: root, hook_event_name: 'SessionStart', source: 'startup' }),
      { CLAUDE_PLUGIN_ROOT: '/plugin-root', CLAUDE_PLUGIN_DATA: '/plugin-data' },
    );
    expect(execution).toEqual({ code: 0, stdout: '', stderr: '' });
  });
});
