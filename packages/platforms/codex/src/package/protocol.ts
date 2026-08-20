/** Codex 官方插件目录当前接受的分类清单。 */
export const CODEX_CATEGORIES = [
  'Productivity',
  'Creativity',
  'Developer Tools',
  'Business & Operations',
  'Data & Analytics',
  'Communication',
  'Education & Research',
  'Security',
  'Finance',
  'Healthcare',
  'Travel',
  'Entertainment',
  'Other',
] as const;

/** Codex 官方插件目录分类的封闭联合类型。 */
export type CodexCategory = typeof CODEX_CATEGORIES[number];

/** Codex Marketplace 当前接受的安装策略清单。 */
export const CODEX_MARKETPLACE_INSTALLATIONS = [
  'AVAILABLE',
  'INSTALLED_BY_DEFAULT',
  'NOT_AVAILABLE',
] as const;

/** Codex Marketplace 安装策略的封闭联合类型。 */
export type CodexMarketplaceInstallation = typeof CODEX_MARKETPLACE_INSTALLATIONS[number];

/** Codex Skill 元数据当前接受的产品范围。 */
export const CODEX_SKILL_PRODUCTS = ['CHAT', 'CODEX'] as const;

/** Plugin 与 Skill 品牌色共同使用的六位十六进制规则。 */
export const CODEX_BRAND_COLOR_PATTERN: RegExp = /^#[\dA-Fa-f]{6}$/;

/** Codex Plugin `interface` 当前允许的全部官方字段。 */
export const CODEX_INTERFACE_FIELDS = [
  'displayName', 'shortDescription', 'longDescription', 'developerName', 'category', 'capabilities',
  'websiteURL', 'privacyPolicyURL', 'termsOfServiceURL', 'supportURL', 'defaultPrompt', 'brandColor',
  'brandColorDark', 'composerIcon', 'logo', 'screenshots',
] as const;

/** Codex interface 字段名称的封闭联合类型。 */
export type CodexInterfaceField = typeof CODEX_INTERFACE_FIELDS[number];

/** Platform 工厂允许配置的 interface 字段联合类型。 */
export type CodexInterfaceOptionField = Exclude<CodexInterfaceField, 'displayName'>;

/** Platform 工厂可配置、但不重复顶层 displayName 的 interface 字段。 */
export const CODEX_INTERFACE_OPTION_FIELDS: readonly CodexInterfaceOptionField[]
  = CODEX_INTERFACE_FIELDS.filter((field): field is CodexInterfaceOptionField => field !== 'displayName');

/** Codex Plugin interface 一旦存在就必须提供的发布展示字段。 */
export const CODEX_INTERFACE_REQUIRED_FIELDS = [
  'displayName', 'shortDescription', 'longDescription', 'developerName',
] as const;

/** 共享 interface 纯校验返回的稳定问题。 */
export interface CodexInterfaceFieldIssue {
  readonly code: string;
  readonly message: string;
}

/**
 * 判断插件根资源引用是否为安全的 `./` 相对路径。
 *
 * @param value 待验证的 Manifest 资源路径。
 * @returns 路径不会逃逸 Plugin 根时返回 true。
 */
export function isSafeCodexPluginPath(value: string): boolean {
  if (!value.startsWith('./') || value.includes('\\') || value.includes('\0'))
    return false;
  /** 去掉协议前缀后用于拒绝父目录和空路径的片段。 */
  const relative = value.slice(2);
  return relative.length > 0
    && relative !== '..'
    && !relative.startsWith('../')
    && !relative.split('/').includes('..');
}

/**
 * 判断字符串是否为不含凭据的 HTTPS URL。
 *
 * @param value 待验证的发布或作者链接。
 * @returns URL 可由官方目录安全接受时返回 true。
 */
export function isCodexHttpsUrl(value: string): boolean {
  try {
    /** 标准 URL 解析器同时拒绝伪造协议、缺失 host 和嵌入凭据。 */
    const url = new URL(value);
    return url.protocol === 'https:'
      && url.hostname.length > 0
      && url.username === ''
      && url.password === '';
  } catch {
    return false;
  }
}

/**
 * 对一个已知 Codex interface 字段执行共享纯值校验。
 *
 * @param field 当前官方字段名称。
 * @param value Factory 输入或最终 Manifest 中的候选值。
 * @returns 值不符合官方协议时返回稳定问题，否则返回 undefined。
 */
export function codexInterfaceFieldIssue(
  field: CodexInterfaceField,
  value: unknown,
): CodexInterfaceFieldIssue | undefined {
  if (field === 'capabilities') {
    if (!Array.isArray(value)
      || value.length > 20
      || value.some(capability => typeof capability !== 'string'
        || capability.trim().length === 0
        || capability.length > 120)) {
      return {
        code: 'CODEX_INTERFACE_CAPABILITIES_INVALID',
        message: 'interface.capabilities must contain at most 20 non-empty strings of 120 characters or fewer.',
      };
    }
    return undefined;
  }
  if (field === 'screenshots') {
    if (!Array.isArray(value)
      || value.length === 0
      || value.some(item => typeof item !== 'string' || !isSafeCodexPluginPath(item))) {
      return {
        code: 'CODEX_INTERFACE_SCREENSHOTS_INVALID',
        message: 'interface.screenshots must contain safe Plugin-root paths.',
      };
    }
    return undefined;
  }
  if (field === 'defaultPrompt') {
    /** 单值与数组写法统一后的 starter prompt。 */
    const prompts = typeof value === 'string' ? [value] : value;
    if (!Array.isArray(prompts)
      || prompts.length === 0
      || prompts.length > 3
      || prompts.some(prompt => typeof prompt !== 'string'
        || prompt.trim().length === 0
        || prompt.length > 512
        || /[\r\n]/u.test(prompt))) {
      return {
        code: 'CODEX_INTERFACE_PROMPT_INVALID',
        message: 'interface.defaultPrompt must contain one to three non-empty single-line prompts.',
      };
    }
    return undefined;
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    return {
      code: 'CODEX_INTERFACE_FIELD_INVALID',
      message: `interface.${field} must be a non-empty string.`,
    };
  }
  if (field === 'displayName' && value.length > 80)
    return { code: 'CODEX_INTERFACE_DISPLAY_NAME_INVALID', message: 'interface.displayName must contain at most 80 characters.' };
  if (field === 'shortDescription' && (value.length > 240 || /[\r\n]/u.test(value))) {
    return {
      code: 'CODEX_INTERFACE_SHORT_DESCRIPTION_INVALID',
      message: 'interface.shortDescription must fit on one line and contain at most 240 characters.',
    };
  }
  if (field === 'longDescription' && value.length > 4_000)
    return { code: 'CODEX_INTERFACE_LONG_DESCRIPTION_INVALID', message: 'interface.longDescription must contain at most 4000 characters.' };
  if (field === 'developerName' && value.length > 120)
    return { code: 'CODEX_INTERFACE_DEVELOPER_NAME_INVALID', message: 'interface.developerName must contain at most 120 characters.' };
  if (field === 'category' && !(CODEX_CATEGORIES as readonly string[]).includes(value))
    return { code: 'CODEX_INTERFACE_CATEGORY_INVALID', message: 'interface.category must be an official Plugin category.' };
  if (['websiteURL', 'privacyPolicyURL', 'termsOfServiceURL', 'supportURL'].includes(field)
    && (!isCodexHttpsUrl(value) || value.length > 2_048)) {
    return { code: 'CODEX_INTERFACE_URL_INVALID', message: `interface.${field} must be an HTTPS URL without credentials.` };
  }
  if ((field === 'brandColor' || field === 'brandColorDark') && !CODEX_BRAND_COLOR_PATTERN.test(value))
    return { code: 'CODEX_INTERFACE_COLOR_INVALID', message: `interface.${field} must be a six-digit hexadecimal color.` };
  if ((field === 'composerIcon' || field === 'logo') && !isSafeCodexPluginPath(value))
    return { code: 'CODEX_INTERFACE_ASSET_INVALID', message: `interface.${field} must be a safe Plugin-root path.` };
  return undefined;
}

/** SVG 数值属性接受的无单位十进制与科学计数法。 */
const SVG_NUMBER_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/** SVG 根元素解析后用于尺寸判断的结果。 */
export interface CodexSvgDimensions {
  readonly width: number;
  readonly height: number;
}

/**
 * 严格解析 Codex 品牌 SVG 的 UTF-8 XML、根元素和无单位尺寸。
 *
 * @param bytes 最终候选中的 SVG 原始字节。
 * @returns viewBox 或 width/height 表达的正数尺寸。
 * @throws XML、根元素或尺寸不符合公共目录协议时抛出错误。
 */
export function parseCodexSvgDimensions(bytes: Uint8Array): CodexSvgDimensions {
  /** fatal 解码确保无效 UTF-8 不会被替换字符静默修复。 */
  const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  /** 第一层 SVG 根元素的属性快照。 */
  let rootAttributes: Readonly<Record<string, string>> | undefined;
  /** 严格文档模式会拒绝未闭合标签和多个根元素。 */
  const parser = new SaxesParser({ xmlns: true });
  parser.on('opentag', (tag) => {
    if (rootAttributes !== undefined)
      return;
    if (tag.local !== 'svg')
      throw new Error('SVG root element must be <svg>.');
    /** 只按 local name 保存根属性，避免 namespace 前缀影响标准属性。 */
    const attributes: Record<string, string> = {};
    /** attribute 表示当前 SVG 根属性。 */
    for (const attribute of Object.values(tag.attributes))
      attributes[attribute.local] = attribute.value;
    rootAttributes = attributes;
  });
  parser.write(source).close();
  if (rootAttributes === undefined)
    throw new Error('SVG root element must be <svg>.');
  /** 把无单位数值文本转换为有限 Number。 */
  const numeric = (value: string | undefined): number | undefined => {
    if (value === undefined || !SVG_NUMBER_PATTERN.test(value.trim()))
      return undefined;
    /** 已通过严格语法检查的有限数值候选。 */
    const number = Number(value);
    return Number.isFinite(number) ? number : undefined;
  };
  /** viewBox 存在时优先使用其宽高，且不允许回退掩盖非法 viewBox。 */
  const viewBox = rootAttributes.viewBox;
  /** 最终参与方形和范围校验的宽高。 */
  let width: number | undefined;
  /** 与 width 同源且必须满足相同范围的最终高度。 */
  let height: number | undefined;
  if (viewBox !== undefined) {
    /** SVG viewBox 允许空白或逗号分隔的四个无单位数值。 */
    const values = viewBox.trim().split(/[\s,]+/u).map(value => numeric(value));
    if (values.length !== 4 || values.some(value => value === undefined))
      throw new Error('SVG viewBox must contain four numeric values without units.');
    width = values[2];
    height = values[3];
  } else {
    width = numeric(rootAttributes.width);
    height = numeric(rootAttributes.height);
    if (width === undefined || height === undefined)
      throw new Error('SVG width and height must be numeric values without units.');
  }
  if (width === undefined || height === undefined || width <= 0 || height <= 0)
    throw new Error('SVG width and height must be positive finite numbers.');
  return { width, height };
}
import { SaxesParser } from 'saxes';
