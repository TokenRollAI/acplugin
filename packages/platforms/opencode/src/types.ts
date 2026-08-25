/** OpenCode workspace 根配置的受控选项。 */
export interface OpenCodeWorkspaceOptions {
  /** 是否在按需生成的 opencode.json 中写入官方 JSON Schema URL。 */
  readonly schema?: boolean;
}

/** 创建 OpenCode Platform 时可声明的公开选项。 */
export interface OpenCodePlatformOptions {
  /** 覆盖当前 Platform 的兼容性严格度。 */
  readonly strict?: boolean;
  /** 只影响 acplugin 拥有的 workspace 配置文件，不允许任意透传。 */
  readonly workspace?: OpenCodeWorkspaceOptions;
}

/** OpenCode Platform 接受的私有 Component union。 */
export type OpenCodePackageComponent = OpenCodeNativeAgentComponent;

/**
 * OpenCode 原生 workspace Subagent contribution。
 *
 * tools/permission 使用 OpenCode 本身的 wire model；不复用任何其他 Platform 的
 * Agent 类型、模型等级或角色抽象。
 */
export type OpenCodeNativeAgentComponent = import('@tokenroll/acplugin/sdk').JsonObject & Readonly<{
  readonly kind: 'native-agent';
  readonly id: string;
  readonly description: string;
  readonly body: string;
  /** OpenCode accepts a sparse map; omitted keys use the Platform defaults. */
  readonly tools?: Readonly<Partial<Record<'read' | 'glob' | 'grep' | 'edit' | 'bash' | 'webfetch' | 'task', boolean>>>;
  /** Permissions are likewise optional per tool and may be supplied independently. */
  readonly permission?: Readonly<Partial<Record<'edit' | 'bash' | 'webfetch' | 'task', 'allow' | 'deny'>>>;
}>;
