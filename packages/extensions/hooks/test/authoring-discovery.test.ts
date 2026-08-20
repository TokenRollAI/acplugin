import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import hooks from '../src/index.js';
import { createProject, runProject } from './fixture.js';

describe('Hooks Extension authoring and discovery', () => {
  it('filters discovered resources with include and rejects invalid factory options', async () => {
    /** 只选择 keep、忽略 skip 的真实作者工程。 */
    const root = await createProject({
      hooks: [
        { id: 'keep', definition: `{ event: 'SessionStart', run() {} }` },
        { id: 'skip', definition: `{ event: 'Stop', run() {} }` },
      ],
      hooksOptions: `{ include: ['keep'] }`,
    });
    /** include 筛选后的双 Platform 构建结果。 */
    const result = await runProject({ cwd: root, command: 'build', mode: 'production' });

    expect(result.success).toBe(true);
    expect((await fs.readdir(path.join(root, 'dist/claude-code/plugin/hooks'))).sort()).toEqual(['hooks.json', 'keep']);
    await expect(fs.access(path.join(root, 'dist/codex/plugin/hooks/skip/handler.mjs'))).rejects.toThrow();
    expect(() => hooks({ include: ['valid', 'valid'] })).toThrow('duplicate ID');
    expect(() => hooks({ include: ['Not-Kebab'] })).toThrow('lowercase kebab-case');
    expect(() => hooks({ unknown: true } as never)).toThrow('Unknown Hooks option');
  });

  it('rejects non-enumerable descriptor accessors without evaluating them', async () => {
    /** 不可枚举 getter 也属于可执行描述行为，不能靠 Object.keys 隐藏。 */
    const root = await createProject({
      hooks: [{
        id: 'accessor',
        definition: `(() => {
          const value = { event: 'SessionStart', run() {} };
          Object.defineProperty(value, 'hidden', { get() { throw new Error('MUST_NOT_RUN'); } });
          return value;
        })() as never`,
      }],
    });
    /** discover 只报告脱敏加载失败，不执行或泄漏 getter 内容。 */
    const result = await runProject({ cwd: root, command: 'validate', mode: 'production' });

    expect(result.success).toBe(false);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'HOOK_LOAD_FAILED' }));
    expect(JSON.stringify(result.diagnostics)).not.toContain('MUST_NOT_RUN');
  });

  it('rejects non-enumerable unknown descriptor fields', async () => {
    /** data property 即使不可枚举也必须保留到领域 Schema 检查。 */
    const root = await createProject({
      hooks: [{
        id: 'hidden-field',
        definition: `(() => {
          const value = { event: 'SessionStart', run() {} };
          Object.defineProperty(value, 'hidden', { value: true });
          return value;
        })() as never`,
      }],
    });
    /** 隐藏字段不能因 Module Service 快照规则而消失。 */
    const result = await runProject({ cwd: root, command: 'validate', mode: 'production' });

    expect(result.success).toBe(false);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'HOOK_FIELD_UNKNOWN' }));
  });

  it('distinguishes omitted descriptor fields from nested undefined values', async () => {
    /** 顶层可选字段缺失是合法 omission。 */
    const omittedRoot = await createProject({
      hooks: [{
        id: 'omitted',
        definition: `{ event: 'SessionStart', run() {} }`,
      }],
    });
    /** omission 能完整进入 validate/build，而不是被误判成非法 JSON。 */
    const omitted = await runProject({ cwd: omittedRoot, command: 'validate', mode: 'production' });
    expect(omitted.success).toBe(true);
    expect(omitted.extensions).toContainEqual(expect.objectContaining({
      id: 'hooks',
      discovered: true,
      subjects: expect.arrayContaining([
        expect.objectContaining({ subject: 'hook:omitted' }),
      ]),
    }));

    /** 已出现的嵌套字段显式 undefined 不是 JSON 数据。 */
    const invalidRoot = await createProject({
      hooks: [{
        id: 'nested-undefined',
        definition: `{ event: 'SessionStart', platforms: { codex: { timeout: undefined } }, run() {} } as never`,
      }],
    });
    /** discover 必须只拒绝包含显式 nested undefined 的 descriptor。 */
    const invalid = await runProject({ cwd: invalidRoot, command: 'validate', mode: 'production' });

    expect(invalid.success).toBe(false);
    expect(invalid.diagnostics.filter(diagnostic => diagnostic.code === 'HOOK_LOAD_FAILED')).toHaveLength(1);
  });

  it('rejects array accessors, custom fields, Symbols and __proto__ fields without executing accessors', async () => {
    /** 四个资源分别覆盖 nested array getter、自定义索引、数组 Symbol 与特殊对象字段名。 */
    const root = await createProject({
      hooks: [{
        id: 'nested-accessor',
        definition: `(() => {
          const platforms = [];
          Object.defineProperty(platforms, '0', { get() { process.stdout.write('GETTER_EXECUTED'); return 'codex'; } });
          Object.defineProperty(platforms, 'length', { value: 1 });
          return { event: 'SessionStart', platforms, run() {} };
        })() as never`,
      }, {
        id: 'array-field',
        definition: `(() => {
          const platforms = ['codex'];
          Object.defineProperty(platforms, '01', { value: 'claude-code' });
          return { event: 'SessionStart', platforms, run() {} };
        })() as never`,
      }, {
        id: 'array-symbol',
        definition: `(() => {
          const platforms = ['codex'];
          Object.defineProperty(platforms, Symbol.for('hidden'), { value: true });
          return { event: 'SessionStart', platforms, run() {} };
        })() as never`,
      }, {
        id: 'proto-field',
        definition: `(() => {
          const value = { event: 'SessionStart', run() {} };
          Object.defineProperty(value, '__proto__', { value: true });
          return value;
        })() as never`,
      }],
    });
    /** getter 资源加载失败，特殊字段资源进入领域未知字段诊断。 */
    const result = await runProject({ cwd: root, command: 'validate', mode: 'production' });

    expect(result.success).toBe(false);
    expect(result.diagnostics.filter(diagnostic => diagnostic.code === 'HOOK_LOAD_FAILED')).toHaveLength(3);
  });

  it('reports missing includes and platform-specific SessionEnd timeout limits', async () => {
    /** 同时覆盖缺失 include 和 Codex 三秒上限的工程。 */
    const missingRoot = await createProject({
      hooks: [{ id: 'session-end', definition: `{ event: 'SessionEnd', timeout: 4, platforms: { 'claude-code': { timeout: 60 } }, run() {} }` }],
      hooksOptions: `{ include: ['session-end', 'missing'] }`,
    });
    /** discover 与 validate 阶段应分别提交目标明确的诊断。 */
    const missing = await runProject({ cwd: missingRoot, command: 'validate', mode: 'production' });
    expect(missing.success).toBe(false);
    expect(missing.diagnostics).toContainEqual(expect.objectContaining({ code: 'HOOK_INCLUDE_MISSING' }));
    expect(missing.diagnostics).not.toContainEqual(expect.objectContaining({ code: 'HOOK_TIMEOUT_PLATFORM_LIMIT' }));

    /** Codex 使用三秒，而 Claude Code 单独超过六十秒上限的工程。 */
    const claudeRoot = await createProject({
      hooks: [{ id: 'session-end', definition: `{ event: 'SessionEnd', timeout: 3, platforms: { 'claude-code': { timeout: 61 } }, run() {} }` }],
    });
    /** Claude Code 上限必须独立于 Codex 默认值验证。 */
    const claude = await runProject({ cwd: claudeRoot, command: 'validate', mode: 'production' });
    expect(claude.success).toBe(false);
    expect(claude.diagnostics).toContainEqual(expect.objectContaining({ code: 'HOOK_TIMEOUT_PLATFORM_LIMIT' }));
  });
});
