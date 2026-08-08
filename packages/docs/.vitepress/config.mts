import { defineConfig } from 'vitepress';
import typedocSidebar from '../api/typedoc-sidebar.json';

/** ACPlugin 文档站的稳定导航、品牌资源与本地构建配置。 */
export default defineConfig({
  lang: 'zh-CN',
  title: 'ACPlugin',
  description: '统一的 AI Plugin 框架与 CLI',
  cleanUrls: true,
  lastUpdated: false,
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/acplugin-mark.svg' }],
    ['meta', { name: 'theme-color', content: '#f6c915' }],
  ],
  markdown: {
    image: { lazyLoading: true },
  },
  themeConfig: {
    logo: {
      light: '/acplugin-logo.svg',
      dark: '/acplugin-logo-dark.svg',
      alt: 'ACPlugin',
    },
    siteTitle: false,
    nav: [
      { text: '指南', link: '/guide/' },
      { text: '配置', link: '/config/' },
      { text: '平台', link: '/platforms/' },
      { text: '扩展', link: '/extensions/' },
      {
        text: '生态',
        items: [
          { text: '🧩 生态开发', link: '/ecosystem/' },
          { text: '🧪 Playground', link: '/playground/' },
          { text: '📚 参考资源', link: '/resources/' },
        ],
      },
      { text: 'API', link: '/api/' },
    ],
    sidebar: {
      '/guide/': [
        {
          text: '开始',
          items: [
            { text: '指南总览', link: '/guide/' },
            { text: '为什么使用 ACPlugin', link: '/guide/why-acplugin' },
            { text: '快速开始', link: '/guide/getting-started' },
            { text: '工程结构', link: '/guide/project-structure' },
          ],
        },
        {
          text: '核心工作流',
          items: [
            { text: 'Commands、Skills 与 Agents', link: '/guide/commands-skills-agents' },
            { text: '构建与校验', link: '/guide/build-and-validate' },
            { text: 'CLI', link: '/guide/cli' },
            { text: 'Migration', link: '/guide/migration' },
            { text: '故障排查', link: '/guide/troubleshooting' },
          ],
        },
      ],
      '/config/': [
        { text: '配置总览', link: '/config/' },
        { text: '工程元数据', link: '/config/project-metadata' },
        { text: 'Public 文件', link: '/config/public-files' },
        { text: '构建选项', link: '/config/build-options' },
        { text: '兼容性与 strict', link: '/config/compatibility-and-strictness' },
      ],
      '/platforms/': [
        { text: '平台总览', link: '/platforms/' },
        { text: 'Claude Code', link: '/platforms/claude-code' },
        { text: 'Codex', link: '/platforms/codex' },
        { text: 'Cursor', link: '/platforms/cursor' },
        { text: 'Antigravity', link: '/platforms/antigravity' },
        { text: 'OpenCode', link: '/platforms/opencode' },
        { text: 'Pi', link: '/platforms/pi' },
      ],
      '/extensions/': [
        { text: '扩展总览', link: '/extensions/' },
        { text: 'Hooks', link: '/extensions/hooks' },
        { text: 'MCP', link: '/extensions/mcp' },
      ],
      '/ecosystem/': [
        { text: '生态开发总览', link: '/ecosystem/' },
        { text: 'Platform 开发', link: '/ecosystem/platform-authoring' },
        { text: 'Extension 开发', link: '/ecosystem/extension-authoring' },
        { text: 'Lifecycle 契约', link: '/ecosystem/lifecycle-contract' },
        { text: 'Artifact 与 Document', link: '/ecosystem/artifacts-and-documents' },
        { text: 'Package 与 peer 边界', link: '/ecosystem/package-and-peer-boundaries' },
      ],
      '/playground/': [
        { text: 'Playground 总览', link: '/playground/' },
        { text: 'llmdoc v3 模板', link: '/playground/llmdoc-v3' },
      ],
      '/resources/': [
        { text: '资源总览', link: '/resources/' },
        { text: '兼容性矩阵', link: '/resources/compatibility-matrix' },
        { text: '确定性构建', link: '/resources/deterministic-builds' },
        { text: '安全模型', link: '/resources/security-model' },
        { text: 'Package map', link: '/resources/package-map' },
      ],
      '/api/': typedocSidebar,
    },
    search: {
      provider: 'local',
      options: {
        miniSearch: {
          searchOptions: { fuzzy: 0.2, prefix: true },
        },
      },
    },
    socialLinks: [
      { icon: 'github', link: 'https://github.com/TokenRollAI/acplugin' },
    ],
    outline: { level: [2, 3], label: '本页内容' },
    docFooter: { prev: '上一页', next: '下一页' },
    darkModeSwitchLabel: '外观',
    lightModeSwitchTitle: '切换到浅色主题',
    darkModeSwitchTitle: '切换到深色主题',
    sidebarMenuLabel: '目录',
    returnToTopLabel: '返回顶部',
    externalLinkIcon: true,
    footer: {
      message: '为可移植的 AI 工作流而构建 · MIT License',
      copyright: 'ACPlugin by TokenRoll',
    },
  },
});
