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
