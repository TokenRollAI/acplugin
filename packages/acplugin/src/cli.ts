#!/usr/bin/env node

import process from 'node:process';
import path from 'node:path';
import { Command, CommanderError, Option } from 'commander';
import { watch } from 'chokidar';
import {
  ACPLUGIN_VERSION,
  initializeProject,
  ProjectConfigError,
  runProject,
  type BuildMode,
  type BuildReport,
  type Diagnostic,
  type TargetId,
} from './index.js';

interface ProjectCliOptions {
  config?: string;
  target?: string[];
  mode: BuildMode;
  strict: boolean;
  json?: boolean;
}

function addProjectOptions(command: Command, defaultMode: BuildMode): Command {
  return command
    .option('-c, --config <path>', 'Use another TypeScript config file')
    .addOption(new Option('-t, --target <target...>', 'Replace the configured target set').choices(['claude-code', 'codex']))
    .addOption(new Option('--mode <mode>', 'Config mode').choices(['development', 'production']).default(defaultMode))
    .option('--no-strict', 'Allow degraded or unsupported target compatibility')
    .option('--json', 'Emit one stable JSON report on stdout');
}

function writeReport(report: BuildReport, json: boolean | undefined): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  const status = report.success ? 'success' : 'failed';
  process.stdout.write(`${report.command}: ${status} (${report.targets.join(', ')})\n`);
  for (const diagnostic of report.diagnostics)
    process.stderr.write(`${diagnostic.severity} ${diagnostic.code}: ${diagnostic.message}\n`);
  for (const entry of report.compatibility) {
    if (entry.level === 'degraded' || entry.level === 'unsupported')
      process.stderr.write(`warning ${entry.target} ${entry.subject}: ${entry.reason}\n`);
  }
}

interface CliFailureReport {
  schemaVersion: '1';
  command: string;
  diagnostics: readonly Diagnostic[];
  success: false;
}

function failureReport(command: string, error: unknown, internal: boolean): CliFailureReport {
  const diagnostics = error instanceof ProjectConfigError
    ? error.diagnostics
    : [{
        code: internal ? 'FRAMEWORK_INTERNAL_FAILED' : 'COMMAND_FAILED',
        severity: 'error' as const,
        message: internal ? 'The command failed inside the framework.' : `${command} failed.`,
        phase: internal ? 'internal' : command,
      }];
  return { schemaVersion: '1', command, diagnostics, success: false };
}

function writeFailure(command: string, error: unknown, json: boolean | undefined, internal: boolean): void {
  const report = failureReport(command, error, internal);
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  for (const diagnostic of report.diagnostics)
    process.stderr.write(`${diagnostic.severity} ${diagnostic.code}: ${diagnostic.message}\n`);
}

async function runPipeline(commandName: 'validate' | 'inspect' | 'build', options: ProjectCliOptions): Promise<void> {
  try {
    const result = await runProject({
      command: commandName,
      mode: options.mode,
      ...(options.config === undefined ? {} : { configPath: options.config }),
      ...(options.target === undefined ? {} : { targets: options.target as TargetId[] }),
      strict: options.strict,
      commit: commandName === 'build',
    });
    writeReport(result.report, options.json);
    if (!result.report.success) {
      process.exitCode = result.report.diagnostics.some(diagnostic => diagnostic.code === 'BUILD_INTERNAL_FAILED') ? 2 : 1;
    }
  } catch (error) {
    const internal = !(error instanceof ProjectConfigError);
    writeFailure(commandName, error, options.json, internal);
    process.exitCode = internal ? 2 : 1;
  }
}

async function runDev(options: ProjectCliOptions): Promise<void> {
  let running = false;
  let pending = false;
  const rebuild = async (): Promise<void> => {
    if (running) {
      pending = true;
      return;
    }
    running = true;
    try {
      const result = await runProject({
        command: 'dev',
        mode: options.mode,
        ...(options.config === undefined ? {} : { configPath: options.config }),
        ...(options.target === undefined ? {} : { targets: options.target as TargetId[] }),
        strict: options.strict,
        commit: true,
      });
      writeReport(result.report, options.json);
      if (!result.report.success)
        process.exitCode = result.report.diagnostics.some(diagnostic => diagnostic.code === 'BUILD_INTERNAL_FAILED') ? 2 : 1;
    } catch (error) {
      writeFailure('dev', error, options.json, !(error instanceof ProjectConfigError));
    } finally {
      running = false;
      if (pending) {
        pending = false;
        await rebuild();
      }
    }
  };

  await rebuild();
  const configPath = path.resolve(options.config ?? 'acplugin.config.ts');
  const projectRoot = path.dirname(configPath);
  const watcher = watch(projectRoot, {
    ignoreInitial: true,
    ignored: (candidate) => {
      const relative = path.relative(projectRoot, candidate).split(path.sep).join('/');
      return relative === 'node_modules'
        || relative.startsWith('node_modules/')
        || relative === 'dist'
        || relative.startsWith('dist/')
        || relative === '.git'
        || relative.startsWith('.git/')
        || /(^|\/)\.acplugin-(?:work|stage|backup|transaction|lock)/.test(relative);
    },
  });
  let debounce: NodeJS.Timeout | undefined;
  watcher.on('all', () => {
    if (debounce)
      clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = undefined;
      void rebuild();
    }, 50);
  });
  await new Promise<void>((resolve) => {
    const stop = (): void => {
      if (debounce)
        clearTimeout(debounce);
      process.exitCode = 130;
      void watcher.close().then(resolve);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

export function createCli(): Command {
  const program = new Command()
    .name('acplugin')
    .description('Build canonical AI plugins for Claude Code and Codex')
    .version(ACPLUGIN_VERSION)
    .showHelpAfterError()
    .exitOverride();

  program.command('init')
    .description('Create an opinionated canonical plugin project')
    .argument('[directory]', 'New or empty destination directory')
    .option('-y, --yes', 'Accept deterministic defaults')
    .option('--name <name>', 'Plugin machine name')
    .option('--display-name <name>', 'Plugin display name')
    .option('--description <description>', 'Plugin description')
    .option('--hooks', 'Enable the official Hooks Module')
    .option('--mcp', 'Enable the official MCP Module')
    .option('--install', 'Run pnpm install after scaffolding')
    .option('--json', 'Emit one stable JSON result on stdout')
    .action(async (directory: string | undefined, options: {
      yes?: boolean;
      name?: string;
      displayName?: string;
      description?: string;
      hooks?: boolean;
      mcp?: boolean;
      install?: boolean;
      json?: boolean;
    }) => {
      try {
        const result = await initializeProject({
          ...(directory === undefined ? {} : { directory }),
          ...(options.yes === undefined ? {} : { yes: options.yes }),
          ...(options.name === undefined ? {} : { name: options.name }),
          ...(options.displayName === undefined ? {} : { displayName: options.displayName }),
          ...(options.description === undefined ? {} : { description: options.description }),
          ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
          ...(options.mcp === undefined ? {} : { mcp: options.mcp }),
          ...(options.install === undefined ? {} : { install: options.install }),
        });
        if (options.json)
          process.stdout.write(`${JSON.stringify({ schemaVersion: '1', success: true, ...result }, null, 2)}\n`);
        else
          process.stdout.write(`Created ${result.directory}\nNext: cd ${result.directory} && pnpm install && pnpm build\n`);
        if (options.install && !result.installed)
          process.exitCode = 1;
      } catch (error) {
        writeFailure('init', error, options.json, false);
        process.exitCode = 1;
      }
    });

  program.command('migrate')
    .description('Migrate a legacy Claude project or plugin into canonical source')
    .argument('<source>', 'Local path or supported GitHub source')
    .argument('[destination]', 'New destination directory')
    .option('-p, --path <subpath>', 'Sub-path inside a GitHub repository')
    .option('--plugin <name>', 'Select one marketplace plugin')
    .option('--all', 'Migrate all marketplace plugins')
    .option('--name <name>', 'Canonical plugin name for project input')
    .option('--description <description>', 'Canonical plugin description for project input')
    .option('--dry-run', 'Generate and validate in temporary storage without committing')
    .option('--strict', 'Fail when any resource is degraded or unmapped')
    .option('--json', 'Emit one stable JSON report on stdout')
    .action(async (source: string, destination: string | undefined, options: {
      path?: string;
      plugin?: string;
      all?: boolean;
      name?: string;
      description?: string;
      dryRun?: boolean;
      strict?: boolean;
      json?: boolean;
    }) => {
      try {
        const { migrate } = await import('./migration/index.js');
        const report = await migrate({
          source,
          ...(destination === undefined ? {} : { destination }),
          ...(options.path === undefined ? {} : { subPath: options.path }),
          ...(options.plugin === undefined ? {} : { plugin: options.plugin }),
          ...(options.all === undefined ? {} : { all: options.all }),
          ...(options.name === undefined ? {} : { name: options.name }),
          ...(options.description === undefined ? {} : { description: options.description }),
          ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
          ...(options.strict === undefined ? {} : { strict: options.strict }),
        });
        if (options.json)
          process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        else
          process.stdout.write(`Migration ${report.success ? 'succeeded' : 'failed'}: ${report.items.length} resource(s)\n`);
        if (!report.success)
          process.exitCode = 1;
      } catch (error) {
        writeFailure('migrate', error, options.json, false);
        process.exitCode = 1;
      }
    });

  addProjectOptions(program.command('validate').description('Validate the complete generated target graphs'), 'production')
    .action((options: ProjectCliOptions) => runPipeline('validate', options));
  addProjectOptions(program.command('inspect').description('Inspect the complete generated target graphs'), 'production')
    .action((options: ProjectCliOptions) => runPipeline('inspect', options));
  addProjectOptions(program.command('build').description('Build and atomically commit selected targets'), 'production')
    .action((options: ProjectCliOptions) => runPipeline('build', options));
  addProjectOptions(program.command('dev').description('Watch and retain the last successful output'), 'development')
    .action((options: ProjectCliOptions) => runDev(options));

  return program;
}

export async function main(argv = process.argv): Promise<void> {
  const program = createCli();
  if (argv.length <= 2) {
    program.outputHelp();
    return;
  }
  try {
    await program.parseAsync(argv);
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.code === 'commander.helpDisplayed' || error.code === 'commander.version')
        return;
      process.exitCode = 2;
      return;
    }
    process.stderr.write('internal error: the CLI failed inside the framework\n');
    process.exitCode = 2;
  }
}

await main();
