# Hooks Extension

## 安装与启用

```bash
pnpm add -D @tokenroll/acplugin-extension-hooks
```

```ts
import { defineConfig } from '@tokenroll/acplugin';
import hooks from '@tokenroll/acplugin-extension-hooks';
import claudeCode from '@tokenroll/acplugin-platform-claude-code';

export default defineConfig({
  name: 'my-plugin',
  version: '1.0.0',
  description: 'Reusable AI workflows.',
  platforms: [claudeCode()],
  extensions: [hooks()],
});
```

`hooks({ include: ['policy'] })` 可以只构建指定的小写 kebab-case ID。

## 作者格式

```ts
// src/hooks/policy/hook.ts
import type { Hook } from '@tokenroll/acplugin-extension-hooks';

export default {
  event: 'PreToolUse',
  matcher: 'Bash|Write|Edit',
  timeout: 10,
  async run(input, context) {
    return input.toolName === 'Bash'
      ? { decision: 'allow' }
      : { decision: 'deny', reason: `Denied on ${context.platform}.` };
  },
} satisfies Hook<'PreToolUse'>;
```

Portable events 是 `SessionStart`、`SessionEnd`、`UserPromptSubmit`、`PreToolUse`、`PermissionRequest`、`PostToolUse`、`PreCompact`、`PostCompact`、`SubagentStart`、`SubagentStop`、`Stop`。平台专属事件必须写成 `{ platform, name }`。

## 运行与安全边界

Extension 通过 Core `portable-node` Compiler 把每个 handler bundle 一次为自包含 Node 20 ESM。经过验证的平台 wire profile 与 runner 一同进入 Bundle，负责目标 stdin schema、camelCase 转换、root/data 映射和 stdout 协议；Contributor 不再补写相邻运行时 JavaScript。共享 runner 限制输入输出为 1 MiB、捕获顶层错误并只发稳定错误码。

作者不能声明 shell command、绝对 executable、HTTP callback 或其他原始目标协议。第三方依赖进入 bundle 时生成相邻 `THIRD_PARTY_LICENSES.txt`。

事件/字段兼容性见[完整矩阵](/resources/compatibility-matrix)。strict 模式拒绝 degraded/unsupported；relaxed 也只会生成验证过的 handler。

[Hooks package API](/api/@tokenroll/acplugin-extension-hooks/)
