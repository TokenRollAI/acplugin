import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createProject, runProject } from './fixture.js';

describe('MCP Extension protocol', () => {
  it('accepts a complete server implemented with the official MCP SDK', async () => {
    /** SDK Server 提供真实 initialize 协商和 tools/list handler。 */
    const root = await createProject({
      remote: false,
      serverSource: `
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
const server = new Server({ name: 'sdk-fixture', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
await server.connect(new StdioServerTransport());
`,
    });
    /** 真实 SDK 响应必须通过同一 Core Execution Host smoke。 */
    const result = await runProject({ cwd: root, command: 'build', mode: 'production' });
    expect(result.success, JSON.stringify(result)).toBe(true);
    expect(result.diagnostics).not.toContainEqual(expect.objectContaining({ code: 'MCP_STDIO_SMOKE_FAILED' }));
  });

  it('rejects protocol-shaped output that is not a valid MCP handshake', async () => {
    /** 所有 case 都会正常退出并打印 JSON，差异只在 JSON-RPC/MCP shape。 */
    const validInitialize = { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'fixture', version: '1.0.0' } } };
    /** 标准空 tool list 响应。 */
    const validTools = { jsonrpc: '2.0', id: 2, result: { tools: [] } };
    /** 旧实现会误接受的响应及各类 envelope/result 反例。 */
    const cases: readonly (readonly unknown[])[] = [
      [{ id: 1, result: {} }, { id: 2, result: {} }],
      [validInitialize, validInitialize, validTools],
      [{ jsonrpc: '2.0', id: 1, error: { code: -32_000, message: 'failed' } }, validTools],
      [{ ...validInitialize, jsonrpc: '1.0' }, validTools],
      [{ jsonrpc: '2.0', id: 1, result: 'initialized' }, validTools],
      [validInitialize, { jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'broken' }] } }],
    ];
    for (const messages of cases) {
      /** Fixture 不解析输入，只伪造旧 validator 所需的两行 JSON。 */
      const stdout = `${messages.map(message => JSON.stringify(message)).join('\n')}\n`;
      /** 每个反例独立编译和执行，证明失败发生在真实 Extension build path。 */
      const root = await createProject({ remote: false, serverSource: `process.stdout.write(${JSON.stringify(stdout)});\n` });
      /** 伪 handshake 不得形成可提交 Platform candidate。 */
      const result = await runProject({ cwd: root, command: 'build', mode: 'production' });
      expect(result.success).toBe(false);
      expect(result.committed).toBe(false);
      expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'MCP_STDIO_SMOKE_FAILED', phase: 'compile' }));
    }
  });

  it('rejects local bundles that fail the MCP protocol smoke in both build modes', async () => {
    /** mode 表示当前必须执行真实 initialize/tools-list 探测的构建模式。 */
    for (const mode of ['development', 'production'] as const) {
      /** 立即退出且不响应 initialize 的无效本地实现。 */
      const root = await createProject({
        remote: false,
        serverSource: 'process.exit(0);\n',
      });
      /** 两种模式都必须在提交任何 Platform 产物前执行真实协议探测。 */
      const result = await runProject({ cwd: root, command: 'build', mode });
      expect(result.success).toBe(false);
      expect(result.committed).toBe(false);
      expect(result.diagnostics).toContainEqual(expect.objectContaining({
        code: 'MCP_STDIO_SMOKE_FAILED',
        phase: 'compile',
      }));
      await expect(fs.access(path.join(root, 'dist'))).rejects.toThrow();
    }
  });

  it('rejects unresolved runtime dynamic imports in local MCP bundles', async () => {
    /** Rolldown 无法静态解析且会原样保留到运行时的动态 import。 */
    const root = await createProject({
      remote: false,
      serverSource: 'await import(process.argv[2]);\n',
    });
    /** 不完整模块图由 Extension build 阶段拒绝。 */
    const result = await runProject({ cwd: root, command: 'build', mode: 'production' });
    expect(result.success).toBe(false);
    expect(result.committed).toBe(false);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: 'BUILD_UNRESOLVED_IMPORT',
      phase: 'compile',
    }));
  });
});
