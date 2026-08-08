import {
  defineConfig,
  definePlatform,
  type PlatformId,
} from '@tokenroll/acplugin';
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
  const community: PlatformId = definePlatform({
    id: 'community-platform',
    apiVersion: '1',
    deliveryType: 'plugin',
    strict: true,
    /** prepare 提供当前对象协议要求的回调实现。 */ prepare: () => ({ documents: [], artifacts: [] }),
    /** generateBundle 提供当前对象协议要求的回调实现。 */ generateBundle: () => ({ id: 'plugin', role: 'primary', type: 'plugin', artifacts: [] }),
    /** validateBundle 提供当前对象协议要求的回调实现。 */ validateBundle: () => undefined,
  }).id;
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
  // @ts-expect-error 最终配置不再接受旧 targets 字段。
  defineConfig({ name: 'legacy', version: '1.0.0', description: 'Legacy.', platforms: official, targets: ['codex'] });

  void [community, official, config, codexId];
}
