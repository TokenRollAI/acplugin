import { defineMcpServer } from '@tokenroll/acplugin-extension-mcp';

/** 使用 OAuth scope 的远程 Streamable HTTP MCP 模板。 */
export default defineMcpServer({
  transport: 'http',
  url: 'https://mcp.example.com/oauth-docs',
  auth: {
    type: 'oauth',
    scopes: ['resources:read', 'templates:read'],
  },
});
