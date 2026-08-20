import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalHooks, createProject, runHandler, runProject } from './fixture.js';

describe('Hooks Extension protocol', () => {
  it('normalizes input, maps results, bounds I/O, and never exposes handler failures', async () => {
    /** 复用完整事件 fixture 取得真实构建后的 Handler。 */
    const root = await createProject({ hooks: canonicalHooks(), dependency: true });
    /** 生成两个默认 Platform Handler 的构建结果。 */
    const build = await runProject({ cwd: root, command: 'build', mode: 'production' });
    expect(build.success).toBe(true);
    /** 用于验证 camelCase 和 PreToolUse deny 映射的 Handler。 */
    const preToolHandler = path.join(root, 'dist/claude-code/plugin/hooks/pre-tool-use/handler.mjs');
    /** 平台发送给 Handler 的规范 snake_case 输入。 */
    const preToolInput = JSON.stringify({
      session_id: 'session-1',
      transcript_path: null,
      cwd: root,
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { nested_value: 'normalized' },
      tool_use_id: 'tool-1',
    });
    /** Claude Code 参数下的真实 Runner 输出。 */
    const claude = await runHandler(preToolHandler, 'claude-code', preToolInput, {
      CLAUDE_PLUGIN_ROOT: '/plugin-root',
      CLAUDE_PLUGIN_DATA: '/plugin-data',
    });
    expect(claude.code).toBe(0);
    expect(JSON.parse(claude.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'claude-code:Bash:normalized',
      },
    });
    expect(claude.stderr).toBe('');

    /** 两个 wire profile 必须各自解析平台原生的 Plugin 根和数据目录。 */
    const contextInput = JSON.stringify({
      session_id: 'session-1',
      cwd: root,
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { nested_value: 'context' },
      tool_use_id: 'tool-2',
    });
    /** Claude Code wire 的运行时上下文结果。 */
    const claudeContext = await runHandler(preToolHandler, 'claude-code', contextInput, {
      CLAUDE_PLUGIN_ROOT: '/claude-root',
      CLAUDE_PLUGIN_DATA: '/claude-data',
    });
    /** Codex wire 的运行时上下文结果。 */
    const codexContext = await runHandler(
      path.join(root, 'dist/codex/plugin/hooks/pre-tool-use/handler.mjs'),
      'codex',
      contextInput,
      { PLUGIN_ROOT: '/codex-root', PLUGIN_DATA: '/codex-data' },
    );
    expect(JSON.parse(claudeContext.stdout).hookSpecificOutput.permissionDecisionReason)
      .toBe('claude-code:/claude-root:/claude-data');
    expect(JSON.parse(codexContext.stdout).hookSpecificOutput.permissionDecisionReason)
      .toBe('codex:/codex-root:/codex-data');

    /** SessionEnd Handler 用于触发三种安全失败边界。 */
    const sessionEndHandler = path.join(root, 'dist/claude-code/plugin/hooks/session-end/handler.mjs');
    /** Codex 目录中与 Codex wire profile 相邻的 SessionEnd Handler。 */
    const codexSessionEndHandler = path.join(root, 'dist/codex/plugin/hooks/session-end/handler.mjs');
    /** 生成 SessionEnd 输入的局部辅助函数。 */
    const sessionEndInput = (reason: string): string => JSON.stringify({
      session_id: 'session-1',
      transcript_path: null,
      cwd: root,
      hook_event_name: 'SessionEnd',
      reason,
    });
    /** 超出一 MiB 的规范结果必须被 Runner 阻止。 */
    const oversized = await runHandler(sessionEndHandler, 'claude-code', sessionEndInput('oversized'));
    expect(oversized).toEqual({
      code: 1,
      stdout: '',
      stderr: 'acplugin hook error: OUTPUT_TOO_LARGE\n',
    });
    /** 用户实现直接写 stdout 时不得绕过规范结果协议或泄露内容。 */
    const logged = await runHandler(sessionEndHandler, 'claude-code', sessionEndInput('log:TOP_SECRET'));
    expect(logged).toEqual({
      code: 1,
      stdout: '',
      stderr: 'acplugin hook error: HANDLER_OUTPUT_FORBIDDEN\n',
    });
    expect(logged.stderr).not.toContain('TOP_SECRET');
    /** 用户异常消息只能收敛为稳定安全代码。 */
    const thrown = await runHandler(codexSessionEndHandler, 'codex', sessionEndInput('throw:TOP_SECRET'));
    expect(thrown).toEqual({
      code: 1,
      stdout: '',
      stderr: 'acplugin hook error: HANDLER_FAILED\n',
    });
    /** 超过输入上限时在 JSON 解析前返回固定错误。 */
    const tooLarge = await runHandler(codexSessionEndHandler, 'codex', `{"value":"${'x'.repeat(1024 * 1024)}"}`);
    expect(tooLarge).toEqual({
      code: 1,
      stdout: '',
      stderr: 'acplugin hook error: INPUT_TOO_LARGE\n',
    });
    /** Codex 目录中与 Codex wire profile 相邻的 PreToolUse Handler。 */
    const codexPreToolHandler = path.join(root, 'dist/codex/plugin/hooks/pre-tool-use/handler.mjs');
    /** 同一对象中的 snake_case/camelCase 字段碰撞不得静默覆盖。 */
    const collision = await runHandler(codexPreToolHandler, 'codex', JSON.stringify({
      session_id: 'session-1',
      cwd: root,
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { nested_value: 'first', nestedValue: 'second' },
      tool_use_id: 'tool-1',
    }));
    expect(collision).toEqual({
      code: 1,
      stdout: '',
      stderr: 'acplugin hook error: INPUT_KEY_COLLISION\n',
    });
    /** 构造超过递归规范化上限、但仍远小于字节上限的输入字段。 */
    let nestedInput: unknown = 'leaf';
    /** depth 表示当前追加的对象嵌套层数。 */
    for (let depth = 0; depth < 130; depth += 1)
      nestedInput = { value: nestedInput };
    /** 过深输入必须使用稳定错误码终止，不能触发运行时栈错误。 */
    const tooDeep = await runHandler(codexPreToolHandler, 'codex', JSON.stringify({
      session_id: 'session-1',
      cwd: root,
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: nestedInput,
      tool_use_id: 'tool-1',
    }));
    expect(tooDeep).toEqual({
      code: 1,
      stdout: '',
      stderr: 'acplugin hook error: INPUT_TOO_DEEP\n',
    });

    /** updatedInput 的嵌套 BigInt 不是 JSON 值，必须在 wire 序列化前拒绝。 */
    const invalidUpdatedInput = await runHandler(codexPreToolHandler, 'codex', JSON.stringify({
      session_id: 'session-1',
      cwd: root,
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { nested_value: 'invalid-json' },
      tool_use_id: 'tool-1',
    }));
    expect(invalidUpdatedInput).toEqual({
      code: 1,
      stdout: '',
      stderr: 'acplugin hook error: RESULT_UPDATED_INPUT_INVALID\n',
    });

    /** 未等待任务中的输出仍在进程退出前被拦截，且不会泄露原文。 */
    const delayedLog = await runHandler(sessionEndHandler, 'claude-code', sessionEndInput('delayed-log'));
    expect(delayedLog).toEqual({
      code: 1,
      stdout: '',
      stderr: 'acplugin hook error: HANDLER_OUTPUT_FORBIDDEN\n',
    });
    expect(delayedLog.stderr).not.toContain('DELAYED_SECRET');
    /** 未等待 timer 抛错和拒绝统一收敛为异步失败码。 */
    for (const reason of ['delayed-throw', 'delayed-rejection']) {
      /** 当前异步失败形式的隔离执行结果。 */
      const delayedFailure = await runHandler(sessionEndHandler, 'claude-code', sessionEndInput(reason));
      expect(delayedFailure).toEqual({
        code: 1,
        stdout: '',
        stderr: 'acplugin hook error: HANDLER_ASYNC_FAILED\n',
      });
      expect(delayedFailure.stderr).not.toContain('DELAYED_SECRET');
    }
    /** 多个未等待异常以及 beforeExit 启动的同步或 I/O 异常都必须保持在安全监听边界内。 */
    for (const reason of ['multiple-async-failures', 'late-before-exit', 'late-before-exit-io']) {
      /** 当前复杂异步失败形式的隔离执行结果。 */
      const complexFailure = await runHandler(sessionEndHandler, 'claude-code', sessionEndInput(reason));
      expect(complexFailure).toEqual({
        code: 1,
        stdout: '',
        stderr: 'acplugin hook error: HANDLER_ASYNC_FAILED\n',
      });
      expect(complexFailure.stderr).not.toMatch(/FIRST_SECRET|SECOND_SECRET|BEFORE_EXIT_(?:IO_)?SECRET/u);
    }

    /** 两个压缩事件都必须通过各自 Platform 的完整 Handler/wire 组合。 */
    for (const [event, id] of [['PreCompact', 'pre-compact'], ['PostCompact', 'post-compact']] as const) {
      /** 当前压缩事件的原生输入。 */
      const compactInput = JSON.stringify({
        session_id: 'session-1',
        transcript_path: null,
        cwd: root,
        hook_event_name: event,
        trigger: 'manual',
      });
      /** Claude Code 目录中的完整运行结果。 */
      const claudeCompact = await runHandler(
        path.join(root, `dist/claude-code/plugin/hooks/${id}/handler.mjs`),
        'claude-code',
        compactInput,
      );
      /** Codex 目录中的完整运行结果。 */
      const codexCompact = await runHandler(
        path.join(root, `dist/codex/plugin/hooks/${id}/handler.mjs`),
        'codex',
        compactInput,
      );
      expect(JSON.parse(claudeCompact.stdout)).toEqual(event === 'PreCompact'
        ? { decision: 'block', reason: 'Compact later.' }
        : { continue: false, stopReason: 'Compact later.' });
      expect(JSON.parse(codexCompact.stdout)).toEqual({ continue: false, stopReason: 'Compact later.' });
    }
  });
});
