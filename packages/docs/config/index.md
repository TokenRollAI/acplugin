# 配置参考

`acplugin.config.ts` 负责工程元数据、显式 Platform/Extension 实例和构建策略。通用配置与各平台专属 options 分开说明。

```ts
import { defineConfig } from '@tokenroll/acplugin';
import claudeCode from '@tokenroll/acplugin-platform-claude-code';

export default defineConfig({
  name: 'my-plugin',
  version: '1.0.0',
  description: 'Reusable AI workflows.',
  platforms: [claudeCode()],
});
```

`platforms` 是必填数组，没有运行时默认。配置也可以导出同步或异步函数，接收稳定的 `{ command, mode }`；不要在配置中读取未声明的机器环境来改变生产产物。

- [工程元数据](./project-metadata.md)
- [Public 文件](./public-files.md)
- [内建 Node Runtime](/guide/node-runtime)
- [构建选项](./build-options.md)
- [兼容性与 strict](./compatibility-and-strictness.md)
