// Target platforms
export type Platform = 'codex' | 'opencode' | 'cursor' | 'antigravity';

// --- Platform resource paths (single source of truth) ---
// These must match the actual output paths in each platform's writer/converter.

export interface PlatformPaths {
  pluginJson: string;           // manifest output path
  marketplaceJson?: string;     // marketplace output path
  skills?: string;              // skills directory reference
  agents?: string;              // agents directory reference
  commands?: string;            // commands directory reference
  instructions?: string;        // instructions file reference
  mcp?: string;                 // MCP config reference
  hooks?: string;               // hooks config reference
}

// --- Skill ---
export interface SkillFrontmatter {
  name?: string;
  description?: string;
  'argument-hint'?: string;
  'disable-model-invocation'?: boolean;
  'user-invocable'?: boolean;
  'allowed-tools'?: string;
  model?: string;
  effort?: string;
  context?: string;
  agent?: string;
  hooks?: Record<string, unknown>;
}

export interface SkillAuxFile {
  relativePath: string; // relative to skill dir, e.g. "references/doc.md"
  content: string;
}

export interface Skill {
  dirName: string;
  frontmatter: SkillFrontmatter;
  body: string;
  sourcePath: string;
  auxFiles: SkillAuxFile[];
}

// --- Instruction ---
export interface Instruction {
  fileName: string;
  content: string;
  sourcePath: string;
  isRule: boolean; // true if from .claude/rules/
}

// --- MCP Server ---
export interface MCPServer {
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  type?: string; // 'http' | 'stdio'
  url?: string;
  headers?: Record<string, string>;
}

export interface MCPConfig {
  servers: MCPServer[];
  sourcePath: string;
}

// --- Agent ---
export interface AgentFrontmatter {
  name?: string;
  description?: string;
  tools?: string;
  disallowedTools?: string;
  model?: string;
  permissionMode?: string;
  maxTurns?: number;
  skills?: string[];
  mcpServers?: unknown[];
  hooks?: Record<string, unknown>;
  memory?: string;
  background?: boolean;
  effort?: string;
  isolation?: string;
}

export interface Agent {
  fileName: string;
  frontmatter: AgentFrontmatter;
  body: string;
  sourcePath: string;
}

// --- Command ---
export interface Command {
  name: string;
  content: string;
  sourcePath: string;
}

// --- Hook ---
export interface HookEntry {
  type: string;
  command?: string;
  url?: string;
}

export interface HookMatcher {
  matcher?: string;
  hooks: HookEntry[];
}

export interface Hooks {
  [event: string]: HookMatcher[];
}

// --- Plugin Interface (Marketplace display metadata) ---
export interface PluginInterface {
  displayName?: string;
  shortDescription?: string;
  longDescription?: string;
  developerName?: string;
  category?: string;
  capabilities?: string[];
  websiteURL?: string;
  privacyPolicyURL?: string;
  termsOfServiceURL?: string;
  defaultPrompt?: string[];
  brandColor?: string;
  composerIcon?: string;
  logo?: string;
  screenshots?: string[];
}

// --- Plugin ---
export interface PluginMeta {
  name: string;
  description?: string;
  version?: string;
  author?: { name: string; email?: string; url?: string };
  source?: string;
  category?: string;
  displayName?: string;
  homepage?: string;
  repository?: string;
  license?: string;
  keywords?: string[];
  // Resource path overrides (from plugin.json)
  skills?: string;
  agents?: string;
  commands?: string | string[];
  hooks?: string;
  mcpServers?: string;
  apps?: string;
  // Marketplace display metadata
  interface?: PluginInterface;
}

// --- Marketplace ---
export interface MarketplaceMeta {
  name: string;
  version?: string;
  description?: string;
  owner?: { name: string; email?: string };
  metadata?: { description?: string; version?: string; pluginRoot?: string };
  plugins: MarketplacePluginEntry[];
}

export interface MarketplacePluginEntry {
  name: string;
  source: string;
  description?: string;
  version?: string;
  category?: string;
}

// --- Plugin Resource File ---
export interface PluginResourceFile {
  relativePath: string;  // relative to plugin root, e.g. "scripts/mcp-server/start.js"
  content: string;
}

// --- Scan Result ---
export interface ScanResult {
  skills: Skill[];
  instructions: Instruction[];
  mcp: MCPConfig | null;
  agents: Agent[];
  commands: Command[];
  hooks: Hooks | null;
  pluginFiles: PluginResourceFile[];  // plugin-level resource files (scripts/, etc.)
  rootDir: string;
}

export interface PluginScanResult extends ScanResult {
  meta: PluginMeta;
}

export interface MarketplaceScanResult {
  marketplace: MarketplaceMeta;
  plugins: PluginScanResult[];
}

// --- Convert Result ---
export interface ConvertedFile {
  path: string;
  content: string;
  type: 'skill' | 'instruction' | 'mcp' | 'agent' | 'command' | 'hook' | 'manifest' | 'resource';
}

export interface ConvertResult {
  platform: Platform;
  files: ConvertedFile[];
  warnings: string[];
}
