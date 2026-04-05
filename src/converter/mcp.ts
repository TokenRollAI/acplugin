import type { MCPConfig, Platform, ConvertedFile } from '../types.js';
import { toToml } from '../utils/toml.js';

/**
 * Replace ${CLAUDE_PLUGIN_ROOT} with relative path.
 * All target platforms use relative paths from plugin root.
 */
function transformPluginRootPaths(value: string): string {
  return value
    .replace(/"\$\{CLAUDE_PLUGIN_ROOT\}\/([^"]+)"/g, './$1')
    .replace(/\$\{CLAUDE_PLUGIN_ROOT\}\//g, './')
    .replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, '.');
}

function transformArgs(args: string[]): string[] {
  return args.map(a => transformPluginRootPaths(a));
}

function transformEnv(env: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    result[k] = transformPluginRootPaths(v);
  }
  return result;
}

export function convertMCP(mcp: MCPConfig, platform: Platform): ConvertedFile {
  switch (platform) {
    case 'codex':
      return convertToCodex(mcp);
    case 'opencode':
      return convertToOpenCode(mcp);
    case 'cursor':
      return convertToCursor(mcp);
    case 'antigravity':
      return convertToAntigravity(mcp);
  }
}

function convertToCodex(mcp: MCPConfig): ConvertedFile {
  // Generate TOML [mcp_servers.X] sections
  const mcpServers: Record<string, Record<string, unknown>> = {};

  for (const server of mcp.servers) {
    const config: Record<string, unknown> = {};

    if (server.type === 'http' && server.url) {
      config.url = server.url;
      if (server.headers) {
        config.http_headers = server.headers;
      }
    } else {
      if (server.command) config.command = server.command;
      if (server.args) config.args = transformArgs(server.args);
    }

    if (server.env && Object.keys(server.env).length > 0) {
      config.env = transformEnv(server.env);
    }

    config.enabled = true;
    mcpServers[server.name] = config;
  }

  const content = toToml({ mcp_servers: mcpServers });
  return {
    path: '.codex/config.toml',
    content: `# MCP servers converted from Claude Code .mcp.json\n\n${content}`,
    type: 'mcp',
  };
}

function convertToOpenCode(mcp: MCPConfig): ConvertedFile {
  const mcpConfig: Record<string, unknown> = {};

  for (const server of mcp.servers) {
    if (server.type === 'http' && server.url) {
      mcpConfig[server.name] = {
        type: 'remote',
        url: server.url,
        ...(server.headers ? { headers: server.headers } : {}),
      };
    } else {
      mcpConfig[server.name] = {
        type: 'local',
        command: server.command,
        args: transformArgs(server.args || []),
        ...(server.env && Object.keys(server.env).length > 0 ? { env: transformEnv(server.env) } : {}),
      };
    }
  }

  const content = JSON.stringify({ mcp: mcpConfig }, null, 2);
  return {
    path: 'opencode.json',
    content,
    type: 'mcp',
  };
}

function convertToCursor(mcp: MCPConfig): ConvertedFile {
  // Cursor format is almost identical to Claude's .mcp.json
  const mcpServers: Record<string, unknown> = {};

  for (const server of mcp.servers) {
    const config: Record<string, unknown> = {};

    if (server.type === 'http' && server.url) {
      config.url = server.url;
      if (server.headers) config.headers = server.headers;
    } else {
      if (server.command) config.command = server.command;
      if (server.args) config.args = transformArgs(server.args);
      if (server.env && Object.keys(server.env).length > 0) {
        config.env = transformEnv(server.env);
      }
    }

    mcpServers[server.name] = config;
  }

  const content = JSON.stringify({ mcpServers }, null, 2);
  return {
    path: 'mcp.json',
    content,
    type: 'mcp',
  };
}

function convertToAntigravity(mcp: MCPConfig): ConvertedFile {
  // Antigravity uses .gemini/settings.json { mcpServers: { ... } }
  const mcpServers: Record<string, unknown> = {};

  for (const server of mcp.servers) {
    const config: Record<string, unknown> = {};

    if (server.type === 'http' && server.url) {
      config.url = server.url;
      if (server.headers) config.headers = server.headers;
    } else {
      if (server.command) config.command = server.command;
      if (server.args) config.args = transformArgs(server.args);
      if (server.env && Object.keys(server.env).length > 0) {
        config.env = transformEnv(server.env);
      }
    }

    mcpServers[server.name] = config;
  }

  const content = JSON.stringify({ mcpServers }, null, 2);
  return {
    path: '.gemini/settings.json',
    content,
    type: 'mcp',
  };
}
