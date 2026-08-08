import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { PlatformValidateContext } from '@tokenroll/acplugin';
import { PLUGIN_MANIFEST_PATH } from './manifest.js';

/**
 * 向 Core 提交 Antigravity 候选校验错误。
 *
 * @param context Platform validateBundle 生命周期上下文。
 * @param code 稳定诊断码。
 * @param message 不包含宿主绝对路径的错误信息。
 */
function report(context: PlatformValidateContext, code: string, message: string): void {
  context.reportDiagnostic({ code, severity: 'error', message });
}

/**
 * 校验 Antigravity 最小 Manifest、Skill 目录和可选 Extension 配置。
 *
 * @param context Platform 提供的已物化候选交付单元。
 */
export async function validateAntigravityBundle(context: PlatformValidateContext): Promise<void> {
  /** 当前候选交付单元的规范 Artifact 路径集合。 */
  const artifacts = new Set(context.candidate.unit.artifacts.map(artifact => artifact.path));
  try {
    /** 当前没有公开 Schema，内部严格规则只接受官方文档确认的 name。 */
    const value: unknown = JSON.parse(await fs.readFile(path.join(context.candidate.root, PLUGIN_MANIFEST_PATH), 'utf8'));
    if (value === null || typeof value !== 'object' || Array.isArray(value))
      throw new TypeError('Manifest is not an object.');
    /** 经过对象形态检查的最小 Manifest。 */
    const manifest = value as Record<string, unknown>;
    if (Object.keys(manifest).length !== 1 || typeof manifest.name !== 'string' || manifest.name.trim().length === 0)
      report(context, 'ANTIGRAVITY_MANIFEST_INVALID', 'plugin.json must contain exactly one non-empty name field.');
  } catch {
    report(context, 'ANTIGRAVITY_MANIFEST_READ_FAILED', 'plugin.json must contain the documented minimal JSON object.');
  }
  /** path 表示当前可选平台配置，存在时必须至少是 JSON 对象。 */
  for (const artifactPath of ['hooks.json', 'mcp_config.json']) {
    if (!artifacts.has(artifactPath))
      continue;
    try {
      /** Extension 配置由其 Adapter 生成，但仍由 Platform 做最终 JSON 对象校验。 */
      const value: unknown = JSON.parse(await fs.readFile(path.join(context.candidate.root, artifactPath), 'utf8'));
      if (value === null || typeof value !== 'object' || Array.isArray(value))
        throw new TypeError('Configuration is not an object.');
    } catch {
      report(context, 'ANTIGRAVITY_EXTENSION_CONFIG_INVALID', `${artifactPath} must contain a JSON object.`);
    }
  }
  if ([...artifacts].some(artifact => artifact.startsWith('commands/') || artifact.startsWith('agents/')))
    report(context, 'ANTIGRAVITY_UNDOCUMENTED_RESOURCE', 'Commands and Agents must be transformed into the documented skills/ tree.');
}
