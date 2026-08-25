import {
  definePlatform,
  type AcpluginPlatform,
  type ContributedPackageComponent,
  type JsonObject,
} from '@tokenroll/acplugin/sdk';
import {
  claudeNativeAgentDocument,
  createClaudeComponents,
  renderClaudeAgent,
  validateClaudeComponent,
} from './package/components.js';
import {
  createMarketplaceAssets,
  createPluginDocument,
  validatePlatformOptions,
} from './package/manifest.js';
import type {
  ClaudeCodeMarketplaceOptions,
  ClaudeCodePlatformOptions,
  ClaudeNativeAgentComponent,
  ClaudePackageComponent,
} from './types.js';
import { validateClaudePackage } from './package/validation/index.js';

export type {
  ClaudeCodeMarketplaceOptions,
  ClaudeCodeMarketplaceOwner,
  ClaudeCodePlatformOptions,
  ClaudeNativeAgentComponent,
  ClaudePackageComponent,
} from './types.js';

/** Claude Code Platform 的稳定开放 ID。 */
export const PLATFORM_ID = 'claude-code' as const;

/** Claude Code Platform 实现的 Core API 版本。 */
export const PLATFORM_API_VERSION = '1' as const;

/** 创建只通过 Package API 交付 Claude Code Plugin 的 Platform。 */
const STABLE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

/** Platform-owned payload errors remain distinguishable from unexpected implementation failures. */
class ClaudeComponentContributionError extends Error {
  constructor(
    readonly category: 'invalid' | 'collision',
    message: string,
  ) {
    super(message);
    this.name = 'ClaudeComponentContributionError';
  }
}

/** @returns 是否为 non-empty stable single-line text。 */
function nonEmptyText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !/[\r\n\t\0]/u.test(value);
}

/** @returns 是否为 unique non-empty string array。 */
function stringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(nonEmptyText) && new Set(value).size === value.length;
}

/** 为 Platform 的私有 Agent schema 建立精确 data-object 边界。 */
function nativeAgent(value: unknown): ClaudeNativeAgentComponent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    || Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError('Claude Code Platform Component must be a plain object.');
  }
  const allowed = new Set(['kind', 'id', 'description', 'body', 'model', 'tools', 'disallowedTools', 'effort', 'maxTurns', 'skills', 'memory', 'background', 'isolation']);
  const fields = Object.getOwnPropertyDescriptors(value);
  for (const [field, descriptor] of Object.entries(fields)) {
    if (!allowed.has(field))
      throw new TypeError(`Unknown Claude Code Platform Component field "${field}".`);
    if (!('value' in descriptor) || descriptor.enumerable !== true)
      throw new TypeError(`Claude Code Platform Component.${field} must be an enumerable data property.`);
  }
  const input = value as Record<string, unknown>;
  if (input.kind !== 'native-agent')
    throw new TypeError('Claude Code Platform Component kind must be native-agent.');
  if (typeof input.id !== 'string' || !STABLE_ID.test(input.id))
    throw new TypeError('Claude Code Platform Component id must use lowercase kebab-case.');
  if (!nonEmptyText(input.description))
    throw new TypeError('Claude Code Platform Component description must be a non-empty stable single-line string.');
  if (typeof input.body !== 'string' || input.body.trim().length === 0)
    throw new TypeError('Claude Code Platform Component body must be non-empty.');
  if (input.model !== undefined && input.model !== 'inherit' && input.model !== 'fast' && input.model !== 'capable')
    throw new TypeError('Claude Code Platform Component model is invalid.');
  if (input.tools !== undefined && !stringArray(input.tools))
    throw new TypeError('Claude Code Platform Component tools must contain unique non-empty strings.');
  if (input.disallowedTools !== undefined && !stringArray(input.disallowedTools))
    throw new TypeError('Claude Code Platform Component disallowedTools must contain unique non-empty strings.');
  if (input.skills !== undefined && !stringArray(input.skills))
    throw new TypeError('Claude Code Platform Component skills must contain unique non-empty strings.');
  if (input.effort !== undefined && !['low', 'medium', 'high', 'xhigh', 'max'].includes(String(input.effort)))
    throw new TypeError('Claude Code Platform Component effort is invalid.');
  if (input.maxTurns !== undefined && (!Number.isInteger(input.maxTurns) || Number(input.maxTurns) <= 0))
    throw new TypeError('Claude Code Platform Component maxTurns must be a positive integer.');
  if (input.memory !== undefined && !['user', 'project', 'local'].includes(String(input.memory)))
    throw new TypeError('Claude Code Platform Component memory is invalid.');
  if (input.background !== undefined && typeof input.background !== 'boolean')
    throw new TypeError('Claude Code Platform Component background must be boolean.');
  if (input.isolation !== undefined && input.isolation !== 'worktree')
    throw new TypeError('Claude Code Platform Component isolation is invalid.');
  return input as ClaudeNativeAgentComponent;
}

/** 保守归一化 Claude Agent output path 的大小写/NFC collision identity。 */
function agentCollisionKey(id: string): string {
  return id.normalize('NFC').toLowerCase();
}

/** Platform finalization 解析并渲染其私有 Native Agent contributions。 */
async function contributedAgents(
  components: readonly ContributedPackageComponent<ClaudePackageComponent>[],
  canonicalIds: readonly string[],
  assets: import('@tokenroll/acplugin/sdk').FinalizationAssetService,
): Promise<{ readonly assets: readonly import('@tokenroll/acplugin/sdk').PackageAssetInput[]; readonly origins: readonly import('@tokenroll/acplugin/sdk').PackageComponentOrigin[] }> {
  const occupied = new Map(canonicalIds.map(id => [agentCollisionKey(id), `canonical Agent "${id}"`]));
  let parsed: readonly { readonly component: ClaudeNativeAgentComponent; readonly origin: import('@tokenroll/acplugin/sdk').PackageComponentOrigin }[];
  try {
    parsed = components.map(component => Object.freeze({ component: nativeAgent(component.value), origin: component.origin }));
  } catch (error) {
    if (!(error instanceof TypeError))
      throw error;
    throw new ClaudeComponentContributionError('invalid', error.message);
  }
  /** Core order无关；Platform 仍按自己的 collision domain 验证全部 component。 */
  for (const { component } of parsed) {
    const key = agentCollisionKey(component.id);
    const existing = occupied.get(key);
    if (existing !== undefined) {
      throw new ClaudeComponentContributionError(
        'collision',
        'Claude Code Native Agent "' + component.id + '" collides with ' + existing + '.',
      );
    }
    occupied.set(key, `contributed Native Agent "${component.id}"`);
  }
  const output: import('@tokenroll/acplugin/sdk').PackageAssetInput[] = [];
  const origins: import('@tokenroll/acplugin/sdk').PackageComponentOrigin[] = [];
  for (const { component, origin } of [...parsed].sort((left, right) => left.component.id < right.component.id ? -1 : left.component.id > right.component.id ? 1 : 0)) {
    const asset = await assets.fromBytes({
      bytes: renderClaudeAgent(claudeNativeAgentDocument(component)),
      origin: { operation: 'platform-component-agent', subjects: [origin.subject], componentOrigins: [origin] },
    });
    output.push(Object.freeze({ path: `agents/${component.id}.md`, asset }));
    origins.push(origin);
  }
  return Object.freeze({ assets: Object.freeze(output), origins: Object.freeze(origins) });
}

/** 创建只通过 Package API 交付 Claude Code Plugin 的 Platform。 */
export function claudeCode(options: ClaudeCodePlatformOptions = {}): AcpluginPlatform<JsonObject, ClaudePackageComponent> {
  validatePlatformOptions(options);
  /** strict 由 Core 解释，其余选项进入复制、深冻的 Platform session 数据。 */
  const { strict, ...platformOptions } = options;
  return definePlatform<JsonObject, ClaudePackageComponent>({
    id: PLATFORM_ID,
    apiVersion: PLATFORM_API_VERSION,
    deliveryType: 'plugin',
    capabilities: { nodeRuntime: { target: 'node20', format: 'esm', root: 'plugin' } },
    ...(strict === undefined ? {} : { strict }),
    options: platformOptions as unknown as JsonObject,
    /** 每次 BuildSession 独立捕获 Core 已复制的只读 Platform options。 */
    createSession({ options: sessionOptions }) {
      return {
        validateComponent: validateClaudeComponent,
        /** base Package 同时声明结构化 Document、Component Assets 和完整报告输入。 */
        async createPackage({ project, assets }) {
          /** components 是 canonical Resource 到 Claude 原生文件的纯转换结果。 */
          const components = await createClaudeComponents(project, assets);
          /** manifest 由 Core codec 负责序列化，Extension 只能填写两个声明点。 */
          const manifest = createPluginDocument({
            metadata: project.metadata,
            options: sessionOptions,
            components: {
              commands: project.commands.length,
              skills: project.skills.length,
            },
          });
          return {
            documents: [manifest.document],
            assets: components.assets,
            compatibility: components.compatibility,
            metadata: manifest.metadata,
          };
        },
        /** Platform 解析自己的 opaque union、渲染 assets，并只写自己预留的 manifest 字段。 */
        async finalizePackage({ project, package: mergedPackage, assets, diagnostics }) {
          let contributed: Awaited<ReturnType<typeof contributedAgents>>;
          try {
            contributed = await contributedAgents(mergedPackage.components, project.agents.map(agent => agent.id), assets);
          } catch (error) {
            if (!(error instanceof ClaudeComponentContributionError))
              throw error;
            diagnostics.report({
              code: error.category === 'collision'
                ? 'CLAUDE_COMPONENT_CONTRIBUTION_COLLISION'
                : 'CLAUDE_COMPONENT_CONTRIBUTION_INVALID',
              severity: 'error',
              message: error.message,
            });
            return { id: 'plugin', type: 'plugin' as const };
          }
          return {
            id: 'plugin',
            type: 'plugin' as const,
            assets: contributed.assets,
            ...(project.agents.length + contributed.assets.length === 0
              ? {}
              : {
                  documentFields: [{
                    document: 'plugin-manifest',
                    path: ['agents'],
                    value: './agents/',
                    ...(contributed.origins.length === 0 ? {} : { componentOrigins: contributed.origins }),
                  }],
                }),
          };
        },
        validatePackage: validateClaudePackage,
        /** 可选 Marketplace 只能从已验证 primary 和当前回调新签发 Asset 派生。 */
        async createDistributions(context) {
          /** marketplace 必须来自 session 的防御性副本，不能闭包读取作者原对象。 */
          const marketplace = sessionOptions.marketplace as ClaudeCodeMarketplaceOptions | undefined;
          if (marketplace === undefined)
            return Object.freeze([]);
          return Object.freeze([{
            id: 'marketplace',
            type: 'marketplace' as const,
            assets: await createMarketplaceAssets(context, marketplace),
          }]);
        },
      };
    },
  });
}

export default claudeCode;
