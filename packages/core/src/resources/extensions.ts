/** Extension Resource Provider 串联发现、验证、构建与贡献收集。 */
import type {
  AcpluginExtension,
  ExtensionSession,
  ExtensionSubject,
  PlatformContributor,
  PlatformIntegrationDescription,
  PackageContribution,
} from '../contracts/integrations.js';
import type { JsonObject } from '../contracts/common.js';
import type { CanonicalProject } from '../contracts/components.js';
import type { CompilerService } from '../contracts/compiler.js';
import type {
  ExecutionService,
  ModuleService,
  SourceDirectoryRef,
} from '../contracts/services.js';
import type { PlatformBasePackageSnapshot } from '../contracts/packages.js';
import { AssetRegistry } from '../services/assets.js';
import { dataArrayItems, dataObjectFields } from '../security/data-boundary.js';
import { DiagnosticRegistry } from '../services/diagnostics.js';
import { snapshotExtensionState } from '../services/extension-state.js';
import { compareCodePoints } from '../security/path-policy.js';
import { SourceRegistry } from '../services/sources.js';

/** Extension discover 完成后的 owner-bound State。 */
export interface DiscoveredExtensionState<D> {
  readonly extension: AcpluginExtension;
  readonly state: Readonly<D>;
}

/** Extension validate 完成后的 owner-bound State 与兼容主题。 */
export interface ValidatedExtensionState<V> {
  readonly extension: AcpluginExtension;
  readonly state: Readonly<V>;
  readonly subjects: readonly ExtensionSubject[];
}

/** 一个选中 Platform 对当前 Extension 的 Contributor 匹配结果。 */
export interface ExtensionConsumer<B> {
  readonly platform: PlatformIntegrationDescription;
  readonly contributor?: PlatformContributor<B, JsonObject>;
}

/** validate 后、build 前固定的 Extension consumer 计划。 */
export interface ExtensionConsumerPlan<V, B> {
  readonly extension: AcpluginExtension;
  readonly validated: Readonly<V>;
  readonly subjects: readonly ExtensionSubject[];
  readonly consumers: readonly ExtensionConsumer<B>[];
  readonly requiresBuild: boolean;
}

/** Extension build 完成后可并行交给全部 Contributor 的 State。 */
export interface BuiltExtensionState<B> {
  readonly extension: AcpluginExtension;
  readonly state: Readonly<B>;
  readonly subjects: readonly ExtensionSubject[];
}

/**
 * 验证 subject/capability 使用稳定非空身份。
 *
 * @param value 未受信任的身份值。
 * @param label 诊断字段标签。
 * @returns 合法原始文本。
 */
function stableSubject(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-z0-9]+(?:[-.:/][a-z0-9]+)*$/u.test(value))
    throw new TypeError(`${label} must be a stable lowercase identifier.`);
  return value;
}

/**
 * 复制、去歧义并排序 Extension subjects。
 *
 * @param value validate 返回的未知 subjects。
 * @returns tuple 唯一的不可变 subjects。
 */
function subjects(value: unknown): readonly ExtensionSubject[] {
  if (!Array.isArray(value))
    throw new TypeError('Extension validation subjects must be an array.');
  /** subject ID 到完整声明的唯一映射。 */
  const entries = new Map<string, ExtensionSubject>();
  for (const [index, item] of [...value].entries()) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)
      || Object.getPrototypeOf(item) !== Object.prototype
      || Object.getOwnPropertySymbols(item).length > 0) {
      throw new TypeError(`Extension validation subjects[${index}] must be a plain object.`);
    }
    /** Subject 字段只通过 descriptor 读取以避免 getter。 */
    const descriptors = Object.getOwnPropertyDescriptors(item);
    if (Object.keys(descriptors).some(field => field !== 'subject' && field !== 'capabilities')
      || Object.values(descriptors).some(descriptor => !('value' in descriptor))) {
      throw new TypeError(`Extension validation subjects[${index}] has invalid fields.`);
    }
    /** subject 是所有 capability tuple 的稳定资源身份。 */
    const id = stableSubject(descriptors.subject?.value, 'Extension subject');
    if (!Array.isArray(descriptors.capabilities?.value))
      throw new TypeError(`Extension subject "${id}" capabilities must be an array.`);
    /** capability 排序使声明顺序不影响后续兼容性覆盖。 */
    const capabilities = [...descriptors.capabilities.value].map(capability => stableSubject(capability, 'Extension capability')).sort(compareCodePoints);
    if (capabilities.length === 0 || new Set(capabilities).size !== capabilities.length)
      throw new TypeError(`Extension subject "${id}" capabilities must be non-empty and unique.`);
    if (entries.has(id))
      throw new TypeError(`Extension subject "${id}" is duplicated.`);
    entries.set(id, Object.freeze({ subject: id, capabilities: Object.freeze(capabilities) }));
  }
  return Object.freeze([...entries.values()].sort((left, right) => compareCodePoints(left.subject, right.subject)));
}

/**
 * 调用 Extension discover 并建立 State 数据边界。
 *
 * @param options 当前 Extension Session 和 owner-scoped 服务。
 * @returns undefined 表示该 Extension 本轮无选中资源。
 */
export async function discoverExtension<D, V, B>(options: {
  readonly extension: AcpluginExtension<import('../contracts/common.js').JsonObject, D, V, B>;
  readonly session: ExtensionSession<D, V, B>;
  readonly roots: Readonly<Record<string, SourceDirectoryRef>>;
  readonly command: import('../contracts/config.js').ConfigCommand;
  readonly mode: import('../contracts/config.js').BuildMode;
  readonly sources: SourceRegistry;
  readonly assets: AssetRegistry;
  readonly modules: ModuleService;
  readonly diagnostics: DiagnosticRegistry;
}): Promise<DiscoveredExtensionState<D> | undefined> {
  /** owner 同时绑定 Source/Asset/Diagnostic capability。 */
  const owner = `extension:${options.extension.id}`;
  /** Context 外壳和 roots map 均不可被 Extension 改写。 */
  const context = Object.freeze({
    command: options.command,
    mode: options.mode,
    roots: Object.freeze({ ...options.roots }),
    sources: options.sources.service(owner),
    modules: options.modules,
    diagnostics: options.diagnostics.service('discover', { owner, extension: options.extension.id }),
  });
  /** Extension 原始返回值必须立即越过 State snapshot 边界。 */
  const discovered = await options.session.discover(context);
  if (discovered === undefined)
    return undefined;
  return Object.freeze({
    extension: options.extension,
    state: snapshotExtensionState(discovered, {
      owner,
      phase: 'discovered',
      sources: options.sources,
      assets: options.assets,
    }),
  });
}

/**
 * 调用 Extension validate 并建立 validated State/subject 边界。
 *
 * @param options 当前 discovered State、Project 和 Session。
 * @returns 不可变 validated State。
 */
export async function validateExtension<D, V, B>(options: {
  readonly discovered: DiscoveredExtensionState<D>;
  readonly session: ExtensionSession<D, V, B>;
  readonly project: CanonicalProject;
  readonly command: import('../contracts/config.js').ConfigCommand;
  readonly mode: import('../contracts/config.js').BuildMode;
  readonly sources: SourceRegistry;
  readonly assets: AssetRegistry;
  readonly diagnostics: DiagnosticRegistry;
}): Promise<ValidatedExtensionState<V>> {
  /** 当前 Extension 稳定 ID 用于上下文和错误归属。 */
  const id = options.discovered.extension.id;
  /** validated State 沿用同一 Extension owner。 */
  const owner = `extension:${id}`;
  /** validate 只读取 immutable Project 与 discovered State。 */
  const output = await options.session.validate(Object.freeze({
    command: options.command,
    mode: options.mode,
    project: options.project,
    diagnostics: options.diagnostics.service('validate', { owner, extension: id }),
  }), options.discovered.state);
  if (typeof output !== 'object' || output === null || Array.isArray(output)
    || Object.getPrototypeOf(output) !== Object.prototype
    || Object.getOwnPropertySymbols(output).length > 0) {
    throw new TypeError(`Extension "${id}" validate output must be a plain object.`);
  }
  /** validate 输出字段通过 descriptor 校验且只允许 state/subjects。 */
  const fields = Object.getOwnPropertyDescriptors(output);
  if (Object.keys(fields).sort().join(',') !== 'state,subjects'
    || Object.values(fields).some(descriptor => !('value' in descriptor))) {
    throw new TypeError(`Extension "${id}" validate output must contain state and subjects data fields.`);
  }
  return Object.freeze({
    extension: options.discovered.extension,
    state: snapshotExtensionState(fields.state!.value as V, {
      owner,
      phase: 'validated',
      sources: options.sources,
      assets: options.assets,
    }),
    subjects: subjects(fields.subjects!.value),
  });
}

/**
 * 验证 Contributor definitions 并为全部选中 Platform 固定 consumer 计划。
 *
 * @param options 当前 Extension、Session、validated State 和选中平台。
 * @returns 与 Platform 配置顺序无关的 frozen consumer plan。
 */
export function preflightExtensionConsumers<D, V, B>(options: {
  readonly validated: ValidatedExtensionState<V>;
  readonly session: ExtensionSession<D, V, B>;
  readonly platforms: readonly PlatformIntegrationDescription[];
}): ExtensionConsumerPlan<V, B> {
  /** Contributor array 自身也必须是无 accessor 的稠密 data array。 */
  const candidates = dataArrayItems(options.session.contributors, `Extension "${options.validated.extension.id}" contributors`);
  /** Platform ID 索引拒绝一个 Extension 对同目标定义两个 Contributor。 */
  const contributors = new Map<string, PlatformContributor<B, JsonObject>>();
  for (const [index, candidate] of candidates.entries()) {
    /** Contributor 是唯一允许包含 contribute 行为的精确对象。 */
    const fields = dataObjectFields(
      candidate,
      new Set(['platform', 'platformApiVersion', 'contribute']),
      `Extension "${options.validated.extension.id}" contributor[${index}]`,
    );
    /** Contributor identity 是精确 Platform ID；API 不匹配是无效定义而非静默 unsupported。 */
    const platform = stableSubject(fields.platform?.value, 'Contributor Platform');
    if (fields.platformApiVersion?.value !== '1')
      throw new TypeError(`Contributor "${platform}" must use Platform API version 1.`);
    if (typeof fields.contribute?.value !== 'function')
      throw new TypeError(`Contributor "${platform}" must provide a contribute function.`);
    if (contributors.has(platform))
      throw new TypeError(`Extension "${options.validated.extension.id}" has duplicate Contributors for Platform "${platform}".`);
    contributors.set(platform, Object.freeze({
      platform,
      platformApiVersion: '1',
      contribute: fields.contribute.value as PlatformContributor<B, JsonObject>['contribute'],
    }));
  }
  /** 选中平台排序使 consumer preflight 与作者配置顺序无关。 */
  const selected = [...options.platforms].sort((left, right) => compareCodePoints(left.id, right.id));
  if (new Set(selected.map(platform => platform.id)).size !== selected.length)
    throw new TypeError('Selected Platform descriptions must be unique.');
  /** 每个 selected Platform 都得到匹配或缺失的显式 consumer slot。 */
  const consumers = selected.map(platform => Object.freeze({
    platform,
    ...(contributors.get(platform.id) === undefined ? {} : { contributor: contributors.get(platform.id)! }),
  }));
  return Object.freeze({
    extension: options.validated.extension,
    validated: options.validated.state,
    subjects: options.validated.subjects,
    consumers: Object.freeze(consumers),
    requiresBuild: consumers.some(consumer => consumer.contributor !== undefined),
  });
}

/**
 * 只在至少一个选中 Platform 拥有 Contributor 时构建 Extension。
 *
 * @param options consumer plan 与当前 Extension 的 owner-scoped Host 服务。
 * @returns frozen Built State；undefined 表示 preflight 已安全跳过 build。
 */
export async function buildExtension<V, B>(options: {
  readonly plan: ExtensionConsumerPlan<V, B>;
  readonly session: ExtensionSession<unknown, V, B>;
  readonly project: CanonicalProject;
  readonly command: import('../contracts/config.js').ConfigCommand;
  readonly mode: import('../contracts/config.js').BuildMode;
  readonly compiler: CompilerService;
  readonly execution: ExecutionService;
  readonly assets: AssetRegistry;
  readonly sources: SourceRegistry;
  readonly diagnostics: DiagnosticRegistry;
}): Promise<BuiltExtensionState<B> | undefined> {
  if (!options.plan.requiresBuild)
    return undefined;
  /** Extension ID 决定 owner-scoped Host capability。 */
  const id = options.plan.extension.id;
  /** 同一 owner 贯穿 build State 与 Contribution。 */
  const owner = `extension:${id}`;
  /** build Context 只提供当前 owner 的受管 Host 能力。 */
  const output = await options.session.build(Object.freeze({
    command: options.command,
    mode: options.mode,
    project: options.project,
    compiler: options.compiler,
    assets: options.assets.service(owner),
    execution: options.execution,
    diagnostics: options.diagnostics.service('compile', { owner, extension: id }),
  }), options.plan.validated);
  /** build 输出只包含 Built State，不允许在此修改 subjects。 */
  const fields = dataObjectFields(output, new Set(['state']), `Extension "${id}" build output`);
  if (!Object.hasOwn(fields, 'state'))
    throw new TypeError(`Extension "${id}" build output must contain a state data field.`);
  return Object.freeze({
    extension: options.plan.extension,
    state: snapshotExtensionState(fields.state!.value as B, {
      owner,
      phase: 'built',
      sources: options.sources,
      assets: options.assets,
    }),
    subjects: options.plan.subjects,
  });
}

/**
 * 对同一 frozen base Package 并行收集 Extension Contributions。
 *
 * @param options 当前 Platform、Project、consumer plans 和 Built States。
 * @returns completion order 无关的 owner-bound Contributions。
 */
export async function collectExtensionContributions(options: {
  readonly platform: PlatformIntegrationDescription;
  readonly base: PlatformBasePackageSnapshot;
  readonly project: CanonicalProject;
  readonly command: import('../contracts/config.js').ConfigCommand;
  readonly mode: import('../contracts/config.js').BuildMode;
  readonly plans: readonly ExtensionConsumerPlan<unknown, unknown>[];
  readonly built: readonly BuiltExtensionState<unknown>[];
  readonly assets: AssetRegistry;
  readonly diagnostics: DiagnosticRegistry;
}): Promise<readonly import('../package/registry.js').OwnedPackageContribution[]> {
  /** Built State 只按 Extension ID 配对，不暴露给其他 Extension。 */
  const builtByExtension = new Map(options.built.map(state => [state.extension.id, state]));
  /** 所有 Contributor promises 在读取同一 base 后并行启动。 */
  const tasks = options.plans.map(async (plan) => {
    /** Context capability 与当前 Extension owner 绑定。 */
    const owner = `extension:${plan.extension.id}`;
    /** 当前 Platform 只读取 plan 中自己的 consumer slot。 */
    const consumer = plan.consumers.find(item => item.platform.id === options.platform.id);
    if (consumer === undefined)
      throw new TypeError(`Extension consumer plan does not include selected Platform "${options.platform.id}".`);
    if (consumer.contributor === undefined) {
      /** 缺少 Contributor 是每个已验证 subject/capability 的显式 unsupported。 */
      const compatibility = plan.subjects.flatMap(subject => subject.capabilities.map(capability => Object.freeze({
        subject: subject.subject,
        capability,
        level: 'unsupported' as const,
        reason: `Extension "${plan.extension.id}" has no compatible contributor for Platform "${options.platform.id}".`,
      })));
      return Object.freeze({
        owner,
        subjects: plan.subjects,
        contribution: Object.freeze({ compatibility: Object.freeze(compatibility) }),
      });
    }
    /** 匹配 Contributor 时必须已有一次共享 Built State。 */
    const built = builtByExtension.get(plan.extension.id);
    if (built === undefined)
      throw new TypeError(`Extension "${plan.extension.id}" requires Built State for Platform "${options.platform.id}".`);
    /** 所有 Contributor 获得同一个 base object identity，且无其他 Contribution 可见。 */
    const contribution = await consumer.contributor.contribute(Object.freeze({
      command: options.command,
      mode: options.mode,
      platform: options.platform,
      project: options.project,
      base: options.base,
      assets: options.assets.service(owner),
      diagnostics: options.diagnostics.service('contribute', {
        owner, extension: plan.extension.id, platform: options.platform.id,
      }),
    }), built.state);
    return Object.freeze({ owner, subjects: plan.subjects, contribution: contribution as PackageContribution<JsonObject> });
  });
  /** Promise.all 保留输入槽位，但 merge 只接受 owner-sorted 无序集合。 */
  return Object.freeze(await Promise.all(tasks));
}
