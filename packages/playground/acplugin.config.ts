import { defineConfig } from '@tokenroll/acplugin';
import hooks from '@tokenroll/acplugin-extension-hooks';
import claudeCode from '@tokenroll/acplugin-platform-claude-code';
import codex from '@tokenroll/acplugin-platform-codex';

/** llmdoc v3 主题模板的真实 acplugin 构建配置。 */
export default defineConfig({
  name: 'llmdoc-v3-playground',
  version: '0.1.0',
  description: 'llmdoc v3 authoring template for acplugin integration exercises.',
  displayName: 'llmdoc v3 Playground',
  platforms: [claudeCode(), codex()],
  extensions: [hooks()],
  build: { strict: false },
});
