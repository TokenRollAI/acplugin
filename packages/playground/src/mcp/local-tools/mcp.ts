import { defineMcpServer } from '@tokenroll/acplugin-extension-mcp';

/** 可被真实 initialize、tools/list 和 tools/call 探测的本地 stdio MCP 模板。 */
export default defineMcpServer({
  transport: 'stdio',
  entry: './server.ts',
  env: {
    PLAYGROUND_MODE: { value: 'template' },
    PLAYGROUND_TOKEN: { env: 'PLAYGROUND_LOCAL_TOKEN' },
  },
});
