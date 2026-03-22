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
  }
}

function convertToCodex(agent: Agent): ConvertedFile {
  // Codex uses .codex/agents/*.toml for subagents
  const name = agent.frontmatter.name || agent.fileName;
  const tomlData: Record<string, unknown> = {
    name,
    description: agent.frontmatter.description || `Agent: ${name}`,
    developer_instructions: agent.body.trim(),
  };

  // Map model
  if (agent.frontmatter.model) {
    tomlData.model = mapModel(agent.frontmatter.model, 'codex');
  } else {
    tomlData.model = 'gpt-5.4';
  }

  // Map tools → sandbox_mode
  if (agent.frontmatter.tools) {
    const tools = agent.frontmatter.tools.toLowerCase();
    if (tools.includes('bash') || tools.includes('write') || tools.includes('edit')) {
      tomlData.sandbox_mode = 'workspace-write';
    } else {
      tomlData.sandbox_mode = 'read-only';
    }
  }

  // Map effort → model_reasoning_effort
  if (agent.frontmatter.effort) {
    tomlData.model_reasoning_effort = agent.frontmatter.effort;
  }

  const content = `# Converted from Claude Code agent: ${name}\n\n` + toToml(tomlData);

  return {
    path: `.codex/agents/${agent.fileName}.toml`,
    content,
    type: 'agent',
  };
}

function convertToOpenCode(agent: Agent): ConvertedFile {
  const fm: Record<string, unknown> = {};

  if (agent.frontmatter.name) fm.name = agent.frontmatter.name;
  if (agent.frontmatter.description) fm.description = agent.frontmatter.description;
  if (agent.frontmatter.tools) fm.tools = agent.frontmatter.tools;
  if (agent.frontmatter.model) fm.model = agent.frontmatter.model;
  if (agent.frontmatter.maxTurns) fm.maxTurns = agent.frontmatter.maxTurns;

  const content = stringifyFrontmatter(fm, agent.body);
  return {
    path: `.opencode/agents/${agent.fileName}.md`,
    content,
    type: 'agent',
  };
}

function convertToCursor(agent: Agent): ConvertedFile {
  const fm: Record<string, unknown> = {
    description: `Agent behavior: ${agent.frontmatter.description || agent.frontmatter.name || agent.fileName}`,
    alwaysApply: false,
  };

  const body = buildAgentRuleBody(agent);
  const content = stringifyFrontmatter(fm, body);

  return {
    path: `.cursor/rules/agent-${agent.fileName}.mdc`,
    content,
    type: 'agent',
  };
}

function buildAgentRuleBody(agent: Agent): string {
  const lines: string[] = [];

  lines.push(`# Agent: ${agent.frontmatter.name || agent.fileName}\n`);

  if (agent.frontmatter.description) {
    lines.push(`> ${agent.frontmatter.description}\n`);
  }

  if (agent.frontmatter.tools) {
    lines.push(`**Available tools:** ${agent.frontmatter.tools}\n`);
  }

  if (agent.frontmatter.disallowedTools) {
    lines.push(`**Restricted tools:** ${agent.frontmatter.disallowedTools}\n`);
  }

  lines.push('', agent.body);

  return lines.join('\n');
}
