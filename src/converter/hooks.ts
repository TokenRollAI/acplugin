import type { Hooks, Platform, ConvertedFile } from '../types.js';

// Events that have reasonable mapping across platforms
const PORTABLE_EVENTS = ['PostToolUse', 'PreToolUse', 'Stop', 'SessionStart', 'PreCompact'];

// Human-readable timing phrase per event, used when degrading a hook to an
// AGENTS.md note. "Run after PreCompact" would be semantically wrong.
const EVENT_TIMING: Record<string, string> = {
  'SessionStart': 'At the start of every session, run',
  'Stop': 'When the session stops, run',
  'PreCompact': 'Right before context compaction, run',
  'PreToolUse': 'Before each tool use, run',
  'PostToolUse': 'After each tool use, run',
};

// Claude Code PascalCase → Cursor camelCase event name mapping
const CURSOR_EVENT_MAP: Record<string, string> = {
  'PostToolUse': 'postToolUse',
  'PreToolUse': 'preToolUse',
  'Stop': 'stop',
  'SessionStart': 'sessionStart',
};

interface HookReport {
  converted: ConvertedFile[];
  warnings: string[];
}

export function convertHooks(hooks: Hooks, platform: Platform): HookReport {
  if (platform === 'cursor') {
    return convertCursorHooks(hooks);
  }
  if (platform === 'codex') {
    return convertCodexHooks(hooks);
  }

  const warnings: string[] = [];
  const converted: ConvertedFile[] = [];

  for (const [event, matchers] of Object.entries(hooks)) {
    if (!PORTABLE_EVENTS.includes(event)) {
      warnings.push(`Hook event "${event}" is not portable to ${platform} — skipped`);
      continue;
    }

    for (const matcher of matchers) {
      for (const hook of matcher.hooks) {
        if (hook.type === 'command' && hook.command) {
          const result = convertCommandHook(event, matcher.matcher, hook.command, platform);
          if (result) {
            converted.push(result);
          } else {
            warnings.push(`Hook ${event}/${matcher.matcher || '*'} cannot be directly converted to ${platform}`);
          }
        } else if (hook.type === 'prompt' || hook.type === 'agent') {
          warnings.push(`Hook type "${hook.type}" for event "${event}" is Claude Code specific — cannot convert to ${platform}`);
        } else if (hook.type === 'http') {
          warnings.push(`HTTP hook for event "${event}" — manual configuration needed for ${platform}`);
        }
      }
    }
  }

  return { converted, warnings };
}

/**
 * Codex plugins support native hooks: the default hook file is hooks/hooks.json
 * at the plugin root, using a Claude-compatible schema (same events incl.
 * SessionStart/Stop/PreCompact, matchers, type:command, additionalContextLimit).
 * See https://developers.openai.com/plugins/build/plugins and
 * https://learn.chatgpt.com/docs/hooks — so we pass hooks through losslessly
 * instead of degrading them to AGENTS.md prose. JSON.parse preserved any fields
 * beyond our HookEntry type, so stringifying keeps them intact. Codex parses
 * but skips non-command handler types itself.
 */
function convertCodexHooks(hooks: Hooks): HookReport {
  return {
    converted: [
      {
        path: 'hooks/hooks.json',
        content: JSON.stringify({ hooks }, null, 2) + '\n',
        type: 'hook',
      },
    ],
    warnings: [
      'Codex plugin hooks are non-managed: users must review and trust them via /hooks before they run',
    ],
  };
}

/**
 * Convert Claude Code hooks to Cursor hooks format.
 * Cursor hooks use camelCase event names, no matcher, and a version field.
 */
function convertCursorHooks(hooks: Hooks): HookReport {
  const warnings: string[] = [];
  const cursorHooks: Record<string, Array<{ command: string }>> = {};

  for (const [event, matchers] of Object.entries(hooks)) {
    const cursorEvent = CURSOR_EVENT_MAP[event];
    if (!cursorEvent) {
      warnings.push(`Hook event "${event}" is not supported in Cursor — skipped`);
      continue;
    }

    const entries: Array<{ command: string }> = [];
    for (const matcher of matchers) {
      for (const hook of matcher.hooks) {
        if (hook.type === 'command' && hook.command) {
          // Strip ${CLAUDE_PLUGIN_ROOT}/ prefix and adapt path for Cursor
          let cmd = hook.command;
          cmd = cmd.replace(/"\$\{CLAUDE_PLUGIN_ROOT\}\/([^"]+)"/g, './$1');
          cmd = cmd.replace(/\$\{CLAUDE_PLUGIN_ROOT\}\//g, './');
          entries.push({ command: cmd });
        } else {
          warnings.push(`Hook type "${hook.type}" for event "${event}" is not supported in Cursor — skipped`);
        }
      }
    }

    if (entries.length > 0) {
      cursorHooks[cursorEvent] = entries;
    }
  }

  const converted: ConvertedFile[] = [];
  if (Object.keys(cursorHooks).length > 0) {
    const content = JSON.stringify({ version: 1, hooks: cursorHooks }, null, 2);
    converted.push({
      path: 'hooks/hooks-cursor.json',
      content,
      type: 'hook',
    });
  }

  return { converted, warnings };
}

function convertCommandHook(
  event: string,
  matcher: string | undefined,
  command: string,
  platform: Platform
): ConvertedFile | null {
  switch (platform) {
    case 'cursor':
      // Cursor doesn't have hooks yet in a config file format we can write
      return null;
    case 'codex':
      // Unreachable: codex is handled by convertCodexHooks (native passthrough).
      return null;
    case 'opencode':
      // OpenCode doesn't have a public hooks system — add as a note
      return {
        path: `AGENTS.md.hook-${event}`,
        content: `## Hook: ${event}${matcher ? ` (${matcher})` : ''}\n\n${EVENT_TIMING[event] || `On ${event}, run`}: \`${command}\`\n`,
        type: 'hook',
      };
    case 'antigravity':
      // Antigravity doesn't have file-configurable hooks
      return null;
    case 'pi':
      // Pi handles hooks only via TypeScript extensions — no file format.
      return null;
  }
}
