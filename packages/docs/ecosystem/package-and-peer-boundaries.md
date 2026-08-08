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
    "@tokenroll/acplugin": "^1.0.0"
  },
  "devDependencies": {
    "@tokenroll/acplugin": "^1.0.0"
  }
}
```

运行时代码不得 import `@acplugin/core`，也不应依赖另一个集成的私有实现。包名、scope 和版本可以独立选择；兼容性由 `apiVersion` 与主包 peer range 表达。

发布前至少验证：

1. ESM-only exports 和声明文件可由 clean consumer 加载。
2. tarball manifest 不包含 `workspace:`、`@acplugin/*` 或仓库相对路径。
3. Platform/Extension bundle externalize 主包 peer。
4. 从 tarball 安装后，品牌化 factory result 能被真实 CLI 接受并完成 build。

官方九个包遵守同一模型，不拥有第三方无法使用的 Core 旁路。
