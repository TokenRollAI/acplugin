import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createProject, executeNode, runProject } from './fixture.js';

describe('MCP Extension build and contributors', () => {
  it('builds remote and local Servers once without reading or leaking Secret values', async () => {
    /** 同时覆盖 HTTP、stdio、环境引用和第三方许可的工程。 */
    const root = await createProject();
    /** 用可检测的 Secret 值证明构建阶段只保留变量名称。 */
    const secret = 'MUST_NOT_APPEAR_IN_BUILD_OUTPUT_9f6a';
    /** 完整提交双 Platform 交付单元的构建结果。 */
    const result = await runProject(
      { cwd: root, command: 'build', mode: 'production' },
      { DOCS_TOKEN: secret, DOCS_TENANT: secret, LOCAL_TOKEN: secret },
    );
    expect(result.success).toBe(true);

    /** Claude Code wrapped MCP 清单。 */
    const claude = JSON.parse(await fs.readFile(
      path.join(root, 'dist/claude-code/plugin/.mcp.json'),
      'utf8',
    )) as Record<string, unknown>;
    /** Codex direct MCP 清单。 */
    const codex = JSON.parse(await fs.readFile(
      path.join(root, 'dist/codex/plugin/.mcp.json'),
      'utf8',
    )) as Record<string, unknown>;
    expect(claude).toHaveProperty('mcpServers.docs.headers.Authorization', 'Bearer ${DOCS_TOKEN}');
    expect(claude).toHaveProperty('mcpServers.local-tools.args.0', '${CLAUDE_PLUGIN_ROOT}/mcp/local-tools/server.mjs');
    expect(codex).toMatchObject({
      'docs': {
        url: 'https://mcp.example.com/mcp',
        bearer_token_env_var: 'DOCS_TOKEN',
        env_http_headers: { 'X-Tenant': 'DOCS_TENANT' },
        http_headers: { 'X-Client': 'acplugin-test' },
      },
      'local-tools': {
        command: 'node',
        args: ['./mcp/local-tools/server.mjs'],
        cwd: '.',
        env: { LOG_LEVEL: 'warn' },
        env_vars: ['LOCAL_TOKEN'],
      },
    });
    expect(JSON.stringify({ result, claude, codex })).not.toContain(secret);

    /** 两个平台复用同一平台中立 Server Bundle。 */
    const claudeServer = path.join(root, 'dist/claude-code/plugin/mcp/local-tools/server.mjs');
    /** Codex 安装包中的同一 Server Bundle。 */
    const codexServer = path.join(root, 'dist/codex/plugin/mcp/local-tools/server.mjs');
    expect(await fs.readFile(claudeServer)).toEqual(await fs.readFile(codexServer));
    expect((await fs.stat(codexServer)).mode & 0o111).not.toBe(0);
    expect(await fs.readFile(
      path.join(root, 'dist/codex/plugin/mcp/local-tools/THIRD_PARTY_LICENSES.txt'),
      'utf8',
    )).toContain('mcp-fixture-dependency@4.5.6');

    /** 使用真实 initialize/list-tools JSON-RPC 流验证安装产物可执行。 */
    const protocolInput = [
      JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } },
      }),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      '',
    ].join('\n');
    /** 本地 Bundle 的实际协议响应。 */
    const execution = await executeNode([codexServer], protocolInput);
    expect(execution).toMatchObject({ code: 0, stderr: '' });
    expect(execution.stdout.trim().split('\n').map(line => JSON.parse(line))).toEqual([
      expect.objectContaining({ id: 1, result: expect.objectContaining({ serverInfo: { name: 'fixture', version: '1.0.0' } }) }),
      { jsonrpc: '2.0', id: 2, result: { tools: [] } },
    ]);
  });
});
