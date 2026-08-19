import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 当前仓库根目录，用于定位生成输出并检查绝对路径泄漏。 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** TypeDoc 与 VitePress 共享的 API Markdown 输出目录。 */
const apiDirectory = path.join(root, 'packages/docs/api');
/** 必须作为 TypeDoc package 模块出现的公开 package 及其代表 API 页面。 */
const publicPackages = [
  {
    name: '@tokenroll/acplugin',
    api: 'functions/defineConfig.md',
    sdk: ['functions/definePlatform.md', 'interfaces/PlatformContributor.md', 'interfaces/CompilerService.md'],
  },
  { name: '@tokenroll/acplugin-platform-antigravity', api: 'functions/antigravity.md' },
  { name: '@tokenroll/acplugin-platform-claude-code', api: 'functions/claudeCode.md' },
  { name: '@tokenroll/acplugin-platform-codex', api: 'functions/codex.md' },
  { name: '@tokenroll/acplugin-platform-cursor', api: 'functions/cursor.md' },
  { name: '@tokenroll/acplugin-platform-opencode', api: 'functions/openCode.md' },
  { name: '@tokenroll/acplugin-platform-pi', api: 'functions/pi.md' },
  { name: '@tokenroll/acplugin-extension-hooks', api: 'interfaces/Hook.md' },
  { name: '@tokenroll/acplugin-extension-mcp', api: 'type-aliases/McpServer.md' },
];
/** 不得成为 TypeDoc package 模块的私有 workspace。 */
const privatePackages = ['@acplugin/core', '@acplugin/test', '@acplugin/docs', '@acplugin/playground'];

/** 递归读取目录中的全部 Markdown 和 JSON 生成物。 */
async function readGenerated(directory) {
  /** 当前目录按代码单元稳定排序后的条目。 */
  const entries = (await fs.readdir(directory, { withFileTypes: true }))
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  /** 当前子树累积的相对文件名和文本内容。 */
  const files = [];
  for (const entry of entries) {
    /** 当前条目的绝对路径。 */
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await readGenerated(file));
    } else if (entry.isFile() && (entry.name.endsWith('.md') || entry.name.endsWith('.json'))) {
      files.push({ file, source: await fs.readFile(file, 'utf8') });
    }
  }
  return files;
}

/** 对确定性文档结构断言失败并使用稳定消息退出。 */
function assert(condition, message) {
  if (!condition)
    throw new Error(message);
}

/** 判断路径是否存在，用于验证 TypeDoc package 页面集合。 */
async function pathExists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

/** 验证 TypeDoc 输出只包含期望的公开 package，且不泄漏本机路径。 */
async function main() {
  /** TypeDoc 主题生成的 VitePress sidebar 文件。 */
  const sidebar = path.join(apiDirectory, 'typedoc-sidebar.json');
  await fs.access(path.join(apiDirectory, 'index.md'));
  await fs.access(sidebar);
  /** 用于检查 package 名和路径泄漏的完整生成文本。 */
  const files = await readGenerated(apiDirectory);
  /** 合并后供 package 名和本机路径断言使用的稳定文本。 */
  const source = files.map(file => file.source).join('\n');
  for (const packageEntry of publicPackages) {
    /** 当前公开 package 对应的 TypeDoc 输出目录。 */
    const packageDirectory = path.join(apiDirectory, packageEntry.name);
    assert(await pathExists(path.join(packageDirectory, 'index.md')), `Generated API is missing package page ${packageEntry.name}.`);
    assert(await pathExists(path.join(packageDirectory, packageEntry.api)), `Generated API is missing representative API for ${packageEntry.name}.`);
    for (const sdkApi of packageEntry.sdk ?? [])
      assert(await pathExists(path.join(packageDirectory, sdkApi)), `Generated API is missing SDK API ${packageEntry.name}/${sdkApi}.`);
    assert(source.includes(`/api/${packageEntry.name}/`), `Generated sidebar is missing public package ${packageEntry.name}.`);
  }
  for (const packageName of privatePackages) {
    assert(!await pathExists(path.join(apiDirectory, packageName)), `Generated API exposes private package directory ${packageName}.`);
    assert(!source.includes(packageName), `Generated API exposes private package ${packageName}.`);
  }
  assert(!source.includes(root), 'Generated API contains the absolute workspace path.');
}

/** 作为脚本入口立即运行检查，让任何结构漂移以非零退出码结束。 */
await main();
