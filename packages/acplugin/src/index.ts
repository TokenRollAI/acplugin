import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createJiti } from 'jiti';
import {
  buildProject,
  resolveConfig,
  type BuildCommand,
  type BuildMode,
  type BuildResult,
  type ResolvedConfig,
  type TargetId,
  type UserConfig,
  type UserConfigExport,
} from '@acplugin/core';
import { claudeCodeCompiler } from '@acplugin/compiler-claude-code';
import { codexCompiler } from '@acplugin/compiler-codex';

export * from '@acplugin/core';
export * from './init.js';

export const ACPLUGIN_VERSION = '1.0.0';

export class ProjectConfigError extends Error {
  readonly diagnostics: readonly import('@acplugin/core').Diagnostic[];

  constructor(
    message: string,
    diagnostics: readonly import('@acplugin/core').Diagnostic[],
    cause?: unknown,
  ) {
    if (cause === undefined)
      super(message);
    else
      super(message, { cause });
    this.name = 'ProjectConfigError';
    this.diagnostics = diagnostics;
  }
}

export function defineConfig(config: UserConfigExport): UserConfigExport {
  return config;
}

export interface LoadProjectConfigOptions {
  cwd?: string;
  configPath?: string;
  command: BuildCommand;
  mode: BuildMode;
}

export interface LoadedProjectConfig {
  config: ResolvedConfig;
  loadTypeScriptModule(path: string): Promise<unknown>;
}

async function importDefault(jiti: ReturnType<typeof createJiti>, modulePath: string): Promise<unknown> {
  return jiti.import(modulePath, { default: true });
}

export async function loadProjectConfig(options: LoadProjectConfigOptions): Promise<LoadedProjectConfig> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const configPath = path.resolve(cwd, options.configPath ?? 'acplugin.config.ts');
  const displayPath = path.relative(cwd, configPath).split(path.sep).join('/') || path.basename(configPath);
  try {
    const stat = await fs.lstat(configPath);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error('Configuration must be a regular non-symlink file.');
  } catch (error) {
    const reason = (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? 'file does not exist.'
      : 'file cannot be accessed as a regular non-symlink file.';
    const message = `Cannot load ${displayPath}: ${reason}`;
    throw new ProjectConfigError(message, [{
      code: 'CONFIG_LOAD_FAILED',
      severity: 'error',
      message,
      phase: 'config',
      location: { path: displayPath },
    }], error);
  }

  const jiti = createJiti(import.meta.url, {
    interopDefault: true,
    moduleCache: false,
    fsCache: false,
  });
  let exported: UserConfigExport;
  try {
    exported = await importDefault(jiti, configPath) as UserConfigExport;
  } catch (error) {
    const message = `Cannot evaluate ${displayPath}.`;
    throw new ProjectConfigError(message, [{
      code: 'CONFIG_EVALUATION_FAILED',
      severity: 'error',
      message,
      phase: 'config',
      location: { path: displayPath },
    }], error);
  }
  let value: UserConfig;
  try {
    value = (typeof exported === 'function'
      ? await exported({ command: options.command, mode: options.mode })
      : exported) as UserConfig;
  } catch (error) {
    const message = `Configuration function in ${displayPath} failed.`;
    throw new ProjectConfigError(message, [{
      code: 'CONFIG_FUNCTION_FAILED',
      severity: 'error',
      message,
      phase: 'config',
      location: { path: displayPath },
    }], error);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new ProjectConfigError('acplugin.config.ts must export a config object or a function returning one.', [{
      code: 'CONFIG_EXPORT_INVALID',
      severity: 'error',
      message: 'acplugin.config.ts must export a config object or a function returning one.',
      phase: 'config',
      location: { path: displayPath },
    }]);

  const resolved = resolveConfig(value, configPath, options.command, options.mode);
  if (!resolved.config) {
    const details = resolved.diagnostics.map(diagnostic => `${diagnostic.code}: ${diagnostic.message}`).join('\n');
    throw new ProjectConfigError(details || 'Configuration is invalid.', resolved.diagnostics);
  }

  return {
    config: resolved.config,
    loadTypeScriptModule: modulePath => importDefault(jiti, modulePath),
  };
}

export interface RunProjectOptions extends LoadProjectConfigOptions {
  targets?: readonly TargetId[];
  strict?: boolean;
  commit?: boolean;
}

export async function runProject(options: RunProjectOptions): Promise<BuildResult> {
  const loaded = await loadProjectConfig(options);
  let config = loaded.config;
  if (options.targets || options.strict !== undefined) {
    const targetIds = options.targets ?? config.targets.map(target => target.id);
    const strict = options.strict;
    config = {
      ...config,
      targets: targetIds.map(id => ({
        id,
        strict: strict ?? config.targets.find(target => target.id === id)?.strict ?? config.strict,
      })),
    };
  }
  return buildProject({
    config,
    compilers: new Map([
      ['claude-code', claudeCodeCompiler],
      ['codex', codexCompiler],
    ]),
    loadTypeScriptModule: loaded.loadTypeScriptModule,
    commit: options.commit ?? (options.command === 'build' || options.command === 'dev'),
  });
}
