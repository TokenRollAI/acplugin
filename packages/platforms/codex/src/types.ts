import type { JsonValue, PluginAuthor } from '@tokenroll/acplugin/sdk';
import type { CodexCategory, CodexMarketplaceInstallation } from './protocol.js';

export type { CodexCategory, CodexMarketplaceInstallation } from './protocol.js';

/** Codex Plugin `interface` 中由平台工厂管理的展示选项。 */
export interface CodexInterfaceOptions {
  readonly shortDescription?: string;
  readonly longDescription?: string;
  readonly developerName?: string;
  readonly category?: CodexCategory;
  readonly capabilities?: readonly string[];
  readonly websiteURL?: string;
  readonly privacyPolicyURL?: string;
  readonly termsOfServiceURL?: string;
  readonly supportURL?: string;
  readonly defaultPrompt?: string | readonly string[];
  readonly brandColor?: string;
  readonly brandColorDark?: string;
  readonly composerIcon?: string;
  readonly logo?: string;
  readonly screenshots?: readonly string[];
}

/** Codex Marketplace 单 Plugin 条目的策略选项。 */
export interface CodexMarketplacePolicyOptions {
  readonly installation?: CodexMarketplaceInstallation;
}

/** Codex Marketplace 的可配置根级展示与安装选项。 */
export interface CodexMarketplaceOptions {
  readonly name?: string;
  readonly displayName?: string;
  readonly category?: CodexCategory;
  readonly policy?: CodexMarketplacePolicyOptions;
}

/** 创建 Codex Platform 时可声明的公开选项。 */
export interface CodexPlatformOptions {
  readonly strict?: boolean;
  readonly interface?: CodexInterfaceOptions;
  readonly marketplace?: CodexMarketplaceOptions;
}

/** Codex Plugin 清单中面向安装界面的完整展示区域。 */
export interface CodexPluginInterface {
  readonly displayName: string;
  readonly shortDescription: string;
  readonly longDescription: string;
  readonly developerName: string;
  readonly category?: CodexCategory;
  readonly capabilities?: readonly string[];
  readonly websiteURL?: string;
  readonly privacyPolicyURL?: string;
  readonly termsOfServiceURL?: string;
  readonly supportURL?: string;
  readonly defaultPrompt?: string | readonly string[];
  readonly brandColor?: string;
  readonly brandColorDark?: string;
  readonly composerIcon?: string;
  readonly logo?: string;
  readonly screenshots?: readonly string[];
}

/** Codex Plugin Manifest 的平台所有字段。 */
export interface CodexPluginManifest {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly author?: PluginAuthor;
  readonly homepage?: string;
  readonly repository?: string;
  readonly license?: string;
  readonly keywords?: readonly string[];
  readonly skills: './skills/';
  readonly interface?: CodexPluginInterface;
  readonly hooks?: JsonValue;
  readonly mcpServers?: string;
}

/** Codex Marketplace 文件中的本地 Plugin 来源。 */
export interface CodexMarketplaceSource {
  readonly source: 'local';
  readonly path: './' | `./plugins/${string}`;
}

/** Codex Marketplace 文件中的单个 Plugin 条目。 */
export interface CodexMarketplacePlugin {
  readonly name: string;
  readonly source: CodexMarketplaceSource;
  readonly policy: {
    readonly installation: CodexMarketplaceInstallation;
    readonly authentication: 'ON_INSTALL';
  };
  readonly category: CodexCategory;
}

/** Codex 自包含 Marketplace 清单。 */
export interface CodexMarketplaceManifest {
  readonly name: string;
  readonly interface: {
    readonly displayName: string;
  };
  readonly plugins: readonly CodexMarketplacePlugin[];
}
