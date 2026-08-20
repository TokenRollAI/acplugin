import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import mcp, { EXTENSION_NAME } from '../src/index.js';
import { compareCodeUnits } from '../src/sorting.js';
import { createProject, runProject } from './fixture.js';

describe('MCP Extension authoring and discovery', () => {
  it('exposes plain descriptor types, filters resources, and rejects invalid options', async () => {
    /** 公开工厂创建的默认 MCP Extension。 */
    const extension = mcp();
    expect(EXTENSION_NAME).toBe('@tokenroll/acplugin-extension-mcp');
    expect(extension.id).toBe('mcp');
    expect(extension.resourceRoots).toEqual(['mcp']);
    expect(Object.isFrozen(extension)).toBe(true);
    expect(() => mcp({ include: ['docs', 'docs'] })).toThrow('duplicate ID');
    expect(() => mcp({ include: ['Not-Kebab'] })).toThrow('lowercase kebab-case');
    expect(() => mcp({ include: ['mcp-é'] })).toThrow('lowercase kebab-case');
    expect(() => mcp({ unknown: true } as never)).toThrow('Unknown MCP option');

    /** include 只选择远程 Server 的真实工程。 */
    const root = await createProject({ mcpOptions: `{ include: ['docs'] }` });
    /** 筛选后的双 Platform 构建结果。 */
    const result = await runProject({ cwd: root, command: 'build', mode: 'production' });
    expect(result.success).toBe(true);
    await expect(fs.access(path.join(root, 'dist/codex/plugin/mcp/local-tools/server.mjs'))).rejects.toThrow();
    expect(JSON.parse(await fs.readFile(path.join(root, 'dist/codex/plugin/.mcp.json'), 'utf8')))
      .toHaveProperty('docs.url', 'https://mcp.example.com/mcp');
  });

  it('uses locale-independent code-unit ordering for deterministic internal maps', () => {
    /** 非 ASCII 样本证明排序不委托给宿主 locale 或 ICU。 */
    const values = ['é', 'z', 'ä', 'a'];
    expect(values.sort(compareCodeUnits)).toEqual(['a', 'z', 'ä', 'é']);
  });

  it('rejects non-enumerable descriptor accessors without evaluating them', async () => {
    /** 不可枚举 getter 不能绕过 plain descriptor 的无行为数据边界。 */
    const root = await createProject({
      local: false,
      remote: `(() => {
        const value = { transport: 'http', url: 'https://mcp.example.com/mcp' };
        Object.defineProperty(value, 'hidden', { get() { throw new Error('MUST_NOT_RUN'); } });
        return value;
      })() as never`,
    });
    /** discover 以稳定错误码拒绝，并且原始 getter 文本不进入诊断。 */
    const result = await runProject({ cwd: root, command: 'validate', mode: 'production' });

    expect(result.success).toBe(false);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'MCP_DESCRIPTOR_LOAD_FAILED' }));
    expect(JSON.stringify(result.diagnostics)).not.toContain('MUST_NOT_RUN');
  });

  it('rejects non-enumerable unknown descriptor fields', async () => {
    /** strict JSON snapshot 直接拒绝不可枚举 data property。 */
    const root = await createProject({
      local: false,
      remote: `(() => {
        const value = { transport: 'http', url: 'https://mcp.example.com/mcp' };
        Object.defineProperty(value, 'hidden', { value: true });
        return value;
      })() as never`,
    });
    /** 隐藏字段不能被静默丢弃，也不能进入跨阶段 State。 */
    const result = await runProject({ cwd: root, command: 'validate', mode: 'production' });

    expect(result.success).toBe(false);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'MCP_DESCRIPTOR_LOAD_FAILED' }));
  });

  it('rejects array accessors, custom fields, Symbols and __proto__ fields without executing accessors', async () => {
    /** nested array getter 写 stdout；若被执行会直接破坏子进程 JSON 协议并使测试失败。 */
    const accessorRoot = await createProject({
      local: false,
      remote: `(() => {
        const scopes = [];
        Object.defineProperty(scopes, '0', { get() { process.stdout.write('GETTER_EXECUTED'); return 'docs:read'; } });
        Object.defineProperty(scopes, 'length', { value: 1 });
        const value = { transport: 'http', url: 'https://mcp.example.com/mcp', auth: { type: 'oauth', scopes } };
        Object.defineProperty(value, '__proto__', { value: true });
        return value;
      })() as never`,
    });
    /** 快照必须在执行 getter 前拒绝整个 descriptor。 */
    const accessor = await runProject({ cwd: accessorRoot, command: 'validate', mode: 'production' });

    expect(accessor.success).toBe(false);
    expect(accessor.diagnostics).toContainEqual(expect.objectContaining({ code: 'MCP_DESCRIPTOR_LOAD_FAILED' }));

    /** 类似索引的自定义字段也不能被 snapshot 静默忽略。 */
    const fieldRoot = await createProject({
      local: false,
      remote: `(() => {
        const scopes = ['docs:read'];
        Object.defineProperty(scopes, '01', { value: 'docs:write' });
        return { transport: 'http', url: 'https://mcp.example.com/mcp', auth: { type: 'oauth', scopes } };
      })() as never`,
    });
    /** 伪索引必须在 discover 数据边界失败。 */
    const field = await runProject({ cwd: fieldRoot, command: 'validate', mode: 'production' });

    expect(field.success).toBe(false);
    expect(field.diagnostics).toContainEqual(expect.objectContaining({ code: 'MCP_DESCRIPTOR_LOAD_FAILED' }));

    /** 字符串字段检查不能遗漏数组自身携带的 Symbol。 */
    const symbolRoot = await createProject({
      local: false,
      remote: `(() => {
        const scopes = ['docs:read'];
        Object.defineProperty(scopes, Symbol.for('hidden'), { value: true });
        return { transport: 'http', url: 'https://mcp.example.com/mcp', auth: { type: 'oauth', scopes } };
      })() as never`,
    });
    /** Symbol 不能进入纯 JSON descriptor State。 */
    const symbol = await runProject({ cwd: symbolRoot, command: 'validate', mode: 'production' });

    expect(symbol.success).toBe(false);
    expect(symbol.diagnostics).toContainEqual(expect.objectContaining({ code: 'MCP_DESCRIPTOR_LOAD_FAILED' }));
  });
});
