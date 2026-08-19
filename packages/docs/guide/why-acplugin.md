# 为什么使用 ACPlugin

AI 编程平台通常使用不同目录、Manifest 和运行协议表达相似能力。直接维护六套输出会让内容、兼容性判断、编译方式和安全边界逐渐分叉。ACPlugin 把作者模型与目标交付分开：作者维护一份 Canonical 工程，Platform 负责目标 Package，Core 提供统一 Rolldown Compiler 与固定生命周期。

## 一条固定流水线

```text
Config → Core Resource discovery → CanonicalProject
       → Platform base Package → unordered add-only Contributions
       → finalized/validated Packages → transaction → BuildReport
```

Core 拥有阶段、Compiler/Module/Watch、诊断、Asset、兼容性和事务。Platform 拥有目标 Component 转换、结构化 Document、Package identity、Distribution 与 candidate validator。Extension 构建一次平台中立状态，再通过只读 base Package 上的 Contributor 添加横向能力。

这意味着：

- CLI、`runProject()`、`Project.run()` 与 `Project.dev()` 走同一 Kernel。
- Platform/Extension 不能自建 bundler、watcher 或直接写入 `dist`。
- 一个目标失败时不会提交部分新 Package 集合。
- 兼容性逐资源显式报告，不能静默丢弃能力。
- 第三方实现使用 `@tokenroll/acplugin/sdk`，不需要中央 registry 或 Core 私有 API。

## 独立 package，而不是主包开关

主包不重新导出官方 Platform 或 Extension。工程安装什么、实例化什么，就是构建图中存在什么：

```ts
import { defineConfig } from '@tokenroll/acplugin';
import cursor from '@tokenroll/acplugin-platform-cursor';

export default defineConfig({
  name: 'review-tools',
  version: '1.0.0',
  description: 'Shared review workflows.',
  platforms: [cursor()],
});
```

Node Runtime 是 Core 内建约定，不是第三个 Extension package。接下来阅读[快速开始](./getting-started.md)，或查看[package map](/resources/package-map)。
