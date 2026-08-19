# Public 文件

默认情况下，Core 扫描工程根的 `public/`，把其中普通文件签发为 Framework-owned Asset，并向每个平台的 base Package 提交 add-only Contribution。可执行位规范为 `0755`，其他普通文件为 `0644`。

## 关闭或改目录

```ts
export default defineConfig({
  // ...metadata and platforms
  public: false,
});
```

```ts
export default defineConfig({
  // ...metadata and platforms
  public: 'static',
});
```

## Copy rules

```ts
export default defineConfig({
  // ...metadata and platforms
  public: {
    dir: 'assets',
    copy: [
      { from: 'templates', to: 'resources/templates' },
      { from: 'LICENSE', to: 'LICENSE' },
    ],
  },
});
```

`from` 与 `to` 都必须是安全相对路径，不能含绝对路径、NUL 或 `..` 片段。来源必须是 Scanner 精确发现的普通文件；符号链接和特殊文件会失败。

Public 路径仍受全局大小写、Unicode normalization、文件/目录和 owner 冲突检查。它不能覆盖 Platform 或 Extension 已拥有的 Asset 路径。
