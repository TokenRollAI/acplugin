# Platform 开发

Platform 把 `CanonicalProject` 转换为一种目标平台 Package。第三方实现只从专用 SDK subpath 导入契约：

```ts
import {
  definePlatform,
  type CompatibilityInput,
} from '@tokenroll/acplugin/sdk';

export function examplePlatform() {
  return definePlatform({
    id: 'example',
    apiVersion: '1',
    deliveryType: 'plugin',
    options: {},
    createSession() {
      return {
        validateComponent: async () => {},
        async createPackage({ project, assets }) {
          const commandAssets = await Promise.all(project.commands.map(async command => ({
            path: `commands/${command.id}.md`,
            asset: await assets.fromBytes({
              bytes: command.body,
              origin: { operation: 'compile-command', subjects: [`command:${command.id}`] },
            }),
          })));
          const compatibility: CompatibilityInput[] = project.commands.map(command => ({
            subject: `command:${command.id}`,
            capability: 'delivery',
            level: 'native',
            reason: 'The target has a native command resource.',
          }));
          return {
            documents: [{
              id: 'manifest',
              path: 'plugin.json',
              format: 'json',
              value: { name: project.metadata.name },
              extensionPoints: [],
            }],
            assets: commandAssets,
            compatibility,
            metadata: [],
          };
        },
        finalizePackage: () => ({ id: 'plugin', type: 'plugin' }),
        validatePackage: async ({ candidate }) => {
          // Validate the complete temporary candidate against the target schema.
          void candidate.root;
        },
      };
    },
  });
}
```

真实实现还必须：

- 校验 `component.platforms[platformId]` 中的平台专属字段；
- 为每个 Canonical Component、Runtime 和 Extension capability 提交完整兼容性结论；
- 在 `createPackage()` 中建立 base Document/Asset，在 `finalizePackage()` 中只决定主 Package 身份并追加必要的平台 Asset；
- 对 Core 临时物化的完整候选执行 Schema、引用闭包和真实格式校验；
- 只从已经验证的主 Package 派生可选 Marketplace Distribution。

Platform 只能使用 Core 签发的 Source/Asset/Compiler capability；物理 workDir 仅由 Core 内部管理。Platform 不能自建 Rolldown、watcher 或写入 `dist`。`PackageCandidate.root` 只在 `validatePackage()` 调用窗口有效，不得保存。

不要 import `@acplugin/core`，不要依赖官方 Platform/Extension 私有实现，也不要在 Core 中申请平台 ID 分支。`@tokenroll/acplugin` 根入口面向普通作者；Integration 实现必须使用 `@tokenroll/acplugin/sdk`。
