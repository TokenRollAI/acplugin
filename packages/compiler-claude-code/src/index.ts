import {
  bytesArtifact,
  markdownWithFrontmatter,
  stableJson,
  type AgentCapability,
  type Compiler,
  type CompilerContext,
  type CompilerOutput,
} from '@acplugin/core';

export const CLAUDE_CODE_TARGET = 'claude-code';

const RESERVED_MANIFEST_FIELDS = new Set([
  'name', 'version', 'description', 'commands', 'skills', 'agents',
]);

function mergeManifestFields(context: CompilerContext, manifest: Record<string, unknown>): void {
  const owners = new Map<string, string>();
  for (const { module, contribution } of context.contributions) {
    for (const [key, value] of Object.entries(contribution.manifestFields ?? {})) {
      if (RESERVED_MANIFEST_FIELDS.has(key))
        throw new Error(`Module ${module} cannot replace reserved manifest field ${key}.`);
      const owner = owners.get(key);
      if (owner)
        throw new Error(`Manifest field ${key} is contributed by both ${owner} and ${module}.`);
      owners.set(key, module);
      manifest[key] = value;
    }
  }
}

function claudeTools(capabilities: readonly AgentCapability[]): string[] {
  const result = new Set<string>();
  for (const capability of capabilities) {
    for (const tool of ({
      'filesystem:read': ['Read', 'Glob', 'Grep'],
      'filesystem:write': ['Write', 'Edit'],
      'search': ['Glob', 'Grep', 'WebSearch'],
      'shell': ['Bash'],
      'network': ['WebFetch', 'WebSearch'],
      'delegate': ['Agent'],
    } satisfies Record<AgentCapability, string[]>)[capability])
      result.add(tool);
  }
  return [...result].sort();
}

function claudeModel(model: 'inherit' | 'fast' | 'capable'): string {
  if (model === 'fast')
    return 'haiku';
  if (model === 'capable')
    return 'sonnet';
  return 'inherit';
}

export const claudeCodeCompiler: Compiler = {
  id: CLAUDE_CODE_TARGET,
  async compile(context): Promise<CompilerOutput> {
    const artifacts = [];
    const compatibility = [];
    const { project } = context;

    for (const command of project.commands) {
      const frontmatter: Record<string, unknown> = { description: command.description };
      if (command.argumentHint)
        frontmatter['argument-hint'] = command.argumentHint;
      artifacts.push(bytesArtifact(
        `commands/${command.id}.md`,
        markdownWithFrontmatter(frontmatter, command.body.replaceAll('{{arguments}}', '$ARGUMENTS')),
      ));
      compatibility.push({ target: CLAUDE_CODE_TARGET, subject: `command:${command.id}`, capability: 'component', level: 'native', reason: 'Claude Code supports plugin Commands.' } as const);
    }

    for (const skill of project.skills) {
      artifacts.push(bytesArtifact(`skills/${skill.id}/SKILL.md`, markdownWithFrontmatter({
        'name': skill.id,
        'description': skill.description,
        'user-invocable': skill.invocation.user,
        'disable-model-invocation': !skill.invocation.model,
      }, skill.body)));
      for (const auxiliary of skill.auxiliaryFiles) {
        artifacts.push({
          path: `skills/${skill.id}/${auxiliary.path}`,
          source: { type: 'file' as const, path: auxiliary.sourcePath },
          mode: auxiliary.mode,
        });
      }
      compatibility.push({ target: CLAUDE_CODE_TARGET, subject: `skill:${skill.id}`, capability: 'component', level: 'native', reason: 'Claude Code supports plugin Skills.' } as const);
    }

    for (const agent of project.agents) {
      const tools = claudeTools(agent.capabilities);
      artifacts.push(bytesArtifact(`agents/${agent.id}.md`, markdownWithFrontmatter({
        name: agent.id,
        description: agent.description,
        model: claudeModel(agent.model),
        tools: tools.length > 0 ? tools : undefined,
      }, agent.body)));
      compatibility.push({ target: CLAUDE_CODE_TARGET, subject: `agent:${agent.id}`, capability: 'component', level: 'native', reason: 'Claude Code supports plugin Agents.' } as const);
    }

    const manifest: Record<string, unknown> = {
      name: project.name,
      version: project.version,
      description: project.description,
    };
    if (project.commands.length > 0)
      manifest.commands = './commands/';
    if (project.skills.length > 0)
      manifest.skills = './skills/';
    if (project.agents.length > 0)
      manifest.agents = './agents/';
    mergeManifestFields(context, manifest);
    artifacts.push(bytesArtifact('.claude-plugin/plugin.json', stableJson(manifest)));

    return { artifacts, compatibility };
  },
};

export default claudeCodeCompiler;
