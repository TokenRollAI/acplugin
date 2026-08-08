# 工程元数据

| 字段 | 必填 | 约束 |
| --- | --- | --- |
| `name` | 是 | 小写 kebab-case |
| `version` | 是 | 完整合法 SemVer |
| `description` | 是 | 非空字符串 |
| `displayName` | 否 | 非空展示名 |
| `author` | 否 | `{ name, email?, url? }` |
| `homepage` | 否 | 绝对 HTTP(S) URL |
| `repository` | 否 | 绝对 HTTP(S) URL |
| `license` | 否 | 合法 SPDX expression |
| `keywords` | 否 | 非空、去空白后不重复的字符串数组 |

```ts
export default defineConfig({
  name: 'review-tools',
  version: '1.2.0',
  description: 'Shared repository review workflows.',
  displayName: 'Review Tools',
  author: {
    name: 'Example Team',
    email: 'maintainers@example.com',
    url: 'https://example.com/team',
  },
  homepage: 'https://example.com/review-tools',
  repository: 'https://github.com/example/review-tools',
  license: 'MIT',
  keywords: ['review', 'workflow'],
  platforms: [claudeCode()],
});
```

Platform 会逐字段报告元数据是 native、transform、degraded、unsupported 或 omitted。一个目标 Schema 不支持某字段时不会偷偷写入未知字段。

完整类型见 [`UserConfig`](/api/@tokenroll/acplugin/interfaces/UserConfig.md) 与 [`PluginMetadata`](/api/@tokenroll/acplugin/interfaces/PluginMetadata.md)。
