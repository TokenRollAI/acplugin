import type { MCPConfig, MCPServer, Platform, ConvertedFile } from '../types.js';
import { toToml } from '../utils/toml.js';

export function convertMCP(mcp: MCPConfig, platform: Platform): ConvertedFile {
  switch (platform) {
    case 'codex':
      return convertToCodex(mcp);
    case 'opencode':
      return convertToOpenCode(mcp);
    case 'cursor':
      return convertToCursor(mcp);
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
      if (server.args) config.args = server.args;
    }

    if (server.env && Object.keys(server.env).length > 0) {
      config.env = server.env;
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
        args: server.args || [],
        ...(server.env && Object.keys(server.env).length > 0 ? { env: server.env } : {}),
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
      if (server.args) config.args = server.args;
      if (server.env && Object.keys(server.env).length > 0) {
        config.env = server.env;
      }
    }

    mcpServers[server.name] = config;
  }

  const content = JSON.stringify({ mcpServers }, null, 2);
  return {
    path: '.cursor/mcp.json',
    content,
    type: 'mcp',
  };
}
