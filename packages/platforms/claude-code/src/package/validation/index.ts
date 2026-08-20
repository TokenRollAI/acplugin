/** Claude Code 主 Plugin 或 Marketplace Distribution 的 validator 组合入口。 */
import { MARKETPLACE_MANIFEST_PATH, PLUGIN_MANIFEST_PATH } from '../manifest.js';
import { validatePluginManifest } from './manifest.js';
import { validateMarketplace } from './marketplace.js';
import { readJson, type PlatformValidateContext } from './shared.js';

/** 验证 Claude Code 最终安装候选。 */
export async function validateClaudePackage(context: PlatformValidateContext): Promise<void> {
  if (context.candidate.unit.role !== 'distribution') {
    /** 主单元始终使用安装根固定 Plugin Manifest。 */
    const plugin = await readJson(context, PLUGIN_MANIFEST_PATH);
    if (plugin !== undefined)
      await validatePluginManifest(context, plugin);
    return;
  }
  /** Marketplace Distribution 额外需要的根清单。 */
  const marketplace = await readJson(context, MARKETPLACE_MANIFEST_PATH);
  if (marketplace !== undefined)
    await validateMarketplace(context, marketplace);
}
