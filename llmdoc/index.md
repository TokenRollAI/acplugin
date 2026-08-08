# ACPlugin documentation

ACPlugin is a canonical AI Plugin framework and CLI. Authors write Commands, Skills, Agents, and optional Extension sources once, then build Platform-owned deliveries for Claude Code, Codex, Cursor, Antigravity, OpenCode, and Pi.

关键稳定文档同时维护英文基准与中文对照；行为变化需要同步更新两种语言。

## Overview

- [Project overview](overview/project.md) · [项目概览](overview/project.zh-CN.md) — product boundary, packages, runtime, and Migration isolation.

## Guides

- [Using ACPlugin](guides/usage.md) · [使用 ACPlugin](guides/usage.zh-CN.md) — scaffold, author, validate, build, and migrate.
- [按 Package 代码导览](guides/package-code-tour.zh-CN.md) — 每个 workspace package 的职责、架构、数据流、实现伪代码与修改入口。
- [Release guide](guides/release.md) · [手动发布指南](guides/release.zh-CN.md) — independent public-package verification and fully manual publishing.
- [中文代码注释规范](guides/commenting.zh-CN.md) — 中文声明注释、关键逻辑注释与自动守卫规则。

## Architecture

- [System architecture](architecture/system.md) · [系统架构](architecture/system.zh-CN.md) — Core-owned lifecycle, Platforms, Extensions, Adapter boundaries, Artifact graph, and managed output transaction.
- [ADR-0001: lifecycle determinism and cache](architecture/decisions/0001-lifecycle-determinism-and-cache.md) · [ADR-0001：生命周期确定性与缓存](architecture/decisions/0001-lifecycle-determinism-and-cache.zh-CN.md)
- [ADR-0002: Extension contribution order](architecture/decisions/0002-extension-contribution-order.md) · [ADR-0002：Extension 贡献顺序](architecture/decisions/0002-extension-contribution-order.zh-CN.md)
- [ADR-0003: Node toolchain and runtime support](architecture/decisions/0003-node-toolchain-and-runtime-support.md) · [ADR-0003：Node 工具链与运行时支持](architecture/decisions/0003-node-toolchain-and-runtime-support.zh-CN.md)
- [ADR-0004: first-class Platform packages](architecture/decisions/0004-first-class-platform-packages.md) · [ADR-0004：Platform 是一等独立生态包](architecture/decisions/0004-first-class-platform-packages.zh-CN.md)

## Reference

- [Target support matrix](reference/conversion-matrix.md) · [目标支持矩阵](reference/conversion-matrix.zh-CN.md) — native, transformed, and degraded target capabilities plus implementation ownership.
- [Domain glossary](reference/domain-glossary.md) · [领域术语](reference/domain-glossary.zh-CN.md) — build, commit, cleanup, determinism, cacheability, and Extension ordering terms.
