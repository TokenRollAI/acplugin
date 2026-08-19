import type { ContributionContext, JsonValue, PlatformContributor } from '@tokenroll/acplugin/sdk';
import type { BuiltMcpServer, BuiltMcpServers } from '../build.js';
import {
  addLocalRuntime,
  collector,
  finishContribution,
  mapValues,
  reportAuth,
  reportTransport,
} from './common.js';

/** @returns OpenCode 原生 local/remote MCP descriptor。 */
function descriptor(server: BuiltMcpServer): JsonValue {
  /** definition 是平台中立 MCP 描述。 */
  const definition = server.definition;
  if (definition.transport === 'stdio') {
    /** OpenCode environment 允许字面量和运行时 env 引用。 */
    const values = mapValues(definition.env);
    /** environment 保留 canonical key 到宿主变量名的映射。 */
    const environment = {
      ...values.literal,
      ...Object.fromEntries(Object.entries(values.environment).map(([key, name]) => [key, `{env:${name}}`])),
    };
    return {
      type: 'local',
      command: ['node', `./.opencode/mcp/${server.id}/server.mjs`],
      ...(Object.keys(environment).length === 0 ? {} : { environment }),
    };
  }
  /** OpenCode remote Header 使用运行时 env 引用。 */
  const values = mapValues(definition.headers);
  /** headers 保留作者字段名。 */
  const headers: Record<string, string> = {
    ...values.literal,
    ...Object.fromEntries(Object.entries(values.environment).map(([key, name]) => [key, `{env:${name}}`])),
  };
  if (definition.auth?.type === 'bearer')
    headers.Authorization = `Bearer {env:${definition.auth.env}}`;
  return {
    type: 'remote',
    url: definition.url,
    ...(Object.keys(headers).length === 0 ? {} : { headers }),
    ...(definition.auth?.type === 'oauth'
      ? { oauth: definition.auth.scopes === undefined ? {} : { scope: definition.auth.scopes.join(' ') } }
      : {}),
  };
}

/** OpenCode Contributor 只扩展 Platform 拥有的 workspace-config Document。 */
export const openCodeContributor: PlatformContributor<BuiltMcpServers> = Object.freeze({
  platform: 'opencode',
  platformApiVersion: '1',
  /** 追加 OpenCode MCP Document 字段和 Plugin-local Bundle。 */
  contribute(_context: ContributionContext, built: Readonly<BuiltMcpServers>) {
    /** output 汇聚当前 owner 的 Assets 和 compatibility。 */
    const output = collector();
    for (const server of built.servers) {
      reportTransport(output, server, 'native', 'OpenCode supports this MCP transport.');
      reportAuth(output, server, 'native', 'OpenCode preserves this MCP authentication policy.');
      if (server.definition.transport === 'stdio')
        addLocalRuntime(output, server, '.opencode/mcp');
    }
    if (built.servers.length === 0)
      return finishContribution(output);
    /** workspace-config.mcp 是唯一配置来源，不生成 sidecar。 */
    const descriptors = Object.fromEntries(built.servers.map(server => [server.id, descriptor(server)]));
    return finishContribution(output, [{ document: 'workspace-config', path: ['mcp'], value: descriptors }]);
  },
});
