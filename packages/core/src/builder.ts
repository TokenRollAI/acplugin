import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ArtifactGraph } from './artifacts.js';
import { applyCompatibilityStrictness, DiagnosticCollector, sanitizeReportText, sortCompatibility } from './diagnostics.js';
import { scanProject } from './scanner.js';
import { commitManagedOutput, validateMaterialization } from './transaction.js';
import type {
  AcpluginModule,
  Artifact,
  ArtifactReportEntry,
  BuildReport,
  BuildRequest,
  BuildResult,
  CompatibilityEntry,
  Diagnostic,
  ModuleBaseContext,
  PluginProject,
  TargetContribution,
  TargetId,
} from './types.js';

interface ModuleRuntime {
  module: AcpluginModule;
  workDir: string;
  state: unknown;
  builtState: unknown;
}

function sortModules(modules: readonly AcpluginModule[]): AcpluginModule[] {
  const byName = new Map(modules.map(module => [module.name, module]));
  const configuredIndex = new Map(modules.map((module, index) => [module.name, index]));
  const result: AcpluginModule[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (module: AcpluginModule, stack: string[]): void => {
    if (visited.has(module.name))
      return;
    if (visiting.has(module.name))
      throw new Error(`Module dependency cycle: ${[...stack, module.name].join(' -> ')}`);
    visiting.add(module.name);
    for (const dependency of module.dependsOn ?? []) {
      const target = byName.get(dependency);
      if (!target)
        throw new Error(`Module "${module.name}" requires missing module "${dependency}".`);
      visit(target, [...stack, module.name]);
    }
    visiting.delete(module.name);
    visited.add(module.name);
    result.push(module);
  };

  for (const module of [...modules].sort((a, b) => (configuredIndex.get(a.name) ?? 0) - (configuredIndex.get(b.name) ?? 0)))
    visit(module, []);
  return result;
}

function dependencyMap(
  runtime: ModuleRuntime,
  all: ReadonlyMap<string, ModuleRuntime>,
  field: 'state' | 'builtState',
): ReadonlyMap<string, unknown> {
  return new Map((runtime.module.dependsOn ?? []).map(name => [name, all.get(name)?.[field]]));
}

function moduleContext(
  request: BuildRequest,
  diagnostics: DiagnosticCollector,
  runtime: ModuleRuntime,
  all: ReadonlyMap<string, ModuleRuntime>,
): ModuleBaseContext {
  return {
    config: request.config,
    diagnostics,
    loadTypeScriptModule: request.loadTypeScriptModule,
    workDir: runtime.workDir,
    dependencyState: dependencyMap(runtime, all, 'state'),
    dependencyBuiltState: dependencyMap(runtime, all, 'builtState'),
  };
}

function createReport(
  request: BuildRequest,
  project: PluginProject | undefined,
  diagnostics: readonly Diagnostic[],
  compatibility: readonly CompatibilityEntry[],
  artifacts: readonly ArtifactReportEntry[],
  committed: boolean,
): BuildReport {
  return {
    schemaVersion: '1',
    command: request.config.command,
    mode: request.config.mode,
    project: { name: request.config.name, version: request.config.version },
    targets: request.config.targets.map(target => target.id),
    diagnostics,
    compatibility: sortCompatibility(compatibility),
    artifacts: request.config.command === 'validate'
      ? []
      : [...artifacts].sort((a, b) => a.target.localeCompare(b.target, 'en') || a.path.localeCompare(b.path, 'en')),
    success: !diagnostics.some(diagnostic => diagnostic.severity === 'error') && project !== undefined,
    committed,
  };
}

export async function buildProject(request: BuildRequest): Promise<BuildResult> {
  const diagnostics = new DiagnosticCollector();
  const compatibility: CompatibilityEntry[] = [];
  const artifactReports: ArtifactReportEntry[] = [];
  const targetArtifacts = new Map<TargetId, readonly Artifact[]>();
  const runtimeRoot = await fs.mkdtemp(path.join(request.config.root, '.acplugin-work-'));
  const runtimes = new Map<string, ModuleRuntime>();
  const initialized: ModuleRuntime[] = [];
  let project: PluginProject | undefined;
  let originalError: unknown;
  let committed = false;
  let finalized = false;

  const finalizeModules = async (cause: unknown): Promise<unknown> => {
    if (finalized)
      return cause;
    finalized = true;
    let cleanupCause = cause;
    for (const runtime of [...initialized].reverse()) {
      try {
        const context = moduleContext(request, diagnostics, runtime, runtimes);
        await runtime.module.buildEnd?.(cleanupCause === undefined ? context : { ...context, error: cleanupCause });
      } catch (error) {
        cleanupCause ??= error;
        diagnostics.error('MODULE_BUILD_END_FAILED', `Module ${runtime.module.name} buildEnd failed.`, { phase: 'buildEnd', module: runtime.module.name });
      }
    }
    return cleanupCause;
  };

  try {
    let orderedModules: AcpluginModule[];
    try {
      orderedModules = sortModules(request.config.modules);
    } catch {
      diagnostics.error('MODULE_GRAPH_INVALID', 'Module dependency graph is invalid.', { phase: 'config' });
      orderedModules = [];
    }

    for (const module of orderedModules) {
      const runtime: ModuleRuntime = {
        module,
        workDir: path.join(runtimeRoot, encodeURIComponent(module.name)),
        state: undefined,
        builtState: undefined,
      };
      await fs.mkdir(runtime.workDir, { recursive: true });
      runtimes.set(module.name, runtime);
      try {
        await module.configResolved?.(request.config);
        initialized.push(runtime);
      } catch {
        diagnostics.error('MODULE_HOOK_FAILED', `Module ${module.name} configResolved failed.`, { phase: 'configResolved', module: module.name });
      }
    }

    for (const runtime of initialized) {
      try {
        runtime.state = await runtime.module.discover?.(moduleContext(request, diagnostics, runtime, runtimes));
      } catch {
        diagnostics.error('MODULE_HOOK_FAILED', `Module ${runtime.module.name} discover failed.`, { phase: 'discover', module: runtime.module.name });
      }
    }

    const scanned = await scanProject(request.config, diagnostics);
    project = scanned.project;

    for (const runtime of initialized) {
      try {
        await runtime.module.validate?.({ ...moduleContext(request, diagnostics, runtime, runtimes), project }, runtime.state);
      } catch {
        diagnostics.error('MODULE_HOOK_FAILED', `Module ${runtime.module.name} validate failed.`, { phase: 'validate', module: runtime.module.name });
      }
    }

    if (!diagnostics.hasErrors) {
      for (const runtime of initialized) {
        try {
          runtime.builtState = await runtime.module.build?.({ ...moduleContext(request, diagnostics, runtime, runtimes), project }, runtime.state);
        } catch {
          diagnostics.error('MODULE_HOOK_FAILED', `Module ${runtime.module.name} build failed.`, { phase: 'build', module: runtime.module.name });
        }
      }
    }

    if (!diagnostics.hasErrors) {
      for (const target of request.config.targets) {
        const errorsBeforeTarget = diagnostics.diagnostics.filter(item => item.severity === 'error').length;
        const compiler = request.compilers.get(target.id);
        if (!compiler) {
          diagnostics.error('COMPILER_MISSING', `No Compiler registered for ${target.id}.`, { phase: 'generate', target: target.id });
          continue;
        }
        const contributions: { module: string; contribution: TargetContribution }[] = [];
        for (const runtime of initialized) {
          try {
            const contribution = await runtime.module.generate?.(
              { ...moduleContext(request, diagnostics, runtime, runtimes), project: project!, target: target.id },
              runtime.state,
              runtime.builtState,
            );
            if (contribution)
              contributions.push({ module: runtime.module.name, contribution });
          } catch {
            diagnostics.error('MODULE_HOOK_FAILED', `Module ${runtime.module.name} generate failed.`, { phase: 'generate', module: runtime.module.name, target: target.id });
          }
        }
        if (diagnostics.diagnostics.filter(item => item.severity === 'error').length > errorsBeforeTarget)
          continue;
        try {
          const output = await compiler.compile({ config: request.config, project: project!, target, contributions, diagnostics });
          const targetCompatibility = [
            ...output.compatibility,
            ...contributions.flatMap(item => item.contribution.compatibility ?? []),
          ];
          compatibility.push(...targetCompatibility);
          applyCompatibilityStrictness(diagnostics, target, targetCompatibility);

          const graph = new ArtifactGraph([request.config.root, runtimeRoot]);
          for (const publicFile of project!.publicFiles)
            await graph.add('public', { path: publicFile.targetPath, source: { type: 'file', path: publicFile.sourcePath }, mode: publicFile.mode });
          for (const artifact of output.artifacts)
            await graph.add(`compiler:${target.id}`, artifact);
          for (const item of contributions) {
            for (const artifact of item.contribution.artifacts ?? [])
              await graph.add(`module:${item.module}`, artifact);
          }
          targetArtifacts.set(target.id, graph.artifacts);
          for (const artifact of graph.artifacts) {
            artifactReports.push({
              target: target.id,
              path: artifact.path,
              owner: sanitizeReportText(artifact.owner),
              mode: artifact.mode,
              size: artifact.size,
              sha256: artifact.sha256,
            });
          }
        } catch {
          diagnostics.error('TARGET_GENERATION_FAILED', `${target.id} generation failed.`, { phase: 'generate', target: target.id });
        }
      }
    }

    if (!diagnostics.hasErrors && targetArtifacts.size === request.config.targets.length) {
      if (request.commit) {
        await commitManagedOutput(request.config.outDir, targetArtifacts, {
          async afterSwap() {
            originalError = await finalizeModules(originalError);
            if (originalError !== undefined)
              throw originalError;
          },
        });
        committed = true;
      } else {
        await validateMaterialization(targetArtifacts);
        originalError = await finalizeModules(originalError);
      }
    }
  } catch (error) {
    originalError ??= error;
    if (!diagnostics.hasErrors)
      diagnostics.error('BUILD_INTERNAL_FAILED', 'The build failed inside the framework.', { phase: 'internal' });
  } finally {
    if (originalError === undefined && diagnostics.hasErrors)
      originalError = new Error('Build failed; see diagnostics.');
    originalError = await finalizeModules(originalError);
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  }

  const result: BuildResult = {
    report: createReport(request, project, diagnostics.diagnostics, compatibility, artifactReports, committed),
  };
  if (project !== undefined)
    result.project = project;
  return result;
}
