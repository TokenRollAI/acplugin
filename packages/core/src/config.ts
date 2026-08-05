import path from 'node:path';
import semver from 'semver';
import type {
  BuildCommand,
  BuildMode,
  PlatformExtensions,
  ResolvedConfig,
  ResolvedPublicConfig,
  ResolvedTarget,
  TargetId,
  UserConfig,
} from './types.js';
import { TARGET_IDS } from './types.js';
import { DiagnosticCollector } from './diagnostics.js';
import { extensionIssues } from './extensions.js';

const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MODULE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const ALLOWED_FIELDS = new Set([
  'name', 'version', 'description', 'displayName', 'srcDir', 'public',
  'targets', 'modules', 'build', 'extensions',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function rejectUnknownFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  fieldPath: readonly (string | number)[],
  diagnostics: DiagnosticCollector,
): void {
  const accepted = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!accepted.has(key)) {
      diagnostics.error('CONFIG_FIELD_UNKNOWN', `Unknown configuration field "${[...fieldPath, key].join('.')}` + '".', {
        phase: 'config', fieldPath: [...fieldPath, key],
      });
    }
  }
}

function presentationName(name: string): string {
  return name.split('-').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function resolveInside(root: string, value: string, field: string, diagnostics: DiagnosticCollector): string {
  const resolved = path.resolve(root, value);
  if (!isInside(root, resolved)) {
    diagnostics.error('CONFIG_PATH_ESCAPE', `${field} must stay inside the project root.`, {
      phase: 'config', fieldPath: [field],
    });
  }
  return resolved;
}

function resolveTargets(
  targets: readonly unknown[] | undefined,
  strict: boolean,
  diagnostics: DiagnosticCollector,
): ResolvedTarget[] {
  const input: readonly unknown[] = targets ?? TARGET_IDS;
  const seen = new Set<TargetId>();
  const resolved: ResolvedTarget[] = [];

  if (input.length === 0)
    diagnostics.error('CONFIG_TARGETS_EMPTY', 'targets must contain at least one target.', { phase: 'config', fieldPath: ['targets'] });

  for (const target of input) {
    if (typeof target !== 'string' && !isRecord(target)) {
      diagnostics.error('CONFIG_TARGET_INVALID', 'Every target must be a target ID or target object.', { phase: 'config', fieldPath: ['targets'] });
      continue;
    }
    if (isRecord(target)) {
      rejectUnknownFields(target, ['id', 'strict'], ['targets'], diagnostics);
      if (target.strict !== undefined && typeof target.strict !== 'boolean')
        diagnostics.error('CONFIG_TARGET_STRICT_INVALID', 'Target strict must be boolean.', { phase: 'config', fieldPath: ['targets', 'strict'] });
    }
    const id = typeof target === 'string' ? target : target.id;
    if (typeof id !== 'string') {
      diagnostics.error('CONFIG_TARGET_INVALID', 'Target id must be a string.', { phase: 'config', fieldPath: ['targets', 'id'] });
      continue;
    }
    if (!TARGET_IDS.includes(id as TargetId)) {
      diagnostics.error('CONFIG_TARGET_UNKNOWN', `Unknown target "${id}".`, { phase: 'config', fieldPath: ['targets'] });
      continue;
    }
    if (seen.has(id as TargetId)) {
      diagnostics.error('CONFIG_TARGET_DUPLICATE', `Target "${id}" is duplicated.`, { phase: 'config', fieldPath: ['targets'] });
      continue;
    }
    seen.add(id as TargetId);
    resolved.push({ id: id as TargetId, strict: typeof target === 'string' || typeof target.strict !== 'boolean' ? strict : target.strict });
  }

  return resolved;
}

function resolvePublic(root: string, value: unknown, diagnostics: DiagnosticCollector): ResolvedPublicConfig {
  if (value === false)
    return { enabled: false, dir: path.join(root, 'public') };
  if (typeof value === 'string')
    return { enabled: true, dir: resolveInside(root, value, 'public', diagnostics) };
  if (value !== undefined && !isRecord(value)) {
    diagnostics.error('CONFIG_PUBLIC_INVALID', 'public must be false, a directory string, or an object.', { phase: 'config', fieldPath: ['public'] });
    return { enabled: true, dir: path.join(root, 'public') };
  }

  const object = value ?? {};
  rejectUnknownFields(object, ['dir', 'copy'], ['public'], diagnostics);
  if (object.dir !== undefined && typeof object.dir !== 'string')
    diagnostics.error('CONFIG_PUBLIC_DIR_INVALID', 'public.dir must be a string.', { phase: 'config', fieldPath: ['public', 'dir'] });
  const dir = resolveInside(root, typeof object.dir === 'string' ? object.dir : 'public', 'public.dir', diagnostics);
  const copy: { from: string; to: string }[] = [];
  if (object.copy !== undefined && !Array.isArray(object.copy))
    diagnostics.error('CONFIG_PUBLIC_COPY_INVALID', 'public.copy must be an array.', { phase: 'config', fieldPath: ['public', 'copy'] });
  if (Array.isArray(object.copy)) {
    for (const [index, rawRule] of object.copy.entries()) {
      if (!isRecord(rawRule)) {
        diagnostics.error('CONFIG_PUBLIC_RULE_INVALID', 'Every Public copy rule must be an object.', { phase: 'config', fieldPath: ['public', 'copy', index] });
        continue;
      }
      rejectUnknownFields(rawRule, ['from', 'to'], ['public', 'copy', index], diagnostics);
      if (typeof rawRule.from !== 'string' || typeof rawRule.to !== 'string') {
        diagnostics.error('CONFIG_PUBLIC_RULE_INVALID', 'Public copy rules require string from and to fields.', { phase: 'config', fieldPath: ['public', 'copy', index] });
        continue;
      }
      const rule = { from: rawRule.from, to: rawRule.to };
      copy.push(rule);
      if (path.isAbsolute(rule.from) || path.isAbsolute(rule.to) || rule.from.split(/[\\/]/).includes('..') || rule.to.split(/[\\/]/).includes('..')) {
        diagnostics.error('CONFIG_PUBLIC_RULE_ESCAPE', 'Public copy paths must be relative and cannot contain parent traversal.', {
          phase: 'config', fieldPath: ['public', 'copy', index],
        });
      }
    }
  }
  return object.copy !== undefined ? { enabled: true, dir, copy } : { enabled: true, dir };
}

export function resolveConfig(
  value: UserConfig,
  configPath: string,
  command: BuildCommand,
  mode: BuildMode,
): { config?: ResolvedConfig; diagnostics: readonly import('./types.js').Diagnostic[] } {
  const diagnostics = new DiagnosticCollector();
  const root = path.dirname(path.resolve(configPath));
  const object = value as unknown;

  if (!isRecord(object)) {
    diagnostics.error('CONFIG_OBJECT_REQUIRED', 'Configuration must be an object.', { phase: 'config' });
    return { diagnostics: diagnostics.diagnostics };
  }

  rejectUnknownFields(object, [...ALLOWED_FIELDS], [], diagnostics);

  if (typeof object.name !== 'string' || !NAME_PATTERN.test(object.name))
    diagnostics.error('CONFIG_NAME_INVALID', 'name must be lowercase kebab-case.', { phase: 'config', fieldPath: ['name'] });
  if (typeof object.version !== 'string' || !semver.valid(object.version))
    diagnostics.error('CONFIG_VERSION_INVALID', 'version must be valid SemVer.', { phase: 'config', fieldPath: ['version'] });
  if (typeof object.description !== 'string' || object.description.trim() === '')
    diagnostics.error('CONFIG_DESCRIPTION_REQUIRED', 'description is required.', { phase: 'config', fieldPath: ['description'] });
  if (object.displayName !== undefined && (typeof object.displayName !== 'string' || object.displayName.trim() === ''))
    diagnostics.error('CONFIG_DISPLAY_NAME_INVALID', 'displayName must be a non-empty string.', { phase: 'config', fieldPath: ['displayName'] });
  if (object.srcDir !== undefined && typeof object.srcDir !== 'string')
    diagnostics.error('CONFIG_SRC_DIR_INVALID', 'srcDir must be a string.', { phase: 'config', fieldPath: ['srcDir'] });

  let build: Record<string, unknown> = {};
  if (object.build !== undefined) {
    if (!isRecord(object.build))
      diagnostics.error('CONFIG_BUILD_INVALID', 'build must be an object.', { phase: 'config', fieldPath: ['build'] });
    else
      build = object.build;
  }
  rejectUnknownFields(build, ['outDir', 'strict'], ['build'], diagnostics);
  if (build.outDir !== undefined && typeof build.outDir !== 'string')
    diagnostics.error('CONFIG_OUT_DIR_INVALID', 'build.outDir must be a string.', { phase: 'config', fieldPath: ['build', 'outDir'] });
  if (build.strict !== undefined && typeof build.strict !== 'boolean')
    diagnostics.error('CONFIG_STRICT_INVALID', 'build.strict must be boolean.', { phase: 'config', fieldPath: ['build', 'strict'] });

  if (object.targets !== undefined && !Array.isArray(object.targets))
    diagnostics.error('CONFIG_TARGETS_INVALID', 'targets must be an array.', { phase: 'config', fieldPath: ['targets'] });
  if (object.modules !== undefined && !Array.isArray(object.modules))
    diagnostics.error('CONFIG_MODULES_INVALID', 'modules must be an array.', { phase: 'config', fieldPath: ['modules'] });

  let extensions: PlatformExtensions = {};
  if (object.extensions !== undefined) {
    if (!isRecord(object.extensions)) {
      diagnostics.error('CONFIG_EXTENSIONS_INVALID', 'extensions must be an object.', { phase: 'config', fieldPath: ['extensions'] });
    } else {
      rejectUnknownFields(object.extensions, [...TARGET_IDS], ['extensions'], diagnostics);
      for (const [target, extension] of Object.entries(object.extensions)) {
        if (!TARGET_IDS.includes(target as TargetId))
          continue;
        if (!isRecord(extension)) {
          diagnostics.error('CONFIG_EXTENSION_INVALID', `extensions.${target} must be an object.`, { phase: 'config', fieldPath: ['extensions', target] });
          continue;
        }
        for (const issue of extensionIssues(extension, ['extensions', target]))
          diagnostics.error('CONFIG_EXTENSION_SEMANTICS', issue.message, { phase: 'config', fieldPath: issue.path });
      }
      extensions = object.extensions as PlatformExtensions;
    }
  }

  const strict = typeof build.strict === 'boolean' ? build.strict : true;
  const srcDir = resolveInside(root, typeof object.srcDir === 'string' ? object.srcDir : 'src', 'srcDir', diagnostics);
  const outDir = resolveInside(root, typeof build.outDir === 'string' ? build.outDir : 'dist', 'build.outDir', diagnostics);
  const publicConfig = resolvePublic(root, object.public, diagnostics);
  const targets = resolveTargets(Array.isArray(object.targets) ? object.targets : object.targets === undefined ? undefined : [], strict, diagnostics);

  if (outDir === root)
    diagnostics.error('CONFIG_OUTDIR_ROOT', 'build.outDir cannot be the project root.', { phase: 'config', fieldPath: ['build', 'outDir'] });
  if (srcDir === outDir || (isInside(srcDir, outDir) && srcDir !== outDir) || (isInside(outDir, srcDir) && srcDir !== outDir))
    diagnostics.error('CONFIG_DIRECTORY_OVERLAP', 'srcDir and build.outDir cannot contain each other.', { phase: 'config' });
  if (publicConfig.enabled && (publicConfig.dir === outDir || isInside(publicConfig.dir, outDir) || isInside(outDir, publicConfig.dir)))
    diagnostics.error('CONFIG_DIRECTORY_OVERLAP', 'Public directory and build.outDir cannot contain each other.', { phase: 'config' });

  const modules = (Array.isArray(object.modules) ? object.modules : []) as unknown[];
  const moduleNames = new Set<string>();
  for (const [index, module] of modules.entries()) {
    if (!isRecord(module) || typeof module.name !== 'string' || !MODULE_NAME_PATTERN.test(module.name)) {
      diagnostics.error('CONFIG_MODULE_INVALID', 'Every module name must be a lowercase package-style identifier.', { phase: 'config', fieldPath: ['modules', index] });
      continue;
    }
    rejectUnknownFields(module, [
      'name', 'dependsOn', 'configResolved', 'discover', 'validate', 'build', 'generate', 'buildEnd',
    ], ['modules', index], diagnostics);
    if (module.dependsOn !== undefined && (!Array.isArray(module.dependsOn) || module.dependsOn.some(dependency => typeof dependency !== 'string' || dependency === '')))
      diagnostics.error('CONFIG_MODULE_DEPENDENCIES_INVALID', 'Module dependsOn must be an array of non-empty names.', { phase: 'config', fieldPath: ['modules', index, 'dependsOn'] });
    for (const hook of ['configResolved', 'discover', 'validate', 'build', 'generate', 'buildEnd']) {
      if (module[hook] !== undefined && typeof module[hook] !== 'function')
        diagnostics.error('CONFIG_MODULE_HOOK_INVALID', `Module ${hook} must be a function.`, { phase: 'config', fieldPath: ['modules', index, hook] });
    }
    if (moduleNames.has(module.name))
      diagnostics.error('CONFIG_MODULE_DUPLICATE', `Module "${module.name}" is configured more than once.`, { phase: 'config', fieldPath: ['modules', index] });
    moduleNames.add(module.name);
  }

  if (diagnostics.hasErrors)
    return { diagnostics: diagnostics.diagnostics };

  const config: ResolvedConfig = {
    root,
    configPath: path.resolve(configPath),
    command,
    mode,
    name: object.name as string,
    version: object.version as string,
    description: (object.description as string).trim(),
    displayName: typeof object.displayName === 'string' ? object.displayName.trim() : presentationName(object.name as string),
    srcDir,
    public: publicConfig,
    targets,
    modules: modules as import('./types.js').AcpluginModule[],
    outDir,
    strict,
    extensions,
  };
  return { config, diagnostics: diagnostics.diagnostics };
}
