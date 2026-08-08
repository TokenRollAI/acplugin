/** Pi npm package gallery 的受控展示选项。 */
export interface PiPackageOptions {
  /** 相对 package 根或远程 URL 的展示图片。 */
  readonly image?: string;
  /** 远程演示视频 URL。 */
  readonly video?: string;
}

/** 创建 Pi Platform 时可声明的公开选项。 */
export interface PiPlatformOptions {
  /** 覆盖当前 Platform 的兼容性严格度。 */
  readonly strict?: boolean;
  /** 只影响 acplugin 生成的 Pi package manifest。 */
  readonly package?: PiPackageOptions;
}
