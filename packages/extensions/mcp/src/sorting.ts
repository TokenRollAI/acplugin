/** 使用与区域设置无关的 UTF-16 code-unit 顺序。 */
export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
