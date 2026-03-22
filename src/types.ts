// Target platforms
export type Platform = 'codex' | 'opencode' | 'cursor' | 'antigravity';

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

export interface Skill {
  dirName: string;
  frontmatter: SkillFrontmatter;
  body: string;
  sourcePath: string;
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

// --- Plugin ---
export interface PluginMeta {
  name: string;
  description?: string;
  version?: string;
  author?: { name: string; email?: string };
  source?: string;
  category?: string;
  displayName?: string;
  homepage?: string;
  repository?: string;
  license?: string;
  keywords?: string[];
}

// --- Scan Result ---
export interface ScanResult {
  skills: Skill[];
  instructions: Instruction[];
  mcp: MCPConfig | null;
  agents: Agent[];
  commands: Command[];
  hooks: Hooks | null;
  rootDir: string;
}

export interface PluginScanResult extends ScanResult {
  meta: PluginMeta;
}

// --- Convert Result ---
export interface ConvertedFile {
  path: string;
  content: string;
  type: 'skill' | 'instruction' | 'mcp' | 'agent' | 'command' | 'hook';
}

export interface ConvertResult {
  platform: Platform;
  files: ConvertedFile[];
  warnings: string[];
}
