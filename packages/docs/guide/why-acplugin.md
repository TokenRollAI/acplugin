# 为什么使用 ACPlugin

AI 编程平台通常使用不同目录、Manifest 和运行协议描述相似的作者能力。直接维护六套输出会让内容、兼容性判断和安全边界逐渐分叉。ACPlugin 把这两个问题拆开：作者维护一份 Canonical 工程，Platform 负责把它编译成一种目标交付格式。

## 一条固定流水线

```text
Config → Core lifecycle → Scanner → Platform Draft
       → Extension Adapter → DeliveryUnit validation → transaction → report
```

Core 固定阶段顺序、诊断、所有权和事务。Platform 只处理目标平台的 Component 转换、结构化 Document 和 DeliveryUnit。Extension 通过 Adapter 向 Platform 声明的扩展点 add-only 地加入横向能力。

这意味着：

- CLI 与程序化 `runProject()` 走同一条 lifecycle。
- 一个 Platform/Extension 失败时，不会提交部分新 `dist`。
- 兼容性必须逐资源报告，不能静默丢掉能力。
- 第三方实现使用主包公开的 `definePlatform()`、`defineExtension()`，不需要中央 registry。

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

接下来阅读[快速开始](./getting-started.md)，或查看[package map](/resources/package-map)。
