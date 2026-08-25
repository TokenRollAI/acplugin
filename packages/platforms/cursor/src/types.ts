/** Cursor Plugin Manifest 中经过官方 Schema 验证的平台专属选项。 */
export interface CursorPlatformOptions {
  /** 覆盖当前 Platform 的兼容性严格度。 */
  readonly strict?: boolean;
  /** Marketplace/安装界面显示的发布组织。 */
  readonly publisher?: string;
  /** 相对 Plugin 根或绝对 URL 的 Logo。 */
  readonly logo?: string;
  /** Cursor Marketplace 分类。 */
  readonly category?: string;
  /** Cursor Marketplace 标签。 */
  readonly tags?: readonly string[];
  /** 按客户端 ID 声明的最低语义版本。 */
  readonly minClientVersions?: Readonly<Record<string, string>>;
}

/** Cursor Platform 接受的私有 Component union。 */
export type CursorPackageComponent = CursorNativeAgentComponent;

/**
 * Cursor 原生 Subagent contribution。
 *
 * 这是 Cursor 自己的窄表示，不映射其他 Platform 的模型、工具或权限字段。
 */
export type CursorNativeAgentComponent = import('@tokenroll/acplugin/sdk').JsonObject & Readonly<{
  readonly kind: 'native-agent';
  readonly id: string;
  readonly description: string;
  readonly body: string;
  readonly readonly?: boolean;
}>;

/** Cursor 官方 Plugin Manifest 的受控结构。 */
export interface CursorPluginManifest {
  /** 稳定 Plugin ID。 */
  readonly name: string;
  /** 人类可读展示名。 */
  readonly displayName?: string;
  /** Plugin 说明。 */
  readonly description: string;
  /** Plugin 语义版本。 */
  readonly version: string;
  /** Cursor Schema 支持的作者姓名和邮件。 */
  readonly author?: { readonly name: string; readonly email?: string };
  /** 项目主页。 */
  readonly homepage?: string;
  /** 源码仓库。 */
  readonly repository?: string;
  /** SPDX License。 */
  readonly license?: string;
  /** 搜索关键词。 */
  readonly keywords?: readonly string[];
  /** Platform 专属发布组织。 */
  readonly publisher?: string;
  /** Platform 专属 Logo。 */
  readonly logo?: string;
  /** Platform 专属分类。 */
  readonly category?: string;
  /** Platform 专属标签。 */
  readonly tags?: readonly string[];
  /** 最低客户端版本映射。 */
  readonly minClientVersions?: Readonly<Record<string, string>>;
  /** Command 文件 Glob。 */
  readonly commands?: string;
  /** Skill 文件 Glob。 */
  readonly skills?: string;
  /** Agent 文件 Glob。 */
  readonly agents?: string;
  /** Hooks 配置路径或内联对象。 */
  readonly hooks?: string | Readonly<Record<string, unknown>>;
  /** MCP 配置路径或内联对象。 */
  readonly mcpServers?: string | Readonly<Record<string, unknown>>;
}
