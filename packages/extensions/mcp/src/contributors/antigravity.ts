import type { ContributionContext, JsonValue, PlatformContributor } from '@tokenroll/acplugin/sdk';
import type { BuiltMcpServer, BuiltMcpServers } from '../build.js';
import {
  addJsonAsset,
  collector,
  finishContribution,
  mapValues,
  reportAuth,
  reportTransport,
  serverSubjects,
} from './common.js';

/** @returns Antigravity 远程 MCP descriptor。 */
function descriptor(server: BuiltMcpServer): JsonValue {
  if (server.definition.transport !== 'http')
    throw new TypeError('Antigravity only accepts remote MCP descriptors.');
  /** values 保存公开 Header 与环境引用。 */
  const values = mapValues(server.definition.headers);
  /** headers 使用 Antigravity 的运行时环境插值。 */
  const headers: Record<string, string> = {
    ...values.literal,
    ...Object.fromEntries(Object.entries(values.environment).map(([key, name]) => [key, `\${${name}}`])),
  };
  if (server.definition.auth?.type === 'bearer')
    headers.Authorization = `Bearer \${${server.definition.auth.env}}`;
  return {
    type: 'http',
    url: server.definition.url,
    ...(Object.keys(headers).length === 0 ? {} : { headers }),
  };
}

/** Antigravity Contributor 只交付拥有稳定协议的远程 HTTP MCP。 */
export const antigravityContributor: PlatformContributor<BuiltMcpServers> = Object.freeze({
  platform: 'antigravity',
  platformApiVersion: '1',
  /** 生成 Antigravity remote-only MCP 配置。 */
  async contribute(context: ContributionContext, built: Readonly<BuiltMcpServers>) {
    /** output 汇聚当前 owner 的 Assets 和 compatibility。 */
    const output = collector();
    /** remote 保存最终会进入 Antigravity 配置的 Server。 */
    const remote: BuiltMcpServer[] = [];
    for (const server of built.servers) {
      if (server.definition.transport === 'stdio') {
        reportTransport(output, server, 'unsupported', 'Antigravity has no verified Plugin-local stdio MCP delivery contract.');
        continue;
      }
      remote.push(server);
      reportTransport(output, server, 'native', 'Antigravity supports remote MCP transport.');
      /** 显式 scopes 无法进入 Antigravity 当前静态 descriptor。 */
      const losesScopes = server.definition.auth?.type === 'oauth' && server.definition.auth.scopes !== undefined;
      reportAuth(
        output,
        server,
        losesScopes ? 'degraded' : 'native',
        losesScopes
          ? 'Antigravity cannot preserve configured OAuth scopes in this descriptor.'
          : 'Antigravity preserves this MCP authentication policy.',
      );
    }
    if (remote.length === 0)
      return finishContribution(output);
    /** descriptors 只包含 remote Server。 */
    const descriptors = Object.fromEntries(remote.map(server => [server.id, descriptor(server)]));
    await addJsonAsset(context, output, 'mcp_config.json', { mcpServers: descriptors }, serverSubjects(remote));
    return finishContribution(output);
  },
});
