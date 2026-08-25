import {
  definePlatform,
  type AcpluginPlatform,
  type ContributedPackageComponent,
  type JsonObject,
} from '@tokenroll/acplugin/sdk';
import {
  createCursorComponents,
  cursorNativeAgentDocument,
  renderCursorAgent,
  validateCursorComponent,
} from './package/components.js';
import { createPluginDocument, validatePlatformOptions } from './package/manifest.js';
import type { CursorNativeAgentComponent, CursorPackageComponent, CursorPlatformOptions } from './types.js';
import { validateCursorPackage } from './package/validator.js';

export type { CursorNativeAgentComponent, CursorPackageComponent, CursorPlatformOptions } from './types.js';

/** Cursor Platform 的稳定开放 ID。 */
export const PLATFORM_ID = 'cursor' as const;

/** Cursor Platform 实现的 Core API 版本。 */
export const PLATFORM_API_VERSION = '1' as const;

const STABLE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

/** Platform-owned payload errors remain distinguishable from unexpected implementation failures. */
class CursorComponentContributionError extends Error {
  constructor(
    readonly category: 'invalid' | 'collision',
    message: string,
  ) {
    super(message);
    this.name = 'CursorComponentContributionError';
  }
}

/** 解析 Cursor 自己拥有的 Native Agent payload schema。 */
function nativeAgent(value: unknown): CursorNativeAgentComponent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    || Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError('Cursor Platform Component must be a plain object.');
  }
  const allowed = new Set(['kind', 'id', 'description', 'body', 'readonly']);
  const fields = Object.getOwnPropertyDescriptors(value);
  for (const [field, descriptor] of Object.entries(fields)) {
    if (!allowed.has(field))
      throw new TypeError(`Unknown Cursor Platform Component field "${field}".`);
    if (!('value' in descriptor) || descriptor.enumerable !== true)
      throw new TypeError(`Cursor Platform Component.${field} must be an enumerable data property.`);
  }
  const input = value as Record<string, unknown>;
  if (input.kind !== 'native-agent')
    throw new TypeError('Cursor Platform Component kind must be native-agent.');
  if (typeof input.id !== 'string' || !STABLE_ID.test(input.id))
    throw new TypeError('Cursor Platform Component id must use lowercase kebab-case.');
  if (typeof input.description !== 'string' || input.description.trim().length === 0 || /[\r\n\t\0]/u.test(input.description))
    throw new TypeError('Cursor Platform Component description must be a non-empty stable single-line string.');
  if (typeof input.body !== 'string' || input.body.trim().length === 0)
    throw new TypeError('Cursor Platform Component body must be non-empty.');
  if (input.readonly !== undefined && typeof input.readonly !== 'boolean')
    throw new TypeError('Cursor Platform Component readonly must be boolean.');
  return input as CursorNativeAgentComponent;
}

/** Cursor Agent namespace follows target filesystem case/NFC collision semantics. */
function agentCollisionKey(id: string): string {
  return id.normalize('NFC').toLowerCase();
}

/** 将 Cursor private payload 解析、校验并渲染为 Platform-owned Agent Assets。 */
async function contributedAgents(
  components: readonly ContributedPackageComponent<CursorPackageComponent>[],
  canonicalIds: readonly string[],
  assets: import('@tokenroll/acplugin/sdk').FinalizationAssetService,
): Promise<{ readonly assets: readonly import('@tokenroll/acplugin/sdk').PackageAssetInput[]; readonly origins: readonly import('@tokenroll/acplugin/sdk').PackageComponentOrigin[] }> {
  const occupied = new Map(canonicalIds.map(id => [agentCollisionKey(id), `canonical Agent "${id}"`]));
  let parsed: readonly { readonly component: CursorNativeAgentComponent; readonly origin: import('@tokenroll/acplugin/sdk').PackageComponentOrigin }[];
  try {
    parsed = components.map(component => Object.freeze({ component: nativeAgent(component.value), origin: component.origin }));
  } catch (error) {
    if (!(error instanceof TypeError))
      throw error;
    throw new CursorComponentContributionError('invalid', error.message);
  }
  for (const { component } of parsed) {
    const key = agentCollisionKey(component.id);
    const existing = occupied.get(key);
    if (existing !== undefined) {
      throw new CursorComponentContributionError(
        'collision',
        'Cursor Native Agent "' + component.id + '" collides with ' + existing + '.',
      );
    }
    occupied.set(key, `contributed Native Agent "${component.id}"`);
  }
  const output: import('@tokenroll/acplugin/sdk').PackageAssetInput[] = [];
  const origins: import('@tokenroll/acplugin/sdk').PackageComponentOrigin[] = [];
  for (const { component, origin } of [...parsed].sort((left, right) => left.component.id < right.component.id ? -1 : left.component.id > right.component.id ? 1 : 0)) {
    const asset = await assets.fromBytes({
      bytes: renderCursorAgent(cursorNativeAgentDocument(component)),
      origin: { operation: 'platform-component-agent', subjects: [origin.subject], componentOrigins: [origin] },
    });
    output.push(Object.freeze({ path: `agents/${component.id}.md`, asset }));
    origins.push(origin);
  }
  return Object.freeze({ assets: Object.freeze(output), origins: Object.freeze(origins) });
}

/** 创建只通过 Package API 交付 Cursor Plugin 的 Platform。 */
export function cursor(options: CursorPlatformOptions = {}): AcpluginPlatform<JsonObject, CursorPackageComponent> {
  validatePlatformOptions(options);
  /** strict 由 Core 解释，其余选项复制、深冻后进入 Platform Session。 */
  const { strict, ...platformOptions } = options;
  return definePlatform<JsonObject, CursorPackageComponent>({
    id: PLATFORM_ID,
    apiVersion: PLATFORM_API_VERSION,
    deliveryType: 'plugin',
    ...(strict === undefined ? {} : { strict }),
    options: platformOptions as unknown as JsonObject,
    /** Cursor 不声明 Node Runtime 能力，Core 将对存在的 Runtime 显式报告 unsupported。 */
    createSession({ options: sessionOptions }) {
      return {
        validateComponent: validateCursorComponent,
        /** base Package 包含原生 Components 和唯一结构化 Manifest。 */
        async createPackage({ project, assets }) {
          /** components 全部通过当前 Platform owner 的 Asset Service 签发。 */
          const components = await createCursorComponents(project, assets);
          /** manifest 由 Core codec 负责序列化，Extension 只能填写声明点。 */
          const manifest = createPluginDocument({
            project,
            options: sessionOptions,
            components: { commands: project.commands.length > 0, skills: project.skills.length > 0 },
          });
          return {
            documents: [manifest.document],
            assets: components.assets,
            compatibility: components.compatibility,
            metadata: manifest.metadata,
          };
        },
        /** Cursor 完整拥有 Native Agent render、Manifest glob 和 collision policy。 */
        async finalizePackage({ project, package: mergedPackage, assets, diagnostics }) {
          let contributed: Awaited<ReturnType<typeof contributedAgents>>;
          try {
            contributed = await contributedAgents(mergedPackage.components, project.agents.map(agent => agent.id), assets);
          } catch (error) {
            if (!(error instanceof CursorComponentContributionError))
              throw error;
            diagnostics.report({
              code: error.category === 'collision'
                ? 'CURSOR_COMPONENT_CONTRIBUTION_COLLISION'
                : 'CURSOR_COMPONENT_CONTRIBUTION_INVALID',
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
                    document: 'plugin-manifest', path: ['agents'], value: './agents/*.md',
                    ...(contributed.origins.length === 0 ? {} : { componentOrigins: contributed.origins }),
                  }],
                }),
          };
        },
        validatePackage: validateCursorPackage,
      };
    },
  });
}

export default cursor;
