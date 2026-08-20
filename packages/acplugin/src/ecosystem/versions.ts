import versions from './versions.json' with { type: 'json' };

/** 正式公开包名到当前脚手架默认精确版本的单一生成快照。 */
export type PublicPackageName = keyof typeof versions;

/** 当前 revision 的公开生态包版本快照。 */
export const PUBLIC_PACKAGE_VERSIONS: Readonly<Record<PublicPackageName, string>> = Object.freeze({ ...versions });

/** 返回脚手架和 Migration 共同使用的兼容依赖范围。 */
export function publicPackageRange(name: PublicPackageName): string {
  return `^${PUBLIC_PACKAGE_VERSIONS[name]}`;
}
