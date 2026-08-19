import type {
  CompilerService,
  GeneratedAssetRef,
  NodeRuntimeResource,
  PackageContribution,
  PlatformIntegrationDescription,
  SourceDirectoryRef,
} from '../kernel-types.js';
import type { ResolvedRuntimeConfig } from '../kernel/config-resolver.js';
import { DiagnosticRegistry } from '../kernel/diagnostic-registry.js';
import { compareCodePoints, safeRelativePath, sourceCollisionKey } from '../kernel/path-policy.js';
import { SourceRegistry } from '../kernel/source-registry.js';
import {
  nodeRuntimeArtifactPath,
  nodeRuntimeLicensesArtifactPath,
} from './runtime-paths.js';

/** Runtime 允许成为 executable entry 的源码扩展名。 */
const RUNTIME_EXTENSIONS = ['.tsx', '.mts', '.cts', '.jsx', '.mjs', '.cjs', '.ts', '.js'] as const;

/** TypeScript declaration 永远不是 Runtime entry。 */
const DECLARATION = /\.d\.(?:ts|mts|cts)$/u;

/** Runtime ID 规范规则。 */
const RUNTIME_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

/** 单个已编译 Runtime entry 的 Core-owned AssetRefs。 */
export interface BuiltNodeRuntimeEntry {
  readonly id: string;
  readonly kind: 'executable' | 'module';
  readonly main: GeneratedAssetRef;
  readonly licenses?: GeneratedAssetRef;
}

/** 一次 portable-node Job 产生的全部 Runtime Built State。 */
export interface BuiltNodeRuntime {
  readonly entries: readonly BuiltNodeRuntimeEntry[];
}

/** @returns Platform 是否声明精确 Plugin-local Node 20 ESM 能力。 */
export function platformSupportsNodeRuntime(platform: PlatformIntegrationDescription): boolean {
  /** capability 是 Platform setup 前已复制冻结的纯 JSON 数据。 */
  const capability = platform.capabilities?.nodeRuntime;
  return capability?.target === 'node20' && capability.format === 'esm' && capability.root === 'plugin';
}

/** 通过 Core 唯一 portable-node Compiler Service 一次编译全部 Runtime entry。 */
export async function buildNodeRuntime(
  resource: NodeRuntimeResource,
  compiler: CompilerService,
): Promise<BuiltNodeRuntime> {
  /** entries 保持 Provider 已固定的稳定 ID 顺序，并由 kind 决定主文件 mode。 */
  const entries = Object.fromEntries(resource.entries.map(entry => [entry.id, Object.freeze({
    type: 'source' as const,
    source: entry.source,
    mode: entry.kind === 'executable' ? 0o755 as const : 0o644 as const,
  })]));
  /** 所有入口属于一个逻辑 Job，Host 内部仍逐 entry 生成独立 Bundle。 */
  const result = await compiler.compile({
    id: 'node-runtime',
    profile: 'portable-node',
    entries: Object.freeze(entries),
    ...(resource.compile === undefined ? {} : { options: resource.compile }),
  });
  /** outputId 将 Compiler 结果确定性归组回 canonical Runtime entry。 */
  const built = resource.entries.map((entry) => {
    /** outputs 只读取当前 entry 的 Host result 槽位。 */
    const outputs = result.outputs.filter(output => output.outputId === entry.id);
    /** 每个 entry 必须恰好拥有固定 main Chunk。 */
    const mains = outputs.filter(output => output.type === 'chunk' && output.fileName === 'main.mjs' && output.isEntry);
    /** license 仅在实际包含第三方依赖时存在。 */
    const licenses = outputs.filter(output => output.type === 'licenses' && output.fileName === 'THIRD_PARTY_LICENSES.txt');
    if (mains.length !== 1 || licenses.length > 1 || outputs.length !== mains.length + licenses.length)
      throw new Error(`Compiler returned an invalid Runtime output set for "${entry.id}".`);
    return Object.freeze({
      id: entry.id,
      kind: entry.kind,
      main: mains[0]!.asset,
      ...(licenses[0] === undefined ? {} : { licenses: licenses[0].asset }),
    });
  });
  return Object.freeze({ entries: Object.freeze(built) });
}

/** 为一个 Platform 建立 capability-driven Runtime add-only Contribution。 */
export function nodeRuntimeContribution(
  resource: NodeRuntimeResource,
  built: BuiltNodeRuntime | undefined,
  platform: PlatformIntegrationDescription,
): PackageContribution {
  /** supported 决定是否继承 Bundle；不支持的平台只获得显式 compatibility。 */
  const supported = platformSupportsNodeRuntime(platform);
  if (supported && built === undefined)
    throw new Error('Supported Platform requires compiled Node Runtime state.');
  /** Built State 必须精确覆盖全部 canonical entry。 */
  const builtById = new Map((built?.entries ?? []).map(entry => [entry.id, entry]));
  if (supported && (builtById.size !== resource.entries.length
    || resource.entries.some(entry => !builtById.has(entry.id)))) {
    throw new Error('Compiled Node Runtime state does not cover every entry.');
  }
  /** 同一 Built AssetRef 被所有支持 Platform 原样继承。 */
  const assets = supported
    ? resource.entries.flatMap((entry) => {
        /** output 必须已由上面的完整覆盖校验证明存在。 */
        const output = builtById.get(entry.id)!;
        return [
          Object.freeze({ path: nodeRuntimeArtifactPath(entry.id), asset: output.main }),
          ...(output.licenses === undefined
            ? []
            : [Object.freeze({ path: nodeRuntimeLicensesArtifactPath(entry.id), asset: output.licenses })]),
        ];
      })
    : [];
  /** Runtime compatibility 由 Framework 而非 Platform converter 统一生成。 */
  const compatibility = resource.entries.map(entry => Object.freeze({
    subject: `runtime:${entry.id}`,
    capability: 'node20-esm',
    level: supported ? 'native' as const : 'unsupported' as const,
    reason: supported
      ? 'The platform can install and execute the bundled Node.js runtime.'
      : 'The platform does not provide a stable Plugin-local Node.js runtime.',
  }));
  return Object.freeze({
    assets: Object.freeze(assets),
    compatibility: Object.freeze(compatibility),
  });
}

/** @returns 文件名匹配的最长 Runtime 扩展名。 */
function extension(file: string): typeof RUNTIME_EXTENSIONS[number] | undefined {
  return RUNTIME_EXTENSIONS.find(candidate => file.endsWith(candidate));
}

/**
 * 提交 Runtime Provider 诊断。
 *
 * @param diagnostics 当前诊断集合。
 * @param code 稳定诊断码。
 * @param message 稳定信息。
 * @param location 工程相对路径。
 */
function error(diagnostics: DiagnosticRegistry, code: string, message: string, location: string): void {
  diagnostics.report('discover', { code, severity: 'error', message, location: { path: location } }, { owner: 'framework:node-runtime' });
}

/**
 * 只把合法 runtime-relative entry 投影为诊断位置。
 *
 * @param root Runtime root 的安全报告路径。
 * @param entry 仍可能绕过 config resolver 的 entry 输入。
 * @returns 合法精确位置，或不泄露越界语法的 Runtime root。
 */
function runtimeLocation(root: SourceDirectoryRef, entry: unknown): string {
  try {
    return `${root.path}/${safeRelativePath(entry)}`;
  } catch {
    return root.path;
  }
}

/**
 * 发现 Runtime auto/explicit entry model。
 *
 * @param options Runtime root、配置和 registries。
 * @returns 不含物理路径的 Runtime resource；无入口时 undefined。
 */
export async function discoverNodeRuntime(options: {
  readonly root?: SourceDirectoryRef;
  readonly config: ResolvedRuntimeConfig;
  readonly sources: SourceRegistry;
  readonly diagnostics: DiagnosticRegistry;
}): Promise<NodeRuntimeResource | undefined> {
  if (!options.config.enabled || options.root === undefined)
    return undefined;
  /** Runtime 只能使用 Framework 固定 owner 的 Source Service。 */
  const sources = options.sources.service('framework:node-runtime');
  /** 有效入口先累积，最后按 ID 排序并冻结。 */
  const entries: { readonly id: string; readonly kind: 'executable' | 'module'; readonly source: import('../kernel-types.js').SourceFileRef }[] = [];
  /** ID 的 NFC/case fold 防止跨文件系统 Asset 路径冲突。 */
  const ids = new Map<string, string>();
  if (options.config.entries === undefined) {
    /** 自动模式只枚举 Runtime root 的直接子项。 */
    for (const entry of await sources.list(options.root)) {
      if (entry.type === 'directory')
        continue;
      if (DECLARATION.test(entry.name))
        continue;
      /** 最长匹配避免把 .mts 等误拆为普通文件名后缀。 */
      const suffix = extension(entry.name);
      if (suffix === undefined) {
        error(options.diagnostics, 'RUNTIME_SOURCE_UNSUPPORTED', 'Runtime root direct files must be executable TypeScript or JavaScript sources.', entry.path);
        continue;
      }
      /** 自动入口 ID 直接来自去除源码扩展名后的文件名。 */
      const id = entry.name.slice(0, -suffix.length);
      if (!RUNTIME_ID.test(id)) {
        error(options.diagnostics, 'RUNTIME_ENTRY_ID_INVALID', `Runtime entry ID "${id}" must use lowercase kebab-case.`, entry.path);
        continue;
      }
      /** case/NFC key 模拟最严格目标文件系统。 */
      const key = sourceCollisionKey(id);
      if (ids.has(key)) {
        error(options.diagnostics, 'RUNTIME_ENTRY_CONFLICT', `Runtime entry ID "${id}" conflicts with another source.`, entry.path);
        continue;
      }
      ids.set(key, entry.path);
      entries.push(Object.freeze({ id, kind: 'executable' as const, source: entry.file }));
    }
  } else {
    for (const id of Object.keys(options.config.entries).sort(compareCodePoints)) {
      /** 显式入口读取最终冻结配置而不是作者原始对象。 */
      const input = options.config.entries[id]!;
      /** 诊断位置必须先通过安全路径投影。 */
      const location = runtimeLocation(options.root, input.entry);
      /** 显式 ID 也使用相同的跨文件系统碰撞规则。 */
      const key = sourceCollisionKey(id);
      if (ids.has(key)) {
        error(options.diagnostics, 'RUNTIME_ENTRY_CONFLICT', `Runtime entry ID "${id}" conflicts after case or Unicode normalization.`, location);
        continue;
      }
      if (!RUNTIME_ID.test(id)) {
        error(options.diagnostics, 'RUNTIME_ENTRY_ID_INVALID', `Runtime entry ID "${id}" must use lowercase kebab-case.`, location);
        continue;
      }
      if (extension(input.entry) === undefined || DECLARATION.test(input.entry)) {
        error(options.diagnostics, 'RUNTIME_SOURCE_UNSUPPORTED', `Runtime entry "${id}" must reference executable TypeScript or JavaScript.`, location);
        continue;
      }
      try {
        /** 精确 entry 最终仍由 Source Registry 拒绝逃逸、symlink 和特殊文件。 */
        const source = await sources.file(options.root, input.entry);
        ids.set(key, source.path);
        entries.push(Object.freeze({ id, kind: input.kind, source }));
      } catch {
        error(options.diagnostics, 'RUNTIME_ENTRY_MISSING', `Runtime entry "${id}" is not a usable source file.`, location);
      }
    }
  }
  if (entries.length === 0)
    return undefined;
  entries.sort((left, right) => compareCodePoints(left.id, right.id));
  return Object.freeze({
    target: 'node20',
    entries: Object.freeze(entries),
    ...(options.config.compile === undefined ? {} : { compile: options.config.compile }),
  });
}
