import type { Agent, Platform, ConvertedFile } from '../types.js';
import { stringifyFrontmatter } from '../utils/frontmatter.js';
import { toToml } from '../utils/toml.js';
import { mapModel } from '../utils/model.js';

export function convertAgent(agent: Agent, platform: Platform): ConvertedFile {
  switch (platform) {
    case 'codex':
      return convertToCodex(agent);
    case 'opencode':
      return convertToOpenCode(agent);
    case 'cursor':
      return convertToCursor(agent);
    case 'antigravity':
      return convertToAntigravity(agent);
  }
}

// --- Codex: .codex/agents/*.toml ---

function convertToCodex(agent: Agent): ConvertedFile {
  const name = agent.frontmatter.name || agent.fileName;
  const tomlData: Record<string, unknown> = {
    name,
    description: agent.frontmatter.description || `Agent: ${name}`,
    developer_instructions: agent.body.trim(),
  };

  if (agent.frontmatter.model) {
    tomlData.model = mapModel(agent.frontmatter.model, 'codex');
  } else {
    tomlData.model = 'gpt-5.4';
  }

  if (agent.frontmatter.tools) {
    const tools = agent.frontmatter.tools.toLowerCase();
    if (tools.includes('bash') || tools.includes('write') || tools.includes('edit')) {
      tomlData.sandbox_mode = 'workspace-write';
    } else {
      tomlData.sandbox_mode = 'read-only';
    }
  }

  if (agent.frontmatter.effort) {
    tomlData.model_reasoning_effort = agent.frontmatter.effort;
  }

  const content = `# Converted from Claude Code agent: ${name}\n\n` + toToml(tomlData);
  return { path: `.codex/agents/${agent.fileName}.toml`, content, type: 'agent' };
}

// --- OpenCode: .opencode/agents/*.md (YAML frontmatter) ---

function convertToOpenCode(agent: Agent): ConvertedFile {
  const name = agent.frontmatter.name || agent.fileName;
  const fm: Record<string, unknown> = {
    description: agent.frontmatter.description || `Agent: ${name}`,
    mode: 'subagent',
  };

  if (agent.frontmatter.model) {
    fm.model = mapModel(agent.frontmatter.model, 'opencode');
  }

  if (agent.frontmatter.maxTurns) {
    fm.steps = agent.frontmatter.maxTurns;
  }

  // Map tools → permission
  if (agent.frontmatter.tools) {
    const tools = agent.frontmatter.tools.toLowerCase();
    const permission: Record<string, string> = {};
    if (!tools.includes('write') && !tools.includes('edit')) {
      permission.edit = 'deny';
    }
    if (!tools.includes('bash')) {
      permission.bash = 'deny';
    }
    if (Object.keys(permission).length > 0) {
      fm.permission = permission;
    }
  }

  const content = stringifyFrontmatter(fm, agent.body);
  return { path: `.opencode/agents/${agent.fileName}.md`, content, type: 'agent' };
}

// --- Cursor: .cursor/agents/*.md (YAML frontmatter) ---

function convertToCursor(agent: Agent): ConvertedFile {
  const name = agent.frontmatter.name || agent.fileName;
  const fm: Record<string, unknown> = {
    name,
    description: agent.frontmatter.description || `Agent: ${name}`,
  };

  if (agent.frontmatter.model) {
    fm.model = mapModel(agent.frontmatter.model, 'cursor');
  }

  // Map tools to readonly
  if (agent.frontmatter.tools) {
    const tools = agent.frontmatter.tools.toLowerCase();
    if (!tools.includes('write') && !tools.includes('edit') && !tools.includes('bash')) {
      fm.readonly = true;
    }
  }

  const content = stringifyFrontmatter(fm, agent.body);
  return { path: `.cursor/agents/${agent.fileName}.md`, content, type: 'agent' };
}

// --- Antigravity: .gemini/agents/*.md (YAML frontmatter) ---

function convertToAntigravity(agent: Agent): ConvertedFile {
  const name = agent.frontmatter.name || agent.fileName;
  const fm: Record<string, unknown> = {
    name,
    description: agent.frontmatter.description || `Agent: ${name}`,
  };

  if (agent.frontmatter.model) {
    fm.model = mapModel(agent.frontmatter.model, 'antigravity');
  }

  // Map tools to allowed-tools list
  if (agent.frontmatter.tools) {
    const toolList = agent.frontmatter.tools.split(',').map(t => t.trim().toLowerCase());
    const mapped: string[] = [];
    for (const t of toolList) {
      if (t === 'read') mapped.push('read_file');
      else if (t === 'grep') mapped.push('search_files');
      else if (t === 'glob') mapped.push('list_files');
      else if (t === 'bash') mapped.push('run_terminal_command');
      else if (t === 'write') mapped.push('write_file');
      else if (t === 'edit') mapped.push('edit_file');
      else mapped.push(t);
    }
    fm['allowed-tools'] = mapped;
  }

  const content = stringifyFrontmatter(fm, agent.body);
  return { path: `.gemini/agents/${agent.fileName}.md`, content, type: 'agent' };
}
