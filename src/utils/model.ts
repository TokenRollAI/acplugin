import type { Platform } from '../types.js';

/**
 * Claude Code model name → target platform model name mapping.
 */
const CODEX_MODEL_MAP: Record<string, string> = {
  'sonnet': 'gpt-5.4',
  'opus': 'gpt-5.4',
  'haiku': 'gpt-5.4',
  'claude-sonnet-4-6': 'gpt-5.4',
  'claude-opus-4-6': 'gpt-5.4',
  'claude-haiku-4-5-20251001': 'gpt-5.4',
  'inherit': 'gpt-5.4',
};

/**
 * Map a Claude Code model name to the target platform's model name.
 * Returns the mapped model, or the original if no mapping exists.
 */
export function mapModel(model: string, platform: Platform): string {
  switch (platform) {
    case 'codex':
      return CODEX_MODEL_MAP[model] || 'gpt-5.4';
    case 'opencode':
      // OpenCode supports multiple providers, keep original or map
      return model;
    case 'cursor':
      // Cursor uses its own model selection, keep original
      return model;
  }
}
