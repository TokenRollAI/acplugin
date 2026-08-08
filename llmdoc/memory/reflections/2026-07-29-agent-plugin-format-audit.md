# Agent Plugin 格式审查反思

## Task

- 审查 ACPlugin 当前转换实现，并用 2026-07-29 的官方资料确认 Claude Code、Codex、Cursor、OpenCode、Gemini CLI 与 Antigravity 的最新扩展格式。
- 对照真实 marketplace、现有测试和并行工作树改动，区分已确认缺口、未提交修正与仍需验证的判断。

## Expected vs Actual

- 预期：现有单元测试、转换矩阵和示例插件足以证明各 writer 输出仍可被目标产品使用。
- 实际：81 个自包含测试通过，但 56 个真实插件集成测试因 fixture 不存在而默认跳过；换成最新 `superpowers` 后出现 22 个失败，其中又混有上游资源数量变化和硬编码版本漂移。
- 预期：Claude marketplace 的 `source` 是项目当前类型里建模的本地字符串。
- 实际：官方 marketplace 已大量使用 `github`、`url`、`git-subdir` 等对象 source；真实仓库可以立即触发当前 scanner 的类型错误。
- 预期：一个平台对应一种目标布局。
- 实际：Codex 的 project config 与 installable plugin、Gemini CLI extension 与 Antigravity CLI/IDE plugin 分别有不同的发现路径和 manifest 契约，不能由同一个模糊 target 混合输出。
- 审查期间工作树发生并行修改：OpenCode MCP 和部分 `.agents/` 路径已被修正，但早先 scratch 报告仍描述修改前状态。若不重新核对 diff，会把“已在工作树修正”误报成“当前仍未修复”。

## What Went Wrong

- 验证重心停留在“生成了预期字符串和路径”，没有把官方 schema、真实 CLI 加载结果和真实 marketplace 当作验收边界。
- 把 project overlay 与可安装 plugin 当成同一交付形态。例如 Codex 项目 MCP 使用 `.codex/config.toml`，但 plugin manifest 的 `mcpServers` 要求插件内 `.mcp.json`；二者单看都像配置文件，安装语义却不同。
- 集成测试依赖固定 `/tmp/superpowers-test` 是否存在，并通过 `skipIf` 静默变绿；fixture 既没有锁定 commit，也没有在默认 CI 中准备。
- 并行审查使用了“当前实现”这个没有时间点的表述。scratch 报告、源文件、diff 和测试结果来自不同瞬间，导致状态口径可能互相矛盾。

## Root Cause

- 缺少按“平台 + 产品形态 + 版本”组织的外部 contract。当前 `Platform` 枚举只表达品牌，没有表达 project/plugin/extension/workspace 模式。
- 测试把仓库自身的预期输出当成规范，没有独立的官方 schema 或目标 CLI validator 作为 oracle。
- 外部 fixture 策略没有同时满足可复现性与真实性：追踪 latest 会漂移，固定本地目录又会在 CI 中消失。
- 并行工作树缺少审查快照协议，没有在报告中统一记录基线 commit、dirty paths、读取时刻和复核状态。

## Better Workflow

1. 先固定审查基线：记录 `HEAD`、目标平台/CLI 版本、`git status --short` 和已存在的并行改动；每条结论标注 `baseline`、`working-tree` 或 `verified-after-edit`。
2. 官方 schema 优先：从官方 reference/schema 建字段和目录清单，再用官方示例补充语义；不能从当前 converter 或第三方示例反推平台 contract。
3. 用两层 fixture 验证输入：仓库内维护最小、锁定版本的 contract fixtures，默认 CI 必跑；另用锁定 commit 的真实官方 marketplace/plugin 做兼容回归，并明确它不是规范本身。
4. 用目标侧验收输出：能运行 validator/list/install 命令时实际加载；否则至少对官方 JSON Schema、frontmatter 契约和引用文件闭包做校验。
5. 在转换前明确 delivery mode。project config、installable plugin、extension 和 workspace overlay 分别进入不同 writer 或显式 package mode，禁止同一 manifest 引用另一种模式的配置文件。
6. 最终报告前再次执行 `git diff --name-only`，重读所有被并行修改的相关 symbol，并重跑对应测试。被修改但未提交的项写成“工作树已有修正，仍待验证/提交”，不能继续列为未修现状。

## Missing Docs or Signals

- 缺少按版本记录官方来源、输入 schema、输出 schema 和验收命令的 platform contract reference。
- 缺少 project config 与 installable package 的架构边界说明。
- 缺少 integration fixture 的锁定、更新和默认 CI 执行规则。
- 缺少并行工作树下的审查状态口径；`.llmdoc-tmp/` 报告目前没有统一的基线元数据模板。

## Promotion Candidates

- 在 architecture 中把 delivery mode 提升为 writer 的一等维度，至少区分 Codex project/plugin 和 Google 系的 Gemini extension、Antigravity CLI、Antigravity IDE。
- 在 reference 中维护“平台版本 + 官方 schema URL + 支持组件 + 验收方式”的兼容矩阵；具体快速变化的模型名不要写成永恒事实。
- 在 testing guide/decision 中规定：最小 fixture 入库、真实 fixture 锁定 commit、默认 CI 不得因 fixture 缺失而整组跳过。
- 在调查模板中加入 `HEAD`、dirty paths、source snapshot 和 final recheck 字段。

## Follow-up

- 由 recorder 更新稳定架构与转换矩阵；本反思不直接替代稳定文档。
- 为 Claude 官方 marketplace 的对象 source 增加锁定 fixture 和端到端 scanner 测试。
- 为每个输出 mode 增加最小可安装 fixture，并用官方 schema或真实 CLI 做 contract test。
- 在合并并行改动前，以最终 working tree 重新分级所有 P0/P1，避免把已修项和基线缺口混在同一清单。
