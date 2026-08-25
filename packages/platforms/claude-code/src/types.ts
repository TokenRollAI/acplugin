/** Claude Code Marketplace 所有者的显式身份。 */
export interface ClaudeCodeMarketplaceOwner {
  readonly name: string;
  readonly email?: string;
  readonly url?: string;
}

/** Claude Code Marketplace 的平台专属根级展示选项。 */
export interface ClaudeCodeMarketplaceOptions {
  readonly name?: string;
  readonly owner?: ClaudeCodeMarketplaceOwner;
  readonly category?: string;
  readonly tags?: readonly string[];
}

/** 创建 Claude Code Platform 时可声明的公开选项。 */
export interface ClaudeCodePlatformOptions {
  readonly strict?: boolean;
  readonly defaultEnabled?: boolean;
  readonly marketplace?: ClaudeCodeMarketplaceOptions;
}

/** Claude Code Platform 允许 Extension 在 finalization 提交的私有 Component 联合。 */
export type ClaudePackageComponent = ClaudeNativeAgentComponent;

/**
 * Claude Code 原生 Agent 的 Platform-owned contribution 数据。
 *
 * 它不是 Canonical Agent，也不复用 Core 的 Agent model/capability 类型；每个字段
 * 的运行时校验、名称冲突、frontmatter 和安装路径都由本 Platform 独立拥有。
 */
export type ClaudeNativeAgentComponent = import('@tokenroll/acplugin/sdk').JsonObject & Readonly<{
  readonly kind: 'native-agent';
  readonly id: string;
  readonly description: string;
  readonly body: string;
  readonly model?: 'inherit' | 'fast' | 'capable';
  readonly tools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  readonly maxTurns?: number;
  readonly skills?: readonly string[];
  readonly memory?: 'user' | 'project' | 'local';
  readonly background?: boolean;
  readonly isolation?: 'worktree';
}>;

/** Claude Code Plugin 清单中可由 Platform 和 Extension 共同组成的字段。 */
export interface ClaudeCodePluginManifest {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly displayName?: string;
  readonly author?: {
    readonly name: string;
    readonly email?: string;
    readonly url?: string;
  };
  readonly homepage?: string;
  readonly repository?: string;
  readonly license?: string;
  readonly keywords?: readonly string[];
  readonly defaultEnabled?: boolean;
  readonly commands?: string;
  readonly skills?: string;
  readonly agents?: string;
  readonly hooks?: string | Readonly<Record<string, unknown>>;
  readonly mcpServers?: string | Readonly<Record<string, unknown>>;
}

/** Claude Code 自包含 Marketplace 中一个 Plugin 的相对安装根。 */
export type ClaudeCodeMarketplacePluginSource = './' | `./plugins/${string}`;

/** Claude Code Marketplace 文件中的单个 Plugin 条目。 */
export interface ClaudeCodeMarketplacePlugin {
  readonly name: string;
  readonly source: ClaudeCodeMarketplacePluginSource;
  readonly description: string;
  readonly version: string;
  readonly author?: ClaudeCodePluginManifest['author'];
  readonly homepage?: string;
  readonly repository?: string;
  readonly license?: string;
  readonly keywords?: readonly string[];
  readonly category?: string;
  readonly tags?: readonly string[];
  readonly strict: true;
}

/** Claude Code 自包含 Marketplace 的根清单。 */
export interface ClaudeCodeMarketplaceManifest {
  readonly name: string;
  readonly owner: ClaudeCodeMarketplaceOwner;
  readonly description: string;
  readonly version: string;
  readonly metadata: {
    readonly pluginRoot: './';
  };
  readonly plugins: readonly ClaudeCodeMarketplacePlugin[];
}
