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

## Platform Component Contribution

当 Extension 的私有资源需要成为某个目标的原生资源时，使用该 Platform package 公开的 payload 类型，而不是把私有内容伪装成 Canonical Component、写入 Platform 路径或 patch Manifest。Core 只复制和排序 JSON payload，并把它与当前 Extension 的已声明 subject 绑定；Platform 在 `finalizePackage()` 中独立验证、渲染、处理命名冲突并决定 Manifest 字段。

```ts
import type { PlatformContributor } from '@tokenroll/acplugin/sdk';
import type { ClaudePackageComponent } from '@tokenroll/acplugin-platform-claude-code';

const contributor: PlatformContributor<Readonly<Record<string, never>>, ClaudePackageComponent> = {
  platform: 'claude-code',
  platformApiVersion: '1',
  contribute: () => ({
    components: [{
      subject: 'example:private-resource',
      value: {
        kind: 'native-agent',
        id: 'observer',
        description: 'Observe the project.',
        body: 'Observe and report concise findings.',
      },
    }],
    compatibility: [{
      subject: 'example:private-resource',
      capability: 'delivery',
      level: 'native',
      reason: 'Claude Code installs this private resource as a native Agent.',
    }],
  }),
};
```

这不是 Slot、Component registry、Extension 排序或 override 协议。payload 的字段、输出路径、名称冲突和支持范围完全由目标 Platform 定义。Claude Code、Cursor 与 OpenCode 首期支持各自的原生 Agent payload；Codex、Antigravity 与 Pi 对非空贡献稳定失败，绝不静默忽略或生成伪 fallback。由 contribution 决定的 Asset 和 Manifest 字段会在 schema-v3 `BuildReport` 中记录可信的 Extension owner/subject provenance。

`discover` 使用 `context.sources`/`context.modules`；`build` 使用 `context.compiler`、`context.assets` 与 `context.execution`。Extension 不获得物理 workDir 写权限，不得直接依赖 Rolldown、建立 watcher、写中间文件或写入 `dist`。编译边界见 [统一 Rolldown Compiler](./build-service.md)。
