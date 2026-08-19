import type {
  ExtensionBuildContext,
  GeneratedAssetRef,
  PortableNodeCompileOptions,
} from '@tokenroll/acplugin/sdk';
import type { HookDescriptorData, ValidatedHooks } from './discovery.js';
import { createRunnerSource } from './runtime-source.js';
import { createWireSource } from './wire-source.js';

/** portable Handler 内联官方平台协议的稳定虚拟模块。 */
const HOOK_WIRE_MODULE_ID = 'acplugin:hook-wire';

/** 单个 Hook 一次编译后可被全部 Contributor 复用的 State。 */
export interface BuiltHook {
  readonly id: string;
  readonly definition: HookDescriptorData;
  readonly handler: GeneratedAssetRef;
  readonly licenses?: GeneratedAssetRef;
}

/** Hooks Extension 的无函数 Built State。 */
export interface BuiltHooks {
  readonly hooks: readonly BuiltHook[];
}

/** 通过 Core `portable-node` 为每个 Hook 生成一次自包含 Handler。 */
export async function buildHooks(
  context: ExtensionBuildContext,
  validated: Readonly<ValidatedHooks>,
  compile?: PortableNodeCompileOptions,
): Promise<BuiltHooks> {
  /** 虚拟 entries 各自从其 Hook 目录解析原始 hook.ts。 */
  const entries = Object.fromEntries(validated.hooks.map(hook => [hook.id, Object.freeze({
    type: 'virtual' as const,
    code: createRunnerSource(),
    resolveFrom: hook.directory,
    mode: 0o755 as const,
  })]));
  /** result 只包含 Core 签发的 GeneratedAssetRef 和脱敏模块图。 */
  const result = await context.compiler.compile({
    id: 'hooks',
    profile: 'portable-node',
    entries: Object.freeze(entries),
    sourceScopes: Object.freeze([validated.root]),
    virtualModules: Object.freeze({ [HOOK_WIRE_MODULE_ID]: createWireSource() }),
    ...(compile === undefined ? {} : { options: compile }),
  });
  /** built 逐 entry 校验固定 main/license 输出闭包。 */
  const built = validated.hooks.map((hook): BuiltHook => {
    /** outputs 是当前 Hook 独立 Bundle 的全部受管文件。 */
    const outputs = result.outputs.filter(output => output.outputId === hook.id);
    /** main 必须是 portable-node 固定的唯一可执行入口。 */
    const mains = outputs.filter(output => output.type === 'chunk' && output.fileName === 'main.mjs' && output.isEntry);
    /** licenses 只在实际打入第三方依赖时出现。 */
    const licenses = outputs.filter(output => output.type === 'licenses' && output.fileName === 'THIRD_PARTY_LICENSES.txt');
    if (mains.length !== 1 || licenses.length > 1 || outputs.length !== mains.length + licenses.length)
      throw new Error(`Compiler returned an invalid Hook output set for "${hook.id}".`);
    return Object.freeze({
      id: hook.id,
      definition: hook.definition,
      handler: mains[0]!.asset,
      ...(licenses[0] === undefined ? {} : { licenses: licenses[0].asset }),
    });
  });
  return Object.freeze({ hooks: Object.freeze(built) });
}
