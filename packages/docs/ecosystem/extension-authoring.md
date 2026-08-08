# Extension 开发

Extension 表达横向作者能力，并通过一个或多个 `ExtensionPlatformAdapter` 参与对应 Platform Draft。

```ts
import { defineExtension } from '@tokenroll/acplugin';

export function notices() {
  return defineExtension({
    name: 'example-notices',
    apiVersion: '1',
    discover: async () => ({ enabled: true }),
    validate: (_context, discovered) => discovered,
    build: (_context, validated) => validated,
    adapters: [],
  });
}
```

完整 Extension 应定义自己的作者目录、验证和 built state，再为明确支持的 Platform 提供 Adapter。Adapter 可：

- 读取 Platform 已公开的只读 Document；
- 向声明的 extension point add-only patch 新字段；
- 追加 owner 为自身的 Artifact；
- 报告兼容性与诊断。

Adapter 不能替换 Platform、完整 Document 或已有字段，也不能读取其他 Extension state。Extension 没有依赖图或 enforce/order API；配置顺序是固定执行顺序，但不能用它建立覆盖语义。两个 owner 写同字段或同 Artifact path 会稳定冲突，而不是 last-writer-wins。

查看 [`defineExtension()`](/api/@tokenroll/acplugin/functions/defineExtension.md) 和 [`ExtensionPlatformAdapter`](/api/@tokenroll/acplugin/interfaces/ExtensionPlatformAdapter.md)。
