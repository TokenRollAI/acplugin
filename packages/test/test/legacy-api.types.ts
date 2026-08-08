// @ts-expect-error 1.0 主入口不再公开旧 Module、Target 或 Compiler 生态类型。
import type { AcpluginModule, TargetId } from '@tokenroll/acplugin';

/**
 * 仅用于让 TypeScript 保留上方负向公开 API 断言。
 */
export function verifyLegacyApiIsPrivate(): void {
  void (undefined as unknown as AcpluginModule);
  void (undefined as unknown as TargetId);
}
