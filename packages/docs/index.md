---
layout: home

hero:
  name: ACPlugin
  text: 一次创作，多平台交付
  tagline: 用一套 Canonical 工程，稳定构建 Claude Code、Codex、Cursor、Antigravity、OpenCode 与 Pi 交付产物。
  image:
    src: /acplugin-mark.svg
    alt: 香蕉形字母 C 组成的 ACPlugin 标志
  actions:
    - theme: brand
      text: 🍌 快速开始
      link: /guide/getting-started
    - theme: alt
      text: 浏览 API
      link: /api/

features:
  - icon: ✍️
    title: Canonical Authoring
    details: 用 Commands、Skills、Agents 与可选 Extensions 表达作者意图。
  - icon: 🧬
    title: 固定生命周期
    details: Core 统一扫描、兼容性、所有权、事务和稳定报告。
  - icon: 🎯
    title: 六平台交付
    details: 官方 Platform 独立安装，把同一份内容转换成目标平台的原生结构。
  - icon: 🧩
    title: 开放生态
    details: Platform 与 Extension 都从独立 package 安装和导入。
  - icon: 🛡️
    title: 安全事务
    details: owner 隔离、候选校验与全量提交共同保护已有 dist。
  - icon: 📐
    title: 确定性输出
    details: 稳定排序、序列化和报告让相同输入产生可审查的相同字节。
---

## 一个工程，明确的交付边界

ACPlugin 把平台中立的作者资源交给显式配置的 Platform，并通过 Extension Adapter 添加横向能力。先从[快速开始](/guide/getting-started)了解工程结构，或直接查看[公开 API](/api/)。

<div class="acp-home-intro">
  <p class="acp-kicker">🍌 One source, many deliveries</p>
  <div class="acp-flow" role="list" aria-label="ACPlugin 从作者资源到多平台产物的构建流程">
    <div class="acp-flow__step" role="listitem">
      <span class="acp-flow__icon" aria-hidden="true">✍️</span>
      <span class="acp-flow__label">Canonical Authoring</span>
    </div>
    <span class="acp-flow__arrow" aria-hidden="true">→</span>
    <div class="acp-flow__step" role="listitem">
      <span class="acp-flow__icon" aria-hidden="true">⚙️</span>
      <span class="acp-flow__label">Core Lifecycle</span>
    </div>
    <span class="acp-flow__arrow" aria-hidden="true">→</span>
    <div class="acp-flow__step" role="listitem">
      <span class="acp-flow__icon" aria-hidden="true">🎯</span>
      <span class="acp-flow__label">Platform Delivery</span>
    </div>
    <span class="acp-flow__arrow" aria-hidden="true">+</span>
    <div class="acp-flow__step" role="listitem">
      <span class="acp-flow__icon" aria-hidden="true">🧩</span>
      <span class="acp-flow__label">Optional Extensions</span>
    </div>
  </div>
</div>

```ts
import { defineConfig } from '@tokenroll/acplugin';
import hooks from '@tokenroll/acplugin-extension-hooks';
import claudeCode from '@tokenroll/acplugin-platform-claude-code';
import codex from '@tokenroll/acplugin-platform-codex';

export default defineConfig({
  name: 'my-plugin',
  version: '1.0.0',
  description: 'Reusable AI workflows.',
  platforms: [claudeCode(), codex()],
  extensions: [hooks()],
});
```

Platform 与 Extension 是独立 package。主包只提供 CLI、配置、生命周期 SDK 和通用契约，因此官方实现与第三方实现遵守同一条边界。
