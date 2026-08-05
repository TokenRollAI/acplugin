// Tolerant input types used only by the isolated Migration scanner.
export interface SkillFrontmatter {
  'name'?: string;
  'description'?: string;
  'when_to_use'?: string;
  'argument-hint'?: string;
  'arguments'?: unknown;
  'disable-model-invocation'?: boolean;
  'user-invocable'?: boolean;
  'allowed-tools'?: string;
  'disallowed-tools'?: string;
  'model'?: string;
  'effort'?: string;
  'context'?: string;
  'agent'?: string;
  'background'?: boolean;
  'paths'?: string | string[];
  'shell'?: string;
  'hooks'?: Record<string, unknown>;
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

export interface Instruction {
  fileName: string;
  content: string;
  sourcePath: string;
  isRule: boolean; // true if from .claude/rules/
}

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
  color?: string;
  initialPrompt?: string;
}

export interface Agent {
  fileName: string;
  frontmatter: AgentFrontmatter;
  body: string;
  sourcePath: string;
}

export interface Command {
  name: string;
  content: string;
  sourcePath: string;
}

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

export interface PluginResourceFile {
  relativePath: string; // relative to plugin root, e.g. "scripts/mcp-server/start.js"
  content: string;
}

export interface ScanResult {
  skills: Skill[];
  instructions: Instruction[];
  mcp: MCPConfig | null;
  agents: Agent[];
  commands: Command[];
  hooks: Hooks | null;
  pluginFiles: PluginResourceFile[]; // plugin-level resource files (scripts/, etc.)
  rootDir: string;
}

export interface PluginScanResult extends ScanResult {
  meta: PluginMeta;
}

export interface MarketplaceScanResult {
  marketplace: MarketplaceMeta;
  plugins: PluginScanResult[];
}
