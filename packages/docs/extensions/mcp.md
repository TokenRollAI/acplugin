# MCP Extension

## 安装与启用

```bash
pnpm add -D @tokenroll/acplugin-extension-mcp
```

```ts
import { defineConfig } from '@tokenroll/acplugin';
import mcp from '@tokenroll/acplugin-extension-mcp';
import claudeCode from '@tokenroll/acplugin-platform-claude-code';

export default defineConfig({
  name: 'my-plugin',
  version: '1.0.0',
  description: 'Reusable AI workflows.',
  platforms: [claudeCode()],
  extensions: [mcp()],
});
```

`mcp({ include: ['docs'] })` 可以只构建指定 Server。

## Remote HTTP

```ts
// src/mcp/docs/mcp.ts
import type { McpServer } from '@tokenroll/acplugin-extension-mcp';

export default {
  transport: 'http',
  url: 'https://example.com/mcp',
  auth: { type: 'bearer', env: 'DOCS_TOKEN' },
  headers: { 'X-Tenant': { env: 'TENANT_ID' } },
} satisfies McpServer;
```

Secret 只用 `{ env }` 引用，构建过程不会读取值。Production endpoint 必须 HTTPS；development 仅允许 loopback HTTP。

## Local stdio

```ts
// src/mcp/local-tools/mcp.ts
import type { McpServer } from '@tokenroll/acplugin-extension-mcp';

export default {
  transport: 'stdio',
  entry: 'server.ts',
  env: { API_TOKEN: { env: 'LOCAL_API_TOKEN' } },
} satisfies McpServer;
```

本地 Server 必须是完整实现。Extension 通过 Core `portable-node` Compiler bundle Node 20 ESM，拒绝未解析动态 import，并使用声明的 literal 环境值执行有界 `initialize → initialized → tools/list` smoke；Secret 引用不会被读取。

HTTP 在 Claude Code、Codex、Cursor、Antigravity、OpenCode 原生，Pi unsupported。Local stdio 在 Claude Code、Codex、OpenCode 原生，其余平台 unsupported。

[MCP package API](/api/@tokenroll/acplugin-extension-mcp/)
