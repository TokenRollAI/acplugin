# Platform 开发

Platform 把 Canonical `PluginProject` 编译成一种目标交付格式。第三方 package 只从 `@tokenroll/acplugin` 导入 SDK：

```ts
import {
  bytesArtifact,
  definePlatform,
  stableJson,
} from '@tokenroll/acplugin';

export function examplePlatform() {
  return definePlatform({
    id: 'example',
    apiVersion: '1',
    deliveryType: 'plugin',
    options: {},
    prepare: context => ({
      documents: [{
        id: 'manifest',
        path: 'plugin.json',
        format: 'json',
        owner: 'platform:example',
        value: { name: context.project.metadata.name },
        extensionPoints: [],
      }],
      artifacts: [],
    }),
    generateBundle: (context) => {
      const manifest = context.documents.find(document => document.id === 'manifest');
      if (!manifest)
        throw new Error('Platform draft is missing its manifest.');
      return {
        id: 'plugin',
        role: 'primary',
        type: 'plugin',
        artifacts: [
          ...context.artifacts,
          bytesArtifact('plugin.json', stableJson(manifest.value)),
        ],
      };
    },
    validateBundle: async () => {},
  });
}
```

真实实现还应提供 Component field validator、逐资源 compatibility、最终候选 Schema 校验和必要的 Distribution。Platform 只能读取自己的 workDir、Scanner 精确发现的 Component/Skill auxiliary 与已公开 Document；不能直接写 `dist`。

不要 import `@acplugin/core`，不要依赖官方 Platform/Extension 实现，也不要在 Core 中申请平台 ID 分支。公共契约见 [`definePlatform()`](/api/@tokenroll/acplugin/functions/definePlatform.md) 与 [`PlatformDefinition`](/api/@tokenroll/acplugin/interfaces/PlatformDefinition.md)。
