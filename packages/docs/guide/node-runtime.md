# 内建 Node Runtime

Node Runtime 是 Core Framework Resource，不需要安装 Extension 或调用额外 factory。启用后，Core 负责发现、编译、模块图 Watch、许可证和跨平台 Asset 交付。

## 约定入口

`src/runtime/` 的一级可执行 TypeScript/JavaScript 文件会自动成为入口，文件名去除扩展名后就是小写 kebab-case ID。嵌套文件只作为依赖：

```text
src/runtime/
├── cli.ts                  # entry id: cli
└── internal/client.ts      # dependency only
```

自动入口默认是 `executable`，生成 `runtime/cli/main.mjs`，mode 为 `0755`。

## 显式入口

当入口 ID、文件位置或 kind 需要明确控制时，在配置中声明 `runtime.entries`。该字段会完整替换自动发现：

```ts
export default defineConfig({
  // ...metadata and platforms
  runtime: {
    target: 'node20',
    entries: {
      cli: { entry: 'cli.ts', kind: 'executable' },
      library: { entry: 'modules/library.ts', kind: 'module' },
    },
    compile: {
      treeshake: true,
    },
  },
});
```

入口路径相对于 `<srcDir>/runtime`，不能使用绝对路径或 `..`。`module` 的 mode 为 `0644`。`runtime: false` 显式关闭该资源；目录存在内容但关闭时会失败，避免静默遗漏。

## 构建与交付

Core 使用 `portable-node` profile 把每个入口编译为自包含 Node 20 ESM。npm 依赖默认进入 Bundle，只有 `node:` 内置模块保持 external。未解析 import、原生扩展、隐式运行时依赖、作者源码 symlink 与特殊文件都会失败。

包含第三方 package 时，会在相邻路径生成稳定排序的 `THIRD_PARTY_LICENSES.txt`；无法确认许可证信息时失败，无第三方依赖时不生成空文件。相同输入产生相同 Bundle 字节，报告只记录工程相对 origin。

当前 Claude Code 与 Codex 声明稳定的 Plugin-local Node 能力并继承同一 Asset 字节。Cursor、Antigravity、OpenCode 与 Pi 报告 `unsupported` 且不生成伪 Runtime。空目录或没有有效入口时不产生 Asset 和兼容性噪声。
