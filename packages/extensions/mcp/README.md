# @tokenroll/acplugin-extension-mcp

Optional MCP declarations, Core-managed local builds, and Platform Contributors for `@tokenroll/acplugin`.

Requires Node.js `^20.19.0 || ^22.13.0 || >=23.5.0`.

`可选的 MCP 远程声明、本地构建能力，以及面向各 ACPlugin Platform 的适配实现。`

```bash
pnpm add -D @tokenroll/acplugin \
  @tokenroll/acplugin-platform-claude-code \
  @tokenroll/acplugin-extension-mcp
```

```ts
import { defineConfig } from '@tokenroll/acplugin';
import claudeCode from '@tokenroll/acplugin-platform-claude-code';
import mcp from '@tokenroll/acplugin-extension-mcp';

export default defineConfig({
  name: 'my-plugin',
  version: '1.0.0',
  description: 'Reusable AI workflows.',
  platforms: [claudeCode()],
  extensions: [mcp()],
});
```

Remote Streamable HTTP is declarative; provide only the endpoint and runtime secret references:

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

Local stdio is executable content; provide a complete server implementation and reference its entry:

```ts
// src/mcp/local-tools/mcp.ts
import type { McpServer } from '@tokenroll/acplugin-extension-mcp';

export default {
  transport: 'stdio',
  entry: 'server.ts',
  env: { API_TOKEN: { env: 'LOCAL_API_TOKEN' } },
} satisfies McpServer;
```

The Extension asks Core's `portable-node` Compiler to bundle each local implementation once as Node 20 ESM and emit deterministic third-party notices when needed. It rejects unresolved runtime dynamic imports and runs the bundle through a bounded `initialize → initialized → tools/list` smoke test using only declared literal environment values. Referenced secret values are never read. Production remote endpoints require HTTPS; development permits loopback HTTP.

`Extension 通过 Core portable-node Compiler 把本地实现统一构建一次 Node 20 ESM，并在需要时生成确定性的第三方许可材料。构建会拒绝无法解析的运行时动态导入，并仅使用声明的公开字面量环境值执行带超时和输出上限的 initialize → initialized → tools/list smoke；环境变量 Secret 引用值不会被读取。`

| Transport | Claude Code | Codex | Cursor | Antigravity | OpenCode | Pi |
| --- | --- | --- | --- | --- | --- | --- |
| Remote HTTP | Native | Native | Native | Native | Native | Unsupported |
| Local stdio | Native | Native | Unsupported | Unsupported | Native | Unsupported |

Unsupported transports are reported and never replaced with fabricated client behavior. Contracts were last rechecked on 2026-08-06 against [Claude Code MCP](https://code.claude.com/docs/en/mcp), [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp), [Cursor MCP](https://cursor.com/docs/context/mcp), [Antigravity Plugins](https://antigravity.google/docs/plugins?app=cli), [OpenCode MCP](https://opencode.ai/docs/mcp-servers/), and [Pi Packages](https://pi.dev/docs/latest/packages).

## License

MIT
