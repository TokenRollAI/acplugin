# Extension 开发

Extension 表达横向作者能力：发现并验证自己的资源，使用 Core Host 只构建一次不可变 Built State，再通过明确的 `PlatformContributor` add-only 参与目标 Package。

```ts
import { defineExtension } from '@tokenroll/acplugin/sdk';

export function notices() {
  return defineExtension({
    id: 'example-notices',
    apiVersion: '1',
    options: {},
    resourceRoots: ['notices'],
    createSession() {
      return {
        discover: async () => ({ enabled: true }),
        validate: async (_context, discovered) => ({
          state: discovered,
          subjects: [{ subject: 'notices:default', capabilities: ['delivery'] }],
        }),
        build: async (_context, validated) => ({ state: validated }),
        contributors: [{
          platform: 'example',
          platformApiVersion: '1',
          async contribute(context, built) {
            const notice = await context.assets.fromBytes({
              bytes: built.enabled ? 'Enabled\n' : 'Disabled\n',
              origin: { operation: 'render-notice', subjects: ['notices:default'] },
            });
            return {
              assets: [{ path: 'NOTICE.txt', asset: notice }],
              compatibility: [{
                subject: 'notices:default',
                capability: 'delivery',
                level: 'native',
                reason: 'The target installs the notice as a native file.',
              }],
            };
          },
        }],
      };
    },
  });
}
```

每个 Contributor 都读取同一个冻结的 Platform base Package。它可以：

- 读取已公开的 Document 与 extension point；
- 填写一个仍为空且已声明的字段；
- 追加由当前 Extension owner 创建或获授权的 Asset；
- 精确覆盖 `validate()` 声明的兼容性 tuple。

Contributor 不能观察其他 Contribution 或 Extension state，不能替换/删除 Platform 内容，也不能 claim/suppress Canonical Component。Core 并发收集贡献，按 owner 稳定排序并集中合并；同字段或同路径竞争稳定失败，不使用配置顺序解决冲突。

`discover` 使用 `context.sources`/`context.modules`；`build` 使用 `context.compiler`、`context.assets` 与 `context.execution`。Extension 不获得物理 workDir 写权限，不得直接依赖 Rolldown、建立 watcher、写中间文件或写入 `dist`。编译边界见 [统一 Rolldown Compiler](./build-service.md)。
