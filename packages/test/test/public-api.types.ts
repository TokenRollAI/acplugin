import {
  antigravity,
  BUILTIN_PLATFORM_IDS,
  claudeCode,
  codex,
  cursor,
  defineConfig,
  definePlatform,
  openCode,
  pi,
  type BuiltinPlatformId,
  type PlatformId,
} from '@tokenroll/acplugin';
import { PLATFORM_ID as CODEX_PLATFORM_ID } from '@tokenroll/acplugin/platforms/codex';

/**
 * 验证主包只需通过精选导出即可支持内置联合类型和开放第三方 Platform。
 */
export function verifyPublicPlatformTypes(): void {
  /** 主包维护的六个平台组成封闭联合类型。 */
  const builtin: BuiltinPlatformId = BUILTIN_PLATFORM_IDS[0];
  /** 第三方平台通过工厂获得不受内置联合限制的开放品牌。 */
  const community: PlatformId = definePlatform({
    id: 'community-platform',
    apiVersion: '1',
    deliveryType: 'plugin',
    strict: true,
    /** prepare 提供当前对象协议要求的回调实现。 */ prepare: () => ({ documents: [], artifacts: [] }),
    /** generateBundle 提供当前对象协议要求的回调实现。 */ generateBundle: () => ({ id: 'plugin', role: 'primary', type: 'plugin', artifacts: [] }),
    /** validateBundle 提供当前对象协议要求的回调实现。 */ validateBundle: () => undefined,
  }).id;
  // @ts-expect-error 第三方 ID 不会被误纳入官方内置联合类型。
  const unsupportedBuiltin: BuiltinPlatformId = 'community-platform';
  /** 六个官方工厂各自接受由所属 Platform 包约束的配置。 */
  const official = [
    claudeCode({ defaultEnabled: false, marketplace: { owner: { name: 'TokenRoll' } } }),
    codex({ interface: { category: 'Productivity' } }),
    cursor({ strict: false }),
    antigravity({ strict: false }),
    openCode({ workspace: { schema: true } }),
    pi({ package: { image: './assets/cover.png' } }),
  ];
  /** 最终配置使用 Platform/Extension 数组且保持顶层 metadata。 */
  const config = defineConfig({
    name: 'typed-config',
    version: '1.0.0',
    description: 'Typed config.',
    platforms: official,
    extensions: [],
  });
  /** 子路径稳定导出与主入口工厂使用同一 Platform ID。 */
  const codexId: 'codex' = CODEX_PLATFORM_ID;
  // @ts-expect-error Antigravity 不接受属于 Marketplace Platform 的配置字段。
  antigravity({ marketplace: {} });
  // @ts-expect-error Cursor 1.0 没有经过验证的 Marketplace Distribution 配置。
  cursor({ marketplace: {} });
  // @ts-expect-error 最终配置不再接受旧 targets 字段。
  defineConfig({ name: 'legacy', version: '1.0.0', description: 'Legacy.', targets: ['codex'] });

  void [builtin, community, unsupportedBuiltin, official, config, codexId];
}
