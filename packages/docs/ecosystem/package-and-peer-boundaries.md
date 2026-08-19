# Package 与 peer 边界

第三方 Platform/Extension 应把 `@tokenroll/acplugin` 声明为 peer dependency，并在开发时同时放入 dev dependency：

```json
{
  "name": "example-acplugin-platform",
  "version": "1.0.0",
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.mts",
      "import": "./dist/index.mjs"
    }
  },
  "peerDependencies": {
    "@tokenroll/acplugin": "^0.0.2-beta"
  },
  "devDependencies": {
    "@tokenroll/acplugin": "^0.0.2-beta"
  }
}
```

运行时代码不得 import `@acplugin/core`，也不应依赖另一个集成的私有实现。包名、scope 和版本可以独立选择；兼容性由 `apiVersion` 与主包 peer range 表达。

Integration factory result 的 `Symbol.for(...)` 只是跨主包 root、SDK 与 CLI bundle chunk 共享的 registry brand。它用于身份互操作，不是 private/security Symbol，也不把第三方代码变成沙箱。Platform/Extension 是可信构建时代码；Core Services 约束可进入 Package 的来源和输出，但不会阻止 Integration 自行调用 Node.js API。

发布前至少验证：

1. ESM-only exports 和声明文件可由 clean consumer 加载。
2. tarball manifest 不包含 `workspace:`、`@acplugin/*` 或仓库相对路径。
3. Platform/Extension bundle externalize 主包 peer。
4. 从 tarball 安装后，品牌化 factory result 能被真实 CLI 接受并完成 build。

官方九个包遵守同一模型，不拥有第三方无法使用的生命周期旁路；统一 Build Service 本身就是公开 SDK 能力。
