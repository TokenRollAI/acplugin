# acplugin documentation

acplugin is a canonical AI Plugin framework and CLI. Authors write Commands, Skills, Agents, and optional Extension sources once, then build Platform-owned deliveries for Claude Code, Codex, Cursor, Antigravity, OpenCode, and Pi.

关键稳定文档同时维护英文基准与中文对照；行为变化需要同步更新两种语言。

## Overview

- [Project overview](overview/project.md) · [项目概览](overview/project.zh-CN.md) — product boundary, packages, runtime, and Migration isolation.

## Guides

- [Using acplugin](guides/usage.md) · [使用 acplugin](guides/usage.zh-CN.md) — scaffold, author, validate, build, and migrate.
- [Release guide](guides/release.md) · [手动发布指南](guides/release.zh-CN.md) — fixed public cohort verification and fully manual publishing.
- [中文代码注释规范](guides/commenting.zh-CN.md) — 中文声明注释、关键逻辑注释与自动守卫规则。

## Architecture

- [System architecture](architecture/system.md) · [系统架构](architecture/system.zh-CN.md) — Core-owned lifecycle, Platforms, Extensions, Adapter boundaries, Artifact graph, and managed output transaction.

## Reference

- [Target support matrix](reference/conversion-matrix.md) · [目标支持矩阵](reference/conversion-matrix.zh-CN.md) — native, transformed, and degraded target capabilities plus implementation ownership.
