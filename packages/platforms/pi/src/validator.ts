import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { JsonValue, ValidatePackageContext } from '@tokenroll/acplugin/sdk';
import { PACKAGE_MANIFEST_PATH } from './manifest.js';

/** Pi validator 只消费 SDK 的最终 Package candidate Context。 */
type PlatformValidateContext = ValidatePackageContext;

/** ACPlugin 允许写入 Pi package.json 的固定根字段。 */
const PACKAGE_FIELDS = new Set([
  'name', 'version', 'description', 'type', 'author', 'homepage', 'repository', 'license', 'keywords', 'pi',
]);

/** Pi discovery 对象允许的官方字段。 */
const PI_FIELDS = new Set(['extensions', 'skills', 'prompts', 'themes', 'image', 'video']);

/** JSON 对象的运行时只读索引类型。 */
type JsonRecord = Record<string, JsonValue>;

/** @returns 未知值是否为非数组 JSON 对象。 */
function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 向 Core 提交不含宿主路径的 Pi candidate 错误。 */
function report(context: PlatformValidateContext, code: string, message: string): void {
  context.diagnostics.report({ code, severity: 'error', message });
}

/** @returns 安全 package-root POSIX 引用对应的 Asset path。 */
function packageAssetPath(value: string): string | undefined {
  if (!value.startsWith('./') || value.includes('\\') || value.includes('\0'))
    return undefined;
  /** relative 不允许空、dot、parent 或 glob segment。 */
  const relative = value.slice(2).replace(/\/+$/u, '');
  /** segments 用于精确拒绝目录逃逸和 ACPlugin 未生成的 glob 语义。 */
  const segments = relative.split('/');
  if (relative.length === 0 || segments.some(segment => segment === '' || segment === '.' || segment === '..' || /[*?[\]{}!]/u.test(segment)))
    return undefined;
  return relative;
}

/** 校验一个 Pi discovery 数组安全且能在最终 Package 中找到资源。 */
function validateDiscoveryPaths(
  context: PlatformValidateContext,
  assets: ReadonlySet<string>,
  field: 'extensions' | 'skills' | 'prompts' | 'themes',
  value: JsonValue,
): void {
  if (!Array.isArray(value) || value.length === 0 || value.some(item => typeof item !== 'string')) {
    report(context, 'PI_DISCOVERY_PATH_INVALID', `pi.${field} must contain package-root path strings.`);
    return;
  }
  for (const reference of value as readonly string[]) {
    /** target 是引用指向的候选文件或目录根。 */
    const target = packageAssetPath(reference);
    if (target === undefined) {
      report(context, 'PI_DISCOVERY_PATH_INVALID', `pi.${field} contains an unsafe package-root path.`);
      continue;
    }
    if (![...assets].some(asset => asset === target || asset.startsWith(`${target}/`)))
      report(context, 'PI_DISCOVERY_PATH_MISSING', `pi.${field} references a missing package resource.`);
  }
}

/** 校验 Pi Gallery image/video 引用不含凭据且本地资源存在。 */
function validateGalleryReference(
  context: PlatformValidateContext,
  assets: ReadonlySet<string>,
  field: 'image' | 'video',
  value: JsonValue,
): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    report(context, 'PI_GALLERY_REFERENCE_INVALID', `pi.${field} must be a non-empty URL or package-root path.`);
    return;
  }
  /** local 是 image 可使用的 package 内静态资源引用。 */
  const local = packageAssetPath(value);
  if (local !== undefined) {
    if (field === 'video' || !assets.has(local))
      report(context, 'PI_GALLERY_REFERENCE_INVALID', `pi.${field} does not reference a supported package resource.`);
    return;
  }
  try {
    /** 远程 Gallery 媒体只允许不带内联凭据的 HTTP(S) URL。 */
    const url = new URL(value);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username !== '' || url.password !== '')
      throw new TypeError('Unsafe URL.');
    if (field === 'video' && !url.pathname.toLowerCase().endsWith('.mp4'))
      throw new TypeError('Video must be MP4.');
    if (field === 'image' && !/\.(?:png|jpe?g|gif|webp)$/iu.test(url.pathname))
      throw new TypeError('Image format is unsupported.');
  } catch {
    report(context, 'PI_GALLERY_REFERENCE_INVALID', `pi.${field} must use a supported HTTP(S) media URL without credentials.`);
  }
}

/** 校验 Pi npm Package 的 manifest、discovery closure 和 workspace 隔离。 */
export async function validatePiPackage(context: PlatformValidateContext): Promise<void> {
  /** 当前候选 Package 的规范 Asset 路径集合。 */
  const assets = new Set(context.candidate.unit.assets.map(asset => asset.path));
  /** 从候选根加载且仍需严格校验的 npm Manifest。 */
  let manifest: JsonRecord;
  try {
    /** JSON.parse 返回 unknown，不能信任 Core codec 之外的候选物化结果。 */
    const value: unknown = JSON.parse(await fs.readFile(path.join(context.candidate.root, PACKAGE_MANIFEST_PATH), 'utf8'));
    if (!isRecord(value))
      throw new TypeError('Manifest is not an object.');
    manifest = value;
  } catch {
    report(context, 'PI_PACKAGE_READ_FAILED', 'package.json must contain a JSON object.');
    return;
  }
  /** field 遍历用于拒绝 workspace/private/dependency 字段泄漏。 */
  for (const field of Object.keys(manifest)) {
    if (!PACKAGE_FIELDS.has(field))
      report(context, 'PI_PACKAGE_FIELD_UNKNOWN', `Unknown generated Pi package field "${field}".`);
  }
  if (Object.hasOwn(manifest, 'private') || Object.hasOwn(manifest, 'workspaces'))
    report(context, 'PI_PACKAGE_WORKSPACE_LEAK', 'Pi delivery package must not contain private or workspaces.');
  if (typeof manifest.name !== 'string' || manifest.name.trim().length === 0
    || typeof manifest.version !== 'string' || manifest.version.trim().length === 0
    || typeof manifest.description !== 'string' || manifest.description.trim().length === 0) {
    report(context, 'PI_PACKAGE_METADATA_INVALID', 'Pi package requires non-empty name, version, and description.');
  }
  if (manifest.type !== 'module')
    report(context, 'PI_PACKAGE_MODULE_TYPE_INVALID', 'Pi package must declare type module.');
  if (!Array.isArray(manifest.keywords) || manifest.keywords.some(keyword => typeof keyword !== 'string') || !manifest.keywords.includes('pi-package'))
    report(context, 'PI_PACKAGE_KEYWORD_MISSING', 'Pi package keywords must include pi-package.');
  if (!isRecord(manifest.pi)) {
    report(context, 'PI_DISCOVERY_CONFIG_INVALID', 'package.json.pi must be an object.');
    return;
  }
  /** field 遍历拒绝任意 package loader 配置或未知执行入口。 */
  for (const field of Object.keys(manifest.pi)) {
    if (!PI_FIELDS.has(field))
      report(context, 'PI_DISCOVERY_FIELD_UNKNOWN', `Unknown generated Pi discovery field "${field}".`);
  }
  for (const field of ['skills', 'prompts', 'extensions', 'themes'] as const) {
    if (manifest.pi[field] !== undefined)
      validateDiscoveryPaths(context, assets, field, manifest.pi[field]);
  }
  for (const field of ['image', 'video'] as const) {
    if (manifest.pi[field] !== undefined)
      validateGalleryReference(context, assets, field, manifest.pi[field]);
  }
}
