import { expectTypeOf } from 'vitest';
import type {
  CompileOptions,
  PortableNodeCompileOptions,
  PortableNodeResolveOptions,
} from '../src/kernel-types.js';

/** portable options 必须只有精确 Profile map 中的一份类型。 */
expectTypeOf<CompileOptions<'portable-node'>>().toEqualTypeOf<PortableNodeCompileOptions>();

/** readonly 作者数组可以直接复用同一套 portable 参数。 */
const options = {
  resolve: { extensions: ['.ts', '.js'] as const },
  transform: { define: { FEATURE: 'true' }, jsx: false as const },
  treeshake: true,
} satisfies CompileOptions<'portable-node'>;
expectTypeOf(options.resolve).toMatchTypeOf<PortableNodeResolveOptions>();

/** arbitrary Plugin 不属于 portable public surface。 */
const invalid = {
  // @ts-expect-error portable-node does not expose Rolldown Plugins
  plugins: [],
} satisfies CompileOptions<'portable-node'>;
void invalid;
