# 构建与校验

## 四个项目命令

- `validate`：执行完整 Package 生成、物化与平台校验，但不提交托管输出。
- `inspect`：执行同一流水线，并在人类可读输出中列出 Component、Extension、Platform、Package 与 Asset。
- `build`：全部所选 Platform 通过后，按事务替换受管 Package 集合。
- `dev`：由 Core 监听真实资源与 Compiler 模块图，每个合并变更轮次执行同一 BuildSession，并保留最后一次成功输出。

它们共享 `--config`、`--platform`、`--mode` 和 `--json`，CLI 与程序化 API 不维护第二条构建路径。兼容性严格度只从 `build.strict` 和 Platform factory override 解析。

## 固定 lifecycle

```text
config/session setup → resource discovery → validation/compile
→ Platform base Package → unordered Contributions → Core merge
→ finalization → primary/distribution candidate validation
→ compatibility/metadata → aggregate validation → transaction → Session close
```

完整阶段和 capability 边界见 [Lifecycle 契约](/ecosystem/lifecycle-contract)。

## 兼容性与提交

每个资源按 Platform 记录 `native`、`transform`、`degraded` 或 `unsupported`。strict 模式拒绝 degraded/unsupported；relaxed 只放宽功能兼容性，不放宽结构、来源、路径、owner、候选或事务错误。

事务以所选 Platform 的完整 Package 集合为单位：锁、恢复、stage、校验、transaction/backup、swap、cleanup。commit 的 Session close 仍位于可回滚窗口；任一目标或必要 cleanup 失败都保留上一份完整输出。

## 稳定 JSON

CI 建议使用：

```bash
pnpm exec acplugin validate --json > build-report.json
```

schema-v3 `BuildReport` 包含 Framework/Compiler 版本、Components、Runtimes、Extensions、Platforms、Packages、Asset 元数据、兼容性、metadata disposition 与阶段诊断。由 Platform Component Contribution 决定的生成 Asset 还会带稳定的 Extension owner/subject provenance。它不包含 Asset bytes、时间戳、凭据、临时路径或机器绝对路径，集合使用稳定顺序。
