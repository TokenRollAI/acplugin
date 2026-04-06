import type {
  PluginMeta,
  PluginInterface,
  MarketplaceMeta,
  ConvertedFile,
  ScanResult,
  PluginScanResult,
  PlatformPaths,
} from '../types.js';

// ─── Platform resource paths (single source of truth) ───
// These must match the actual output paths in each platform's writer/converter.
//
// Only codex and cursor support plugin manifest/marketplace generation.
// OpenCode's plugin system is fundamentally different (npm packages / .ts modules).
// Antigravity does not support plugins.
// Other platforms still perform normal resource conversion (skills, agents, etc.).

type ManifestPlatform = 'codex' | 'cursor';

const PLATFORM_PATHS: Record<ManifestPlatform, PlatformPaths> = {
  codex: {
    pluginJson: '.codex-plugin/plugin.json',
    marketplaceJson: '.agents/plugins/marketplace.json',
    skills: './.agents/skills/',
    agents: './.codex/agents/',
    mcp: './.codex/config.toml',
  },
  cursor: {
    pluginJson: '.cursor-plugin/plugin.json',
    marketplaceJson: '.cursor-plugin/marketplace.json',
    skills: './.cursor/skills/',
    agents: './.cursor/agents/',
    commands: './.cursor/commands/',
    instructions: './.cursor/rules/',
    mcp: './.cursor/mcp.json',
    hooks: './.cursor/hooks.json',
  },
};

export { PLATFORM_PATHS, type ManifestPlatform };

// ─── Codex ───

/**
 * Generate .codex-plugin/plugin.json manifest from Claude plugin metadata.
 */
export function convertPluginManifestForCodex(
  scan: ScanResult,
  meta?: PluginMeta,
): ConvertedFile {
  const manifest: Record<string, unknown> = {
    name: meta?.name || 'converted-plugin',
    version: meta?.version || '1.0.0',
    description: meta?.description || 'Converted from Claude Code plugin via acplugin',
  };

  if (meta?.author) manifest.author = meta.author;
  if (meta?.homepage) manifest.homepage = meta.homepage;
  if (meta?.repository) manifest.repository = meta.repository;
  if (meta?.license) manifest.license = meta.license;
  if (meta?.keywords) manifest.keywords = meta.keywords;

  const paths = PLATFORM_PATHS.codex;

  // Resource path references (derived from platform paths)
  if (scan.skills.length > 0 && paths.skills) manifest.skills = paths.skills;
  if (scan.mcp && paths.mcp) manifest.mcpServers = paths.mcp;
  if (meta?.apps) manifest.apps = './.app.json';

  // Interface (marketplace display metadata)
  if (meta?.interface) {
    manifest.interface = buildCodexInterface(meta.interface);
  }

  return {
    path: paths.pluginJson,
    content: JSON.stringify(manifest, null, 2),
    type: 'manifest',
  };
}

function buildCodexInterface(iface: PluginInterface): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (iface.displayName) result.displayName = iface.displayName;
  if (iface.shortDescription) result.shortDescription = iface.shortDescription;
  if (iface.longDescription) result.longDescription = iface.longDescription;
  if (iface.developerName) result.developerName = iface.developerName;
  if (iface.category) result.category = iface.category;
  if (iface.capabilities) result.capabilities = iface.capabilities;
  if (iface.websiteURL) result.websiteURL = iface.websiteURL;
  if (iface.privacyPolicyURL) result.privacyPolicyURL = iface.privacyPolicyURL;
  if (iface.termsOfServiceURL) result.termsOfServiceURL = iface.termsOfServiceURL;
  if (iface.defaultPrompt) result.defaultPrompt = iface.defaultPrompt;
  if (iface.brandColor) result.brandColor = iface.brandColor;
  if (iface.composerIcon) result.composerIcon = iface.composerIcon;
  if (iface.logo) result.logo = iface.logo;
  if (iface.screenshots) result.screenshots = iface.screenshots;
  return result;
}

/**
 * Generate Codex marketplace.json from Claude marketplace metadata.
 */
export function convertMarketplaceForCodex(
  marketplace: MarketplaceMeta,
  plugins: PluginScanResult[],
): ConvertedFile {
  const paths = PLATFORM_PATHS.codex;
  const output: Record<string, unknown> = {
    name: marketplace.name,
  };

  // Interface with displayName
  const displayName = marketplace.metadata?.description || marketplace.name;
  output.interface = { displayName };

  output.plugins = plugins.map((p) => {
    const entry: Record<string, unknown> = {
      name: p.meta.name,
      source: {
        source: 'local',
        path: `./plugins/${p.meta.name}`,
      },
      policy: {
        installation: 'AVAILABLE',
        authentication: 'ON_INSTALL',
      },
    };
    const category = p.meta.category || p.meta.interface?.category;
    if (category) entry.category = category;
    return entry;
  });

  return {
    path: paths.marketplaceJson!,
    content: JSON.stringify(output, null, 2),
    type: 'manifest',
  };
}

// ─── Cursor ───

/**
 * Generate .cursor-plugin/plugin.json manifest from Claude plugin metadata.
 * Enhanced version that includes interface fields.
 */
export function convertPluginManifestForCursor(
  scan: ScanResult,
  meta?: PluginMeta,
): ConvertedFile {
  const manifest: Record<string, unknown> = {
    name: meta?.name || 'converted-plugin',
  };

  if (meta?.displayName) manifest.displayName = meta.displayName;
  // Also pull displayName from interface if not at top level
  if (!manifest.displayName && meta?.interface?.displayName) {
    manifest.displayName = meta.interface.displayName;
  }

  manifest.description = meta?.description || 'Converted from Claude Code plugin via acplugin';
  manifest.version = meta?.version || '1.0.0';

  if (meta?.author) manifest.author = meta.author;
  if (meta?.homepage) manifest.homepage = meta.homepage;
  if (meta?.repository) manifest.repository = meta.repository;
  if (meta?.license) manifest.license = meta.license;
  if (meta?.keywords) manifest.keywords = meta.keywords;

  const paths = PLATFORM_PATHS.cursor;

  // Resource paths for existing components (derived from platform paths)
  if (scan.skills.length > 0 && paths.skills) manifest.skills = paths.skills;
  if (scan.agents.length > 0 && paths.agents) manifest.agents = paths.agents;
  if (scan.commands.length > 0 && paths.commands) manifest.commands = paths.commands;
  if (scan.instructions.length > 0 && paths.instructions) manifest.rules = paths.instructions;
  if (scan.mcp && paths.mcp) manifest.mcpServers = paths.mcp;
  if (scan.hooks && paths.hooks) manifest.hooks = paths.hooks;

  // Logo from interface
  if (meta?.interface?.logo) manifest.logo = meta.interface.logo;

  return {
    path: paths.pluginJson,
    content: JSON.stringify(manifest, null, 2),
    type: 'manifest',
  };
}

/**
 * Generate Cursor marketplace.json from Claude marketplace metadata.
 */
export function convertMarketplaceForCursor(
  marketplace: MarketplaceMeta,
  plugins: PluginScanResult[],
): ConvertedFile {
  const output: Record<string, unknown> = {
    name: marketplace.name,
  };

  if (marketplace.owner) output.owner = marketplace.owner;

  // Metadata block
  const metadata: Record<string, unknown> = {};
  if (marketplace.metadata?.description || marketplace.description) {
    metadata.description = marketplace.metadata?.description || marketplace.description;
  }
  if (marketplace.metadata?.version || marketplace.version) {
    metadata.version = marketplace.metadata?.version || marketplace.version;
  }
  metadata.pluginRoot = 'plugins';
  output.metadata = metadata;

  output.plugins = plugins.map((p) => ({
    name: p.meta.name,
    source: p.meta.name,
    description: p.meta.description,
  }));

  return {
    path: PLATFORM_PATHS.cursor.marketplaceJson!,
    content: JSON.stringify(output, null, 2),
    type: 'manifest',
  };
}

// OpenCode and Antigravity are intentionally not handled here.
// OpenCode's plugin system uses npm packages / local .ts modules (fundamentally different).
// Antigravity does not support plugins.
// Both platforms still perform normal resource conversion (skills, agents, MCP, etc.)
// through their respective writers.
