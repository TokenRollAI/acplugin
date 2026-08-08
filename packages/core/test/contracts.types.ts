import {
  defineExtension,
  definePlatform,
  type AcpluginPlatform,
  type DraftDocument,
  type ExtensionPlatformAdapter,
  type PlatformAdapterContext,
  type PlatformId,
} from '../src/index.js';

/** 第三方 Extension discover 阶段产生的示例状态。 */
interface ExampleDiscoveredState {
  readonly source: string;
}

/** 第三方 Extension build 阶段产生的示例状态。 */
interface ExampleBuiltState {
  readonly output: string;
}

/**
 * 由 TypeScript 编译器验证第三方 Platform、Extension 和 Bridge Adapter 的正负契约。
 */
export function verifyContractTypes(): void {
  /** 正常第三方 Platform 无需修改 Core 的封闭联合类型。 */
  const platform = definePlatform({
    id: 'community-platform',
    apiVersion: '1',
    deliveryType: 'workspace',
    strict: false,
    /** prepare 提供当前对象协议要求的回调实现。 */ prepare: () => ({ documents: [], artifacts: [] }),
    /** generateBundle 提供当前对象协议要求的回调实现。 */ generateBundle: () => ({ id: 'workspace', role: 'primary', type: 'workspace', artifacts: [] }),
    /** validateBundle 提供当前对象协议要求的回调实现。 */ validateBundle: () => undefined,
  });
  /** 正常 Bridge Adapter 同时绑定两个 API 版本。 */
  const adapter: ExtensionPlatformAdapter<ExampleBuiltState> = {
    extensionApiVersion: '1',
    platform: platform.id,
    platformApiVersion: '1',
    /** apply 提供当前对象协议要求的回调实现。 */ apply: (context, built) => context.emitArtifact({
      path: built.output,
      source: { type: 'bytes', value: new Uint8Array() },
    }),
  };
  /** 正常第三方 Extension 可以保留显式 Discovered/Built State。 */
  const extension = defineExtension<ExampleDiscoveredState, ExampleBuiltState>({
    name: 'community-extension',
    apiVersion: '1',
    /** discover 提供当前对象协议要求的回调实现。 */ discover: () => ({ source: 'extension.ts' }),
    /** build 同时验证第三方 Extension 可登记自己的完整依赖图。 */
    build: (context, discovered) => {
      context.addWatchFile('/absolute/extension.ts');
      return { output: discovered.source };
    },
    adapters: [adapter],
  });

  // @ts-expect-error 原始字符串没有经过 Platform 工厂，不能直接获得开放品牌。
  const rawPlatformId: PlatformId = 'community-platform';
  // @ts-expect-error 普通对象缺少 Core 私有的 Platform Symbol 品牌。
  const fakePlatform: AcpluginPlatform = {
    id: platform.id,
    apiVersion: '1',
    deliveryType: 'workspace',
    strict: false,
    /** prepare 提供当前对象协议要求的回调实现。 */ prepare: () => ({ documents: [], artifacts: [] }),
    /** generateBundle 提供当前对象协议要求的回调实现。 */ generateBundle: () => ({ id: 'workspace', role: 'primary', type: 'workspace', artifacts: [] }),
    /** validateBundle 提供当前对象协议要求的回调实现。 */ validateBundle: () => undefined,
  };
  /** API 版本错误的 Adapter 应由 TypeScript 在作者工程中提前拒绝。 */
  const wrongVersionAdapter: ExtensionPlatformAdapter<ExampleBuiltState> = {
    extensionApiVersion: '1',
    platform: platform.id,
    // @ts-expect-error Platform Adapter 必须声明当前 Platform API 版本。
    platformApiVersion: '2',
    /** apply 提供当前对象协议要求的回调实现。 */ apply: () => undefined,
  };
  /** 受限 Adapter Context 和只读 Draft 不允许访问内部写入、序列化或替换能力。 */
  const verifyRestrictedContext = (context: PlatformAdapterContext, document: DraftDocument): void => {
    // @ts-expect-error Adapter 不获得最终输出目录。
    void context.outDir;
    // @ts-expect-error Adapter 不获得 Platform 内部 Serializer。
    void context.serialize;
    // @ts-expect-error DraftDocument 的结构化值不可被 Extension 原地替换。
    document.value = {};
  };

  void [extension, rawPlatformId, fakePlatform, wrongVersionAdapter, verifyRestrictedContext];
}
