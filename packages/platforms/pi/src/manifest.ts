import type {
  JsonObject,
  MetadataDispositionInput,
  PackageDocumentInput,
  PluginMetadata,
} from '@tokenroll/acplugin/sdk';
import type { PiPackageOptions, PiPlatformOptions } from './types.js';

/** Pi npm package Manifest 的稳定 Document ID。 */
export const PACKAGE_MANIFEST_ID = 'package-manifest';

/** Pi npm package Manifest 相对于交付根的固定路径。 */
export const PACKAGE_MANIFEST_PATH = 'package.json';

/** @returns 值是否为非空字符串。 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** 校验 Pi Platform 选项并拒绝任意 npm 字段透传。 */
export function validatePlatformOptions(options: PiPlatformOptions): void {
  /** Platform 顶层只允许 Core strict 和受控 package 子对象。 */
  const allowed = new Set(['strict', 'package']);
  for (const field of Object.keys(options)) {
    if (!allowed.has(field))
      throw new TypeError(`Unknown Pi Platform option "${field}".`);
  }
  if (options.strict !== undefined && typeof options.strict !== 'boolean')
    throw new TypeError('Pi strict must be a boolean.');
  if (options.package === undefined)
    return;
  if (options.package === null || typeof options.package !== 'object' || Array.isArray(options.package))
    throw new TypeError('Pi package must be a plain object.');
  for (const field of Object.keys(options.package)) {
    if (field !== 'image' && field !== 'video')
      throw new TypeError(`Unknown Pi package option "${field}".`);
  }
  for (const field of ['image', 'video'] as const) {
    if (options.package[field] !== undefined && !isNonEmptyString(options.package[field]))
      throw new TypeError(`Pi package.${field} must be a non-empty string.`);
  }
}

/** @returns 当前工程实际 metadata 的完整 npm emitted/omitted disposition。 */
function metadataDispositions(metadata: PluginMetadata): readonly MetadataDispositionInput[] {
  /** outputs 保存字段和确定的 npm Manifest 位置。 */
  const outputs: [string, string | undefined][] = [
    ['name', `${PACKAGE_MANIFEST_PATH}.name`],
    ['version', `${PACKAGE_MANIFEST_PATH}.version`],
    ['description', `${PACKAGE_MANIFEST_PATH}.description`],
  ];
  if (metadata.displayName !== undefined)
    outputs.push(['displayName', undefined]);
  if (metadata.author !== undefined) {
    outputs.push(['author.name', `${PACKAGE_MANIFEST_PATH}.author.name`]);
    if (metadata.author.email !== undefined)
      outputs.push(['author.email', `${PACKAGE_MANIFEST_PATH}.author.email`]);
    if (metadata.author.url !== undefined)
      outputs.push(['author.url', `${PACKAGE_MANIFEST_PATH}.author.url`]);
  }
  for (const field of ['homepage', 'repository', 'license'] as const) {
    if (metadata[field] !== undefined)
      outputs.push([field, `${PACKAGE_MANIFEST_PATH}.${field}`]);
  }
  if (metadata.keywords.length > 0)
    outputs.push(['keywords', `${PACKAGE_MANIFEST_PATH}.keywords`]);
  return Object.freeze(outputs.map(([field, output]) => Object.freeze({
    field,
    disposition: output === undefined ? 'omitted' as const : 'emitted' as const,
    ...(output === undefined ? {} : { output }),
    reason: output === undefined
      ? 'The npm and Pi package contracts have no displayName field.'
      : `npm package.json supports ${field}.`,
  })));
}

/** 创建由 Core codec 序列化、只开放 Hooks discovery 点的 npm Manifest。 */
export function createPackageDocument(input: {
  readonly metadata: PluginMetadata;
  readonly options: Readonly<JsonObject>;
  readonly hasSkills: boolean;
  readonly hasPrompts: boolean;
}): { readonly document: PackageDocumentInput; readonly metadata: readonly MetadataDispositionInput[] } {
  /** packageOptions 已由 factory 校验并由 Core 防御性复制。 */
  const packageOptions = input.options.package as PiPackageOptions | undefined;
  /** pi-package keyword 与作者关键词保持首次出现顺序并稳定去重。 */
  const keywords = [...new Set([...input.metadata.keywords, 'pi-package'])];
  /** pi 只声明当前 Package 中真实存在或配置明确要求的 discovery 字段。 */
  const pi: JsonObject = {
    ...(input.hasSkills ? { skills: ['./skills'] } : {}),
    ...(input.hasPrompts ? { prompts: ['./prompts'] } : {}),
    ...(packageOptions?.image === undefined ? {} : { image: packageOptions.image }),
    ...(packageOptions?.video === undefined ? {} : { video: packageOptions.video }),
  };
  /** Manifest 不继承消费 workspace 的 private/workspaces/dependencies。 */
  const value: JsonObject = {
    name: input.metadata.name,
    version: input.metadata.version,
    description: input.metadata.description,
    type: 'module',
    keywords,
    ...(input.metadata.author === undefined
      ? {}
      : {
          author: {
            name: input.metadata.author.name,
            ...(input.metadata.author.email === undefined ? {} : { email: input.metadata.author.email }),
            ...(input.metadata.author.url === undefined ? {} : { url: input.metadata.author.url }),
          },
        }),
    ...(input.metadata.homepage === undefined ? {} : { homepage: input.metadata.homepage }),
    ...(input.metadata.repository === undefined ? {} : { repository: input.metadata.repository }),
    ...(input.metadata.license === undefined ? {} : { license: input.metadata.license }),
    pi,
  };
  /** document 是 Platform 唯一拥有且不可被完整替换的 package.json。 */
  const document: PackageDocumentInput = Object.freeze({
    id: PACKAGE_MANIFEST_ID,
    path: PACKAGE_MANIFEST_PATH,
    format: 'json',
    value,
    extensionPoints: Object.freeze([Object.freeze(['pi', 'extensions'] as const)]),
  });
  return Object.freeze({ document, metadata: metadataDispositions(input.metadata) });
}
