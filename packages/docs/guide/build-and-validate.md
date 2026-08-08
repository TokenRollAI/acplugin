# 构建与校验

## 四个项目命令

- `validate`：执行完整候选生成与校验，但不提交新的托管输出。
- `inspect`：执行同一流水线，并在人类可读输出中列出 Component、Extension、Platform、Document、DeliveryUnit 与 Artifact。
- `build`：验证全部选中目标后，按事务整体替换 `dist`。
- `dev`：监听真实依赖并保留最后一次成功输出。

它们共享 `--config`、`--platform`、`--mode`、`--strict/--no-strict` 和 `--json`，不会维护第二条构建路径。

## 固定 lifecycle

```text
configResolved → buildStart → Extension.discover → Scanner
→ Extension.validate/build → Platform.prepare → Adapter.apply
→ Platform.generateBundle/validateBundle → distributions
→ compatibility → transaction → buildEnd
```

`buildEnd` 在成功和失败时都按初始化逆序执行，并只收到脱敏摘要。

## 兼容性与提交

每个资源按 Platform 记录 `native`、`transform`、`degraded` 或 `unsupported`。strict 模式拒绝 degraded/unsupported；relaxed 模式只放宽功能兼容性，不放宽结构、来源、路径、owner 或事务错误。

事务以选中 Platform 的完整目标集合为单位：锁、恢复、stage、校验、backup、swap、cleanup。任一目标失败都保留上一次完整输出。

## 稳定 JSON

CI 建议使用：

```bash
pnpm exec acplugin validate --json > build-report.json
```

报告不包含 Artifact bytes、时间戳、凭据、临时路径或机器绝对路径。字段和集合使用稳定顺序，适合作为自动化输入。
