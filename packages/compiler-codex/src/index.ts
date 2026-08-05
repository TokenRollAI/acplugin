import {
  bytesArtifact,
  markdownWithFrontmatter,
  stableJson,
  stableYaml,
  type Compiler,
  type CompilerContext,
  type CompilerOutput,
  type Component,
} from '@acplugin/core';

export const CODEX_TARGET = 'codex';

const RESERVED_MANIFEST_FIELDS = new Set(['name', 'version', 'description', 'skills']);

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

function requiresAgent(component: Component, byKey: ReadonlyMap<string, Component>, seen = new Set<string>()): boolean {
  const key = `${component.kind}:${component.id}`;
  if (seen.has(key))
    return false;
  seen.add(key);
  if (component.requires.agents.length > 0)
    return true;
  return component.requires.skills.some((id) => {
    const dependency = byKey.get(`skill:${id}`);
    return dependency ? requiresAgent(dependency, byKey, seen) : false;
  });
}

function skillMetadata(modelInvocation: boolean): string | undefined {
  if (modelInvocation)
    return undefined;
  return `${stableYaml({ policy: { allow_implicit_invocation: false } })}\n`;
}

export const codexCompiler: Compiler = {
  id: CODEX_TARGET,
  async compile(context): Promise<CompilerOutput> {
    const artifacts = [];
    const compatibility = [];
    const generatedIds = new Map<string, string>();
    const allComponents: Component[] = [...context.project.commands, ...context.project.skills, ...context.project.agents];
    const byKey = new Map(allComponents.map(component => [`${component.kind}:${component.id}`, component]));

    const reserve = (id: string, subject: string): void => {
      const collision = generatedIds.get(id.toLocaleLowerCase('en-US'));
      if (collision)
        throw new Error(`Generated Codex Skill ID collision: ${collision} and ${subject} both use ${id}.`);
      generatedIds.set(id.toLocaleLowerCase('en-US'), subject);
    };

    for (const skill of context.project.skills) {
      reserve(skill.id, `skill:${skill.id}`);
      artifacts.push(bytesArtifact(`skills/${skill.id}/SKILL.md`, markdownWithFrontmatter({
        name: skill.id,
        description: skill.description,
      }, skill.body)));
      const metadata = skillMetadata(skill.invocation.model);
      if (metadata)
        artifacts.push(bytesArtifact(`skills/${skill.id}/agents/openai.yaml`, metadata));
      for (const auxiliary of skill.auxiliaryFiles) {
        artifacts.push({
          path: `skills/${skill.id}/${auxiliary.path}`,
          source: { type: 'file' as const, path: auxiliary.sourcePath },
          mode: auxiliary.mode,
        });
      }
      if (!skill.invocation.user) {
        compatibility.push({
          target: CODEX_TARGET,
          subject: `skill:${skill.id}`,
          capability: 'invocation.user',
          level: 'degraded',
          transformation: 'The Skill remains explicitly invocable.',
          reason: 'Codex Skill metadata cannot disable explicit user invocation.',
        } as const);
      } else {
        compatibility.push({ target: CODEX_TARGET, subject: `skill:${skill.id}`, capability: 'component', level: 'native', reason: 'Codex supports plugin Skills.' } as const);
      }
    }

    for (const command of context.project.commands) {
      const id = `command-${command.id}`;
      reserve(id, `command:${command.id}`);
      artifacts.push(bytesArtifact(`skills/${id}/SKILL.md`, markdownWithFrontmatter({
        name: id,
        description: command.description,
      }, command.body.replaceAll('{{arguments}}', 'the arguments supplied with this explicit invocation'))));
      artifacts.push(bytesArtifact(`skills/${id}/agents/openai.yaml`, skillMetadata(false)!));
      compatibility.push({
        target: CODEX_TARGET,
        subject: `command:${command.id}`,
        capability: 'component',
        level: 'transform',
        transformation: `Explicit Skill ${id}`,
        reason: 'Codex represents Commands as explicitly invoked Skills.',
      } as const);
    }

    for (const agent of context.project.agents) {
      const id = `agent-${agent.id}`;
      reserve(id, `agent:${agent.id}`);
      const guidance = [
        agent.body,
        '',
        `Intended model class: ${agent.model}.`,
        `Intended capabilities: ${agent.capabilities.join(', ') || 'none declared'}.`,
        'When delegation is available, use a focused subagent with this role. These settings are guidance, not enforced registration.',
      ].join('\n');
      artifacts.push(bytesArtifact(`skills/${id}/SKILL.md`, markdownWithFrontmatter({
        name: id,
        description: agent.description,
      }, guidance)));
      compatibility.push({
        target: CODEX_TARGET,
        subject: `agent:${agent.id}`,
        capability: 'component',
        level: 'degraded',
        transformation: `Model-only fallback Skill ${id}`,
        reason: 'Codex installable plugins cannot register project/user custom Agents; model and capability enforcement are lost.',
      } as const);
    }

    for (const component of allComponents) {
      if (component.kind !== 'agent' && requiresAgent(component, byKey)) {
        compatibility.push({
          target: CODEX_TARGET,
          subject: `${component.kind}:${component.id}`,
          capability: 'requires.agents',
          level: 'degraded',
          reason: 'A required Agent is degraded to a fallback Skill on Codex.',
          causes: component.requires.agents.map(id => `agent:${id}`),
        } as const);
      }
    }

    const manifest: Record<string, unknown> = {
      name: context.project.name,
      version: context.project.version,
      description: context.project.description,
    };
    if (generatedIds.size > 0)
      manifest.skills = './skills/';
    mergeManifestFields(context, manifest);
    artifacts.push(bytesArtifact('.codex-plugin/plugin.json', stableJson(manifest)));

    return { artifacts, compatibility };
  },
};

export default codexCompiler;
