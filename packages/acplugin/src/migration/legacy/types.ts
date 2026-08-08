// 以下宽松输入类型只服务于隔离的 Legacy Scanner，不属于 Core Plugin 公开契约。
/** 旧 Skill Frontmatter 的宽松字段集合，未知或平台专有值由迁移层决定是否降级。 */
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

/** 旧 Skill 目录中除 SKILL.md 外、需要按原始字节保留的辅助文件。 */
export interface SkillAuxFile {
  /** 相对于 Skill 目录的路径，例如 `references/doc.md`。 */
  relativePath: string;
  /** 旧辅助文件的绝对来源路径，迁移时直接执行字节复制。 */
  sourcePath: string;
}

/** Legacy Scanner 读取的完整旧 Skill。 */
export interface Skill {
  /** 旧 Skill 一级目录名称。 */
  dirName: string;
  /** 容错解析后的旧 Frontmatter。 */
  frontmatter: SkillFrontmatter;
  /** 去除 Frontmatter 后的 Markdown 正文。 */
  body: string;
  /** 旧 SKILL.md 的绝对来源路径。 */
  sourcePath: string;
  /** 需要随 Skill 一起保留的辅助文件。 */
  auxFiles: SkillAuxFile[];
}

/** 旧 CLAUDE.md 或 `.claude/rules` 内容；不属于规范可安装 Plugin 边界。 */
export interface Instruction {
  /** 旧指令文件名。 */
  fileName: string;
  /** 原始 Markdown 内容。 */
  content: string;
  /** 旧文件绝对路径。 */
  sourcePath: string;
  /** 是否来自 `.claude/rules/` 而非 CLAUDE.md。 */
  isRule: boolean;
}

/** 旧 `.mcp.json` 中一个宽松 MCP Server 条目。 */
export interface MCPServer {
  /** Server 在旧映射中的名称。 */
  name: string;
  /** stdio 模式使用的本地命令。 */
  command?: string;
  /** 本地命令参数；迁移报告中必须脱敏。 */
  args?: string[];
  /** 本地进程环境；迁移报告中只保留变量名称。 */
  env?: Record<string, string>;
  /** 旧传输标识，常见值为 http 或 stdio。 */
  type?: string;
  /** 远程 MCP 端点。 */
  url?: string;
  /** 远程请求 Header；迁移报告中只保留名称。 */
  headers?: Record<string, string>;
}

/** 旧 MCP 配置及其来源文件。 */
export interface MCPConfig {
  /** 从旧映射展开并注入名称的 Server 列表。 */
  servers: MCPServer[];
  /** `.mcp.json` 的绝对路径。 */
  sourcePath: string;
}

/** 旧 Agent Frontmatter 的宽松字段集合。 */
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

/** Legacy Scanner 读取的完整旧 Agent。 */
export interface Agent {
  /** 不含 `.md` 后缀的旧 Agent 文件名。 */
  fileName: string;
  /** 容错解析后的旧 Frontmatter。 */
  frontmatter: AgentFrontmatter;
  /** 去除 Frontmatter 后的 Markdown 正文。 */
  body: string;
  /** 旧 Agent Markdown 的绝对路径。 */
  sourcePath: string;
}

/** Legacy Scanner 读取的旧 Command Markdown。 */
export interface Command {
  /** 不含 `.md` 后缀的旧 Command 名称。 */
  name: string;
  /** 保留 Frontmatter 的完整旧 Markdown。 */
  content: string;
  /** 旧 Command 文件绝对路径。 */
  sourcePath: string;
}

/** 旧 Hook Matcher 中一个命令或 URL Handler。 */
export interface HookEntry {
  /** 旧 Handler 类型。 */
  type: string;
  /** 本地命令 Handler。 */
  command?: string;
  /** 远程 URL Handler。 */
  url?: string;
}

/** 旧 Hook 事件下的一组可选 Matcher 与 Handler。 */
export interface HookMatcher {
  /** 旧平台 Matcher 表达式。 */
  matcher?: string;
  /** 该 Matcher 触发的 Handler。 */
  hooks: HookEntry[];
}

/** 旧 Hook 事件名到 Matcher 组的宽松映射。 */
export interface Hooks {
  /** 未知事件仍被保留，供人工迁移。 */
  [event: string]: HookMatcher[];
}

/** 旧 Marketplace Plugin 的展示层元数据。 */
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

/** 旧 `.claude-plugin/plugin.json` 的容错元数据和资源路径覆盖。 */
export interface PluginMeta {
  /** 旧 Plugin 机器名称。 */
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
  // 以下字段覆盖旧 plugin.json 中各资源类型的默认扫描位置。
  skills?: string;
  agents?: string;
  commands?: string | string[];
  hooks?: string;
  mcpServers?: string;
  apps?: string;
  // Marketplace 可选的展示层元数据。
  interface?: PluginInterface;
}

/** 旧 Marketplace 清单及其 Plugin 条目。 */
export interface MarketplaceMeta {
  name: string;
  version?: string;
  description?: string;
  owner?: { name: string; email?: string };
  metadata?: { description?: string; version?: string; pluginRoot?: string };
  plugins: MarketplacePluginEntry[];
}

/** Marketplace 中一个待解析来源的 Plugin 记录。 */
export interface MarketplacePluginEntry {
  name: string;
  source: string;
  description?: string;
  version?: string;
  category?: string;
}

/** 无法分类、需要在未映射目录中保留的 Plugin 级文本文件。 */
export interface PluginResourceFile {
  /** 相对于 Plugin 根目录的路径，例如 `scripts/mcp-server/start.js`。 */
  relativePath: string;
  /** 原样保留的文本内容。 */
  content: string;
}

/** 旧 Claude 工程扫描产生的统一宽松资源集合。 */
export interface ScanResult {
  /** 扫描到的旧 Skills。 */
  skills: Skill[];
  /** 扫描到但不会进入可安装 Plugin 的 Instructions。 */
  instructions: Instruction[];
  /** 可选的旧 MCP 配置。 */
  mcp: MCPConfig | null;
  /** 扫描到的旧 Agents。 */
  agents: Agent[];
  /** 扫描到的旧 Commands。 */
  commands: Command[];
  /** 可选的旧 Hooks 配置。 */
  hooks: Hooks | null;
  /** Hooks 实际读取文件的绝对路径；没有 Hooks 时省略。 */
  hooksSourcePath?: string;
  /** 未分类的 Plugin 级资源文件。 */
  pluginFiles: PluginResourceFile[];
  /** 当前 ScanResult 对应的绝对来源根目录。 */
  rootDir: string;
}

/** 在通用 ScanResult 上附加旧 Plugin 元数据。 */
export interface PluginScanResult extends ScanResult {
  /** 旧 Plugin 清单元数据。 */
  meta: PluginMeta;
  /** 元数据实际来自的来源根相对清单路径。 */
  metadataSource: string;
}

/** Marketplace 扫描清单及其中成功解析的全部 Plugin。 */
export interface MarketplaceScanResult {
  /** Marketplace 顶层元数据。 */
  marketplace: MarketplaceMeta;
  /** 各 Marketplace 条目对应的完整 Plugin 扫描结果。 */
  plugins: PluginScanResult[];
}
