/** Codex candidate validator 共用的只读边界。 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { JsonValue, ValidatePackageContext } from '@tokenroll/acplugin/sdk';
import { parseDocument } from 'yaml';

/** Codex validator 只消费 SDK 的最终 Package candidate Context。 */
export type PlatformValidateContext = ValidatePackageContext;

/** JSON 对象的运行时可索引类型。 */
export type JsonRecord = Record<string, JsonValue>;

/**
 * 判断未知值是否为非数组 JSON 对象。
 *
 * @param value 从候选清单解析的未知值。
 * @returns 可以按字段读取时返回 true。
 */
export function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 向 Core 提交 Codex 候选校验错误。
 *
 * @param context Platform validatePackage 生命周期上下文。
 * @param code 稳定诊断码。
 * @param message 不包含宿主绝对路径的错误信息。
 * @param fieldPath 可选的清单字段位置。
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
 * @param assetPath 候选根内的规范 Asset 路径。
 * @returns JSON 对象；缺失或格式错误时提交诊断并返回 undefined。
 */
export async function readJson(
  context: PlatformValidateContext,
  assetPath: string,
): Promise<JsonRecord | undefined> {
  try {
    /** 从 Core 已安全物化的候选根读取清单文本。 */
    const source = await fs.readFile(path.join(context.candidate.root, assetPath), 'utf8');
    /** JSON.parse 的未知结果仍需验证顶层对象形态。 */
    const value: unknown = JSON.parse(source);
    if (!isRecord(value)) {
      report(context, 'CODEX_MANIFEST_OBJECT_REQUIRED', `${assetPath} must contain a JSON object.`);
      return undefined;
    }
    return value;
  } catch {
    report(context, 'CODEX_MANIFEST_READ_FAILED', `${assetPath} must be present and contain valid JSON.`);
    return undefined;
  }
}

/**
 * 解析 YAML 并要求顶层为普通映射。
 *
 * @param context Platform validatePackage 生命周期上下文。
 * @param source 待解析的 YAML 文本。
 * @param assetPath 用于稳定诊断的相对 Asset 路径。
 * @returns 无语法错误的 JSON 兼容对象，否则返回 undefined。
 */
export function parseYamlObject(
  context: PlatformValidateContext,
  source: string,
  assetPath: string,
): JsonRecord | undefined {
  try {
    /** 保留 YAML parser errors 以拒绝重复键和其他不规范输入。 */
    const document = parseDocument(source, { uniqueKeys: true });
    if (document.errors.length > 0)
      throw new Error('Malformed YAML.');
    /** YAML 文档转换后的未知顶层值。 */
    const value: unknown = document.toJSON();
    if (!isRecord(value)) {
      report(context, 'CODEX_YAML_OBJECT_REQUIRED', `${assetPath} must contain a YAML mapping.`);
      return undefined;
    }
    return value;
  } catch {
    report(context, 'CODEX_YAML_INVALID', `${assetPath} must contain valid YAML.`);
    return undefined;
  }
}

/**
 * 判断清单路径引用是否严格位于当前 Plugin 安装根。
 *
 * @param reference Codex Manifest 中的相对路径。
 * @returns 路径使用 `./`、不逃逸且不指向根本身时返回 true。
 */
export function isSafePluginReference(reference: string): boolean {
  if (!reference.startsWith('./') || reference.includes('\\') || reference.includes('\0'))
    return false;
  /** 去掉协议前缀后执行 POSIX 规范化的路径片段。 */
  const relative = reference.slice(2);
  /** 规范化路径用于拒绝空引用和父目录逃逸。 */
  const normalized = path.posix.normalize(relative);
  return relative.length > 0
    && normalized !== '.'
    && normalized !== '..'
    && !normalized.startsWith('../')
    && !path.posix.isAbsolute(normalized);
}

/**
 * 判断 Asset 集合是否包含被引用文件或目录。
 *
 * @param assets 当前 Package 的规范路径集合。
 * @param reference 已通过安全规则验证的 Manifest 引用。
 * @returns 精确文件或目录前缀存在时返回 true。
 */
export function referenceExists(assets: ReadonlySet<string>, reference: string): boolean {
  /** 清单引用去掉 `./` 和结尾斜线后的 Asset 路径。 */
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

/**
 * 校验单个 Manifest 路径的安全性与存在性。
 *
 * @param context Platform validatePackage 生命周期上下文。
 * @param assets 当前 Package 的 Asset 路径集合。
 * @param field 当前引用所属字段。
 * @param reference 待校验路径。
 * @param fieldPath 精确诊断位置。
 */
export function validateReference(
  context: PlatformValidateContext,
  assets: ReadonlySet<string>,
  field: string,
  reference: string,
  fieldPath: readonly (string | number)[],
): void {
  if (!isSafePluginReference(reference)) {
    report(context, 'CODEX_MANIFEST_REFERENCE_UNSAFE', `${field} must start with ./ and stay inside the Plugin root.`, fieldPath);
  } else if (!referenceExists(assets, reference)) {
    report(context, 'CODEX_MANIFEST_REFERENCE_MISSING', `${field} references a missing Plugin file or directory.`, fieldPath);
  }
}
