/** Claude Code candidate validator 共用的只读边界。 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { JsonValue, ValidatePackageContext } from '@tokenroll/acplugin/sdk';

/** Claude Code validator 只消费 SDK 的最终 Package candidate Context。 */
export type PlatformValidateContext = ValidatePackageContext;

/** JSON 对象的运行时只读索引类型。 */
export type JsonRecord = Record<string, JsonValue>;

/**
 * 判断未知值是否为非数组 JSON 对象。
 *
 * @param value 从候选清单解析的未知 JSON 值。
 * @returns 可以按字段读取时返回 true。
 */
export function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 向 Core 提交 Claude Code 候选校验错误。
 *
 * @param context Platform validatePackage 生命周期上下文。
 * @param code 稳定诊断码。
 * @param message 不包含宿主绝对路径的错误信息。
 * @param fieldPath 可选的清单字段路径。
 */
export function report(
  context: PlatformValidateContext,
  code: string,
  message: string,
  fieldPath?: readonly (string | number)[],
): void {
  context.diagnostics.report({
    code,
    severity: 'error',
    message,
    ...(fieldPath === undefined ? {} : { fieldPath }),
  });
}

/**
 * 从候选安装根读取并解析 JSON 文件。
 *
 * @param context Platform validatePackage 生命周期上下文。
 * @param artifactPath 候选根内的规范 Asset 路径。
 * @returns JSON 对象；缺失或格式错误时提交诊断并返回 undefined。
 */
export async function readJson(
  context: PlatformValidateContext,
  artifactPath: string,
): Promise<JsonRecord | undefined> {
  try {
    /** 从已由 Core 安全物化的候选根读取清单文本。 */
    const source = await fs.readFile(path.join(context.candidate.root, artifactPath), 'utf8');
    /** JSON.parse 返回的未知值必须继续验证顶层对象形态。 */
    const value: unknown = JSON.parse(source);
    if (!isRecord(value)) {
      report(context, 'CLAUDE_MANIFEST_OBJECT_REQUIRED', `${artifactPath} must contain a JSON object.`);
      return undefined;
    }
    return value;
  } catch {
    report(context, 'CLAUDE_MANIFEST_READ_FAILED', `${artifactPath} must be present and contain valid JSON.`);
    return undefined;
  }
}

/**
 * 判断清单路径引用是否严格位于当前 Plugin 安装根。
 *
 * @param reference Claude Code 清单中的相对路径。
 * @returns 使用 `./`、不逃逸且不指向根本身时返回 true。
 */
export function isSafePluginReference(reference: string): boolean {
  if (!reference.startsWith('./') || reference.includes('\\') || reference.includes('\0'))
    return false;
  /** 去除协议要求的 `./` 后执行 POSIX 规范化。 */
  const relative = reference.slice(2);
  /** 规范化后的路径用于拒绝空路径、绝对路径和父目录逃逸。 */
  const normalized = path.posix.normalize(relative);
  return relative.length > 0
    && normalized !== '.'
    && normalized !== '..'
    && !normalized.startsWith('../')
    && !path.posix.isAbsolute(normalized);
}

/**
 * 判断候选 Asset 集合是否满足文件或目录引用。
 *
 * @param assets 当前 Package 的全部规范 Asset 路径。
 * @param reference 已通过安全规则校验的 Claude Code 路径引用。
 * @returns 精确文件或目录前缀至少匹配一个 Asset 时返回 true。
 */
export function referenceExists(assets: ReadonlySet<string>, reference: string): boolean {
  /** 清单引用去除固定 `./` 后的 Asset 路径。 */
  const target = reference.slice(2).replace(/\/+$/u, '');
  if (assets.has(target))
    return true;
  for (const asset of assets) {
    if (asset.startsWith(`${target}/`))
      return true;
  }
  return false;
}

/**
 * 把 Distribution 中某个 Plugin 子树转换为安装根相对 Asset 集合。
 *
 * @param context Platform validatePackage 生命周期上下文。
 * @param pluginRoot Plugin 相对于 Distribution 根的无前导点路径。
 * @returns 去掉 Plugin 根前缀后的 Asset 路径集合。
 */
export function scopedAssets(context: PlatformValidateContext, pluginRoot: string): ReadonlySet<string> {
  /** 根 Plugin 不需要过滤或裁剪路径。 */
  if (pluginRoot === '')
    return new Set(context.candidate.unit.assets.map(asset => asset.path));
  /** 嵌套 Plugin 全部 Asset 共同使用的固定目录前缀。 */
  const prefix = `${pluginRoot}/`;
  return new Set(context.candidate.unit.assets
    .filter(asset => asset.path.startsWith(prefix))
    .map(asset => asset.path.slice(prefix.length)));
}
