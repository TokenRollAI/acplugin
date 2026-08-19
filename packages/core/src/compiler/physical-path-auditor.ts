import path from 'node:path';

/** @returns haystack 是否包含完整 needle 字节序列。 */
function containsBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (needle.byteLength === 0 || needle.byteLength > haystack.byteLength)
    return false;
  /** 物理路径很短且输出在内存中，直接扫描避免把二进制 Asset 强制解码。 */
  outer: for (let offset = 0; offset <= haystack.byteLength - needle.byteLength; offset += 1) {
    for (let index = 0; index < needle.byteLength; index += 1) {
      if (haystack[offset + index] !== needle[index])
        continue outer;
    }
    return true;
  }
  return false;
}

/**
 * 拒绝输出字节中的 Core-known 物理根，且绝不在错误中回显 marker。
 *
 * @param bytes 最终待签发输出字节。
 * @param roots project/source/work/package 等物理根。
 * @param message 稳定、无物理路径的失败文案。
 */
export function assertNoPhysicalPathBytes(
  bytes: Uint8Array,
  roots: readonly string[],
  message: string,
): void {
  /** 同一 root 的宿主与 POSIX separator 形态都属于泄漏。 */
  const markers = new Set<string>();
  for (const root of roots) {
    if (root.length <= 1)
      continue;
    markers.add(root);
    markers.add(root.split(path.sep).join('/'));
    markers.add(root.replaceAll('\\', '/'));
  }
  /** 编码器保持物理 marker 与输出都按原始 UTF-8 字节比较。 */
  const encoder = new TextEncoder();
  for (const marker of markers) {
    if (containsBytes(bytes, encoder.encode(marker)))
      throw new Error(message);
  }
}
