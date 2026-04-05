#!/usr/bin/env node

import { Command } from 'commander';
import * as path from 'path';
import * as fs from 'fs';
import { scanClaudeProject } from './scanner/claude.js';
import { hasMarketplace, isSinglePlugin, scanAllPlugins, scanPlugin, countResources, scanMarketplaceFull } from './scanner/plugin.js';
import { generateCodex } from './writer/codex.js';
import { generateOpenCode } from './writer/opencode.js';
import { generateCursor } from './writer/cursor.js';
import { generateAntigravity } from './writer/antigravity.js';
import { writeFile } from './utils/fs.js';
import { parseGitHubSource, downloadGitHubRepo, cleanupTempDir, getTempRoot } from './github.js';
import { selectPlugins, selectPlatforms, runWizard, log } from './tui.js';
import type { Platform, ConvertResult, ScanResult, PluginScanResult, MarketplaceScanResult } from './types.js';
import { convertMarketplaceForCodex } from './converter/pluginManifest.js';
// TODO: re-enable after Cursor marketplace test validation
// import { convertMarketplaceForCursor } from './converter/pluginManifest.js';

const program = new Command();

program
  .name('acplugin')
  .description('Convert Claude Code plugins to Codex, OpenCode, and Cursor formats')
  .version('1.1.0');

/**
 * Detect if source is a GitHub repo or local path.
 */
function isGitHubSource(source: string): boolean {
  if (source.startsWith('github:')) return true;
  if (source.startsWith('https://github.com/')) return true;
  if (source.startsWith('http://github.com/')) return true;
  // owner/repo pattern: contains exactly one slash, no dots or path separators at start
  if (/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9._-]+$/.test(source)) {
    // Check it's not a local path that exists
    if (!fs.existsSync(source)) return true;
  }
  return false;
}

/**
 * Resolve source to a local directory path.
 */
async function resolveSource(source: string, subPath?: string): Promise<[string, (() => void) | null]> {
  if (isGitHubSource(source)) {
    const ghSource = parseGitHubSource(source);
    if (subPath) ghSource.subPath = subPath;
    log.info(`Downloading ${ghSource.owner}/${ghSource.repo}${ghSource.branch ? `#${ghSource.branch}` : ''}...`);
    const repoDir = await downloadGitHubRepo(ghSource);
    const tempRoot = getTempRoot(repoDir);
    log.success('Downloaded and extracted');
    return [repoDir, () => cleanupTempDir(tempRoot)];
  }

  return [path.resolve(source), null];
}

/**
 * Detect source type and scan.
 */
function detectAndScan(rootDir: string): { type: 'marketplace'; plugins: PluginScanResult[]; marketplaceMeta: MarketplaceScanResult | null }
  | { type: 'plugin'; scan: PluginScanResult }
  | { type: 'project'; scan: ScanResult } {

  if (hasMarketplace(rootDir)) {
    const full = scanMarketplaceFull(rootDir);
    return {
      type: 'marketplace',
      plugins: full?.plugins || scanAllPlugins(rootDir),
      marketplaceMeta: full,
    };
  }
  if (isSinglePlugin(rootDir)) {
    return { type: 'plugin', scan: scanPlugin(rootDir) };
  }
  return { type: 'project', scan: scanClaudeProject(rootDir) };
}

// --- scan command ---
program
  .command('scan')
  .description('Scan and list convertible resources')
  .argument('[source]', 'Local path or GitHub repo (owner/repo)', '.')
  .option('-p, --path <subpath>', 'Sub-path within the repository')
  .action(async (source: string, opts: { path?: string }) => {
    const [rootDir, cleanup] = await resolveSource(source, opts.path);
    try {
      const detected = detectAndScan(rootDir);

      if (detected.type === 'marketplace') {
        printMarketplaceScan(detected.plugins);
      } else if (detected.type === 'plugin') {
        log.header(`Plugin: ${detected.scan.meta.name}`);
        printScanResult(detected.scan);
      } else {
        printScanResult(detected.scan);
      }
    } finally {
      cleanup?.();
    }
  });

// --- convert command ---
program
  .command('convert')
  .description('Convert Claude Code plugins to other platforms')
  .argument('[source]', 'Local path or GitHub repo (owner/repo)', '.')
  .option('-t, --to <platforms>', 'Target platforms (codex,opencode,cursor,antigravity)')
  .option('-o, --output <path>', 'Output directory')
  .option('-a, --all', 'Convert all plugins without selection')
  .option('-p, --path <subpath>', 'Sub-path within the repository')
  .option('--dry-run', 'Preview without writing files')
  .action(async (source: string, opts: { to?: string; output?: string; all?: boolean; path?: string; dryRun?: boolean }) => {
    const [rootDir, cleanup] = await resolveSource(source, opts.path);

    try {
      const outputDir = opts.output
        ? path.resolve(opts.output)
        : (isGitHubSource(source) ? path.resolve('.') : rootDir);

      // Resolve platforms
      let platforms: Platform[];
      if (opts.to) {
        platforms = opts.to.split(',').map(p => p.trim()) as Platform[];
        const valid: Platform[] = ['codex', 'opencode', 'cursor', 'antigravity'];
        for (const p of platforms) {
          if (!valid.includes(p)) {
            log.error(`Unknown platform "${p}". Valid: ${valid.join(', ')}`);
            process.exit(1);
          }
        }
      } else {
        // Interactive platform selection
        platforms = await selectPlatforms();
        if (platforms.length === 0) {
          log.warn('No platforms selected.');
          return;
        }
      }

      const dryRun = opts.dryRun || false;
      const detected = detectAndScan(rootDir);

      if (detected.type === 'marketplace') {
        await convertMarketplace(detected.plugins, platforms, outputDir, dryRun, opts.all || false, detected.marketplaceMeta);
      } else if (detected.type === 'plugin') {
        log.header(detected.scan.meta.name);
        convertSingleScan(detected.scan, platforms, outputDir, dryRun);
      } else {
        convertSingleScan(detected.scan, platforms, outputDir, dryRun);
      }
    } finally {
      cleanup?.();
    }
  });

// --- Marketplace conversion ---

async function convertMarketplace(
  plugins: PluginScanResult[],
  platforms: Platform[],
  outputDir: string,
  dryRun: boolean,
  all: boolean,
  marketplaceMeta?: MarketplaceScanResult | null,
): Promise<void> {
  if (plugins.length === 0) {
    log.warn('No plugins with convertible resources found.');
    return;
  }

  log.success(`Found ${plugins.length} plugin(s)`);

  let selectedIndices: number[];
  if (all) {
    selectedIndices = plugins.map((_, i) => i);
  } else {
    selectedIndices = await selectPlugins(plugins);
    if (selectedIndices.length === 0) {
      log.warn('No plugins selected.');
      return;
    }
  }

  // Determine whether to use subdirectories for each plugin
  let useSubDirs = selectedIndices.length > 1;
  if (!useSubDirs && selectedIndices.length === 1 && process.stdin.isTTY) {
    const { confirm } = require('@inquirer/prompts') as { confirm: Function };
    useSubDirs = await confirm({
      message: `Output to subdirectory "${plugins[selectedIndices[0]].meta.name}/"?`,
      default: false,
    });
  }

  log.info(`Converting ${selectedIndices.length} plugin(s) to ${platforms.join(', ')}...`);

  let totalFiles = 0;
  const selectedPlugins = selectedIndices.map(i => plugins[i]);

  for (const plugin of selectedPlugins) {
    const pluginOutputDir = useSubDirs
      ? path.join(outputDir, plugin.meta.name)
      : outputDir;
    log.header(plugin.meta.name);
    totalFiles += convertSingleScan(plugin, platforms, pluginOutputDir, dryRun);
  }

  // Generate marketplace manifest files for each platform
  if (marketplaceMeta?.marketplace) {
    for (const platform of platforms) {
      const marketplaceFiles = generateMarketplaceManifest(
        platform,
        marketplaceMeta.marketplace,
        selectedPlugins,
      );
      for (const file of marketplaceFiles.files) {
        if (!dryRun) {
          writeFile(path.join(outputDir, file.path), file.content);
        }
        totalFiles++;
      }
      if (marketplaceFiles.files.length > 0) {
        log.stat(`${platform} marketplace`, `${marketplaceFiles.files.length} file(s)`);
      }
      for (const w of marketplaceFiles.warnings) {
        log.warn(w);
      }
    }
  }

  console.log();
  const verb = dryRun ? 'Would generate' : 'Generated';
  log.success(`${verb} ${totalFiles} file(s) for ${selectedIndices.length} plugin(s)`);
}

// --- Single scan conversion ---

function convertSingleScan(
  scan: ScanResult,
  platforms: Platform[],
  outputDir: string,
  dryRun: boolean,
): number {
  const totalResources = scan.skills.length + scan.instructions.length +
    (scan.mcp ? scan.mcp.servers.length : 0) + scan.agents.length +
    scan.commands.length + (scan.hooks ? Object.keys(scan.hooks).length : 0);

  if (totalResources === 0) {
    log.warn('No resources found.');
    return 0;
  }

  log.stat('Resources', totalResources);

  let totalFiles = 0;
  const results: ConvertResult[] = [];

  for (const platform of platforms) {
    const result = generateForPlatform(scan, platform);
    results.push(result);
    totalFiles += result.files.length;

    if (!dryRun) {
      for (const file of result.files) {
        writeFile(path.join(outputDir, file.path), file.content);
      }
    }
  }

  printConvertReport(results, dryRun);
  return totalFiles;
}

function generateForPlatform(scan: ScanResult, platform: Platform): ConvertResult {
  switch (platform) {
    case 'codex': return generateCodex(scan);
    case 'opencode': return generateOpenCode(scan);
    case 'cursor': return generateCursor(scan);
    case 'antigravity': return generateAntigravity(scan);
  }
}

/**
 * Generate marketplace manifest files for a target platform.
 */
function generateMarketplaceManifest(
  platform: Platform,
  marketplace: import('./types.js').MarketplaceMeta,
  plugins: PluginScanResult[],
): { files: import('./types.js').ConvertedFile[]; warnings: string[] } {
  const files: import('./types.js').ConvertedFile[] = [];
  const warnings: string[] = [];

  switch (platform) {
    case 'codex':
      files.push(convertMarketplaceForCodex(marketplace, plugins));
      break;
    // TODO: Cursor marketplace generation — pending test validation
    // case 'cursor':
    //   files.push(convertMarketplaceForCursor(marketplace, plugins));
    //   break;
    // OpenCode and Antigravity don't support plugin manifest/marketplace.
    // Their resource conversion (skills, agents, etc.) is handled normally by the writers.
  }

  return { files, warnings };
}

// --- Print functions ---

function printMarketplaceScan(plugins: PluginScanResult[]): void {
  log.header('Claude Code Plugin Marketplace');
  log.success(`Found ${plugins.length} plugin(s) with resources`);
  console.log();

  for (let i = 0; i < plugins.length; i++) {
    const p = plugins[i];
    const resources = countResources(p);
    const category = p.meta.category ? ` [${p.meta.category}]` : '';
    log.plugin(`${i + 1}. ${p.meta.name}${category}`, `${resources} resource(s)`);
    if (p.meta.description) {
      log.dim(`   ${p.meta.description}`);
    }

    const parts: string[] = [];
    if (p.skills.length) parts.push(`${p.skills.length} skill(s)`);
    if (p.agents.length) parts.push(`${p.agents.length} agent(s)`);
    if (p.commands.length) parts.push(`${p.commands.length} command(s)`);
    if (p.hooks) parts.push(`${Object.keys(p.hooks).length} hook event(s)`);
    if (parts.length) log.dim(`   ${parts.join(', ')}`);
    console.log();
  }
}

function printScanResult(scan: ScanResult): void {
  const sections: [string, number][] = [
    ['Skills', scan.skills.length],
    ['Instructions', scan.instructions.length],
    ['MCP Servers', scan.mcp?.servers.length || 0],
    ['Agents', scan.agents.length],
    ['Commands', scan.commands.length],
    ['Hook Events', scan.hooks ? Object.keys(scan.hooks).length : 0],
  ];

  for (const [label, count] of sections) {
    if (count > 0) log.stat(label, count);
  }

  if (scan.skills.length) {
    for (const s of scan.skills) log.file(`skill: ${s.frontmatter.name || s.dirName}`);
  }
  if (scan.agents.length) {
    for (const a of scan.agents) log.file(`agent: ${a.frontmatter.name || a.fileName}`);
  }
  if (scan.commands.length) {
    for (const c of scan.commands) log.file(`command: /${c.name}`);
  }
}

function printConvertReport(results: ConvertResult[], dryRun: boolean): void {
  for (const result of results) {
    const name = result.platform.charAt(0).toUpperCase() + result.platform.slice(1);

    if (dryRun) {
      log.dim(`  ${name}: ${result.files.length} file(s)`);
      for (const f of result.files) log.file(f.path);
    } else {
      log.stat(name, `${result.files.length} file(s)`);
    }

    for (const w of result.warnings) {
      log.warn(w);
    }
  }
}

// --- Default: interactive wizard when no subcommand ---
async function main() {
  // If no subcommand provided (just `acplugin`), run interactive wizard
  const args = process.argv.slice(2);
  const hasSubcommand = args.length > 0 && ['scan', 'convert', 'help', '--help', '-h', '--version', '-V'].includes(args[0]);

  if (args.length === 0 || !hasSubcommand) {
    if (args.length === 0 && process.stdin.isTTY) {
      // Pure `acplugin` with no args → wizard
      const result = await runWizard();
      const fakeArgs = [result.action, result.source];

      if (result.action === 'convert') {
        if (result.platforms.length) fakeArgs.push('--to', result.platforms.join(','));
        if (result.outputDir) fakeArgs.push('-o', result.outputDir);
        if (result.all) fakeArgs.push('--all');
        if (result.dryRun) fakeArgs.push('--dry-run');
      }

      process.argv = ['node', 'acplugin', ...fakeArgs];
    }
  }

  program.parse();
}

main();
