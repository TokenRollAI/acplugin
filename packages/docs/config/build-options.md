# 构建选项

```ts
export default defineConfig({
  // ...metadata and platforms
  srcDir: 'src',
  build: {
    outDir: 'dist',
    strict: true,
  },
});
```

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `srcDir` | `src` | Canonical 与 Extension 作者源码根 |
| `runtime` | `{}` | 内建 Runtime 自动发现、显式入口与 portable-node 编译参数；`false` 关闭 |
| `build.outDir` | `dist` | 框架完整托管的输出根 |
| `build.strict` | `true` | 是否拒绝 degraded/unsupported 兼容性 |

路径都相对于配置文件所在工程根解析，必须留在根目录内。`srcDir`、Public 和 `outDir` 不能相互包含，`outDir` 也不能等于工程根。

`runtime.entries` 的入口路径相对于 `<srcDir>/runtime`；配置存在时会完整替换一级文件自动发现。详细边界见[内建 Node Runtime](/guide/node-runtime)。

## 函数式配置

```ts
export default defineConfig(({ command, mode }) => ({
  name: 'my-plugin',
  version: '1.0.0',
  description: `${command} configuration`,
  platforms: [claudeCode()],
  build: { strict: mode === 'production' },
}));
```

环境只包含 `command` 和 `mode`。`dev` 默认 development，其余项目命令默认 production；CLI `--mode` 可覆盖。配置加载不会自动读取 `.env`。
