import { describe, expect, it } from 'vitest';
import { createProject, runProject } from './fixture.js';

describe('MCP Extension discovery validation', () => {
  it('enforces production URL, value-source, entry, and include safety', async () => {
    /** 使用 HTTP、非法认证和值来源的远程定义。 */
    const remoteRoot = await createProject({
      local: false,
      remote: `{
        transport: 'http',
        url: 'http://example.com/mcp',
        auth: { type: 'bearer', env: 'INVALID-NAME' },
        headers: { 'X-Secret': { value: 'public', env: 'PRIVATE_TOKEN' } },
      } as never`,
      mcpOptions: `{ include: ['docs'] }`,
    });
    /** 远程安全策略产生的结构化失败结果。 */
    const remote = await runProject({ cwd: remoteRoot, command: 'validate', mode: 'production' });
    expect(remote.success).toBe(false);
    expect(remote.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'MCP_HTTPS_REQUIRED' }),
      expect.objectContaining({ code: 'MCP_BEARER_INVALID' }),
      expect.objectContaining({ code: 'MCP_VALUE_SOURCE_INVALID' }),
    ]));
    /** 单独工程验证 include 指向不存在资源时的诊断。 */
    const includeRoot = await createProject({ local: false, mcpOptions: `{ include: ['missing'] }` });
    /** 执行 include fixture 并读取稳定诊断。 */
    const include = await runProject({ cwd: includeRoot, command: 'validate', mode: 'production' });
    expect(include.diagnostics).toContainEqual(expect.objectContaining({ code: 'MCP_INCLUDE_MISSING' }));

    /** 使用目录逃逸入口的本地定义。 */
    const localRoot = await createProject({
      remote: false,
      local: `{ transport: 'stdio', entry: '../outside.ts' }`,
    });
    /** 入口边界验证必须在 Bundle 之前失败。 */
    const local = await runProject({ cwd: localRoot, command: 'validate', mode: 'production' });
    expect(local.success).toBe(false);
    expect(local.diagnostics).toContainEqual(expect.objectContaining({ code: 'MCP_ENTRY_ESCAPE' }));
  });

  it('enforces exact transport, auth, URL, and stdio entry variants', async () => {
    /** HTTP 不能携带 stdio 字段，none auth 不能携带 bearer 字段。 */
    const httpRoot = await createProject({
      local: false,
      remote: `{ transport: 'http', url: 'https://mcp.example.com/mcp', entry: 'server.ts', env: {}, auth: { type: 'none', env: 'TOKEN' } } as never`,
    });
    /** 跨判别分支字段必须在 Extension validate 阶段失败。 */
    const http = await runProject({ cwd: httpRoot, command: 'validate', mode: 'production' });
    expect(http.success).toBe(false);
    expect(http.diagnostics.filter(diagnostic => diagnostic.code === 'MCP_FIELD_UNKNOWN').length).toBeGreaterThanOrEqual(3);

    /** bearer 与 oauth 认证分支各自拒绝另一分支的字段。 */
    for (const auth of [
      `{ type: 'bearer', env: 'TOKEN', scopes: ['docs:read'] }`,
      `{ type: 'oauth', scopes: ['docs:read'], env: 'TOKEN' }`,
    ]) {
      /** 当前认证分支交叉字段的独立 HTTP fixture。 */
      const authRoot = await createProject({
        local: false,
        remote: `{ transport: 'http', url: 'https://mcp.example.com/mcp', auth: ${auth} } as never`,
      });
      /** exact discriminated union 必须在领域 validate 阶段拒绝交叉字段。 */
      const authResult = await runProject({ cwd: authRoot, command: 'validate', mode: 'production' });
      expect(authResult.success).toBe(false);
      expect(authResult.diagnostics).toContainEqual(expect.objectContaining({ code: 'MCP_FIELD_UNKNOWN' }));
    }

    /** stdio 不能携带 HTTP 字段或任何 HTTP auth。 */
    const stdioRoot = await createProject({
      remote: false,
      local: `{ transport: 'stdio', entry: 'server.ts', url: 'https://mcp.example.com', headers: {}, auth: { type: 'bearer', env: 'TOKEN' } } as never`,
    });
    /** 顶层 transport exact union 不依赖 TypeScript 静态检查。 */
    const stdio = await runProject({ cwd: stdioRoot, command: 'validate', mode: 'production' });
    expect(stdio.success).toBe(false);
    expect(stdio.diagnostics.filter(diagnostic => diagnostic.code === 'MCP_FIELD_UNKNOWN').length).toBeGreaterThanOrEqual(3);

    /** development 也只允许 HTTPS 或 loopback HTTP，不能放行其他 scheme。 */
    const schemeRoot = await createProject({ local: false, remote: `{ transport: 'http', url: 'ftp://localhost/mcp' }` });
    /** 非 HTTP(S) scheme 必须产生稳定 URL 失败。 */
    const scheme = await runProject({ cwd: schemeRoot, command: 'validate', mode: 'development' });
    expect(scheme.diagnostics).toContainEqual(expect.objectContaining({ code: 'MCP_URL_INVALID' }));

    /** 文档化的 canonical entry 和 development loopback URL 都合法。 */
    const validRoot = await createProject({ remote: `{ transport: 'http', url: 'http://127.0.0.1:3000/mcp' }`, local: `{ transport: 'stdio', entry: 'server.ts' }` });
    /** validate 不执行 stdio smoke，但应完整通过作者 schema。 */
    const valid = await runProject({ cwd: validRoot, command: 'validate', mode: 'development' });
    expect(valid.success).toBe(true);

    /** dot、空 segment、反斜线和父目录 spelling 都不能被静默 normalize。 */
    for (const entry of ['./server.ts', '.', 'nested//server.ts', 'nested\\server.ts', '../server.ts', '/server.ts']) {
      /** 每个非法 spelling 使用独立工程，避免诊断相互掩盖。 */
      const root = await createProject({ remote: false, local: `{ transport: 'stdio', entry: ${JSON.stringify(entry)} }` });
      /** 路径语法错误必须与真实缺失文件区分。 */
      const result = await runProject({ cwd: root, command: 'validate', mode: 'production' });
      expect(result.success).toBe(false);
      expect(result.diagnostics).toContainEqual(expect.objectContaining({
        code: entry.startsWith('/') || entry.includes('../') ? 'MCP_ENTRY_ESCAPE' : 'MCP_ENTRY_INVALID',
      }));
      expect(result.diagnostics).not.toContainEqual(expect.objectContaining({ code: 'MCP_ENTRY_MISSING' }));
    }
  });
});
