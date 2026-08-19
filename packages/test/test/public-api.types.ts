import {
  defineConfig,
} from '@tokenroll/acplugin';
import {
  definePlatform,
  type AcpluginPlatform,
} from '@tokenroll/acplugin/sdk';
import antigravity from '@tokenroll/acplugin-platform-antigravity';
import claudeCode from '@tokenroll/acplugin-platform-claude-code';
import codex, { PLATFORM_ID as CODEX_PLATFORM_ID } from '@tokenroll/acplugin-platform-codex';
import cursor from '@tokenroll/acplugin-platform-cursor';
import openCode from '@tokenroll/acplugin-platform-opencode';
import pi from '@tokenroll/acplugin-platform-pi';

/**
 * 验证主包只提供开放 SDK，官方 Platform 则通过独立 package 参与同一品牌契约。
 */
export function verifyPublicPlatformTypes(): void {
  /** 第三方平台通过主包公开工厂获得开放品牌。 */
  const community: AcpluginPlatform = definePlatform({
    id: 'community-platform',
    apiVersion: '1',
    deliveryType: 'plugin',
    strict: true,
    /** 为每轮构建创建最小隔离 Session。 */
    createSession: () => ({
      /** 返回空 Platform base Package。 */
      createPackage: () => ({ documents: [], assets: [], compatibility: [], metadata: [] }),
      /** 固定主 Plugin Package 身份。 */
      finalizePackage: () => ({ id: 'plugin', type: 'plugin' }),
      /** 不增加候选校验约束。 */
      validatePackage: () => undefined,
    }),
  });
  /** 六个官方 package 各自约束自己的工厂选项。 */
  const official = [
    claudeCode({ defaultEnabled: false, marketplace: { owner: { name: 'TokenRoll' } } }),
    codex({ interface: { category: 'Productivity' } }),
    cursor({ strict: false }),
    antigravity({ strict: false }),
    openCode({ workspace: { schema: true } }),
    pi({ package: { image: './assets/cover.png' } }),
  ];
  /** 最终配置使用显式 Platform/Extension 数组且保持顶层 metadata。 */
  const config = defineConfig({
    name: 'typed-config',
    version: '1.0.0',
    description: 'Typed config.',
    platforms: official,
    extensions: [],
  });
  /** 独立 Codex package 暴露稳定 Platform ID。 */
  const codexId: 'codex' = CODEX_PLATFORM_ID;
  // @ts-expect-error Antigravity 不接受属于 Marketplace Platform 的配置字段。
  antigravity({ marketplace: {} });
  // @ts-expect-error Cursor 1.0 没有经过验证的 Marketplace Distribution 配置。
  cursor({ marketplace: {} });
  /** defineConfig 保留开放字面量，旧字段不会进入 UserConfig 的消费位置。 */
  const legacyLike = defineConfig({ name: 'legacy', version: '1.0.0', description: 'Legacy.', platforms: official, targets: ['codex'] });

  void [community, official, config, codexId, legacyLike];
}
