import {
  stableJson,
  type CompatibilityInput,
  type ContributionContext,
  type JsonValue,
  type PackageAssetInput,
  type PackageContribution,
} from '@tokenroll/acplugin/sdk';
import type { BuiltMcpServer } from '../build.js';
import { compareCodeUnits } from '../sorting.js';

/** MCP Contributor 构建结果时使用的 mutable 收集器。 */
export interface ContributionCollector {
  readonly assets: PackageAssetInput[];
  readonly compatibility: CompatibilityInput[];
}

/** ValueSource 按目标协议拆分后的公开字面量和环境引用。 */
export interface MappedValues {
  readonly literal: Readonly<Record<string, string>>;
  readonly environment: Readonly<Record<string, string>>;
}

/** 将 ValueSource 转换为稳定排序的公开字面量和环境变量名称。 */
export function mapValues(
  input: Readonly<Record<string, { readonly value?: string; readonly env?: string }>> | undefined,
): MappedValues {
  /** literal 只包含作者明确允许写入产物的字符串。 */
  const literal: Record<string, string> = {};
  /** environment 只包含变量名称，绝不读取构建环境。 */
  const environment: Record<string, string> = {};
  /** 键顺序由确定性 code-unit comparator 固定。 */
  const entries = Object.entries(input ?? {}).sort(([left], [right]) => compareCodeUnits(left, right));
  for (const [key, source] of entries) {
    if (source.value !== undefined)
      literal[key] = source.value;
    else if (source.env !== undefined)
      environment[key] = source.env;
  }
  return Object.freeze({ literal: Object.freeze(literal), environment: Object.freeze(environment) });
}

/** 创建一个空的 Contributor 收集器。 */
export function collector(): ContributionCollector {
  return { assets: [], compatibility: [] };
}

/** 记录当前平台对一个 MCP transport 的真实支持级别。 */
export function reportTransport(
  output: ContributionCollector,
  server: BuiltMcpServer,
  level: 'native' | 'unsupported',
  reason: string,
): void {
  output.compatibility.push(Object.freeze({
    subject: `mcp:${server.id}`,
    capability: `transport.${server.definition.transport}`,
    level,
    reason,
  }));
}

/** 记录可交付 HTTP Server 的认证语义支持级别。 */
export function reportAuth(
  output: ContributionCollector,
  server: BuiltMcpServer,
  level: 'native' | 'degraded',
  reason: string,
): void {
  if (server.definition.transport !== 'http' || server.definition.auth === undefined)
    return;
  output.compatibility.push(Object.freeze({
    subject: `mcp:${server.id}`,
    capability: `auth.${server.definition.auth.type}`,
    level,
    reason,
  }));
}

/** 把同一个 Core Bundle 映射到当前 Platform 固定的本地 MCP 根。 */
export function addLocalRuntime(
  output: ContributionCollector,
  server: BuiltMcpServer,
  root: string,
): void {
  if (server.handler === undefined)
    throw new Error(`MCP Server "${server.id}" has no compiled handler.`);
  output.assets.push(Object.freeze({ path: `${root}/${server.id}/server.mjs`, asset: server.handler }));
  if (server.licenses !== undefined) {
    output.assets.push(Object.freeze({
      path: `${root}/${server.id}/THIRD_PARTY_LICENSES.txt`,
      asset: server.licenses,
    }));
  }
}

/** 通过 Core Asset Service 创建稳定 JSON Package Asset。 */
export async function addJsonAsset(
  context: ContributionContext,
  output: ContributionCollector,
  path: string,
  value: JsonValue,
  subjects: readonly string[],
): Promise<void> {
  /** JSON bytes 由公开稳定 codec 产生，不写 dist 或自建 workDir。 */
  const asset = await context.assets.fromBytes({
    bytes: stableJson(value),
    origin: { operation: 'mcp-platform-config', subjects },
  });
  output.assets.push(Object.freeze({ path, asset }));
}

/** 完成不可变且 add-only 的 Package Contribution。 */
export function finishContribution(
  output: ContributionCollector,
  documentFields: PackageContribution['documentFields'] = [],
): PackageContribution {
  return Object.freeze({
    ...(output.assets.length === 0 ? {} : { assets: Object.freeze(output.assets) }),
    ...(documentFields.length === 0 ? {} : { documentFields: Object.freeze([...documentFields]) }),
    compatibility: Object.freeze(output.compatibility),
  });
}

/** @returns 当前实际交付 Server 的稳定 compatibility subject 列表。 */
export function serverSubjects(servers: readonly BuiltMcpServer[]): readonly string[] {
  return Object.freeze(servers.map(server => `mcp:${server.id}`));
}
