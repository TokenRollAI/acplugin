/** Codex interface 与品牌 Asset validator。 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { JsonValue } from '@tokenroll/acplugin/sdk';
import { imageSize } from 'image-size';
import {
  CODEX_INTERFACE_FIELDS,
  CODEX_INTERFACE_REQUIRED_FIELDS,
  codexInterfaceFieldIssue,
  parseCodexSvgDimensions,
} from '../protocol.js';
import {
  isRecord,
  isSafePluginReference,
  referenceExists,
  report,
  validateReference,
  type PlatformValidateContext,
} from './shared.js';

/** Codex Plugin `interface` 允许出现的当前官方字段。 */
const INTERFACE_FIELDS = new Set<string>(CODEX_INTERFACE_FIELDS);

/** Codex 目录品牌图片支持的文件扩展名。 */
const BRANDING_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.svg']);

/** Codex 目录品牌图片允许的最大字节数。 */
const MAX_BRANDING_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * 校验已存在的 Codex 目录品牌图片格式、字节数和方形尺寸。
 *
 * @param context Platform validatePackage 生命周期上下文。
 * @param pluginRoot Plugin 相对于候选 Distribution 根的安装目录。
 * @param reference 相对于 Plugin 根的图片路径。
 * @param field Manifest 中声明图片的字段。
 * @param fieldPath 精确诊断位置。
 */
async function validateBrandingImage(
  context: PlatformValidateContext,
  pluginRoot: string,
  reference: string,
  field: string,
  fieldPath: readonly (string | number)[],
): Promise<void> {
  if (!isSafePluginReference(reference))
    return;
  /** Manifest 引用转换后的候选根内 Asset 路径。 */
  const assetPath = reference.slice(2);
  /** 图片文件名的规范小写扩展名。 */
  const extension = path.posix.extname(assetPath).toLocaleLowerCase('en-US');
  if (!BRANDING_IMAGE_EXTENSIONS.has(extension)) {
    report(context, 'CODEX_BRANDING_IMAGE_FORMAT_UNSUPPORTED', `${field} must use PNG, JPEG, WebP, or SVG.`, fieldPath);
    return;
  }
  try {
    /** 从 Core 已物化的候选根读取实际图片字节。 */
    const bytes = await fs.readFile(path.join(context.candidate.root, pluginRoot, assetPath));
    if (bytes.byteLength > MAX_BRANDING_IMAGE_BYTES) {
      report(context, 'CODEX_BRANDING_IMAGE_TOO_LARGE', `${field} must not exceed 5 MiB.`, fieldPath);
      return;
    }
    /** SVG 与 Raster 解析后统一参与方形和范围校验的尺寸。 */
    let dimensions: { readonly width?: number; readonly height?: number };
    if (extension === '.svg') {
      dimensions = parseCodexSvgDimensions(bytes);
    } else {
      /** Raster 继续使用二进制格式探测与安全解码。 */
      const raster = imageSize(bytes);
      /** `.jpeg` 与 image-size 返回的 `jpg` 使用同一检测格式。 */
      const expectedType = extension === '.jpeg' ? 'jpg' : extension.slice(1);
      if (raster.type !== expectedType) {
        report(context, 'CODEX_BRANDING_IMAGE_CONTENT_MISMATCH', `${field} extension must match the detected image format.`, fieldPath);
      }
      dimensions = raster;
    }
    if (dimensions.width === undefined || dimensions.height === undefined
      || dimensions.width !== dimensions.height
      || dimensions.width < 48
      || dimensions.width > 4_096) {
      report(context, 'CODEX_BRANDING_IMAGE_DIMENSIONS_INVALID', `${field} must be a square image between 48 and 4096 pixels.`, fieldPath);
    }
  } catch {
    report(context, 'CODEX_BRANDING_IMAGE_DECODE_FAILED', `${field} must reference a readable, decodable image.`, fieldPath);
  }
}

/**
 * 校验 Codex Plugin 安装界面字段和资源引用。
 *
 * @param context Platform validatePackage 生命周期上下文。
 * @param assets 当前 Package 的 Asset 路径集合。
 * @param pluginRoot Plugin 相对于候选 Distribution 根的安装目录。
 * @param value Manifest 的 interface 候选。
 */
export async function validateInterface(
  context: PlatformValidateContext,
  assets: ReadonlySet<string>,
  pluginRoot: string,
  value: JsonValue,
): Promise<void> {
  if (!isRecord(value)) {
    report(context, 'CODEX_INTERFACE_OBJECT_REQUIRED', 'interface must be a JSON object.', ['interface']);
    return;
  }
  for (const field of Object.keys(value)) {
    if (!INTERFACE_FIELDS.has(field))
      report(context, 'CODEX_INTERFACE_FIELD_UNKNOWN', `Unknown Codex interface field "${field}".`, ['interface', field]);
  }
  /** 已报告纯值问题的字段不再进入资源存在性校验。 */
  const invalidFields = new Set<string>();
  for (const field of CODEX_INTERFACE_FIELDS) {
    /** 当前最终 interface 字段候选。 */
    const candidate = value[field];
    /** 当前字段是否属于 interface 存在时的四个必填展示字段。 */
    const required = (CODEX_INTERFACE_REQUIRED_FIELDS as readonly string[]).includes(field);
    /** 必填字段缺失、类型错误或空白时只报告必填问题。 */
    const requiredInvalid = required && (typeof candidate !== 'string' || candidate.trim().length === 0);
    if (candidate === undefined || requiredInvalid) {
      if (required) {
        report(context, 'CODEX_INTERFACE_FIELD_REQUIRED', `interface.${field} must be a non-empty string.`, ['interface', field]);
        invalidFields.add(field);
      }
      continue;
    }
    /** 共享纯规则返回的第一个稳定问题。 */
    const issue = codexInterfaceFieldIssue(field, candidate);
    if (issue !== undefined) {
      report(context, issue.code, issue.message, ['interface', field]);
      invalidFields.add(field);
    }
  }
  for (const field of ['composerIcon', 'logo'] as const) {
    /** 当前图片路径候选。 */
    const candidate = value[field];
    if (typeof candidate === 'string' && !invalidFields.has(field)) {
      validateReference(context, assets, `interface.${field}`, candidate, ['interface', field]);
      if (referenceExists(assets, candidate))
        await validateBrandingImage(context, pluginRoot, candidate, `interface.${field}`, ['interface', field]);
    }
  }
  if (Array.isArray(value.screenshots) && !invalidFields.has('screenshots')) {
    for (const [index, screenshot] of value.screenshots.entries())
      validateReference(context, assets, 'interface.screenshots', screenshot as string, ['interface', 'screenshots', index]);
  }
}
