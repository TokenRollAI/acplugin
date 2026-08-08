# 兼容性与 strict

兼容性是逐 Platform、逐资源、逐字段报告的显式结果：

| Level | 含义 |
| --- | --- |
| `native` | 目标平台直接表达同一语义 |
| `transform` | 经过受控转换后保持语义 |
| `degraded` | 产物可用，但部分语义或控制能力丢失 |
| `unsupported` | 目标平台不能提供经过验证的实现 |

## 严格度层级

全局默认 `build.strict: true`。Platform factory 可以单独覆盖：

```ts
export default defineConfig({
  // ...metadata
  platforms: [
    claudeCode(),
    codex({ strict: false }),
  ],
});
```

CLI 的 `--strict` 或 `--no-strict` 覆盖本次选择的全部 Platform，适合 CI 临时策略。优先级是 CLI override → Platform override → `build.strict` 默认。

Relaxed 模式只允许功能兼容性继续构建，并保留完整报告。以下错误始终失败：

- 配置、Frontmatter、依赖图或 Schema 无效；
- Artifact 来源越权、路径冲突或 owner 冲突；
- Extension/Adapter API 不兼容；
- DeliveryUnit 最终校验或 transaction 失败。

建议默认 strict，只在明确接受一个已审查的降级时对特定 Platform 放宽，并在 CI 检查报告中允许的诊断集合。
