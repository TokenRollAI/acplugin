import { describe, it, expect } from 'vitest';
import { convertMCP } from '../converter/mcp.js';
import type { MCPConfig } from '../types.js';

const sampleMCP: MCPConfig = {
  servers: [
    {
      name: 'filesystem',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
      env: { NODE_ENV: 'dev' },
    },
    {
      name: 'github',
      type: 'http',
      url: 'https://api.github.com/mcp',
      headers: { Authorization: 'Bearer token' },
    },
  ],
  sourcePath: '/tmp/.mcp.json',
};

describe('convertMCP', () => {
  it('converts to codex TOML format', () => {
    const result = convertMCP(sampleMCP, 'codex');
    expect(result.path).toBe('.codex/config.toml');
    expect(result.content).toContain('[mcp_servers.filesystem]');
    expect(result.content).toContain('command = "npx"');
    expect(result.content).toContain('[mcp_servers.github]');
    expect(result.content).toContain('url = "https://api.github.com/mcp"');
  });

  it('converts to opencode JSON format', () => {
    const result = convertMCP(sampleMCP, 'opencode');
    expect(result.path).toBe('opencode.json');
    const data = JSON.parse(result.content);
    expect(data.mcp.filesystem.type).toBe('local');
    expect(data.mcp.filesystem.command).toBe('npx');
    expect(data.mcp.github.type).toBe('remote');
    expect(data.mcp.github.url).toBe('https://api.github.com/mcp');
  });

  it('converts to cursor JSON format', () => {
    const result = convertMCP(sampleMCP, 'cursor');
    expect(result.path).toBe('.cursor/mcp.json');
    const data = JSON.parse(result.content);
    expect(data.mcpServers.filesystem.command).toBe('npx');
    expect(data.mcpServers.github.url).toBe('https://api.github.com/mcp');
  });
});
