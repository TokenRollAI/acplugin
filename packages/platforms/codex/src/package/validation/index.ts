/** Codex 主 Plugin 或 Marketplace Distribution 的 validator 组合入口。 */
import { MARKETPLACE_MANIFEST_PATH, PLUGIN_MANIFEST_PATH } from '../manifest.js';
import { validatePluginManifest } from './manifest.js';
import { validateMarketplace } from './marketplace.js';
import { readJson, report, type PlatformValidateContext } from './shared.js';

/** 校验主 Plugin 或 Marketplace Distribution 的最终安装根契约。 */
export async function validateCodexPackage(context: PlatformValidateContext): Promise<void> {
  if (context.candidate.unit.type === 'marketplace') {
    /** Distribution 额外要求 Repo Marketplace 固定路径。 */
    const marketplace = await readJson(context, MARKETPLACE_MANIFEST_PATH);
    if (marketplace !== undefined)
      await validateMarketplace(context, marketplace);
    return;
  }
  /** 主单元始终使用安装根固定 Plugin Manifest。 */
  const plugin = await readJson(context, PLUGIN_MANIFEST_PATH);
  if (plugin !== undefined)
    await validatePluginManifest(context, plugin);
  if (context.candidate.unit.assets.some(asset => asset.path === MARKETPLACE_MANIFEST_PATH))
    report(context, 'CODEX_MARKETPLACE_IN_PRIMARY', 'Primary Plugin must not contain a Marketplace manifest.');
}
