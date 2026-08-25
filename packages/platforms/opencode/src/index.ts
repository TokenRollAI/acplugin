import {
  definePlatform,
  type AcpluginPlatform,
  type ContributedPackageComponent,
  type JsonObject,
} from '@tokenroll/acplugin/sdk';
import {
  createOpenCodeComponents,
  openCodeNativeAgentDocument,
  renderOpenCodeAgent,
  validateOpenCodeComponent,
} from './package/components.js';
import { createWorkspaceDocument, validatePlatformOptions } from './package/config-document.js';
import type { OpenCodeNativeAgentComponent, OpenCodePackageComponent, OpenCodePlatformOptions } from './types.js';
import { validateOpenCodePackage } from './package/validator.js';

export type {
  OpenCodeNativeAgentComponent,
  OpenCodePackageComponent,
  OpenCodePlatformOptions,
  OpenCodeWorkspaceOptions,
} from './types.js';

/** OpenCode Platform 的稳定开放 ID。 */
export const PLATFORM_ID = 'opencode' as const;

/** OpenCode Platform 实现的 Core API 版本。 */
export const PLATFORM_API_VERSION = '1' as const;

const STABLE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const TOOLS = new Set(['read', 'glob', 'grep', 'edit', 'bash', 'webfetch', 'task']);
const PERMISSIONS = new Set(['edit', 'bash', 'webfetch', 'task']);

/** Platform-owned payload errors remain distinguishable from unexpected implementation failures. */
class OpenCodeComponentContributionError extends Error {
  constructor(
    readonly category: 'invalid' | 'collision',
    message: string,
  ) {
    super(message);
    this.name = 'OpenCodeComponentContributionError';
  }
}

/** @returns 是否为 Platform-safe 单行展示文本。 */
function nonEmptyText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !/[\r\n\t\0]/u.test(value);
}

/** 读取 OpenCode wire map，拒绝未声明字段或不匹配的标量。 */
function record(value: unknown, allowed: ReadonlySet<string>, label: string, valid: (value: unknown) => boolean): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    || Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  const fields = Object.getOwnPropertyDescriptors(value);
  for (const [field, descriptor] of Object.entries(fields)) {
    if (!allowed.has(field))
      throw new TypeError(`Unknown ${label} field "${field}".`);
    if (!('value' in descriptor) || descriptor.enumerable !== true || !valid(descriptor.value))
      throw new TypeError(`${label}.${field} is invalid.`);
  }
  return Object.fromEntries(Object.entries(fields).map(([field, descriptor]) => [field, descriptor.value]));
}

/** 解析 OpenCode 自己拥有的 Native Agent payload schema。 */
function nativeAgent(value: unknown): OpenCodeNativeAgentComponent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    || Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError('OpenCode Platform Component must be a plain object.');
  }
  const allowed = new Set(['kind', 'id', 'description', 'body', 'tools', 'permission']);
  const fields = Object.getOwnPropertyDescriptors(value);
  for (const [field, descriptor] of Object.entries(fields)) {
    if (!allowed.has(field))
      throw new TypeError(`Unknown OpenCode Platform Component field "${field}".`);
    if (!('value' in descriptor) || descriptor.enumerable !== true)
      throw new TypeError(`OpenCode Platform Component.${field} must be an enumerable data property.`);
  }
  const input = value as Record<string, unknown>;
  if (input.kind !== 'native-agent')
    throw new TypeError('OpenCode Platform Component kind must be native-agent.');
  if (typeof input.id !== 'string' || !STABLE_ID.test(input.id))
    throw new TypeError('OpenCode Platform Component id must use lowercase kebab-case.');
  if (!nonEmptyText(input.description))
    throw new TypeError('OpenCode Platform Component description must be a non-empty stable single-line string.');
  if (typeof input.body !== 'string' || input.body.trim().length === 0)
    throw new TypeError('OpenCode Platform Component body must be non-empty.');
  const tools = input.tools === undefined ? undefined : record(input.tools, TOOLS, 'OpenCode Platform Component tools', item => typeof item === 'boolean');
  const permission = input.permission === undefined ? undefined : record(input.permission, PERMISSIONS, 'OpenCode Platform Component permission', item => item === 'allow' || item === 'deny');
  return Object.freeze({
    kind: 'native-agent' as const,
    id: input.id,
    description: input.description,
    body: input.body,
    ...(tools === undefined ? {} : { tools: tools as NonNullable<OpenCodeNativeAgentComponent['tools']> }),
    ...(permission === undefined ? {} : { permission: permission as NonNullable<OpenCodeNativeAgentComponent['permission']> }),
  }) as OpenCodeNativeAgentComponent;
}

/** OpenCode Agent namespace follows target filesystem case/NFC collision semantics. */
function agentCollisionKey(id: string): string {
  return id.normalize('NFC').toLowerCase();
}

/** 将 OpenCode private payload 解析、校验并渲染为 workspace Agent Assets。 */
async function contributedAgents(
  components: readonly ContributedPackageComponent<OpenCodePackageComponent>[],
  canonicalIds: readonly string[],
  assets: import('@tokenroll/acplugin/sdk').FinalizationAssetService,
): Promise<readonly import('@tokenroll/acplugin/sdk').PackageAssetInput[]> {
  const occupied = new Map(canonicalIds.map(id => [agentCollisionKey(id), `canonical Agent "${id}"`]));
  let parsed: readonly { readonly component: OpenCodeNativeAgentComponent; readonly origin: import('@tokenroll/acplugin/sdk').PackageComponentOrigin }[];
  try {
    parsed = components.map(component => Object.freeze({ component: nativeAgent(component.value), origin: component.origin }));
  } catch (error) {
    if (!(error instanceof TypeError))
      throw error;
    throw new OpenCodeComponentContributionError('invalid', error.message);
  }
  for (const { component } of parsed) {
    const key = agentCollisionKey(component.id);
    const existing = occupied.get(key);
    if (existing !== undefined) {
      throw new OpenCodeComponentContributionError(
        'collision',
        'OpenCode Native Agent "' + component.id + '" collides with ' + existing + '.',
      );
    }
    occupied.set(key, `contributed Native Agent "${component.id}"`);
  }
  const output: import('@tokenroll/acplugin/sdk').PackageAssetInput[] = [];
  for (const { component, origin } of [...parsed].sort((left, right) => left.component.id < right.component.id ? -1 : left.component.id > right.component.id ? 1 : 0)) {
    const asset = await assets.fromBytes({
      bytes: renderOpenCodeAgent(openCodeNativeAgentDocument(component)),
      origin: { operation: 'platform-component-agent', subjects: [origin.subject], componentOrigins: [origin] },
    });
    output.push(Object.freeze({ path: `.opencode/agents/${component.id}.md`, asset }));
  }
  return Object.freeze(output);
}

/** 创建只通过 Package API 交付 OpenCode workspace overlay 的 Platform。 */
export function openCode(options: OpenCodePlatformOptions = {}): AcpluginPlatform<JsonObject, OpenCodePackageComponent> {
  validatePlatformOptions(options);
  /** strict 由 Core 解释，其余选项复制、深冻后进入 Platform Session。 */
  const { strict, ...platformOptions } = options;
  return definePlatform<JsonObject, OpenCodePackageComponent>({
    id: PLATFORM_ID,
    apiVersion: PLATFORM_API_VERSION,
    deliveryType: 'workspace',
    ...(strict === undefined ? {} : { strict }),
    options: platformOptions as unknown as JsonObject,
    /** OpenCode workspace 不声明 Plugin-local Node Runtime 能力。 */
    createSession({ options: sessionOptions }) {
      return {
        validateComponent: validateOpenCodeComponent,
        /** base Package 包含 workspace Components 和可省略的结构化配置。 */
        async createPackage({ project, assets }) {
          /** components 全部通过 Platform owner 的 Asset Service 签发。 */
          const components = await createOpenCodeComponents(project, assets);
          /** workspace config 由 Core codec 处理并只开放 MCP 字段。 */
          const config = createWorkspaceDocument({ metadata: project.metadata, options: sessionOptions });
          return {
            documents: [config.document],
            assets: components.assets,
            compatibility: components.compatibility,
            metadata: config.metadata,
          };
        },
        /** 主单元身份明确是 workspace，不伪装 Plugin root；Native Agent 不要求 Config patch。 */
        async finalizePackage({ project, package: mergedPackage, assets, diagnostics }) {
          let contributed: Awaited<ReturnType<typeof contributedAgents>>;
          try {
            contributed = await contributedAgents(mergedPackage.components, project.agents.map(agent => agent.id), assets);
          } catch (error) {
            if (!(error instanceof OpenCodeComponentContributionError))
              throw error;
            diagnostics.report({
              code: error.category === 'collision'
                ? 'OPENCODE_COMPONENT_CONTRIBUTION_COLLISION'
                : 'OPENCODE_COMPONENT_CONTRIBUTION_INVALID',
              severity: 'error',
              message: error.message,
            });
            return { id: 'workspace', type: 'workspace' as const };
          }
          return {
            id: 'workspace',
            type: 'workspace' as const,
            assets: contributed,
          };
        },
        validatePackage: validateOpenCodePackage,
      };
    },
  });
}

export default openCode;
