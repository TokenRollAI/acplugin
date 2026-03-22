import chalk from 'chalk';
import type { PluginScanResult, Platform } from './types.js';
import { countResources } from './scanner/plugin.js';

const { checkbox, select, input, confirm } = require('@inquirer/prompts') as {
  checkbox: Function; select: Function; input: Function; confirm: Function;
};

// --- Interactive wizard (acplugin with no args) ---

export interface WizardResult {
  action: 'scan' | 'convert';
  source: string;
  platforms: Platform[];
  outputDir?: string;
  all: boolean;
  dryRun: boolean;
}

/**
 * Full interactive wizard when running `acplugin` with no arguments.
 */
export async function runWizard(): Promise<WizardResult> {
  console.log();
  console.log(chalk.bold.cyan('  acplugin') + chalk.dim(' — Claude Code Plugin Converter'));
  console.log();

  // Step 1: Action
  const action: 'scan' | 'convert' = await select({
    message: 'What do you want to do?',
    choices: [
      { name: `${chalk.green('Convert')} — Convert plugins to other platforms`, value: 'convert' },
      { name: `${chalk.blue('Scan')}    — Scan and list available resources`, value: 'scan' },
    ],
  });

  // Step 2: Source
  const sourceType: 'local' | 'github' = await select({
    message: 'Where are the plugins?',
    choices: [
      { name: `${chalk.yellow('Local')}  — Current directory or local path`, value: 'local' },
      { name: `${chalk.magenta('GitHub')} — Download from a GitHub repository`, value: 'github' },
    ],
  });

  let source: string;
  if (sourceType === 'github') {
    source = await input({
      message: 'GitHub repo (owner/repo):',
      validate: (v: string) => v.includes('/') || 'Please enter owner/repo format',
    });
  } else {
    source = await input({
      message: 'Local path:',
      default: '.',
    });
  }

  // For scan, we're done
  if (action === 'scan') {
    return { action, source, platforms: [], all: false, dryRun: false };
  }

  // Step 3: Platforms (convert only)
  const platforms = await selectPlatforms();
  if (platforms.length === 0) {
    log.warn('No platforms selected, defaulting to all.');
    return { action, source, platforms: ['codex', 'opencode', 'cursor'], all: true, dryRun: false };
  }

  // Step 4: Output directory
  const customOutput = await confirm({
    message: 'Use custom output directory?',
    default: false,
  });

  let outputDir: string | undefined;
  if (customOutput) {
    outputDir = await input({
      message: 'Output directory:',
      default: './output',
    });
  }

  // Step 5: Dry run?
  const dryRun = await confirm({
    message: 'Dry run (preview only, no files written)?',
    default: false,
  });

  return { action, source, platforms, outputDir, all: false, dryRun };
}

// --- Plugin selection ---

/**
 * Interactive plugin selection via checkbox.
 */
export async function selectPlugins(plugins: PluginScanResult[]): Promise<number[]> {
  if (!process.stdin.isTTY) {
    return plugins.map((_, i) => i);
  }

  const choices = plugins.map((p, i) => {
    const resources = countResources(p);
    const category = p.meta.category ? chalk.dim(` [${p.meta.category}]`) : '';
    const desc = p.meta.description ? chalk.dim(` — ${p.meta.description}`) : '';
    return {
      name: `${p.meta.name}${category} ${chalk.cyan(`(${resources} resources)`)}${desc}`,
      value: i,
      checked: true,
    };
  });

  const selected: number[] = await checkbox({
    message: 'Select plugins to convert',
    choices,
    pageSize: 15,
    instructions: chalk.dim('(↑↓ navigate, space toggle, a=all, enter=confirm)'),
  });

  return selected;
}

/**
 * Interactive platform selection via checkbox.
 */
export async function selectPlatforms(): Promise<Platform[]> {
  if (!process.stdin.isTTY) {
    return ['codex', 'opencode', 'cursor'];
  }

  const choices = [
    { name: 'Codex CLI', value: 'codex' as Platform, checked: true },
    { name: 'OpenCode', value: 'opencode' as Platform, checked: true },
    { name: 'Cursor', value: 'cursor' as Platform, checked: true },
  ];

  const selected: Platform[] = await checkbox({
    message: 'Select target platforms',
    choices,
  });

  return selected;
}

/**
 * Parse selection string for non-interactive mode.
 */
export function parseSelection(input: string, total: number): number[] {
  const trimmed = input.trim().toLowerCase();

  if (trimmed === 'all' || trimmed === 'a' || trimmed === '*') {
    return Array.from({ length: total }, (_, i) => i);
  }

  const indices = new Set<number>();
  const parts = trimmed.split(',').map(s => s.trim()).filter(Boolean);

  for (const part of parts) {
    const rangeMatch = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1], 10);
      const end = parseInt(rangeMatch[2], 10);
      for (let i = start; i <= end; i++) {
        if (i >= 1 && i <= total) indices.add(i - 1);
      }
    } else {
      const num = parseInt(part, 10);
      if (!isNaN(num) && num >= 1 && num <= total) indices.add(num - 1);
    }
  }

  return Array.from(indices).sort((a, b) => a - b);
}

// --- Styled output helpers ---

export const log = {
  success: (msg: string) => console.log(chalk.green('✔') + ' ' + msg),
  error: (msg: string) => console.error(chalk.red('✖') + ' ' + msg),
  warn: (msg: string) => console.log(chalk.yellow('⚠') + ' ' + chalk.dim(msg)),
  info: (msg: string) => console.log(chalk.blue('ℹ') + ' ' + msg),
  dim: (msg: string) => console.log(chalk.dim(msg)),
  header: (msg: string) => console.log('\n' + chalk.bold.underline(msg)),
  plugin: (name: string, detail: string) => console.log(chalk.bold.cyan(name) + ' ' + chalk.dim(detail)),
  file: (path: string) => console.log('  ' + chalk.green(path)),
  stat: (label: string, value: string | number) => console.log(`  ${chalk.dim(label + ':')} ${chalk.white(String(value))}`),
};
