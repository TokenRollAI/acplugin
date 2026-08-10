import { defineMcpServer } from '@tokenroll/acplugin-extension-mcp';

/** 同时展示 Bearer、环境 Header 和公开字面量 Header 的远程 MCP 模板。 */
export default defineMcpServer({
  transport: 'http',
  url: 'https://mcp.example.com/protected-docs',
  auth: { type: 'bearer', env: 'PLAYGROUND_MCP_TOKEN' },
  headers: {
    'X-Project': { value: 'acplugin-capability-playground' },
    'X-Tenant': { env: 'PLAYGROUND_MCP_TENANT' },
  },
});
