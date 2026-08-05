import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildProject,
  resolveConfig,
  type TypeScriptModuleLoader,
} from '@acplugin/core';
import { claudeCodeCompiler } from '@acplugin/compiler-claude-code';
import { codexCompiler } from '@acplugin/compiler-codex';
import hooks, { defineHook } from '@tokenroll/acplugin-module-hooks';
import mcp, { defineMcpServer } from '@tokenroll/acplugin-module-mcp';

const roots: string[] = [];

async function runNode(file: string, input: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => stdout += chunk);
    child.stderr.setEncoding('utf8').on('data', chunk => stderr += chunk);
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe('official Modules', () => {
  it('builds portable Hooks and remote/local MCP into both targets', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acplugin-modules-test-'));
    roots.push(root);
    await fs.mkdir(path.join(root, 'src/skills/tools'), { recursive: true });
    await fs.mkdir(path.join(root, 'src/hooks/policy'), { recursive: true });
    await fs.mkdir(path.join(root, 'src/hooks/permission'), { recursive: true });
    await fs.mkdir(path.join(root, 'src/hooks/compact'), { recursive: true });
    await fs.mkdir(path.join(root, 'src/hooks/session-end'), { recursive: true });
    await fs.mkdir(path.join(root, 'src/mcp/docs'), { recursive: true });
    await fs.mkdir(path.join(root, 'src/mcp/local-tools'), { recursive: true });
    await fs.mkdir(path.join(root, 'node_modules/license-fixture'), { recursive: true });
    await fs.writeFile(path.join(root, 'node_modules/license-fixture/package.json'), JSON.stringify({
      name: 'license-fixture',
      version: '1.2.3',
      type: 'module',
      exports: './index.js',
      license: 'MIT',
    }));
    await fs.writeFile(path.join(root, 'node_modules/license-fixture/index.js'), `export default process.env.LICENSE_FIXTURE !== 'off';\n`);
    await fs.writeFile(path.join(root, 'node_modules/license-fixture/LICENSE'), 'Fixture MIT license text.\n');
    await fs.writeFile(path.join(root, 'src/skills/tools/SKILL.md'), '---\ndescription: Use the tools.\n---\nUse the available tools safely.\n');
    await fs.writeFile(path.join(root, 'src/hooks/policy/hook.ts'), `import marker from 'license-fixture';
    export default {
      __acpluginHook: true,
      event: 'PreToolUse',
      matcher: 'Bash',
      timeout: 5,
      async run() { return { decision: marker ? 'allow' : 'deny' }; },
    };`);
    await fs.writeFile(path.join(root, 'src/hooks/permission/hook.ts'), `export default { __acpluginHook: true, event: 'PermissionRequest', async run() { return { decision: 'defer' }; } };`);
    await fs.writeFile(path.join(root, 'src/hooks/compact/hook.ts'), `export default { __acpluginHook: true, event: 'PreCompact', async run() { return { decision: 'continue' }; } };`);
    await fs.writeFile(path.join(root, 'src/hooks/session-end/hook.ts'), `export default { __acpluginHook: true, event: 'SessionEnd', async run() { return { decision: 'stop' }; } };`);
    await fs.writeFile(path.join(root, 'src/mcp/docs/mcp.ts'), 'export default {};');
    await fs.writeFile(path.join(root, 'src/mcp/local-tools/mcp.ts'), 'export default {};');
    await fs.writeFile(path.join(root, 'src/mcp/local-tools/server.ts'), `
import marker from 'license-fixture';
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const request = JSON.parse(line);
    if (request.method === 'initialize') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {
        protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: marker ? 'fixture' : 'invalid', version: '1.0.0' },
      } }) + '\\n');
    } else if (request.method === 'tools/list') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { tools: [] } }) + '\\n');
    }
  }
});
`);

    const hookDefinition = defineHook({
      event: 'PreToolUse',
      matcher: 'Bash',
      timeout: 5,
      async run() { return { decision: 'allow' }; },
    });
    const permissionDefinition = defineHook({
      event: 'PermissionRequest',
      async run() {
        return { decision: 'defer' };
      },
    });
    const compactDefinition = defineHook({
      event: 'PreCompact',
      async run() {
        return { decision: 'continue' };
      },
    });
    const invalidSessionEndDefinition = {
      __acpluginHook: true,
      event: 'SessionEnd',
      async run() {
        return { decision: 'stop' };
      },
    } as any;
    const loader: TypeScriptModuleLoader = async (file) => {
      if (file.endsWith('/hooks/policy/hook.ts'))
        return hookDefinition;
      if (file.endsWith('/hooks/permission/hook.ts'))
        return permissionDefinition;
      if (file.endsWith('/hooks/compact/hook.ts'))
        return compactDefinition;
      if (file.endsWith('/hooks/session-end/hook.ts'))
        return invalidSessionEndDefinition;
      if (file.endsWith('/mcp/docs/mcp.ts'))
        return defineMcpServer({ transport: 'http', url: 'https://example.com/mcp', auth: { type: 'bearer', env: 'DOCS_TOKEN' }, headers: { 'X-Tenant': { env: 'TENANT' } } });
      if (file.endsWith('/mcp/local-tools/mcp.ts'))
        return defineMcpServer({ transport: 'stdio', env: { TOKEN: { env: 'LOCAL_TOKEN' } } });
      throw new Error(`Unexpected descriptor ${file}`);
    };
    const resolved = resolveConfig({
      name: 'module-plugin',
      version: '1.0.0',
      description: 'Module plugin.',
      modules: [hooks(), mcp()],
    }, path.join(root, 'acplugin.config.ts'), 'build', 'production');
    expect(resolved.diagnostics).toEqual([]);

    const result = await buildProject({
      config: resolved.config!,
      compilers: new Map([
        ['claude-code', claudeCodeCompiler],
        ['codex', codexCompiler],
      ]),
      loadTypeScriptModule: loader,
      commit: true,
    });

    expect(result.report.success).toBe(true);
    expect(JSON.parse(await fs.readFile(path.join(root, 'dist/claude-code/.mcp.json'), 'utf8'))).toHaveProperty('mcpServers.docs.headers.Authorization', 'Bearer ${DOCS_TOKEN}');
    expect(JSON.parse(await fs.readFile(path.join(root, 'dist/codex/.mcp.json'), 'utf8'))).toMatchObject({
      'docs': { bearer_token_env_var: 'DOCS_TOKEN', env_http_headers: { 'X-Tenant': 'TENANT' } },
      'local-tools': { env_vars: ['LOCAL_TOKEN'] },
    });
    expect(JSON.parse(await fs.readFile(path.join(root, 'dist/codex/.codex-plugin/plugin.json'), 'utf8'))).toHaveProperty('mcpServers', './.mcp.json');
    expect(JSON.parse(await fs.readFile(path.join(root, 'dist/codex/hooks/hooks.json'), 'utf8'))).toHaveProperty('hooks.PreToolUse');
    const hookHandler = path.join(root, 'dist/codex/hooks/policy/handler.mjs');
    expect((await fs.stat(hookHandler)).mode & 0o111).not.toBe(0);
    const hookRun = await runNode(hookHandler, JSON.stringify({
      hook_event_name: 'PreToolUse',
      session_id: 'session',
      cwd: root,
      tool_name: 'Bash',
    }));
    expect(hookRun).toMatchObject({ code: 0, stderr: '' });
    expect(JSON.parse(hookRun.stdout)).toHaveProperty('hookSpecificOutput.permissionDecision', 'allow');
    const malformedRun = await runNode(hookHandler, 'secret-payload-that-is-not-json');
    expect(malformedRun.code).toBe(1);
    expect(malformedRun.stdout).toBe('');
    expect(malformedRun.stderr).toBe('acplugin hook error: INPUT_JSON_INVALID\n');
    expect(malformedRun.stderr).not.toContain('secret-payload');
    const permissionRun = await runNode(path.join(root, 'dist/codex/hooks/permission/handler.mjs'), JSON.stringify({
      hook_event_name: 'PermissionRequest', session_id: 'session', cwd: root,
    }));
    expect(permissionRun).toMatchObject({ code: 0, stdout: '', stderr: '' });
    const compactRun = await runNode(path.join(root, 'dist/codex/hooks/compact/handler.mjs'), JSON.stringify({
      hook_event_name: 'PreCompact', session_id: 'session', cwd: root,
    }));
    expect(compactRun).toMatchObject({ code: 0, stdout: '', stderr: '' });
    const invalidSessionEndRun = await runNode(path.join(root, 'dist/codex/hooks/session-end/handler.mjs'), JSON.stringify({
      hook_event_name: 'SessionEnd', session_id: 'session', cwd: root,
    }));
    expect(invalidSessionEndRun).toMatchObject({ code: 1, stdout: '', stderr: 'acplugin hook error: RESULT_DECISION_INVALID\n' });
    expect(await fs.readFile(path.join(root, 'dist/codex/hooks/policy/THIRD_PARTY_LICENSES.txt'), 'utf8')).toContain('license-fixture@1.2.3');
    const localServer = path.join(root, 'dist/codex/mcp/local-tools/server.mjs');
    const mcpRun = await runNode(localServer, [
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } } }),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      '',
    ].join('\n'));
    expect(mcpRun).toMatchObject({ code: 0, stderr: '' });
    expect(mcpRun.stdout.trim().split('\n').map(line => JSON.parse(line))).toEqual([
      expect.objectContaining({ id: 1, result: expect.objectContaining({ serverInfo: { name: 'fixture', version: '1.0.0' } }) }),
      expect.objectContaining({ id: 2, result: { tools: [] } }),
    ]);
    expect(await fs.readFile(path.join(root, 'dist/codex/mcp/local-tools/THIRD_PARTY_LICENSES.txt'), 'utf8')).toContain('Fixture MIT license text.');

    const installedRoot = path.join(root, 'installed-cache', 'module-plugin', '1.0.0');
    await fs.mkdir(path.dirname(installedRoot), { recursive: true });
    await fs.cp(path.join(root, 'dist/codex'), installedRoot, { recursive: true });
    const installedDescriptor = JSON.parse(await fs.readFile(path.join(installedRoot, '.mcp.json'), 'utf8')) as Record<string, { args: string[]; cwd: string }>;
    const installed = installedDescriptor['local-tools']!;
    const installedRun = await runNode(path.resolve(installedRoot, installed.cwd, installed.args[0]!), [
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } } }),
      '',
    ].join('\n'));
    expect(installedRun.code).toBe(0);
    expect(JSON.parse(installedRun.stdout)).toHaveProperty('result.serverInfo.name', 'fixture');
  });
});
