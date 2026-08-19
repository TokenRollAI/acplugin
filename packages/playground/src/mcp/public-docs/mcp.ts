import type { McpServer } from '@tokenroll/acplugin-extension-mcp';

/** 无认证的远程 Streamable HTTP MCP 模板。 */
export default {
  transport: 'http',
  url: 'https://mcp.example.com/public-docs',
  auth: { type: 'none' },
} satisfies McpServer;
