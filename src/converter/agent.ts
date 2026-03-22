import type { Agent, Platform, ConvertedFile } from '../types.js';
import { stringifyFrontmatter } from '../utils/frontmatter.js';

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
  // Codex doesn't have agent files — embed as AGENTS.md section
  const lines = [`## Agent: ${agent.frontmatter.name || agent.fileName}\n`];

  if (agent.frontmatter.description) {
    lines.push(`**Description:** ${agent.frontmatter.description}\n`);
  }
  if (agent.frontmatter.tools) {
    lines.push(`**Tools:** ${agent.frontmatter.tools}\n`);
  }
  if (agent.frontmatter.model) {
    lines.push(`**Model:** ${agent.frontmatter.model}\n`);
  }

  lines.push('', agent.body);

  return {
    path: `AGENTS.md.agent-${agent.fileName}`,
    content: lines.join('\n'),
    type: 'agent',
  };
}

function convertToOpenCode(agent: Agent): ConvertedFile {
  // OpenCode supports agent files with similar format
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
  // Cursor doesn't support custom agents — convert to a rule
  const fm: Record<string, unknown> = {
    description: `Agent behavior: ${agent.frontmatter.description || agent.frontmatter.name || agent.fileName}`,
    alwaysApply: false, // Agent-requested: only applied when relevant
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
