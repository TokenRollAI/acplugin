import type { ContributionContext, JsonValue, PlatformContributor } from '@tokenroll/acplugin/sdk';
import type { BuiltMcpServer, BuiltMcpServers } from '../build.js';
import {
  addJsonAsset,
  addLocalRuntime,
  collector,
  finishContribution,
  mapValues,
  reportAuth,
  reportTransport,
  serverSubjects,
} from './common.js';

/** @returns Codex 原生 MCP descriptor。 */
function descriptor(server: BuiltMcpServer): JsonValue {
  /** definition 是平台中立 MCP 描述。 */
  const definition = server.definition;
  if (definition.transport === 'stdio') {
    /** Codex 分离公开 env 和由宿主透传的变量名。 */
    const values = mapValues(definition.env);
    return {
      command: 'node',
      args: [`./mcp/${server.id}/server.mjs`],
      cwd: '.',
      ...(Object.keys(values.literal).length === 0 ? {} : { env: values.literal }),
      ...(Object.keys(values.environment).length === 0 ? {} : { env_vars: Object.values(values.environment) }),
    };
  }
  /** Codex 为字面量和环境引用 Header 提供独立字段。 */
  const values = mapValues(definition.headers);
  return {
    url: definition.url,
    ...(definition.auth?.type === 'bearer' ? { bearer_token_env_var: definition.auth.env } : {}),
    ...(definition.auth?.type === 'oauth' && definition.auth.scopes !== undefined ? { scopes: definition.auth.scopes } : {}),
    ...(Object.keys(values.literal).length === 0 ? {} : { http_headers: values.literal }),
    ...(Object.keys(values.environment).length === 0 ? {} : { env_http_headers: values.environment }),
  };
}

/** Codex Contributor 交付 Plugin-local stdio 与 Streamable HTTP MCP。 */
export const codexContributor: PlatformContributor<BuiltMcpServers> = Object.freeze({
  platform: 'codex',
  platformApiVersion: '1',
  /** 生成 Codex MCP 配置和本地 Bundle 引用。 */
  async contribute(context: ContributionContext, built: Readonly<BuiltMcpServers>) {
    /** output 汇聚当前 owner 的 Assets 和 compatibility。 */
    const output = collector();
    for (const server of built.servers) {
      reportTransport(output, server, 'native', 'Codex supports this MCP transport.');
      reportAuth(output, server, 'native', 'Codex preserves this MCP authentication policy.');
      if (server.definition.transport === 'stdio')
        addLocalRuntime(output, server, 'mcp');
    }
    if (built.servers.length === 0)
      return finishContribution(output);
    /** descriptors 按已稳定排序的 Built State 创建。 */
    const descriptors = Object.fromEntries(built.servers.map(server => [server.id, descriptor(server)]));
    await addJsonAsset(context, output, '.mcp.json', descriptors, serverSubjects(built.servers));
    return finishContribution(output, [{ document: 'plugin-manifest', path: ['mcpServers'], value: './.mcp.json' }]);
  },
});
