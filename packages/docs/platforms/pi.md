# Pi

## 安装与配置

```bash
pnpm add -D @tokenroll/acplugin @tokenroll/acplugin-platform-pi
```

```ts
import { defineConfig } from '@tokenroll/acplugin';
import pi from '@tokenroll/acplugin-platform-pi';

export default defineConfig({
  name: 'my-plugin',
  version: '1.0.0',
  description: 'Reusable AI workflows.',
  platforms: [pi({ package: { image: './assets/cover.png' } })],
});
```

## Options

- `strict?: boolean`：覆盖兼容性严格度。
- `package.image?: string`：相对 package 根或远程展示图片。
- `package.video?: string`：远程演示视频 URL。

## 交付与兼容性

Pi 产生带 `package.json` 的 npm package DeliveryUnit：

- Command 转换到 `prompts/<id>.md`；参数提示可进入原生 prompt metadata。
- Skill 进入 `skills/<id>/SKILL.md`，为 native。
- Agent 转为指导型 `skills/agent-<id>`，model/capabilities 不能强制，因此 degraded。

Pi 不支持 MCP transport，官方 MCP Adapter 会报告 unsupported，而不会伪造客户端行为。

[Pi package API](/api/@tokenroll/acplugin-platform-pi/)
