import type { Awaitable } from './common.js';
import type { PortableNodeCompileOptions } from './compiler.js';
import type { AcpluginExtension, AcpluginPlatform } from './integrations.js';

/** 配置与 BuildSession 支持的命令。 */
export type ConfigCommand = 'dev' | 'validate' | 'inspect' | 'build';

/** 构建执行模式。 */
export type BuildMode = 'development' | 'production';

/** 函数式配置唯一可观察的执行环境。 */
export interface ConfigEnvironment {
  readonly command: ConfigCommand;
  readonly mode: BuildMode;
}

/** Plugin 作者元数据。 */
export interface PluginAuthor {
  readonly name: string;
  readonly email?: string;
  readonly url?: string;
}

/** 规范化后的 Plugin 元数据。 */
export interface PluginMetadata {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly displayName?: string;
  readonly author?: PluginAuthor;
  readonly homepage?: string;
  readonly repository?: string;
  readonly license?: string;
  readonly keywords: readonly string[];
}

/** Public 目录中的一条显式来源映射。 */
export interface PublicCopyRule {
  readonly from: string;
  readonly to: string;
}

/** Public 资源的关闭、简写或精确映射配置。 */
export type PublicConfig = false | string | {
  readonly dir?: string;
  readonly copy?: readonly PublicCopyRule[];
};

/** Node Runtime 入口的执行意图。 */
export type NodeRuntimeEntryKind = 'executable' | 'module';

/** 作者显式配置的 Node Runtime 入口。 */
export interface NodeRuntimeEntryInput {
  readonly entry: string;
  readonly kind?: NodeRuntimeEntryKind;
}

/** 内建 Node Runtime Resource 的作者配置。 */
export interface NodeRuntimeConfig {
  readonly target?: 'node20';
  readonly entries?: Readonly<Record<string, NodeRuntimeEntryInput>>;
  readonly compile?: PortableNodeCompileOptions;
}

/** 构建输出和全局兼容性策略。 */
export interface BuildConfig {
  readonly outDir?: string;
  readonly strict?: boolean;
}

/** acplugin.config.ts 的最终作者配置。 */
export interface UserConfig {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly displayName?: string;
  readonly author?: PluginAuthor;
  readonly homepage?: string;
  readonly repository?: string;
  readonly license?: string;
  readonly keywords?: readonly string[];
  readonly srcDir?: string;
  readonly public?: PublicConfig;
  readonly runtime?: false | NodeRuntimeConfig;
  readonly platforms: readonly AcpluginPlatform[];
  readonly extensions?: readonly AcpluginExtension[];
  readonly build?: BuildConfig;
}

/** 配置文件允许导出的静态对象或函数。 */
export type UserConfigExport = UserConfig | ((environment: Readonly<ConfigEnvironment>) => Awaitable<UserConfig>);

/** 不包含工程路径的已解析配置摘要。 */
export interface ResolvedConfigSummary {
  readonly metadata: Readonly<PluginMetadata>;
  readonly command: ConfigCommand;
  readonly mode: BuildMode;
  readonly strict: boolean;
}
