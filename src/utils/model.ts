import type { Platform } from '../types.js';

const CODEX_MODEL_MAP: Record<string, string> = {
  'sonnet': 'gpt-5.4',
  'opus': 'gpt-5.4',
  'haiku': 'gpt-5.4',
  'claude-sonnet-4-6': 'gpt-5.4',
  'claude-opus-4-6': 'gpt-5.4',
  'claude-haiku-4-5-20251001': 'gpt-5.4',
  'inherit': 'gpt-5.4',
};

const ANTIGRAVITY_MODEL_MAP: Record<string, string> = {
  'sonnet': 'gemini-3-pro',
  'opus': 'gemini-3-pro',
  'haiku': 'gemini-3-flash',
  'claude-sonnet-4-6': 'gemini-3-pro',
  'claude-opus-4-6': 'gemini-3-pro',
  'claude-haiku-4-5-20251001': 'gemini-3-flash',
  'inherit': 'gemini-3-pro',
};

export function mapModel(model: string, platform: Platform): string {
  switch (platform) {
    case 'codex':
      return CODEX_MODEL_MAP[model] || 'gpt-5.4';
    case 'antigravity':
      return ANTIGRAVITY_MODEL_MAP[model] || 'gemini-3-pro';
    case 'opencode':
      return model;
    case 'cursor':
      return model;
  }
}
