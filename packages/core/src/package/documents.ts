/** Core 确定性编解码结构化 Package Document。 */
import { stringify as stringifyToml } from '@iarna/toml';
import { stringify as stringifyYaml } from 'yaml';
import type {
  JsonObject,
  JsonValue,
} from '../contracts/common.js';
import type { PackageDocumentSnapshot } from '../contracts/packages.js';
import { snapshotJson } from './json-snapshot.js';

/** Frontmatter Document 的唯一结构化 schema。 */
interface FrontmatterDocumentValue extends JsonObject {
  readonly frontmatter: JsonObject;
  readonly body: string;
}

/** @returns JSON object 是否不包含任何字段。 */
function emptyObject(value: JsonValue): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length === 0;
}

/**
 * 验证 frontmatter codec 的精确根结构。
 *
 * @param value 已完成 JSON snapshot 的 Document 值。
 * @returns 只含 frontmatter/body 的可序列化结构。
 */
function frontmatterValue(value: JsonValue): FrontmatterDocumentValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'body,frontmatter') {
    throw new TypeError('Frontmatter Document value must contain exactly frontmatter and body.');
  }
  /** 两个固定字段在严格 JSON snapshot 上读取不会执行行为。 */
  const input = value as JsonObject;
  if (typeof input.body !== 'string' || typeof input.frontmatter !== 'object'
    || input.frontmatter === null || Array.isArray(input.frontmatter)) {
    throw new TypeError('Frontmatter Document requires a JSON object frontmatter and string body.');
  }
  return input as FrontmatterDocumentValue;
}

/**
 * 判断 omit-if-empty Document 当前是否为空。
 *
 * @param document 已验证 Document snapshot。
 * @returns 空 object 或空 frontmatter+body 为 true。
 */
export function documentIsEmpty(document: PackageDocumentSnapshot): boolean {
  if (document.format !== 'frontmatter')
    return emptyObject(document.value);
  /** Frontmatter 空值要求头部无字段且正文为空。 */
  const value = frontmatterValue(document.value);
  return emptyObject(value.frontmatter) && value.body.trim().length === 0;
}

/**
 * 使用 Core 固定 codec 产生确定性 UTF-8 Document 字节。
 *
 * @param document 已验证且冻结的 Package Document。
 * @returns 单个尾随换行、无环境信息的稳定字节。
 */
export function encodePackageDocument(document: PackageDocumentSnapshot): Uint8Array {
  /** codec 再次建立 JSON snapshot，防止内部调用方绕过 Package Registry。 */
  const value = snapshotJson(document.value, `Document ${document.id}`);
  /** 文本只由选中 codec 的确定性结果赋值一次。 */
  let text: string;
  if (document.format === 'json') {
    text = `${JSON.stringify(value, null, 2)}\n`;
  } else if (document.format === 'yaml') {
    text = `${stringifyYaml(value, { lineWidth: 0, aliasDuplicateObjects: false }).trimEnd()}\n`;
  } else if (document.format === 'toml') {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      throw new TypeError('TOML Document root must be a JSON object.');
    try {
      text = `${stringifyToml(value as never).trimEnd()}\n`;
    } catch {
      throw new TypeError('TOML Document contains a value that cannot be represented losslessly.');
    }
  } else {
    /** Frontmatter 使用稳定 YAML head 和精确修整后的正文。 */
    const input = frontmatterValue(value);
    /** YAML header 独立生成后嵌入固定分隔符。 */
    const head = stringifyYaml(input.frontmatter, { lineWidth: 0, aliasDuplicateObjects: false }).trimEnd();
    text = `---\n${head}\n---\n${input.body.trim()}\n`;
  }
  return new TextEncoder().encode(text);
}
