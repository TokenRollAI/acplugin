import { defineMcpServer } from '@tokenroll/acplugin-extension-mcp';

/** 无认证的远程 Streamable HTTP MCP 模板。 */
export default defineMcpServer({
  transport: 'http',
  url: 'https://mcp.example.com/public-docs',
  auth: { type: 'none' },
});
