import type { Platform } from '../types.js';

// Codex default is gpt-5.6-sol; the lighter/faster tier (terra) suits fast
// small-model roles. See learn.chatgpt.com/docs/models.
const CODEX_DEFAULT_MODEL = 'gpt-5.6-sol';
const CODEX_MODEL_MAP: Record<string, string> = {
  'sonnet': 'gpt-5.6-sol',
  'opus': 'gpt-5.6-sol',
  'haiku': 'gpt-5.6-terra',
  'claude-sonnet-4-6': 'gpt-5.6-sol',
  'claude-opus-4-6': 'gpt-5.6-sol',
  'claude-haiku-4-5-20251001': 'gpt-5.6-terra',
  'inherit': 'gpt-5.6-sol',
};

// gemini-3-pro/gemini-3-flash are not valid API model IDs; gemini-3-pro-preview
// was discontinued 2026-03. See ai.google.dev/gemini-api/docs/models.
const ANTIGRAVITY_DEFAULT_MODEL = 'gemini-3.1-pro-preview';
const ANTIGRAVITY_MODEL_MAP: Record<string, string> = {
  'sonnet': 'gemini-3.1-pro-preview',
  'opus': 'gemini-3.1-pro-preview',
  'haiku': 'gemini-3.6-flash',
  'claude-sonnet-4-6': 'gemini-3.1-pro-preview',
  'claude-opus-4-6': 'gemini-3.1-pro-preview',
  'claude-haiku-4-5-20251001': 'gemini-3.6-flash',
  'inherit': 'gemini-3.1-pro-preview',
};

export function mapModel(model: string, platform: Platform): string {
  switch (platform) {
    case 'codex':
      return CODEX_MODEL_MAP[model] || CODEX_DEFAULT_MODEL;
    case 'antigravity':
      return ANTIGRAVITY_MODEL_MAP[model] || ANTIGRAVITY_DEFAULT_MODEL;
    case 'opencode':
      return model;
    case 'cursor':
      return model;
    case 'pi':
      return model;
  }
}
